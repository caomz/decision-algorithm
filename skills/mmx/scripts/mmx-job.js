#!/usr/bin/env node
"use strict";

// Durable MMX batch supervisor. Exclusive job and worker claims, immutable
// input snapshots, and inspection-only recovery: an ambiguous job is not replayed.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { parseArgs, collectShardFiles, readProfileBudget } = require("./mmx-batch.js");

const BATCH = path.join(__dirname, "mmx-batch.js");
const EXIT_UNKNOWN = 2;
const FORMAT = 2;
const CANCEL_GRACE_MS = 5000;
const CANCEL_KILL_WAIT_MS = 2000;
const HASH = /^[a-f0-9]{64}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function writeOnce(file, value) {
  const data = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const temp = file + "." + crypto.randomUUID() + ".writing";
  try {
    fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    // link, unlike rename, atomically refuses an existing destination. This
    // publishes complete JSON without an exists/rename overwrite race.
    fs.linkSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function regularBytes(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error("job record must be a regular file");
  return fs.readFileSync(file);
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
// Pin the actual local runtime used by the detached job. Do not record keys,
// model credentials, proxy addresses, or arbitrary environment contents.
function cliLauncher() {
  const names = process.platform === "win32" ? ["mmx.cmd", "mmx.exe", "mmx"] : ["mmx"];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        const file = fs.realpathSync(path.resolve(dir, name));
        if (!fs.statSync(file).isFile()) continue;
        return file;
      } catch {}
    }
  }
  return null;
}
function cliPackage(file) {
  let dir = path.dirname(file);
  for (let i=0;i<12;i++) {
    const pkg = path.join(dir, "package.json");
    try {
      const meta = JSON.parse(fs.readFileSync(pkg,"utf8"));
      if (meta.name === "mmx-cli" && typeof meta.version === "string") {
        return { file: pkg, version: meta.version, ...fingerprint(pkg) };
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function runtimeBinding() {
  const components = [
    path.join(__dirname, "mmx-chat.js"),
    path.join(__dirname, "fetch-timeout-guard.js"),
    path.join(__dirname, "mmx-provider-slot.js"),
    __filename,
  ];
  const files = components.map(file=>({file:fs.realpathSync(file),...fingerprint(file)}));
  const cli = cliLauncher();
  return {
    format:1,
    node_version:process.version,
    node_executable:fs.realpathSync(process.execPath),
    files,
    cli:cli?{file:cli,...fingerprint(cli),package:cliPackage(cli)}:null,
  };
}

function snapshot(job, input, target) {
  const bytes = regularBytes(fs.realpathSync(input));
  const dst = path.join(job, "input", target);
  fs.writeFileSync(dst, bytes, { flag: "wx", mode: 0o600 });
  return { file: dst, sha256: digest(bytes), bytes: bytes.length };
}
function resolveArgs(argv) {
  const parsed = parseArgs(argv);
  if (parsed.receiptFile !== null) throw new Error("job owns --receipt-file");
  const shards = collectShardFiles(parsed);
  if (!shards.length) throw new Error("job needs at least one shard");
  return { parsed, shards };
}
function makeBatchArgs(parsed, prompts, profileFile, receiptFile) {
  const args = prompts.flatMap(s => ["--prompt-file", s.file]);
  if (parsed.concurrency !== null) args.push("--concurrency", String(parsed.concurrency));
  if (parsed.model !== null) args.push("--model", parsed.model);
  if (parsed.maxTokens !== null) args.push("--max-tokens", String(parsed.maxTokens));
  if (parsed.timeout !== null) args.push("--timeout", String(parsed.timeout));
  if (parsed.wrapTimeout !== null) args.push("--wrap-timeout", String(parsed.wrapTimeout));
  if (parsed.allowPaidRetry === true) args.push("--allow-paid-retry");
  args.push("--profile-file", profileFile, "--receipt-file", receiptFile);
  return args;
}
function readRequest(job) {
  const recorded = readJson(path.join(job, "request-digest.json"));
  matchesFingerprint(path.join(job, "request.json"), recorded);
  const request = readJson(path.join(job, "request.json"));
  if (request.format !== FORMAT || !Array.isArray(request.prompts) || request.prompts.length < 1 ||
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
  const canonical = makeBatchArgs(parsed, request.prompts, request.profile.file, path.join(job, "receipt.json"));
  if (JSON.stringify(canonical) !== JSON.stringify(request.batch_args)) throw new Error("arguments do not bind snapshots");
  readProfileBudget(request.profile.file);
  matchesFingerprint(request.batch_script, request.batch_script_digest);
  // An old request without the runtime contract can still be inspected, but
  // must never be promoted to a new executable request by the worker.
  if (!request.runtime || request.runtime.format !== 1 ||
      JSON.stringify(request.runtime) !== JSON.stringify(runtimeBinding())) {
    throw new Error("Node, wrapper, guard or CLI runtime changed; do not launch");
  }
  // A missing CLI is a recorded runtime state, not a license to execute a
  // different launcher later. readRequest's exact runtime identity check blocks
  // PATH drift, while the actual wrapper rejects cli_missing before billing.
  return { request, requestDigest: recorded.sha256 };
}
function start(jobPath, argv, overrides = {}) {
  const { parsed, shards } = resolveArgs(argv);
  // mkdir without recursive is the idempotency gate. Preserve partial jobs:
  // their absence of a receipt is never permission to launch again.
  fs.mkdirSync(path.resolve(jobPath), { mode: 0o700 });
  const job = canonicalJob(jobPath);
  fs.mkdirSync(path.join(job, "input"), { mode: 0o700 });
  const prompts = shards.map((s, i) => snapshot(job, s.file, "shard-" + i + ".txt"));
  const profile = snapshot(job, parsed.profileFile ?? path.join(__dirname, "..", "profiles", "local.json"), "profile.json");
  readProfileBudget(profile.file);
  const batchScript = fs.realpathSync(overrides.batchPath ?? BATCH);
  const request = { format: FORMAT, created_at: new Date().toISOString(), prompts, profile,
    batch_script: batchScript, batch_script_digest: fingerprint(batchScript),
    runtime: runtimeBinding(),
    batch_args: makeBatchArgs(parsed, prompts, profile.file, path.join(job, "receipt.json")) };
  writeOnce(path.join(job, "request.json"), request);
  writeOnce(path.join(job, "request-digest.json"), fingerprint(path.join(job, "request.json")));
  readRequest(job);
  const log = fs.openSync(path.join(job, "supervisor.log"), "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [__filename, "worker", job], {
      cwd: job, detached: true, shell: false, windowsHide: true, stdio: ["ignore", log, log],
    });
    child.on("error", error => {
      try { writeOnce(path.join(job, "launch-error.json"), { code: error.code || "error" }); } catch {}
    });
    writeOnce(path.join(job, "launch.json"), { supervisor_pid: child.pid ?? null, started_at: new Date().toISOString() });
    child.unref();
  } finally { fs.closeSync(log); }
  return { status: child.pid ? "started" : "unknown", job_dir: job,
    supervisor_pid: child.pid ?? null, prompt_count: prompts.length };
}
function readExecution(job, requestDigest) {
  const completion = readJson(path.join(job, "completion.json"));
  matchesFingerprint(path.join(job, "execution.json"), completion.execution);
  matchesFingerprint(path.join(job, "started.json"), completion.started);
  const execution = readJson(path.join(job, "execution.json"));
  if (execution.format !== FORMAT || execution.request_sha256 !== requestDigest ||
      !Number.isSafeInteger(execution.started_ms) || !Number.isSafeInteger(execution.ended_ms) ||
      execution.ended_ms < execution.started_ms ||
      !["child_exit", "cancelled", "spawn_error"].includes(execution.reason) ||
      typeof execution.batch_started !== "boolean" || typeof execution.batch_exit_observed !== "boolean" ||
      ![true, false, null].includes(execution.termination_confirmed) ||
      ![true, false, null].includes(execution.batch_group_gone) ||
      !(execution.exit_code === null || Number.isInteger(execution.exit_code)) ||
      !(execution.signal === null || typeof execution.signal === "string") ||
      typeof execution.receipt_exists !== "boolean" || !execution.outputs) throw new Error("execution schema");
  const started = readJson(path.join(job, "started.json"));
  if (started.started_ms !== execution.started_ms || started.batch_started !== execution.batch_started) throw new Error("execution start mismatch");
  if (!execution.batch_started && (execution.exit_code !== null || execution.signal !== null ||
      execution.reason !== "cancelled" || execution.batch_exit_observed ||
      execution.termination_confirmed !== true)) throw new Error("unstarted execution");
  if (execution.reason !== "cancelled" && !execution.batch_exit_observed) throw new Error("unobserved exit");
  if (execution.batch_started && execution.termination_confirmed === true) throw new Error("unproven descendant termination");
  for (const name of ["stdout.json", "stderr.log"]) matchesFingerprint(path.join(job, name), execution.outputs[name]);
  if (execution.receipt_exists) {
    matchesFingerprint(path.join(job, "receipt.json"), execution.outputs["receipt.json"]);
    readJson(path.join(job, "receipt.json"));
  } else if (fs.existsSync(path.join(job, "receipt.json")) || execution.outputs["receipt.json"] !== null) throw new Error("unexpected receipt");
  return execution;
}
function status(jobPath) {
  let job = path.resolve(jobPath);
  try {
    job = canonicalJob(job);
    const { request, requestDigest } = readRequest(job);
    const launchPath = path.join(job, "launch.json");
    const result = { status: "unknown", job_dir: job, prompt_count: request.prompts.length,
      supervisor_pid: fs.existsSync(launchPath) ? readJson(launchPath).supervisor_pid : null };
    if (fs.existsSync(path.join(job, "completion.json"))) {
      result.execution = readExecution(job, requestDigest);
      if (!result.execution.batch_started || result.execution.batch_exit_observed) result.status = "finished";
      if (result.execution.receipt_exists) result.receipt = readJson(path.join(job, "receipt.json"));
    }
    if (result.status === "unknown") result.note = "No verified batch exit: may still be running. Never resubmit automatically.";
    return result;
  } catch {
    return { status: "unknown", job_dir: job, note: "Job records missing, changed or unreadable. Never resubmit automatically." };
  }
}
function verify(jobPath) {
  let job = path.resolve(jobPath);
  try {
    job = canonicalJob(job);
    const { requestDigest } = readRequest(job);
    if (!fs.existsSync(path.join(job, "completion.json"))) return { integrity: "incomplete", job_dir: job };
    const execution = readExecution(job, requestDigest);
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
async function worker(jobPath) {
  const job = canonicalJob(jobPath);
  // Keep the claim permanently, including after a crash. Calling worker twice
  // must never become an alternate paid-work replay path.
  fs.mkdirSync(path.join(job, "worker.lock"), { mode: 0o700 });
  for (const name of ["started.json", "stdout.json", "stderr.log", "execution.json", "completion.json", "receipt.json"]) {
    if (fs.existsSync(path.join(job, name))) throw new Error("existing execution evidence; do not replay");
  }
  const { request, requestDigest } = readRequest(job);
  const started_ms = Date.now();
  const out = fs.openSync(path.join(job, "stdout.json"), "wx", 0o600);
  let err;
  try { err = fs.openSync(path.join(job, "stderr.log"), "wx", 0o600); }
  catch (error) { fs.closeSync(out); throw error; }
  let child = null, reason = "child_exit", closed = null, spawnError = null, exited;
  let requested = fs.existsSync(path.join(job, "cancel.request"));
  let notifyCancel;
  const cancellation = new Promise(resolve => { notifyCancel = resolve; });
  const requestCancel = () => { requested = true; reason = "cancelled"; notifyCancel(); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, requestCancel);
  let polling;
  try {
    // Cancellation published before launch is a terminal no-op, with no new
    // batch or provider process even briefly created.
    if (requested) reason = "cancelled";
    else {
      child = spawn(process.execPath, [request.batch_script, ...request.batch_args], {
        cwd: job, shell: false, detached: process.platform !== "win32",
        windowsHide: true, stdio: ["ignore", out, err],
      });
      child.once("error", error => { spawnError = error.code || "error"; });
      exited = new Promise(resolve => {
        child.once("close", (code, signal) => { closed = { code, signal }; resolve(); });
      });
    }
  } finally { fs.closeSync(out); fs.closeSync(err); }
  try {
    writeOnce(path.join(job, "started.json"), { supervisor_pid: process.pid,
      batch_pid: child?.pid ?? null, started_ms, batch_started: child !== null });
    if (child) {
      polling = setInterval(() => {
        if (fs.existsSync(path.join(job, "cancel.request"))) requestCancel();
      }, 100);
      if (fs.existsSync(path.join(job, "cancel.request"))) requestCancel();
      await Promise.race([exited, cancellation]);
      if (requested) {
        reason = "cancelled";
        await stopBatch(child, () => closed !== null);
      } else if (spawnError) reason = "spawn_error";
    }
  } catch (error) {
    // A record-write failure after spawn must still initiate cleanup; there is
    // no verified terminal record and callers must treat the job as unknown.
    await stopBatch(child, () => closed !== null);
    throw error;
  } finally {
    clearInterval(polling);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeListener(signal, requestCancel);
  }
  const receipt_exists = fs.existsSync(path.join(job, "receipt.json"));
  const outputs = { "stdout.json": fingerprint(path.join(job, "stdout.json")),
    "stderr.log": fingerprint(path.join(job, "stderr.log")),
    "receipt.json": receipt_exists ? fingerprint(path.join(job, "receipt.json")) : null };
  writeOnce(path.join(job, "execution.json"), {
    format: FORMAT, request_sha256: requestDigest, started_ms, ended_ms: Date.now(), reason,
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
}
async function cli(argv) {
  const [action, job, ...args] = argv;
  if (!job || !["start", "status", "resume", "cancel", "verify", "worker"].includes(action) ||
      (action !== "start" && args.length)) throw new Error("usage");
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
  }).catch(() => {
    process.stdout.write(JSON.stringify({ status: "supervisor_error",
      note: "Could not perform operation; inspect the existing job and do not automatically resubmit." }) + "\n");
    process.exitCode = EXIT_UNKNOWN;
  });
}
module.exports = { start, status, cancel, verify, resolveArgs, runtimeBinding };
