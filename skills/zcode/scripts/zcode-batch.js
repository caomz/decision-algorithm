#!/usr/bin/env node
// Run a whole ZCode review shard batch in ONE host tool call and emit exactly
// one JSON envelope. Mirrors mmx-batch.js on the ZCode side:
//   1. each shard goes through zcode-chat.js, so the guarded mode, isolated
//      HOME/cwd, zero-tool verification and per-shard zcode-text-* evidence
//      directories all apply unchanged;
//   2. a bounded parallel pool replaces N sequential host tool calls, so wall
//      time is ~ceil(N/concurrency) shard durations, not their sum.
// Unlike the MMX wrapper the ZCode receipt already carries a structured
// review_gate, so the batch gate is TWO levels: a transport gate (all shards
// ok/complete/untruncated) and a content gate aggregated from per-shard
// review_gate (any FAIL wins; all PASS needs every shard PASS). --version and
// --help stay plain-text exceptions.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const VERSION = "1.0.0";
const DEFAULT_WRAPPER = path.join(__dirname, "zcode-chat.js");
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const MAX_SHARDS = 32;
const DEFAULT_TIMEOUT_SECONDS = 1200;
const MAX_TIMEOUT_SECONDS = 21600;
// Test hook only: a production run never overrides the quota/timeout backoff.
const RETRY_DELAY_MS = (() => {
  const raw = process.env.ZCODE_BATCH_RETRY_MS;
  if (raw === undefined) return 30000;
  if (!/^\d+$/.test(raw) || Number(raw) > 30000) return 30000;
  return Number(raw);
})();
const STDOUT_CAP_BYTES = 16 * 1024 * 1024;
const MODES = ["chat", "review", "challenge"];
const RETRYABLE = new Set(["quota_error", "timeout"]);

// ---------------------------------------------------------------------------
// Emission — exactly ONE JSON object on stdout (same contract as zcode-chat.js).
// ---------------------------------------------------------------------------

let emitted = false;
function emit(result) {
  if (emitted) return;
  emitted = true;
  process.stdout.write(JSON.stringify(result) + "\n");
}

function fail(result) {
  emit(result);
  process.exitCode = 1;
}

function usageError(message) {
  throw Object.assign(new Error(message), { envelope: { status: "usage_error", error: message } });
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------
// Argument parsing — strict, unknown flags reject the whole request.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { promptFiles: [], promptsDir: null, concurrency: null, mode: "chat",
    evidenceIdsFile: null, cliPath: null, timeout: null, receiptFile: null, allowPaidRetry: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // A repeated flag is a usage error: silently keeping the last value would
    // hide a caller mistake that the single-shot wrapper rejects outright.
    // --prompt-file is the one flag that may repeat.
    if (arg !== "--prompt-file" && seen.has(arg)) usageError(`${arg} must not be given more than once.`);
    seen.add(arg);
    const next = () => {
      if (i + 1 >= argv.length) usageError(`${arg} requires a value.`);
      return argv[++i];
    };
    switch (arg) {
      case "--prompt-file": out.promptFiles.push(path.resolve(next())); break;
      case "--prompts-dir": out.promptsDir = path.resolve(next()); break;
      case "--concurrency": {
        const value = next();
        if (!/^\d+$/.test(value)) usageError("--concurrency must be a positive integer.");
        out.concurrency = Number(value);
        break;
      }
      case "--mode": out.mode = next(); break;
      case "--evidence-ids-file": out.evidenceIdsFile = path.resolve(next()); break;
      case "--cli-path": out.cliPath = next(); break;
      case "--timeout-seconds": {
        const value = next();
        if (!/^\d+$/.test(value) || !positiveInteger(Number(value))) {
          usageError("--timeout-seconds must be a positive integer.");
        }
        out.timeout = Number(value);
        break;
      }
      case "--receipt-file": out.receiptFile = path.resolve(next()); break;
      // Never enable remote replays from environment, profile, or old job state.
      case "--allow-paid-retry": out.allowPaidRetry = true; break;
      default: usageError(`Unknown flag: ${arg}`);
    }
  }
  if (out.concurrency !== null && (out.concurrency < 1 || out.concurrency > MAX_CONCURRENCY)) {
    usageError(`--concurrency must be between 1 and ${MAX_CONCURRENCY}.`);
  }
  if (!MODES.includes(out.mode)) usageError("--mode must be chat, review or challenge.");
  if (out.mode !== "chat" && out.evidenceIdsFile === null) {
    usageError("--evidence-ids-file is required for review/challenge, as with the single-shot wrapper.");
  }
  if (out.mode === "chat" && out.evidenceIdsFile !== null) {
    usageError("--evidence-ids-file is not accepted in chat mode.");
  }
  if (out.timeout !== null && out.timeout > MAX_TIMEOUT_SECONDS) {
    usageError(`--timeout-seconds must not exceed ${MAX_TIMEOUT_SECONDS}.`);
  }
  if (out.promptFiles.length > 0 && out.promptsDir !== null) {
    usageError("Use either --prompt-file or --prompts-dir, not both.");
  }
  if (out.promptFiles.length === 0 && out.promptsDir === null) {
    usageError("Provide at least one --prompt-file or a --prompts-dir.");
  }
  return out;
}

