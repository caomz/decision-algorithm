#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { strictJson } = require("./review.js");
const { parseArgs, checkInstall } = require("./zcode-chat.js");
const WRAPPER = path.join(__dirname, "zcode-chat.js");

function save(file, value) {
  // Atomic no-overwrite publication: fs.renameSync can replace prior evidence.
  // Local NTFS (Windows) and POSIX job stores support hard-link publication.
  const temp = file + "." + randomUUID() + ".writing";
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.linkSync(temp, file);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("existing job state; never overwrite prior evidence");
    if (["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"].includes(error.code)) {
      throw Object.assign(new Error("Atomic Job publication unavailable; use writable local NTFS storage."),
        { code: "ZCODE_JOB_PUBLICATION_UNAVAILABLE", cause: error });
    }
    throw error;
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function read(file) { return strictJson(fs.readFileSync(file, "utf8")); }
const SHA256 = /^[0-9a-f]{64}$/;
function rawFingerprint(value) {
  // Job material is hashed byte for byte; NEVER normalize CRLF like the
  // installation manifest, which has completely different semantics.
  const bytes = Buffer.isBuffer(value) ? value : fs.readFileSync(value);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function checkedBytes(file, expected) {
  if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 ||
      typeof expected.sha256 !== "string" || !SHA256.test(expected.sha256)) throw new Error("invalid raw fingerprint");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input or record is not a regular file");
  const bytes = fs.readFileSync(file);
  if (bytes.length !== expected.bytes || rawFingerprint(bytes).sha256 !== expected.sha256) throw new Error("raw bytes mismatch");
  return bytes;
}
function readPinnedRequest(job, { requireRuntime = true } = {}) {
  const recorded = read(path.join(job, "request-digest.json"));
  checkedBytes(path.join(job, "request.json"), recorded);
  const request = read(path.join(job, "request.json"));
  if (request.format !== 2 || !path.isAbsolute(request.wrapper) ||
      !Array.isArray(request.args) || request.args.some(v => typeof v !== "string") ||
      !Array.isArray(request.inputs) || request.inputs.length < 1 || request.inputs.length > 2) {
    throw new Error("invalid request schema");
  }
  if (!fs.lstatSync(path.join(job, "inputs")).isDirectory()) throw new Error("job inputs must be an actual directory");
  const options = parseArgs(request.args);
  if (options.output !== path.join(job, "run")) throw new Error("job output role mismatch");
  const seen = new Set();
  for (const input of request.inputs) {
    const role = input.name === "prompt.txt" ? "--prompt-file" :
      input.name === "evidence-ids.json" ? "--evidence-ids-file" : null;
    if (!role || seen.has(role) || !Number.isInteger(input.index) || input.index < 1 ||
        input.file !== path.join(job, "inputs", input.name) ||
        request.args[input.index - 1] !== role || request.args[input.index] !== input.file) {
      throw new Error("job input role, argument or path mismatch");
    }
    seen.add(role);
    checkedBytes(input.file, input);
  }
  if (!seen.has("--prompt-file") || Boolean(options.ids) !== seen.has("--evidence-ids-file") ||
      options.prompt !== path.join(job, "inputs", "prompt.txt") ||
      (options.ids && options.ids !== path.join(job, "inputs", "evidence-ids.json"))) {
    throw new Error("job input set mismatch");
  }
  let runtimeCode = "match";
  try { checkedBytes(request.wrapper, request.wrapper_digest); }
  catch {
    runtimeCode = "changed_or_missing";
    if (requireRuntime) throw new Error("wrapper runtime changed; do not replay");
  }
  return { request, options, requestSha256: recorded.sha256, runtimeCode };
}
function verify(jobPath) {
  const job = path.resolve(jobPath);
  try {
    const { requestSha256, runtimeCode } = readPinnedRequest(job, { requireRuntime: false });
    if (!fs.existsSync(path.join(job, "completion.json"))) {
      return { integrity: "incomplete", job_dir: job, runtime_code: runtimeCode };
    }
    const completion = read(path.join(job, "completion.json"));
    if (completion.format !== 2 || completion.request_sha256 !== requestSha256) throw new Error("completion request mismatch");
    for (const name of ["attempt.json", "started.json", "execution.json"]) {
      checkedBytes(path.join(job, name), completion[name]);
    }
    const execution = read(path.join(job, "execution.json"));
    if (execution.format !== 2 || execution.request_sha256 !== requestSha256 ||
        !["child_exit", "cancelled", "spawn_error", "supervisor_timeout"].includes(execution.reason) ||
        typeof execution.wrapper_started !== "boolean" || typeof execution.receipt_exists !== "boolean" ||
        execution.receipt_exists !== true || !execution.outputs ||
        !(Number.isInteger(execution.exit_code) || execution.exit_code === null) ||
        !(execution.signal === null || typeof execution.signal === "string")) throw new Error("execution schema mismatch");
    for (const name of ["stdout.json", "stderr.log", "run/receipt.json"]) {
      checkedBytes(path.join(job, name), execution.outputs[name]);
    }
    const attempt = read(path.join(job, "attempt.json"));
    if (attempt.format !== 2 || attempt.request_sha256 !== requestSha256) throw new Error("attempt request mismatch");
    const receipt = read(path.join(job, "run/receipt.json"));
    const stdout = strictJson(fs.readFileSync(path.join(job, "stdout.json"), "utf8").trim());
    if (receipt.job_request_sha256 !== requestSha256 ||
        !receipt.job_input_sha256 ||
        !Array.isArray(read(path.join(job, "request.json")).inputs) ||
        read(path.join(job, "request.json")).inputs.some(input =>
          receipt.job_input_sha256[input.name] !== input.sha256) ||
        JSON.stringify(stdout) !== JSON.stringify(receipt) ||
        (receipt.status === "ok" && (execution.exit_code !== 0 || receipt.complete !== true))) {
      throw new Error("exit, wrapper stdout and receipt disagree");
    }
    return { integrity: "match", job_dir: job, runtime_code: runtimeCode,
      note: "Only local records are consistent; provider billing and detached descendants are not independently verified." };
  } catch {
    if (!fs.existsSync(path.join(job, "request-digest.json"))) return { integrity: "legacy_unverified", job_dir: job };
    return { integrity: "corrupt", job_dir: job };
  }
}

function alive(pid, job) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return error.code === "ESRCH" ? false : null; }
  // Windows PID existence cannot establish that this is still our worker.
  // A reused PID must never turn an interrupted job into "running".
  if (process.platform === "win32") return null;
  const probe = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000, shell: false });
  if (probe.error || probe.status !== 0) return null;
  return probe.stdout.includes(`${__filename} worker ${job}`);
}
function signalChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === "win32") {
    if (signal !== "SIGKILL") return;
    const killed = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false, windowsHide: true, timeout: 2000, stdio: "ignore",
    });
    if (killed.status !== 0) { try { child.kill("SIGKILL"); } catch {} }
    return;
  }
  try { process.kill(-child.pid, signal); } catch {}
}
function writeCancel(job) {
  try { fs.writeFileSync(path.join(job, "cancel.request"), "cancel\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
// Never wait indefinitely for a wrapper whose descendants may retain pipes.
async function boundedClose(closed, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
async function stopOwnedAfterPublicationFailure(child, closed, job) {
  // The wrapper may already have made a paid request. Never synthesize a
  // cli_invoked=false receipt or treat PID disappearance as remote cancellation.
  let markerWritten = false;
  try { writeCancel(job); markerWritten = true; } catch {}
  if (!markerWritten || !await boundedClose(closed, 15000)) {
    signalChild(child, "SIGKILL"); // Only the child we actually spawned.
    if (!await boundedClose(closed, 2000)) child.unref();
  }
}

function start(jobPath, wrapperArgs, { wrapperPath = WRAPPER, spawnWorker = spawn } = {}) {
  checkInstall();
  const job = path.resolve(jobPath);
  const args = [...wrapperArgs];
  for (let i = 0; i < args.length; i++) {
    if (["--prompt-file", "--evidence-ids-file", "--cli-path"].includes(args[i]) && args[i + 1]) args[i + 1] = path.resolve(args[i + 1]);
  }
  if (args.includes("--output-dir")) throw new Error("job owns output-dir");
  args.push("--output-dir", path.join(job, "run"));
  parseArgs(args);
  // A detached worker must consume the exact inputs accepted by start, even
  // when the caller edits the original files immediately or closes its shell.
  const inputs = [];
  for (let i = 0; i < args.length; i++) {
    if (["--prompt-file", "--evidence-ids-file"].includes(args[i])) {
      inputs.push({ index: i + 1, name: args[i] === "--prompt-file" ? "prompt.txt" : "evidence-ids.json", bytes: fs.readFileSync(args[i + 1]) });
    }
  }
  fs.mkdirSync(job, { mode: 0o700 });
  fs.mkdirSync(path.join(job, "inputs"), { mode: 0o700 });
  const pinnedInputs = [];
  for (const input of inputs) {
    const file = path.join(job, "inputs", input.name);
    fs.writeFileSync(file, input.bytes, { flag: "wx", mode: 0o600 });
    args[input.index] = file;
    pinnedInputs.push({ index: input.index, name: input.name, file, ...rawFingerprint(input.bytes) });
  }
  const wrapperFile = fs.realpathSync(wrapperPath);
  const requestFile = path.join(job, "request.json");
  save(requestFile, { format: 2, created_at: new Date().toISOString(), wrapper: wrapperFile,
    wrapper_digest: rawFingerprint(wrapperFile), args, inputs: pinnedInputs });
  save(path.join(job, "request-digest.json"), rawFingerprint(requestFile));
  readPinnedRequest(job);
  const log = fs.openSync(path.join(job, "supervisor.log"), "wx", 0o600);
  let child;
  const recordLaunchError = error => {
    try { save(path.join(job, "launch-error.json"), { status: "launch_error", code: error.code || "UNKNOWN", cli_invoked: false }); } catch {}
  };
  try {
    child = spawnWorker(process.execPath, [__filename, "worker", job], {
      cwd: job, detached: true, shell: false, windowsHide: true, stdio: ["ignore", log, log],
    });
    child.on("error", recordLaunchError);
  } catch (error) {
    recordLaunchError(error);
  } finally { fs.closeSync(log); }
  save(path.join(job, "launch.json"), { supervisor_pid: child?.pid ?? null, started_at: new Date().toISOString(), job_dir: job });
  child?.unref();
  return { status: child?.pid ? "started" : "unknown", job_dir: job, supervisor_pid: child?.pid ?? null };
}

async function worker(job) {
  // A removed worker.lock is never permission to resubmit a job that
  // already has any execution evidence. Check before claiming the new lock.
  for (const name of ["attempt.json", "started.json", "stdout.json", "stderr.log", "execution.json", "completion.json", "run"]) {
    if (fs.existsSync(path.join(job, name))) throw new Error("existing execution evidence; do not replay");
  }
  fs.mkdirSync(path.join(job, "worker.lock"), { mode: 0o700 });
  const { request, options, requestSha256 } = readPinnedRequest(job);
  // Durable attempt evidence precedes any possible wrapper/provider launch.
  // Even a lost worker.lock cannot turn this attempt into permission to replay.
  save(path.join(job, "attempt.json"), { format: 2, request_sha256: requestSha256,
    worker_pid: process.pid, claimed_at: new Date().toISOString() });
  // Read and verify the snapshots a second time into immutable local buffers.
  // After this point the handoff never consults the input files again.
  const sealedInputs = request.inputs.map(input => ({
    name: input.name, file: input.file, bytes: input.bytes, sha256: input.sha256,
    data_base64: checkedBytes(input.file, input).toString("base64"),
  }));
  const sealedPayload = JSON.stringify({ format: 1, request_sha256: requestSha256, inputs: sealedInputs });
  const cancelMarker = path.join(job, "cancel.request");
  if (fs.existsSync(cancelMarker)) {
    save(path.join(job, "execution.json"), { format: 2, request_sha256: requestSha256,
      exit_code: null, signal: null, reason: "cancelled", ended_at: new Date().toISOString(),
      wrapper_started: false, receipt_exists: false });
    // A cancelled pre-launch request without a wrapper receipt stays incomplete.
    return;
  }
  const out = fs.openSync(path.join(job, "stdout.json"), "wx", 0o600);
  const err = fs.openSync(path.join(job, "stderr.log"), "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [request.wrapper, ...request.args], {
      cwd: job, detached: process.platform !== "win32", shell: false, windowsHide: true,
      env: { ...process.env, ZCODE_CANCEL_REQUEST_FILE: cancelMarker,
        ZCODE_JOB_SEALED_INPUT_V1: "1", ZCODE_JOB_REQUEST_SHA256: requestSha256 },
      stdio: ["pipe", out, err],
    });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  let reason = "child_exit";
  // Subscribe to both child events BEFORE publishing started.json. Otherwise
  // a disk-full/access-denied fault after spawn can strand the paid wrapper.
  child.stdin?.on("error", () => { reason = "stdin_error"; });
  child.once("error", () => { reason = "spawn_error"; });
  const closed = new Promise(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    save(path.join(job, "started.json"), { supervisor_pid: process.pid, wrapper_pid: child.pid ?? null, started_at: new Date().toISOString() });
  } catch (error) {
    // Do not send any request material if publication failed. Close stdin to
    // unblock the wrapper's sealed-input preflight before cooperative cancel.
    try { child.stdin?.end(); } catch {}
    await stopOwnedAfterPublicationFailure(child, closed, job);
    // Preserve unknown and permanent claim. No fabricated execution receipt.
    throw error;
  }
  // Only AFTER the durable started claim is published may the wrapper receive
  // the previously verified input bytes. A changed disk snapshot cannot slip in.
  child.stdin?.end(sealedPayload);
  let escalation;
  const stop = nextReason => {
    if (reason !== "child_exit") return;
    reason = nextReason;
    writeCancel(job);
    // The owned wrapper polls this marker on every platform. Sending SIGTERM
    // can race its preflight or receipt cleanup even on POSIX. Allow the
    // bounded 10s version probe plus cleanup to finish before escalation.
    escalation = setTimeout(() => signalChild(child, "SIGKILL"), 15000);
  };
  const cancel = () => stop("cancelled");
  process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  const cancelPoll = setInterval(() => { if (fs.existsSync(cancelMarker)) cancel(); }, 75);
  // The wrapper owns the request deadline. This independent deadline also covers preflight and cleanup.
  const deadline = setTimeout(() => stop("supervisor_timeout"), (options.timeout + 45) * 1000);
  const result = await closed;
  clearTimeout(deadline); clearInterval(cancelPoll); if (escalation) clearTimeout(escalation);
  if (reason === "child_exit" && fs.existsSync(cancelMarker)) reason = "cancelled";
  process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel);
  // Preserve a real negative outcome even if the wrapper died before writing
  // its receipt, but NEVER publish completion or a PASS for a missing receipt.
  const receiptFile = path.join(job, "run/receipt.json");
  const receiptExists = fs.existsSync(receiptFile);
  const outputRecords = {
    "stdout.json": rawFingerprint(path.join(job, "stdout.json")),
    "stderr.log": rawFingerprint(path.join(job, "stderr.log")),
    "run/receipt.json": receiptExists ? rawFingerprint(receiptFile) : null,
  };
  const executionFile = path.join(job, "execution.json");
  save(executionFile, { format: 2, request_sha256: requestSha256, exit_code: result.code,
    signal: result.signal, reason, ended_at: new Date().toISOString(),
    wrapper_started: Boolean(child.pid), receipt_exists: receiptExists, outputs: outputRecords });
  if (receiptExists) {
    try {
      // Validate before the final publication; never bless truncated or
      // mismatched output, and never manufacture receipt data.
      const receipt = read(receiptFile);
      const stdout = strictJson(fs.readFileSync(path.join(job, "stdout.json"), "utf8").trim());
      if (JSON.stringify(receipt) === JSON.stringify(stdout) &&
          !(receipt.status === "ok" && (result.code !== 0 || receipt.complete !== true))) {
        save(path.join(job, "completion.json"), { format: 2, request_sha256: requestSha256,
          "attempt.json": rawFingerprint(path.join(job, "attempt.json")),
          "started.json": rawFingerprint(path.join(job, "started.json")),
          "execution.json": rawFingerprint(executionFile) });
      }
    } catch { /* Incomplete evidence remains permanently unknown and inspect-only. */ }
  }
}

function cancel(jobPath) {
  const job = path.resolve(jobPath);
  // A cancellation request is a file in this existing job; it never signals a
  // PID recovered from disk and never restarts the request.
  if (!fs.statSync(job).isDirectory() || fs.lstatSync(job).isSymbolicLink()) throw new Error("invalid job");
  if (!fs.existsSync(path.join(job, "request-digest.json"))) {
    return { status: "legacy_read_only", job_dir: job, cancel_requested: false };
  }
  if (fs.existsSync(path.join(job, "completion.json"))) return { ...status(job), cancel_requested: false };
  writeCancel(job);
  return { status: "cancel_requested", job_dir: job, cancel_requested: true };
}

// isAlive is injectable so tests can reproduce the exit race deterministically.
function legacyStatus(jobPath, { isAlive = alive } = {}) {
  const job = path.resolve(jobPath);
  const launch = read(path.join(job, "launch.json"));
  const result = { status: "running", job_dir: job, supervisor_pid: launch.supervisor_pid };
  const execution = path.join(job, "execution.json");
  if (!fs.existsSync(execution)) {
    if (fs.existsSync(path.join(job, "launch-error.json"))) {
      return { ...result, status: "unknown", launch_error: read(path.join(job, "launch-error.json")) };
    }
    if (fs.existsSync(path.join(job, "worker.lock"))) {
      return { ...result, status: "unknown",
        note: "Worker claimed execution but no terminal record exists. Never replay or remove the claim." };
    }
    const supervisorAlive = isAlive(launch.supervisor_pid, job);
    // The worker saves execution.json before it exits. A supervisor that ends
    // between the check above and the probe has finished, so look again before
    // reporting it as interrupted or unknown.
    if (supervisorAlive === true || !fs.existsSync(execution)) {
      result.supervisor_alive = supervisorAlive;
      if (supervisorAlive === false) result.status = "interrupted";
      if (supervisorAlive === null) result.status = "unknown";
      if (fs.existsSync(path.join(job, "run/progress.json"))) result.progress = read(path.join(job, "run/progress.json"));
      return result;
    }
  }
  result.status = "finished";
  result.execution = read(execution);
  if (result.execution.receipt_exists) {
    try { result.receipt = read(path.join(job, "run/receipt.json")); }
    catch { result.receipt_unreadable = true; }
  }
  return result;
}

function status(jobPath, { isAlive = alive } = {}) {
  const job = path.resolve(jobPath);
  if (!fs.existsSync(path.join(job, "request-digest.json"))) {
    try { return { ...legacyStatus(job, { isAlive }), legacy_unverified: true }; }
    catch { return { status: "unknown", job_dir: job, legacy_unverified: true,
      note: "Old-format job is read-only and cannot be replayed or upgraded automatically." }; }
  }
  const evidence = verify(job);
  if (evidence.integrity !== "match") {
    let pid = null;
    try { pid = read(path.join(job, "launch.json")).supervisor_pid ?? null; } catch {}
    // Preserve original pre-spawn diagnostics without promoting the job to
    // finished or inferring that a provider was (or was not) invoked.
    let launchError = null;
    try { launchError = read(path.join(job, "launch-error.json")); } catch {}
    return { status: "unknown", job_dir: job, supervisor_pid: pid, integrity: evidence.integrity,
      runtime_code: evidence.runtime_code ?? null,
      ...(launchError ? { launch_error: launchError } : {}),
      note: "Missing, incomplete or changed job evidence: never resubmit automatically." };
  }
  return { ...legacyStatus(job, { isAlive }), integrity: "match",
    runtime_code: evidence.runtime_code };
}

if (require.main === module) {
  const [action, job, ...args] = process.argv.slice(2);
  (async () => {
    if (!job || !["start", "status", "cancel", "worker", "verify"].includes(action)) throw new Error("usage");
    if (action === "worker") { await worker(path.resolve(job)); return; }
    const result = action === "start" ? start(job, args) : action === "cancel" ? cancel(job)
      : action === "verify" ? verify(job) : status(job);
    if (action === "verify" && result.integrity !== "match") process.exitCode = 2;
    process.stdout.write(JSON.stringify(result) + "\n");
  })().catch(() => { process.stdout.write('{"status":"supervisor_error"}\n'); process.exitCode = 1; });
}

module.exports = { start, status, cancel, verify };
