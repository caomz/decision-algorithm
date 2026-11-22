#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { strictJson } = require("./review.js");
const { parseArgs, checkInstall } = require("./zcode-chat.js");
const WRAPPER = path.join(__dirname, "zcode-chat.js");

function save(file, value) {
  if (fs.existsSync(file)) throw new Error("existing job state");
  const temporary = file + ".writing";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
}
function read(file) { return strictJson(fs.readFileSync(file, "utf8")); }
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
  for (const input of inputs) {
    const file = path.join(job, "inputs", input.name);
    fs.writeFileSync(file, input.bytes, { flag: "wx", mode: 0o600 });
    args[input.index] = file;
  }
  save(path.join(job, "request.json"), { wrapper: path.resolve(wrapperPath), args });
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
  for (const name of ["started.json", "stdout.json", "stderr.log", "execution.json", "completion.json", "run"]) {
    if (fs.existsSync(path.join(job, name))) throw new Error("existing execution evidence; do not replay");
  }
  fs.mkdirSync(path.join(job, "worker.lock"), { mode: 0o700 });
  const request = read(path.join(job, "request.json"));
  if (!path.isAbsolute(request.wrapper) || !Array.isArray(request.args) || request.args.some(arg => typeof arg !== "string")) throw new Error("invalid job");
  const options = parseArgs(request.args);
  if (path.resolve(options.output) !== path.join(job, "run")) throw new Error("invalid output-dir");
  const cancelMarker = path.join(job, "cancel.request");
  if (fs.existsSync(cancelMarker)) {
    save(path.join(job, "execution.json"), { exit_code: null, signal: null, reason: "cancelled", ended_at: new Date().toISOString(), wrapper_started: false, receipt_exists: false });
    return;
  }
  const out = fs.openSync(path.join(job, "stdout.json"), "wx", 0o600);
  const err = fs.openSync(path.join(job, "stderr.log"), "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [request.wrapper, ...request.args], {
      cwd: job, detached: process.platform !== "win32", shell: false, windowsHide: true,
      env: { ...process.env, ZCODE_CANCEL_REQUEST_FILE: cancelMarker }, stdio: ["ignore", out, err],
    });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  let reason = "child_exit";
  // Subscribe to both child events BEFORE publishing started.json. Otherwise
  // a disk-full/access-denied fault after spawn can strand the paid wrapper.
  child.once("error", () => { reason = "spawn_error"; });
  const closed = new Promise(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    save(path.join(job, "started.json"), { supervisor_pid: process.pid, wrapper_pid: child.pid ?? null, started_at: new Date().toISOString() });
  } catch (error) {
    await stopOwnedAfterPublicationFailure(child, closed, job);
    // Preserve unknown and permanent claim. No fabricated execution receipt.
    throw error;
  }
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
  // Preserve a real negative outcome even if the wrapper died before writing its receipt.
  save(path.join(job, "execution.json"), { exit_code: result.code, signal: result.signal, reason, ended_at: new Date().toISOString(), wrapper_started: Boolean(child.pid), receipt_exists: fs.existsSync(path.join(job, "run/receipt.json")) });
}

function cancel(jobPath) {
  const job = path.resolve(jobPath);
  // A cancellation request is a file in this existing job; it never signals a
  // PID recovered from disk and never restarts the request.
  if (!fs.statSync(job).isDirectory() || fs.lstatSync(job).isSymbolicLink()) throw new Error("invalid job");
  read(path.join(job, "request.json"));
  if (fs.existsSync(path.join(job, "execution.json"))) return { ...status(job), cancel_requested: false };
  writeCancel(job);
  return { status: "cancel_requested", job_dir: job, cancel_requested: true };
}

// isAlive is injectable so tests can reproduce the exit race deterministically.
function status(jobPath, { isAlive = alive } = {}) {
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

if (require.main === module) {
  const [action, job, ...args] = process.argv.slice(2);
  (async () => {
    if (!job || !["start", "status", "cancel", "worker"].includes(action)) throw new Error("usage");
    if (action === "worker") { await worker(path.resolve(job)); return; }
    const result = action === "start" ? start(job, args) : action === "cancel" ? cancel(job) : status(job);
    process.stdout.write(JSON.stringify(result) + "\n");
  })().catch(() => { process.stdout.write('{"status":"supervisor_error"}\n'); process.exitCode = 1; });
}

module.exports = { start, status, cancel };