function collectShardFiles(args) {
  let files;
  if (args.promptsDir !== null) {
    let entries;
    try { entries = fs.readdirSync(args.promptsDir); }
    catch { usageError("--prompts-dir is not readable."); }
    files = entries
      .filter(name => /\.txt$/i.test(name))
      .map(name => path.join(args.promptsDir, name))
      .filter(file => { try { return fs.statSync(file).isFile(); } catch { return false; } })
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
    if (files.length === 0) usageError("--prompts-dir contains no .txt shard files.");
  } else {
    files = args.promptFiles;
  }
  if (files.length > MAX_SHARDS) usageError(`A batch accepts at most ${MAX_SHARDS} shards.`);

  const seen = new Set();
  const labeled = [];
  for (const file of files) {
    let real, stat;
    try {
      real = fs.realpathSync(file);
      stat = fs.statSync(real, { bigint: true });
      if (!stat.isFile()) throw new Error("not a regular file");
    }
    catch { usageError(`Prompt file not found: ${file}`); }
    const identity = stat.ino !== 0n ? `inode:${stat.dev}:${stat.ino}`
      : `path:${process.platform === "win32" ? real.toLowerCase() : real}`;
    if (seen.has(identity)) usageError(`Duplicate prompt file: ${file}`);
    seen.add(identity);
    let label = path.basename(file).replace(/\.txt$/i, "").replace(/[^A-Za-z0-9._-]/g, "_") || "shard";
    let unique = label;
    for (let n = 2; labeled.some(s => s.label === unique); n++) unique = `${label}-${n}`;
    label = unique;
    labeled.push({ label, file, real });
  }
  return labeled;
}

// ---------------------------------------------------------------------------
// One shard attempt: spawn the single-shot wrapper, parse its JSON envelope.
// The wrapper owns the CLI child and its cleanup; the batch never touches the
// CLI process tree directly.
// ---------------------------------------------------------------------------

const liveChildren = new Set();
let cancelled = false;
let cancelMarker = process.env.ZCODE_CANCEL_REQUEST_FILE;
let cancelDirectory;
let escalation;
let cancellationSent = false;
let receiptFd = null;

function cancellationRequested() {
  if (cancelMarker && fs.existsSync(cancelMarker)) cancelled = true;
  return cancelled;
}

function waitForRetry() {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(deadline); clearInterval(poll); resolve(); };
    const deadline = setTimeout(finish, RETRY_DELAY_MS);
    const poll = setInterval(() => { if (cancellationRequested()) finish(); }, 75);
  });
}

