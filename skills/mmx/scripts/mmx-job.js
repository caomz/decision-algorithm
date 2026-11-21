#!/usr/bin/env node
"use strict";

// Durable MMX batch supervisor. Immutable input snapshots, exclusive job path,
// no implicit replay on an absent/ambiguous completion record.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { parseArgs, collectShardFiles } = require("./mmx-batch.js");

const BATCH = path.join(__dirname, "mmx-batch.js");
const EXIT_UNKNOWN = 2;

function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function writeNew(file, value) {
  const data = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const temp = file + "." + crypto.randomUUID() + ".writing";
  try {
    fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function writeOnce(file, value) {
  if (fs.existsSync(file)) throw new Error("existing job record");
  writeNew(file, value);
}
function readJson(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid job record");
  return value;
}
function snapshot(job, input, target) {
  const real = fs.realpathSync(input);
  if (!fs.statSync(real).isFile()) throw new Error("job input must be a regular file");
  const bytes = fs.readFileSync(real);
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
  args.push("--profile-file", profileFile, "--receipt-file", receiptFile);
  return args;
}
function start(jobPath, argv, overrides = {}) {
  const { parsed, shards } = resolveArgs(argv);
  const job = path.resolve(jobPath);
  // mkdir without recursive is the idempotency gate. The caller must inspect
  // an existing job, not relaunch it with the same path.
  fs.mkdirSync(job, { mode: 0o700 });
  try {
    fs.mkdirSync(path.join(job, "input"), { mode: 0o700 });
    const prompts = shards.map((s, i) => snapshot(job, s.file, "shard-" + i + ".txt"));
    const profile = snapshot(job, parsed.profileFile ?? path.join(__dirname, "..", "profiles", "local.json"), "profile.json");
    const receiptFile = path.join(job, "receipt.json");
    const args = makeBatchArgs(parsed, prompts, profile.file, receiptFile);
    // Validate the rewritten job against the same batch parser.
    resolveArgs(args.filter((x, i) => !(x === "--receipt-file" || (i > 0 && args[i - 1] === "--receipt-file"))));
    const request = { format: 1, created_at: new Date().toISOString(), prompts, profile,
      batch_script: path.resolve(overrides.batchPath ?? BATCH), batch_args: args };
    writeOnce(path.join(job, "request.json"), request);
    const log = fs.openSync(path.join(job, "supervisor.log"), "wx", 0o600);
    let child;
    try {
      child = spawn(process.execPath, [__filename, "worker", job], {
        cwd: job, detached: true, shell: false, windowsHide: true,
        stdio: ["ignore", log, log],
      });
      child.on("error", () => {});
      writeOnce(path.join(job, "launch.json"), { supervisor_pid: child.pid ?? null,
        started_at: new Date().toISOString() });
      child.unref();
    } finally { fs.closeSync(log); }
    return { status: "started", job_dir: job, supervisor_pid: child.pid ?? null,
      prompt_count: prompts.length };
  } catch (error) {
    // Preserve all partial records and snapshots. Do NOT delete the directory:
    // a process may already have been launched.
    throw error;
  }
}
function status(jobPath) {
  const job = path.resolve(jobPath);
  try {
    const request = readJson(path.join(job, "request.json"));
    const launchPath = path.join(job, "launch.json");
    const executionPath = path.join(job, "execution.json");
    const result = { status: "unknown", job_dir: job,
      prompt_count: Array.isArray(request.prompts) ? request.prompts.length : null,
      supervisor_pid: fs.existsSync(launchPath) ? readJson(launchPath).supervisor_pid : null };
    if (fs.existsSync(executionPath)) {
      result.execution = readJson(executionPath);
      result.status = "finished";
      if (fs.existsSync(path.join(job, "receipt.json"))) {
        try { result.receipt = readJson(path.join(job, "receipt.json")); }
        catch { result.receipt_unreadable = true; }
      }
    } else {
      result.note = "No terminal execution record: may still be running. Never resubmit automatically.";
    }
    return result;
  } catch {
    return { status: "unknown", job_dir: job, note: "Job records missing or unreadable; do not resubmit automatically." };
  }
}
function verify(jobPath) {
  const job = path.resolve(jobPath);
  try {
    const request = readJson(path.join(job, "request.json"));
    if (request.format !== 1 || !Array.isArray(request.prompts) || !request.profile) throw new Error("schema");
    const root = path.join(job, "input") + path.sep;
    const items = [...request.prompts, request.profile];
    if (items.length < 2) throw new Error("empty");
    for (const item of items) {
      if (typeof item.file !== "string" || !path.resolve(item.file).startsWith(root)) throw new Error("input path");
      if (!fs.lstatSync(item.file).isFile()) throw new Error("input type");
      const bytes = fs.readFileSync(item.file);
      if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw new Error("input digest");
    }
    const record = status(job);
    if (record.status !== "finished") return { integrity: "incomplete", job_dir: job };
    if (!record.execution || !Number.isInteger(record.execution.started_ms)) throw new Error("execution schema");
    if (record.execution.receipt_exists && (record.receipt_unreadable || !record.receipt)) throw new Error("receipt missing");
    return { integrity: "match", job_dir: job, state: record.execution.reason };
  } catch {
    return { integrity: "corrupt", job_dir: job };
  }
}
function cancel(jobPath) {
  const job = path.resolve(jobPath);
  const existing = status(job);
  if (existing.status === "finished") return { status: "finished", job_dir: job };
  if (!fs.existsSync(path.join(job, "request.json"))) return { status: "unknown", job_dir: job };
  const marker = path.join(job, "cancel.request");
  try { fs.writeFileSync(marker, "cancel\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return { status: "cancel_requested", job_dir: job,
    note: "Cancellation is advisory until execution.json confirms termination." };
}
function killTree(child) {
  if (!child || !child.pid) return false;
  if (process.platform === "win32") {
    try {
      const r = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, shell: false, timeout: 3000, stdio: "ignore" });
      return !r.error && r.status === 0;
    } catch { return false; }
  }
  try { process.kill(-child.pid, "SIGTERM"); return true; }
  catch { try { child.kill("SIGTERM"); } catch {} return false; }
}
async function worker(job) {
  const request = readJson(path.join(job, "request.json"));
  if (!path.isAbsolute(request.batch_script) || !Array.isArray(request.batch_args)) throw new Error("invalid request");
  // A missing script or corrupt input is terminally recorded, never retried.
  const checked = verify(job);
  if (checked.integrity === "corrupt") throw new Error("job input integrity mismatch");
  const started_ms = Date.now();
  let child = null, reason = "child_exit", terminationConfirmed = true;
  const out = fs.openSync(path.join(job, "stdout.json"), "wx", 0o600);
  const err = fs.openSync(path.join(job, "stderr.log"), "wx", 0o600);
  try {
    child = spawn(process.execPath, [request.batch_script, ...request.batch_args], {
      cwd: job, shell: false, detached: process.platform !== "win32",
      windowsHide: true, stdio: ["ignore", out, err],
    });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  writeOnce(path.join(job, "started.json"), { supervisor_pid: process.pid,
    batch_pid: child.pid ?? null, started_ms });
  let cancellationSent = false;
  const requestCancel = () => {
    if (cancellationSent) return;
    cancellationSent = true;
    reason = "cancelled";
    if (!killTree(child)) terminationConfirmed = false;
  };
  const polling = setInterval(() => {
    if (fs.existsSync(path.join(job, "cancel.request"))) requestCancel();
  }, 100);
  process.on("SIGTERM", requestCancel);
  process.on("SIGINT", requestCancel);
  if (fs.existsSync(path.join(job, "cancel.request"))) requestCancel();
  const closed = await new Promise(resolve => {
    child.once("error", error => { reason = "spawn_error"; resolve({ code: null, signal: null, spawn_error: error.code || "error" }); });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearInterval(polling);
  process.removeListener("SIGTERM", requestCancel);
  process.removeListener("SIGINT", requestCancel);
  const receipt_exists = fs.existsSync(path.join(job, "receipt.json"));
  writeOnce(path.join(job, "execution.json"), {
    started_ms, ended_at: new Date().toISOString(), reason,
    exit_code: closed.code, signal: closed.signal, receipt_exists,
    termination_confirmed: terminationConfirmed, ...(closed.spawn_error ? { spawn_error: closed.spawn_error } : {}),
  });
}
async function cli(argv) {
  const [action, job, ...args] = argv;
  if (!job || !["start", "status", "resume", "cancel", "verify", "worker"].includes(action)) throw new Error("usage");
  if (action === "worker") { await worker(path.resolve(job)); return; }
  if (action === "start") return start(job, args);
  if (action === "status") return status(job);
  if (action === "resume") return { ...status(job), resume_policy: "inspect_only_no_automatic_replay" };
  if (action === "cancel") return cancel(job);
  return verify(job);
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
module.exports = { start, status, cancel, verify, resolveArgs };
