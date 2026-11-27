#!/usr/bin/env node
"use strict";

// Durable MMX batch supervisor. Exclusive job and worker claims, immutable
// input snapshots, and inspection-only recovery: an ambiguous job is not replayed.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { parseArgs, collectShardFiles, readProfileBudget } = require("./mmx-batch.js");

const { acquireMmxSlot, DEFAULT_ROOT: DEFAULT_SLOT_ROOT } = require("./mmx-provider-slot.js");
const BATCH = path.join(__dirname, "mmx-batch.js");
const FIXTURE = path.join(__dirname, "mmx-job-fixture.js");
const RUNTIME = [__filename, BATCH, path.join(__dirname, "batch-safety.js"),
  path.join(__dirname, "mmx-provider-slot.js"), FIXTURE];
// Intentionally no real backend and no default enable switch. Native lifecycle
// and the fixed CLI transport must pass independently before that can change.
const ADMISSION = Object.freeze({ default_enabled: false, allowed_backend: "fixture",
  native_lifecycle: "NOT_EVALUATED", real_transport: "NOT_EVALUATED" });
const EXIT_UNKNOWN = 2;
const FORMAT = 3;
const CANCEL_GRACE_MS = 5000;
const CANCEL_KILL_WAIT_MS = 2000;
const HASH = /^[a-f0-9]{64}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function syncDirectory(dir) {
  // Windows directory fsync/ACL and lifecycle semantics require native evidence.
  // Fixture use remains possible, but no Windows durability acceptance is implied.
  if (process.platform === "win32") return false;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(fd).isDirectory()) throw new Error("durability target must be a directory");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return true;
}
function syncCreatedPath(dir, firstCreated) {
  syncDirectory(dir);
  if (!firstCreated) return;
  const stop = path.dirname(firstCreated);
  for (let parent = path.dirname(dir); ; parent = path.dirname(parent)) {
    syncDirectory(parent);
    if (parent === stop || parent === path.dirname(parent)) break;
  }
}
function syncFile(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("durability output must be regular");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("durability output changed");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function syncOutputs(dir) {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("durability output directory replaced");
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) syncOutputs(file);
    else if (entry.isFile()) syncFile(file);
    else throw new Error("unsupported durability output entry");
  }
  syncDirectory(dir);
}
function saveBytes(file, bytes) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeOnce(file, value) {
  const data = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const temp = file + "." + crypto.randomUUID() + ".writing";
  try {
    saveBytes(temp, data);
    // link, unlike rename, atomically refuses an existing destination. This
    // publishes complete JSON without an exists/rename overwrite race.
    fs.linkSync(temp, file);
    fs.unlinkSync(temp);
    // File fsync alone does not commit a newly linked directory entry.
    // A sync error propagates before the worker may release its provider slot.
    syncDirectory(path.dirname(file));
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function regularBytes(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 48 * 1024 * 1024) throw new Error("job record must be a regular bounded file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const a = fs.fstatSync(fd);
    if (a.dev !== before.dev || a.ino !== before.ino || !a.isFile()) throw new Error("job record changed");
    const bytes = fs.readFileSync(fd), b = fs.fstatSync(fd);
    if (bytes.length !== a.size || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs) throw new Error("job record changed");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function readJson(file) {
  const value = JSON.parse(regularBytes(file).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid job record");
  return value;
}
function canonicalJob(jobPath) {
  const job = path.resolve(jobPath);
  if (!fs.lstatSync(job).isDirectory()) throw new Error("job must be a directory, not a link");
  return fs.realpathSync(job);
}
function fingerprint(file) {
  const bytes = regularBytes(file);
  return { bytes: bytes.length, sha256: digest(bytes) };
}
function matchesFingerprint(file, expected) {
  if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || !HASH.test(expected.sha256)) {
    throw new Error("invalid digest record");
  }
  const actual = fingerprint(file);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error("record digest mismatch");
}
function resolveArgs(argv) {
  // Admission is checked before reading any input or reserving any directory.
  const backendIndex = argv.indexOf("--backend");
  if (backendIndex < 0 || argv[backendIndex + 1] !== "fixture") throw new Error("durable jobs disabled by default; only explicit --backend fixture is available");
  const args = [...argv]; args.splice(backendIndex, 2);
  const jobOptions = { backend: "fixture", slotRoot: DEFAULT_SLOT_ROOT, slotWaitMs: 120000, fixtureDelayMs: 25 };
  for (const [flag, key] of [["--slot-root", "slotRoot"], ["--slot-wait-ms", "slotWaitMs"], ["--fixture-delay-ms", "fixtureDelayMs"]]) {
    const index = args.indexOf(flag);
    if (index >= 0) {
      if (args.indexOf(flag, index + 1) >= 0 || args[index + 1] === undefined) throw new Error("invalid durable option");
      jobOptions[key] = args[index + 1]; args.splice(index, 2);
    }
  }
  jobOptions.slotRoot = path.resolve(jobOptions.slotRoot);
  for (const key of ["slotWaitMs", "fixtureDelayMs"]) {
    if (!/^\d+$/.test(String(jobOptions[key]))) throw new Error("invalid fixture/slot duration");
    jobOptions[key] = Number(jobOptions[key]);
    if (!Number.isSafeInteger(jobOptions[key]) || jobOptions[key] > 120000) throw new Error("fixture/slot duration exceeds 120000 ms");
  }
  const parsed = parseArgs(args);
  if (parsed.concurrency !== null && parsed.concurrency !== 1) throw new Error("durable MMX concurrency must be 1");
  parsed.concurrency = 1;
  if (parsed.receiptFile !== null) throw new Error("job owns --receipt-file");
  const shards = collectShardFiles(parsed);
  if (!shards.length) throw new Error("job needs at least one shard");
  return { parsed, shards, jobOptions };
}
function makeBatchArgs(parsed, prompts, profileFile, receiptFile) {
  const args = prompts.flatMap(s => ["--prompt-file", s.file]);
  if (parsed.concurrency !== null) args.push("--concurrency", String(parsed.concurrency));
  args.push("--shard-max-bytes", String(parsed.shardMaxBytes));
  if (parsed.expectedCliVersion !== null) args.push("--expected-cli-version", parsed.expectedCliVersion);
  if (parsed.model !== null) args.push("--model", parsed.model);
  if (parsed.maxTokens !== null) args.push("--max-tokens", String(parsed.maxTokens));
  if (parsed.timeout !== null) args.push("--timeout", String(parsed.timeout));
  if (parsed.wrapTimeout !== null) args.push("--wrap-timeout", String(parsed.wrapTimeout));
  if (parsed.supervisorTimeout !== null) args.push("--supervisor-timeout-seconds", String(parsed.supervisorTimeout));
  if (parsed.batchTimeout !== null) args.push("--batch-timeout-seconds", String(parsed.batchTimeout));
  args.push("--profile-file", profileFile, "--receipt-file", receiptFile);
  return args;
}
function readRequest(job) {
  const recorded = readJson(path.join(job, "request-digest.json"));
  matchesFingerprint(path.join(job, "request.json"), recorded);
  const request = readJson(path.join(job, "request.json"));
  if (request.format !== FORMAT || request.backend !== "fixture" || !HASH.test(request.submission_sha256 || "") ||
      request.batch_script !== BATCH || request.fixture_script !== FIXTURE ||
      !path.isAbsolute(request.slot_root || "") || !Number.isSafeInteger(request.slot_wait_ms) ||
      request.slot_wait_ms < 0 || request.slot_wait_ms > 120000 ||
      !Number.isSafeInteger(request.fixture_delay_ms) || request.fixture_delay_ms < 0 || request.fixture_delay_ms > 120000 ||
      !Number.isSafeInteger(request.job_deadline_ms) || request.job_deadline_ms < 1000 || request.job_deadline_ms > 86420000 ||
      !Array.isArray(request.prompts) || request.prompts.length < 1 ||
      request.prompts.length > 32 || !request.profile || !Array.isArray(request.batch_args) ||
      request.batch_args.some(arg => typeof arg !== "string") || typeof request.batch_script !== "string" ||
      !path.isAbsolute(request.batch_script)) throw new Error("invalid request schema");
  const input = path.join(job, "input");
  if (!fs.lstatSync(input).isDirectory()) throw new Error("input directory must not be a link");
  const entries = [...request.prompts, request.profile];
  const names = request.prompts.map((_, i) => "shard-" + i + ".txt").concat("profile.json");
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].file !== path.join(input, names[i])) throw new Error("input role/path mismatch");
    matchesFingerprint(entries[i].file, entries[i]);
  }
  const parsed = parseArgs(request.batch_args);
  if (parsed.concurrency !== 1) throw new Error("durable concurrency changed");
  if (request.prompts.some(p => p.bytes > parsed.shardMaxBytes)) throw new Error("durable shard exceeds the bound limit");
  const canonical = makeBatchArgs(parsed, request.prompts, request.profile.file, path.join(job, "receipt.json"));
  if (JSON.stringify(canonical) !== JSON.stringify(request.batch_args)) throw new Error("arguments do not bind snapshots");
  readProfileBudget(request.profile.file);
  matchesFingerprint(request.batch_script, request.batch_script_digest);
  if (!Array.isArray(request.runtime) || request.runtime.length !== RUNTIME.length) throw new Error("runtime provenance missing");
  for (const [index, entry] of request.runtime.entries()) {
    if (entry.file !== RUNTIME[index]) throw new Error("runtime path changed");
    matchesFingerprint(entry.file, entry);
  }
  const material = submissionMaterial(parsed, request.prompts, request.profile,
    { slotRoot: request.slot_root, slotWaitMs: request.slot_wait_ms, fixtureDelayMs: request.fixture_delay_ms });
  if (digest(JSON.stringify(material)) !== request.submission_sha256) throw new Error("submission binding mismatch");
  return { request, requestDigest: recorded.sha256 };
}
function submissionMaterial(parsed, prompts, profile, options) {
  return { backend: "fixture", prompts: prompts.map(p => ({ bytes: p.bytes, sha256: p.sha256 })),
    profile: { bytes: profile.bytes, sha256: profile.sha256 },
    arguments: { concurrency: 1, model: parsed.model, maxTokens: parsed.maxTokens,
      timeout: parsed.timeout, wrapTimeout: parsed.wrapTimeout, shardMaxBytes: parsed.shardMaxBytes,
      expectedCliVersion: parsed.expectedCliVersion,
      supervisorTimeout: parsed.supervisorTimeout, batchTimeout: parsed.batchTimeout },
    slot_root: options.slotRoot, slot_wait_ms: options.slotWaitMs, fixture_delay_ms: options.fixtureDelayMs };
}
function fixtureEnv(job, request) {
  // No inherited NODE_OPTIONS, proxy settings, credentials, backend overrides,
  // provider endpoint, or CLI lookup path can reach this fixture worker.
  const env = { PATH: path.dirname(process.execPath), HOME: job, USERPROFILE: job,
    TMPDIR: job, TMP: job, TEMP: job, LANG: "C.UTF-8", CI: "true" };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC"])
    if (process.env[key]) env[key] = process.env[key];
  if (request) {
    // The batch honours a wrapper override only through the explicit offline
    // fixture contract: pinned script, declared root and exact digest.
    env.MMX_BATCH_WRAPPER = FIXTURE;
    env.ZMX_OFFLINE_FIXTURE = "1";
    env.ZMX_FIXTURE_ROOT = path.dirname(FIXTURE);
    env.ZMX_FIXTURE_SHA256 = fingerprint(FIXTURE).sha256;
    env.MMX_DURABLE_FIXTURE_DELAY_MS = String(request.fixture_delay_ms);
  }
  return env;
}
function start(jobPath, argv) {
  const { parsed, shards, jobOptions } = resolveArgs(argv);
  const promptInputs = shards.map(s => ({ bytes: s.bytes ?? regularBytes(fs.realpathSync(s.file)) }));
  const profileInput = regularBytes(fs.realpathSync(parsed.profileFile ?? path.join(__dirname, "..", "profiles", "local.json")));
  const profileData = JSON.parse(profileInput.toString("utf8"));
  if (profileData.format !== 1 || !Number.isSafeInteger(profileData.max_tokens) || profileData.max_tokens < 1) throw new Error("invalid profile");
  const req = parsed.timeout ?? profileData.request_timeout_seconds;
  const wrap = parsed.wrapTimeout ?? profileData.wrapper_timeout_seconds;
  const supervisor = parsed.supervisorTimeout ?? wrap + 20;
  if (![req, wrap, supervisor].every(n => Number.isSafeInteger(n) && n > 0) || wrap <= req || wrap > 3600 || supervisor > 86400) throw new Error("invalid deadlines");
  const batchSeconds = parsed.batchTimeout ?? Math.min(86400, shards.length * (supervisor + 8) + 5);
  const prompts = promptInputs.map(p => ({ bytes: p.bytes.length, sha256: digest(p.bytes) }));
  const profile = { bytes: profileInput.length, sha256: digest(profileInput) };
  const submissionDigest = digest(JSON.stringify(submissionMaterial(parsed, prompts, profile, jobOptions)));
  // A job path is itself an idempotency key. Existing incomplete/UNKNOWN
  // records are preserved. The deterministic submit command also derives this
  // path from a caller's explicit key, so a host timeout cannot generate a new ID.
  try {
    fs.mkdirSync(path.resolve(jobPath), { mode: 0o700 });
    syncDirectory(path.dirname(path.resolve(jobPath)));
  }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let prior;
    try { prior = readRequest(canonicalJob(jobPath)).request; }
    catch { return { ...status(jobPath), reused: true, automatic_replay: false }; }
    if (prior.submission_sha256 !== submissionDigest) throw new Error("idempotency conflict: key already binds different material or options");
    return { ...status(jobPath), reused: true, automatic_replay: false };
  }
  const job = canonicalJob(jobPath);
  fs.mkdirSync(path.join(job, "input"), { mode: 0o700 });
  syncDirectory(job);
  for (const [i, p] of prompts.entries()) {
    p.file = path.join(job, "input", "shard-" + i + ".txt");
    saveBytes(p.file, promptInputs[i].bytes);
  }
  profile.file = path.join(job, "input", "profile.json");
  saveBytes(profile.file, profileInput);
  syncDirectory(path.join(job, "input"));
  const request = { format: FORMAT, created_at: new Date().toISOString(), backend: "fixture", prompts, profile,
    admission: ADMISSION, submission_sha256: submissionDigest, retry_policy: "none", automatic_replay: false,
    slot_root: jobOptions.slotRoot, slot_wait_ms: jobOptions.slotWaitMs, fixture_delay_ms: jobOptions.fixtureDelayMs,
    job_deadline_ms: (batchSeconds + 20) * 1000, fixture_script: FIXTURE,
    runtime: RUNTIME.map(file => ({ file, ...fingerprint(file) })),
    batch_script: BATCH, batch_script_digest: fingerprint(BATCH),
    batch_args: makeBatchArgs(parsed, prompts, profile.file, path.join(job, "receipt.json")) };
  writeOnce(path.join(job, "request.json"), request);
  writeOnce(path.join(job, "request-digest.json"), fingerprint(path.join(job, "request.json")));
  readRequest(job);
  const log = fs.openSync(path.join(job, "supervisor.log"), "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [__filename, "worker", job], {
      cwd: job, detached: true, shell: false, windowsHide: true, stdio: ["ignore", log, log], env: fixtureEnv(job),
    });
    child.on("error", error => {
      try { writeOnce(path.join(job, "launch-error.json"), { code: error.code || "error" }); } catch {}
    });
    child.unref();
    writeOnce(path.join(job, "launch.json"), { supervisor_pid: child.pid ?? null, started_at: new Date().toISOString() });
  } finally { fs.closeSync(log); }
  return { status: child.pid ? "started" : "unknown", job_dir: job, backend: "fixture", admission: ADMISSION,
    submission_sha256: submissionDigest, reused: false, automatic_replay: false,
    supervisor_pid: child.pid ?? null, prompt_count: prompts.length };
}
function submit(rootPath, key, argv) {
  // Check admission before creating the root, and never generate random keys.
  resolveArgs(argv);
  if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new Error("explicit idempotency key required");
  const firstCreated = fs.mkdirSync(path.resolve(rootPath), { recursive: true, mode: 0o700 });
  const root = canonicalJob(rootPath);
  syncCreatedPath(root, firstCreated);
  return { ...start(path.join(root, "job-" + digest(key)), argv), idempotency_key_sha256: digest(key) };
}
function readExecution(job, requestDigest, request) {
  const confirmed = readJson(path.join(job, "completion-confirmed.json"));
  if (confirmed.request_sha256 !== requestDigest || confirmed.prior_completion_synced !== (process.platform !== "win32"))
    throw new Error("completion publication not confirmed for this platform");
  matchesFingerprint(path.join(job, "completion.json"), confirmed.completion);
  const completion = readJson(path.join(job, "completion.json"));
  matchesFingerprint(path.join(job, "execution.json"), completion.execution);
  matchesFingerprint(path.join(job, "started.json"), completion.started);
  const execution = readJson(path.join(job, "execution.json"));
  if (execution.format !== FORMAT || execution.request_sha256 !== requestDigest ||
      !Number.isSafeInteger(execution.started_ms) || !Number.isSafeInteger(execution.ended_ms) ||
      execution.ended_ms < execution.started_ms ||
      !["child_exit", "cancelled", "spawn_error", "slot_busy", "supervisor_timeout"].includes(execution.reason) ||
      typeof execution.batch_started !== "boolean" || typeof execution.batch_exit_observed !== "boolean" ||
      ![true, false, null].includes(execution.termination_confirmed) ||
      ![true, false, null].includes(execution.batch_group_gone) ||
      !(execution.exit_code === null || Number.isInteger(execution.exit_code)) ||
      !(execution.signal === null || typeof execution.signal === "string") ||
      typeof execution.slot_acquired !== "boolean" || execution.slot_released !== false ||
      typeof execution.slot_release_eligible !== "boolean" ||
      typeof execution.receipt_exists !== "boolean" || !execution.outputs) throw new Error("execution schema");
  const started = readJson(path.join(job, "started.json"));
  if (started.started_ms !== execution.started_ms || started.batch_started !== execution.batch_started) throw new Error("execution start mismatch");
  if (!execution.batch_started && (execution.exit_code !== null || execution.signal !== null ||
      !["cancelled", "slot_busy"].includes(execution.reason) || execution.batch_exit_observed ||
      execution.termination_confirmed !== true)) throw new Error("unstarted execution");
  if (execution.batch_started && !["cancelled", "supervisor_timeout"].includes(execution.reason) && !execution.batch_exit_observed) throw new Error("unobserved exit");
  if (execution.batch_started && execution.termination_confirmed === true) throw new Error("unproven descendant termination");
  for (const name of ["stdout.json", "stderr.log"]) matchesFingerprint(path.join(job, name), execution.outputs[name]);
  if (execution.receipt_exists) {
    matchesFingerprint(path.join(job, "receipt.json"), execution.outputs["receipt.json"]);
    const receipt = readJson(path.join(job, "receipt.json"));
    if (!Array.isArray(receipt.shards) || receipt.shards.length !== request.prompts.length) throw new Error("receipt shard count mismatch");
    for (const [i, shard] of receipt.shards.entries()) {
      if (shard.material_sha256 !== request.prompts[i].sha256 ||
          (shard.status === "ok" && shard.batch_config_sha256 !== request.profile.sha256)) throw new Error("receipt material version mismatch");
    }
  } else if (fs.existsSync(path.join(job, "receipt.json")) || execution.outputs["receipt.json"] !== null) throw new Error("unexpected receipt");
  const releasedPath = path.join(job, "slot-release.json");
  if (fs.existsSync(releasedPath)) {
    const released = readJson(releasedPath);
    matchesFingerprint(path.join(job, "completion.json"), released.completion);
    if (!execution.slot_acquired || !execution.slot_release_eligible || released.request_sha256 !== requestDigest || released.released !== true)
      throw new Error("invalid slot release evidence");
    execution.slot_released = true;
  }
  return execution;
}
function status(jobPath) {
  let job = path.resolve(jobPath);
  try {
    job = canonicalJob(job);
    const { request, requestDigest } = readRequest(job);
    const launchPath = path.join(job, "launch.json");
    const result = { status: "unknown", job_dir: job, backend: "fixture", admission: ADMISSION,
      submission_sha256: request.submission_sha256, automatic_replay: false, prompt_count: request.prompts.length,
      supervisor_pid: fs.existsSync(launchPath) ? readJson(launchPath).supervisor_pid : null };
    if (fs.existsSync(path.join(job, "completion-confirmed.json"))) {
      result.execution = readExecution(job, requestDigest, request);
      if (!result.execution.batch_started || result.execution.batch_exit_observed) result.status = "finished";
      if (result.execution.receipt_exists) result.receipt = readJson(path.join(job, "receipt.json"));
    }
    if (result.status === "unknown") result.note = "No verified batch exit: may still be running. Never resubmit automatically.";
    return result;
  } catch {
    return { status: "unknown", job_dir: job, automatic_replay: false, note: "Job records missing, changed or unreadable. Never resubmit automatically." };
  }
}
function verify(jobPath) {
  let job = path.resolve(jobPath);
  try {
    job = canonicalJob(job);
    const { request, requestDigest } = readRequest(job);
    if (!fs.existsSync(path.join(job, "completion.json")) || !fs.existsSync(path.join(job, "completion-confirmed.json")))
      return { integrity: "incomplete", job_dir: job };
    const execution = readExecution(job, requestDigest, request);
    if (execution.batch_started && !execution.batch_exit_observed) return { integrity: "incomplete", job_dir: job };
    return { integrity: "match", job_dir: job, state: execution.reason,
      termination_confirmed: execution.termination_confirmed,
      note: "Local record consistency only; detached descendants and provider completion are not independently proven." };
  } catch {
    return { integrity: "corrupt", job_dir: job };
  }
}
function cancel(jobPath) {
  let job;
  try { job = canonicalJob(jobPath); }
  catch { return { status: "unknown", job_dir: path.resolve(jobPath) }; }
  if (status(job).status === "finished") return { status: "finished", job_dir: job };
  if (!fs.existsSync(path.join(job, "request.json"))) return { status: "unknown", job_dir: job };
  try { fs.writeFileSync(path.join(job, "cancel.request"), "cancel\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return { status: "cancel_requested", job_dir: job,
    note: "Cancellation is advisory until the batch exit is observed; detached descendants may remain uncertain." };
}
function groupGone(child) {
  if (!child || !child.pid || process.platform === "win32") return null;
  try { process.kill(-child.pid, 0); return false; }
  catch (error) { return error.code === "ESRCH" ? true : null; }
}
function signalBatch(child, force) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    try { spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, shell: false, timeout: 2000, stdio: "ignore" }); } catch {}
    return;
  }
  // First let mmx-batch ask wrappers to clean their own detached CLI groups.
  // Escalate the owned batch group only if that cooperative path does not close.
  if (force) {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch {}
  }
  try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
}
async function stopBatch(child, closed) {
  if (!child) return;
  signalBatch(child, false);
  const deadline = Date.now() + CANCEL_GRACE_MS;
  while (Date.now() < deadline && (!closed() || groupGone(child) === false)) await pause(25);
  if (!closed() || groupGone(child) === false) {
    signalBatch(child, true);
    const killDeadline = Date.now() + CANCEL_KILL_WAIT_MS;
    while (!closed() && Date.now() < killDeadline) await pause(25);
  }
  if (!closed()) child.unref();
}
async function waitForJob(jobPath, waitMs = 1000) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw new Error("wait must be 0..60000 ms");
  const started = performance.now();
  while (true) {
    const current = status(jobPath);
    if (current.status === "finished") return { ...current, host_wait_timed_out: false };
    if (performance.now() - started >= waitMs) return { ...current, host_wait_timed_out: true,
      wait_policy: "query_only_no_cancel_no_resubmit" };
    await pause(Math.min(100, Math.max(1, waitMs - (performance.now() - started))));
  }
}
async function worker(jobPath) {
  const job = canonicalJob(jobPath);
  // Keep the claim permanently, including after a crash. Calling worker twice
  // must never become an alternate paid-work replay path.
  fs.mkdirSync(path.join(job, "worker.lock"), { mode: 0o700 });
  syncDirectory(path.join(job, "worker.lock"));
  syncDirectory(job);
  for (const name of ["started.json", "stdout.json", "stderr.log", "execution.json", "completion.json", "completion-confirmed.json", "receipt.json"]) {
    if (fs.existsSync(path.join(job, name))) throw new Error("existing execution evidence; do not replay");
  }
  const { request, requestDigest } = readRequest(job);
  const started_ms = Date.now();
  const out = fs.openSync(path.join(job, "stdout.json"), "wx", 0o600);
  let err;
  try { err = fs.openSync(path.join(job, "stderr.log"), "wx", 0o600); }
  catch (error) { fs.closeSync(out); throw error; }
  let child = null, reason = "child_exit", closed = null, spawnError = null, exited;
  let slot = null, slotReleaseEligible = false, slotError = null;
  const slotAbort = new AbortController();
  let requested = fs.existsSync(path.join(job, "cancel.request"));
  let notifyCancel;
  const cancellation = new Promise(resolve => { notifyCancel = resolve; });
  const requestCancel = () => { requested = true; reason = "cancelled"; slotAbort.abort(); notifyCancel(); };
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, requestCancel);
  const ignoreHup = () => {}; process.on("SIGHUP", ignoreHup);
  let polling, deadline;
  polling = setInterval(() => {
    if (fs.existsSync(path.join(job, "cancel.request"))) requestCancel();
  }, 100);
  try {
    if (!requested) {
      try { slot = await acquireMmxSlot({ root: request.slot_root, waitMs: request.slot_wait_ms, signal: slotAbort.signal }); }
      catch (error) { slotError = error.code || "MMX_SLOT_IO"; reason = requested ? "cancelled" : "slot_busy"; }
    }

    // Cancellation published before launch is a terminal no-op, with no new
    // batch or provider process even briefly created.
    if (requested) reason = "cancelled";
    else if (slot) {
      // Recheck snapshots and implementation after a queued slot wait.
      readRequest(job);
      if (fs.existsSync(path.join(job, "cancel.request"))) requestCancel();
      if (!requested) child = spawn(process.execPath, [request.batch_script, ...request.batch_args], {
        cwd: job, shell: false, detached: process.platform !== "win32",
        windowsHide: true, stdio: ["ignore", out, err], env: fixtureEnv(job, request),
      });
      if (child) {
        child.once("error", error => { spawnError = error.code || "error"; });
        exited = new Promise(resolve => {
          child.once("close", (code, signal) => { closed = { code, signal }; resolve(); });
        });
      }
    }
  } catch (error) {
    clearInterval(polling);
    for (const signal of ["SIGTERM", "SIGINT"]) process.removeListener(signal, requestCancel);
    process.removeListener("SIGHUP", ignoreHup);
    // Nothing was spawned: an owned slot may be released. A failed release is
    // retained rather than reclaimed. The permanent worker claim stays intact.
    if (slot && !child) { try { slot.release(); } catch {} }
    throw error;
  } finally { fs.closeSync(out); fs.closeSync(err); }
  try {
    writeOnce(path.join(job, "started.json"), { supervisor_pid: process.pid,
      batch_pid: child?.pid ?? null, started_ms, batch_started: child !== null });
    if (child) {
      if (fs.existsSync(path.join(job, "cancel.request"))) requestCancel();
      const timedOut = new Promise(resolve => { deadline = setTimeout(() => {
        requested = true; reason = "supervisor_timeout"; resolve();
      }, request.job_deadline_ms); });
      await Promise.race([exited, cancellation, timedOut]);
      if (requested) {
        if (reason !== "supervisor_timeout") reason = "cancelled";
        await stopBatch(child, () => closed !== null);
      } else if (spawnError) reason = "spawn_error";
    }
  } catch (error) {
    // A record-write failure after spawn must still initiate cleanup; there is
    // no verified terminal record and callers must treat the job as unknown.
    await stopBatch(child, () => closed !== null);
    throw error;
  } finally {
    clearInterval(polling); clearTimeout(deadline);
    for (const signal of ["SIGTERM", "SIGINT"]) process.removeListener(signal, requestCancel);
    process.removeListener("SIGHUP", ignoreHup);
  }
  const receipt_exists = fs.existsSync(path.join(job, "receipt.json"));
  // The batch has closed its files. Commit both output bytes and their directory
  // entries (including per-shard archives) before publishing completion.
  for (const name of ["stdout.json", "stderr.log", ...(receipt_exists ? ["receipt.json"] : [])]) syncFile(path.join(job, name));
  const shardArchive = path.join(job, "receipt.json.shards");
  if (fs.existsSync(shardArchive)) syncOutputs(shardArchive);
  syncDirectory(job);
  const outputs = { "stdout.json": fingerprint(path.join(job, "stdout.json")),
    "stderr.log": fingerprint(path.join(job, "stderr.log")),
    "receipt.json": receipt_exists ? fingerprint(path.join(job, "receipt.json")) : null };
  // Release only after this worker observed a clean, bound fixture completion.
  // A crash, uncertain cancellation or failed publication keeps the slot held.
  // No status/resume path can release or reclaim it from a PID check.
  if (slot && !child) slotReleaseEligible = true;
  if (slot && child && closed?.code === 0 && closed.signal === null && groupGone(child) === true && receipt_exists) {
    const receipt = readJson(path.join(job, "receipt.json"));
    if (receipt.gate === "PASS" && receipt.batch?.retried === 0 &&
        receipt.shards?.length === request.prompts.length && receipt.shards.every((s, i) =>
          s.material_sha256 === request.prompts[i].sha256 && s.batch_config_sha256 === request.profile.sha256 &&
          s.transport_validation === "PASS" && s.wrapper_exit_observed === true)) {
      slotReleaseEligible = true;
    }
  }
  writeOnce(path.join(job, "execution.json"), {
    format: FORMAT, request_sha256: requestDigest, started_ms, ended_ms: Date.now(), reason,
    slot_acquired: slot !== null, slot_released: false, slot_release_eligible: slotReleaseEligible, slot_error: slotError,
    batch_started: child !== null, batch_exit_observed: closed !== null,
    exit_code: closed?.code ?? null, signal: closed?.signal ?? null, receipt_exists, outputs,
    // Exiting the batch/group cannot prove that a detached provider descendant
    // stopped. Report this uncertainty instead of treating signal delivery as proof.
    termination_confirmed: child ? (requested ? false : null) : true,
    batch_group_gone: groupGone(child), ...(spawnError ? { spawn_error: spawnError } : {}),
  });
  // Publish completion only after all evidence records are closed and hashed.
  writeOnce(path.join(job, "completion.json"), {
    execution: fingerprint(path.join(job, "execution.json")),
    started: fingerprint(path.join(job, "started.json")),
  });
  // This confirmation is created only after completion's directory sync has
  // succeeded. A visible but unsuccessfully synced completion stays UNKNOWN.
  writeOnce(path.join(job, "completion-confirmed.json"), { request_sha256: requestDigest,
    completion: fingerprint(path.join(job, "completion.json")), prior_completion_synced: process.platform !== "win32" });
  if (slot && slotReleaseEligible) {
    // Completion publication precedes release. If either publication or the
    // worker crashes first, the occupied slot is retained for inspection.
    readRequest(job);
    readExecution(job, requestDigest, request);
    slot.release();
    writeOnce(path.join(job, "slot-release.json"), { request_sha256: requestDigest,
      completion: fingerprint(path.join(job, "completion.json")), released: true });
  }
}
async function cli(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { admission: ADMISSION, usage: [
    "mmx-job.js submit ROOT KEY --backend fixture --prompt-file FILE [--slot-root DIR]",
    "mmx-job.js start NEW_DIR --backend fixture --prompt-file FILE",
    "mmx-job.js status|resume|verify|cancel JOB_DIR", "mmx-job.js wait JOB_DIR --wait-ms 0..60000" ] };
  const [action, job, ...args] = argv;
  if (!job || !["submit", "start", "status", "resume", "wait", "cancel", "verify", "worker"].includes(action)) throw new Error("usage");
  if (action === "submit") {
    const [key, ...options] = args; return submit(job, key, options);
  }
  if (action === "wait") {
    if (args.length !== 2 || args[0] !== "--wait-ms" || !/^\d+$/.test(args[1])) throw new Error("usage");
    return waitForJob(job, Number(args[1]));
  }
  if (action !== "start" && args.length) throw new Error("usage");
  if (action === "worker") { await worker(job); return; }
  if (action === "start") return start(job, args);
  if (action === "status") return status(job);
  if (action === "resume") return { ...status(job), resume_policy: "inspect_only_no_automatic_replay" };
  if (action === "cancel") return cancel(job);
  const result = verify(job);
  if (result.integrity !== "match") process.exitCode = EXIT_UNKNOWN;
  return result;
}
if (require.main === module) {
  cli(process.argv.slice(2)).then(value => {
    if (value) process.stdout.write(JSON.stringify(value) + "\n");
  }).catch(error => {
    process.stdout.write(JSON.stringify({ status: "supervisor_error", admission: ADMISSION,
      error: /idempotency conflict/.test(error.message) ? "idempotency_conflict" : "operation_refused",
      note: "Could not perform operation; inspect the existing job and do not automatically resubmit." }) + "\n");
    process.exitCode = EXIT_UNKNOWN;
  });
}
module.exports = { start, submit, status, waitForJob, cancel, verify, resolveArgs, ADMISSION };