function runWrapperOnce(promptFile, fixedArgs) {
  return new Promise(resolve => {
    if (cancellationRequested()) { resolve({ receipt: { status: "cancelled", complete: false }, duration: 0 }); return; }
    const wrapperPath = process.env.ZCODE_BATCH_WRAPPER || DEFAULT_WRAPPER;
    const args = [wrapperPath, "--prompt-file", promptFile, ...fixedArgs];
    let child;
    try {
      child = spawn(process.execPath, args, {
        stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
        env: { ...process.env, ZCODE_CANCEL_REQUEST_FILE: cancelMarker },
      });
    } catch (err) {
      resolve({ receipt: { status: "child_error", error: `could not spawn wrapper: ${err.code || err.message}` }, duration: 0 });
      return;
    }
    liveChildren.add(child);
    const stdout = [];
    let stdoutBytes = 0;
    let overflow = false;
    const started = Date.now();
    child.stdout.on("data", chunk => {
      if (stdoutBytes >= STDOUT_CAP_BYTES) { overflow = true; return; }
      const take = Math.min(chunk.length, STDOUT_CAP_BYTES - stdoutBytes);
      if (take !== chunk.length) overflow = true;
      stdout.push(take === chunk.length ? chunk : chunk.subarray(0, take));
      stdoutBytes += take;
    });
    // stderr is drained but deliberately NOT captured or echoed: the wrapper
    // keeps its own scrubbing boundary and the shard evidence dirs hold detail.
    child.stderr.on("data", () => {});
    child.on("error", err => {
      liveChildren.delete(child);
      resolve({ receipt: { status: "child_error", error: `wrapper spawn failed: ${err.code || err.message}` }, duration: 0 });
    });
    child.on("close", (code, signal) => {
      liveChildren.delete(child);
      const duration = (Date.now() - started) / 1000;
      if (cancellationRequested()) {
        resolve({ receipt: { status: "cancelled", complete: false, exit_code: code, signal }, duration });
        return;
      }
      const outText = Buffer.concat(stdout).toString("utf8").trim();
      if (!outText) {
        resolve({ receipt: { status: "child_error", exit_code: code, error: "wrapper produced no stdout envelope" }, duration });
        return;
      }
      if (overflow) {
        resolve({ receipt: { status: "child_error", exit_code: code, error: "wrapper stdout exceeded the batch capture cap" }, duration });
        return;
      }
      let receipt;
      try { receipt = JSON.parse(outText); }
      catch {
        resolve({ receipt: { status: "child_error", exit_code: code, error: "wrapper stdout was not valid JSON" }, duration });
        return;
      }
      if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt) ||
          typeof receipt.status !== "string") {
        resolve({ receipt: { status: "child_error", exit_code: code, error: "wrapper envelope is not a JSON object with a status" }, duration });
        return;
      }
      // The process outcome is independent evidence. A valid-looking success
      // envelope must not hide a crash, signal, or nonzero wrapper exit.
      if (signal || code === null || code !== 0 && (code !== 1 || receipt.status === "ok" || receipt.complete === true)) {
        receipt = { ...receipt, status: "child_error", complete: false, review_gate: "NOT_EVALUATED",
          error: "wrapper exit did not match its receipt" };
      }
      receipt.wrapper_exit_code = code;
      receipt.wrapper_signal = signal;
      resolve({ receipt, duration });
    });
  });
}

// ---------------------------------------------------------------------------
// Retry policy — default at most one possibly billed provider attempt.
// An explicitly authorized second attempt retains the first receipt; local
// cleanup does not establish remote idempotency or absence of provider billing.
// ---------------------------------------------------------------------------

async function runShardWithRetries(shard, fixedArgs, allowPaidRetry) {
  const first = await runWrapperOnce(shard.file, fixedArgs);
  const retrySafe = first.receipt.status !== "timeout" || first.receipt.cleanup_confirmed === true;
  if (!allowPaidRetry || !RETRYABLE.has(first.receipt.status) || !retrySafe || cancellationRequested()) {
    return { shard: shard.label, prompt_file: shard.file, retried: false, retry_reason: null,
      ...(!allowPaidRetry && RETRYABLE.has(first.receipt.status) ? { retry_skipped_reason: "paid_retry_not_authorized" } : {}),
      duration_seconds: first.duration, ...first.receipt };
  }
  const retryReason = first.receipt.status;
  const backoffStarted = Date.now();
  await waitForRetry();
  const backoffSeconds = (Date.now() - backoffStarted) / 1000;
  // A cancellation during the backoff must not spawn a new child.
  if (cancellationRequested()) {
    return { shard: shard.label, prompt_file: shard.file, retried: false, retry_reason: retryReason,
      retry_backoff_seconds: backoffSeconds,
      duration_seconds: first.duration + backoffSeconds,
      first_attempt: first.receipt, status: "cancelled", complete: false };
  }
  const second = await runWrapperOnce(shard.file, fixedArgs);
  return {
    shard: shard.label, prompt_file: shard.file, retried: true, retry_reason: retryReason,
    retry_backoff_seconds: backoffSeconds,
    duration_seconds: first.duration + second.duration + backoffSeconds,
    first_attempt: first.receipt,
    ...second.receipt,
  };
}

