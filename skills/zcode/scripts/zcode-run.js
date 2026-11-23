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
  if (process.platform === "win32") return true;
  const probe = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000, shell: false });
  if (probe.error || probe.status !== 0) return null;
  return probe.stdout.includes(`${__filename} worker ${job}`);
}
function signalGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, signal); } catch {}
}

function start(jobPath, wrapperArgs, { wrapperPath = WRAPPER } = {}) {
  checkInstall();
  const job = path.resolve(jobPath);
  const args = [...wrapperArgs];
  for (let i = 0; i < args.length; i++) {
    if (["--prompt-file", "--evidence-ids-file", "--cli-path"].includes(args[i]) && args[i + 1]) args[i + 1] = path.resolve(args[i + 1]);
  }
  if (args.includes("--output-dir")) throw new Error("job owns output-dir");
  args.push("--output-dir", path.join(job, "run"));
  parseArgs(args);
  fs.mkdirSync(job, { mode: 0o700 });
  save(path.join(job, "request.json"), { wrapper: path.resolve(wrapperPath), args });
  const log = fs.openSync(path.join(job, "supervisor.log"), "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [__filename, "worker", job], {
      cwd: job, detached: true, shell: false, stdio: ["ignore", log, log],
    });
    child.on("error", () => {});
    save(path.join(job, "launch.json"), { supervisor_pid: child.pid ?? null, started_at: new Date().toISOString(), job_dir: job });
    child.unref();
  } finally { fs.closeSync(log); }
  return { status: "started", job_dir: job, supervisor_pid: child.pid ?? null };
}

async function worker(job) {
  const request = read(path.join(job, "request.json"));
  if (!path.isAbsolute(request.wrapper) || !Array.isArray(request.args) || request.args.some(arg => typeof arg !== "string")) throw new Error("invalid job");
  const options = parseArgs(request.args);
  if (path.resolve(options.output) !== path.join(job, "run")) throw new Error("invalid output-dir");
  const out = fs.openSync(path.join(job, "stdout.json"), "wx", 0o600);
  const err = fs.openSync(path.join(job, "stderr.log"), "wx", 0o600);
  const child = spawn(process.execPath, [request.wrapper, ...request.args], {
    cwd: job, detached: process.platform !== "win32", shell: false, stdio: ["ignore", out, err],
  });
  fs.closeSync(out); fs.closeSync(err);
  save(path.join(job, "started.json"), { supervisor_pid: process.pid, wrapper_pid: child.pid ?? null, started_at: new Date().toISOString() });
  let reason = "child_exit";
  const cancel = () => { reason = "cancelled"; signalGroup(child.pid, "SIGTERM"); };
  process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  // The wrapper owns the request deadline. This independent deadline also covers preflight and cleanup.
  let escalation;
  const deadline = setTimeout(() => {
    reason = "supervisor_timeout";
    signalGroup(child.pid, "SIGTERM");
    escalation = setTimeout(() => {
      signalGroup(child.pid, "SIGKILL");
      try { signalGroup(read(path.join(job, "run/progress.json")).cli_pid, "SIGKILL"); } catch {}
    }, 5000);
  }, (options.timeout + 45) * 1000);
  const result = await new Promise(resolve => {
    child.once("error", () => { reason = "spawn_error"; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(deadline); if (escalation) clearTimeout(escalation);
  process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel);
  // Preserve a real negative outcome even if the wrapper died before writing its receipt.
  save(path.join(job, "execution.json"), { exit_code: result.code, signal: result.signal, reason, ended_at: new Date().toISOString(), receipt_exists: fs.existsSync(path.join(job, "run/receipt.json")) });
}

// isAlive is injectable so tests can reproduce the exit race deterministically.
function status(jobPath, { isAlive = alive } = {}) {
  const job = path.resolve(jobPath);
  const launch = read(path.join(job, "launch.json"));
  const result = { status: "running", job_dir: job, supervisor_pid: launch.supervisor_pid };
  const execution = path.join(job, "execution.json");
  if (!fs.existsSync(execution)) {
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
    if (!job || !["start", "status", "worker"].includes(action)) throw new Error("usage");
    if (action === "worker") { await worker(path.resolve(job)); return; }
    const result = action === "start" ? start(job, args) : status(job);
    process.stdout.write(JSON.stringify(result) + "\n");
  })().catch(() => { process.stdout.write('{"status":"supervisor_error"}\n'); process.exitCode = 1; });
}

module.exports = { start, status };