// ---------------------------------------------------------------------------
// Gates — transport usability and content review_gate are separate verdicts.
// ---------------------------------------------------------------------------

// A wrapper's content verdict is only a vote if its independent execution
// evidence is valid. In particular, Windows may report cleanup_confirmed=null
// for a clean root exit: that is NOT proof that all CLI descendants exited.
function reviewVoteEligible(result) {
  return result.status === "ok" &&
    result.cli_invoked === true &&
    result.exit_code === 0 && result.signal === null &&
    result.wrapper_exit_code === 0 && result.wrapper_signal === null &&
    result.complete === true && result.truncated === false &&
    typeof result.model === "string" && result.model.trim().length > 0 &&
    typeof result.provider === "string" && result.provider.trim().length > 0 &&
    result.model_identity_source === "runtime.model_request" &&
    result.tool_calls === 0 && result.tool_requests === 0 &&
    result.cleanup_confirmed === true &&
    ["stop", "end_turn", "stop_sequence"].includes(result.stop_reason);
}

function aggregate(results, shards, args, started, { cancelled: interrupted = false } = {}) {
  let okCount = 0;
  let transportOkCount = 0;
  let truncatedCount = 0;
  let retriedCount = 0;
  let reviewPass = 0;
  let reviewFail = 0;
  let reviewNotEvaluated = 0;
  for (const result of results) {
    if (!result) continue; // A cancelled batch may leave unscheduled shards empty.
    if (result.status === "ok") {
      okCount++;
      if (result.complete === true && result.truncated !== true) {
        transportOkCount++;
        // Transport completeness is separate from review eligibility. A claimed
        // PASS or FAIL without valid model/process/cleanup evidence cannot vote.
        if (!reviewVoteEligible(result)) reviewNotEvaluated++;
        else if (result.review_gate === "PASS") reviewPass++;
        else if (result.review_gate === "FAIL") reviewFail++;
        else reviewNotEvaluated++;
      } else truncatedCount++;
    }
    if (result.retried) retriedCount++;
  }
  const transportGate = !interrupted && transportOkCount === shards.length ? "PASS" : "NOT_EVALUATED";
  let gate;
  if (interrupted || args.mode === "chat") gate = "NOT_EVALUATED";
  else if (reviewFail > 0) gate = "FAIL"; // A confirmed finding outranks transport noise.
  else if (reviewPass === shards.length) gate = "PASS";
  else gate = "NOT_EVALUATED";
  const batchStatus = interrupted ? "cancelled" : transportOkCount === shards.length ? "ok" : (transportOkCount > 0 ? "partial" : "failed");
  return {
    status: batchStatus,
    gate,
    transport_gate: transportGate,
    batch: {
      shards: shards.length, ok: okCount, transport_ok: transportOkCount,
      truncated_or_incomplete: truncatedCount, retried: retriedCount,
      review_pass: reviewPass, review_fail: reviewFail, review_not_evaluated: reviewNotEvaluated,
      mode: args.mode,
      paid_retry_authorized: args.allowPaidRetry,
      concurrency: args.concurrency ?? DEFAULT_CONCURRENCY,
      wall_seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    },
  };
}

// ---------------------------------------------------------------------------
// Main — bounded pool over shards, preserving input order in the result.
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`zcode-batch ${VERSION}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(JSON.stringify({ status: "usage", usage: "node zcode-batch.js --prompt-file FILE [--prompt-file FILE ...] | --prompts-dir DIR [--concurrency 2] [--mode chat|review|challenge --evidence-ids-file FILE] [--timeout-seconds 1200] [--cli-path EXECUTABLE] [--receipt-file FILE] [--allow-paid-retry]" }) + "\n");
    return;
  }

  const args = parseArgs(argv);
  if (args.evidenceIdsFile !== null) {
    // Fail fast at the batch level instead of letting every shard spawn a
    // wrapper that dies with input_error on the same malformed ids file.
    let raw;
    const { readUtf8 } = require("./zcode-chat.js");
    try { raw = readUtf8(args.evidenceIdsFile); }
    catch { usageError(`--evidence-ids-file is not readable: ${args.evidenceIdsFile}`); }
    let parsed;
    const { strictJson } = require("./review.js");
    try { parsed = strictJson(raw); }
    catch { usageError("--evidence-ids-file is not valid JSON."); }
    // The upstream validator owns the exact id rules; reuse it so the batch
    // gate cannot drift from the single-shot contract.
    const { validateIds } = require("./review.js");
    try { validateIds(parsed); }
    catch { usageError("--evidence-ids-file must be a nonempty unique array of plain id strings."); }
  }
  const shards = collectShardFiles(args);
  if (args.receiptFile !== null) {
    // Reserve a new writable receipt before starting any model request, and
    // never replace an input file or a previously completed receipt.
    try { receiptFd = fs.openSync(args.receiptFile, "wx", 0o600); }
    catch { usageError("--receipt-file must be a new file in an existing writable directory."); }
  }
  if (!cancelMarker) {
    cancelDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-batch-cancel-"));
    cancelMarker = path.join(cancelDirectory, "cancel.request");
  }
  const timeout = args.timeout ?? DEFAULT_TIMEOUT_SECONDS;

  const fixedArgs = ["--mode", args.mode, "--timeout-seconds", String(timeout)];
  if (args.evidenceIdsFile !== null) fixedArgs.push("--evidence-ids-file", args.evidenceIdsFile);
  if (args.cliPath !== null) fixedArgs.push("--cli-path", args.cliPath);

  const concurrency = args.concurrency ?? DEFAULT_CONCURRENCY;
  const started = Date.now();
  const results = new Array(shards.length);
  let nextIndex = 0;

  async function worker() {
    while (!cancellationRequested()) {
      const index = nextIndex++;
      if (index >= shards.length) return;
      results[index] = await runShardWithRetries(shards[index], fixedArgs, args.allowPaidRetry);
    }
  }
  const poll = setInterval(() => { if (cancellationRequested()) onSignal(); }, 75);
  try { await Promise.all(Array.from({ length: Math.min(concurrency, shards.length) }, worker)); }
  finally {
    clearInterval(poll);
    if (escalation) clearTimeout(escalation);
    cancellationRequested();
    if (cancelDirectory) { try { fs.rmSync(cancelDirectory, { recursive: true, force: true }); } catch {} }
  }

  const envelope = { ...aggregate(results, shards, args, started, { cancelled: cancellationRequested() }), shards: results };
  if (args.receiptFile !== null) {
    envelope.receipt_file = args.receiptFile;
    try {
      fs.writeFileSync(receiptFd, JSON.stringify(envelope, null, 2) + "\n");
      fs.closeSync(receiptFd);
      receiptFd = null;
    } catch (err) {
      delete envelope.receipt_file;
      envelope.status = "receipt_error";
      envelope.gate = "NOT_EVALUATED";
      envelope.transport_gate = "NOT_EVALUATED";
      envelope.receipt_file_write_error = `could not write receipt file: ${err.code || err.message}`;
    }
  }
  if (envelope.status === "ok") emit(envelope);
  else fail(envelope);
}

function onSignal(code) {
  if (emitted || cancellationSent) return;
  cancellationSent = true;
  cancelled = true;
  if (cancelMarker) {
    try { fs.writeFileSync(cancelMarker, "cancel\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") process.exitCode = 1; }
  }
  // Owned wrappers read this marker on every platform. Avoid racing their
  // preflight/receipt handlers with SIGTERM, and cover the 10s version probe.
  if (!escalation) escalation = setTimeout(() => {
    for (const child of liveChildren) {
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, timeout: 2000, stdio: "ignore" });
      }
      try { child.kill("SIGKILL"); } catch {}
    }
  }, 15000);
}

if (require.main === module) {
  process.on("SIGTERM", () => onSignal(143));
  process.on("SIGINT", () => onSignal(130));
  process.on("SIGHUP", () => onSignal(129));
  main().catch(error => {
    fail(error.envelope ?? { status: "batch_error", error: "zcode-batch failed locally." });
  }).finally(() => {
    if (receiptFd !== null) { try { fs.closeSync(receiptFd); } catch {} receiptFd = null; }
    if (cancelDirectory) { try { fs.rmSync(cancelDirectory, { recursive: true, force: true }); } catch {} }
  });
} else {
  module.exports = { parseArgs, collectShardFiles, aggregate, MODES, RETRYABLE };
}
