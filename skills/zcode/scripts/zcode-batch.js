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
const path = require("path");
const { spawn } = require("child_process");

const VERSION = "1.0.0";
const DEFAULT_WRAPPER = path.join(__dirname, "zcode-chat.js");
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const MAX_SHARDS = 32;
const DEFAULT_TIMEOUT_SECONDS = 600;
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
    evidenceIdsFile: null, cliPath: null, timeout: null, receiptFile: null };
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
      .filter(name => name.endsWith(".txt"))
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
    let real;
    try { real = fs.realpathSync(file); }
    catch { usageError(`Prompt file not found: ${file}`); }
    if (seen.has(real)) usageError(`Duplicate prompt file: ${file}`);
    seen.add(real);
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

function runWrapperOnce(promptFile, fixedArgs) {
  return new Promise(resolve => {
    const wrapperPath = process.env.ZCODE_BATCH_WRAPPER || DEFAULT_WRAPPER;
    const args = [wrapperPath, "--prompt-file", promptFile, ...fixedArgs];
    let child;
    try {
      child = spawn(process.execPath, args, {
        stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
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
    child.on("close", code => {
      liveChildren.delete(child);
      const duration = (Date.now() - started) / 1000;
      if (cancelled) {
        resolve({ receipt: { status: "cancelled", exit_code: code }, duration });
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
      resolve({ receipt, duration });
    });
  });
}

// ---------------------------------------------------------------------------
// Retry policy — one explicit retry for clearly terminated transport failures
// (quota/timeout) with backoff; both receipts kept. Auth, policy, schema and
// content-level FAIL are never retried.
// ---------------------------------------------------------------------------

async function runShardWithRetries(shard, fixedArgs) {
  const first = await runWrapperOnce(shard.file, fixedArgs);
  if (!RETRYABLE.has(first.receipt.status) || cancelled) {
    return { shard: shard.label, prompt_file: shard.file, retried: false, retry_reason: null,
      duration_seconds: first.duration, ...first.receipt };
  }
  const retryReason = first.receipt.status;
  await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
  // A cancellation during the backoff must not spawn a new child.
  if (cancelled) {
    return { shard: shard.label, prompt_file: shard.file, retried: false, retry_reason: retryReason,
      retry_backoff_seconds: RETRY_DELAY_MS / 1000,
      duration_seconds: first.duration + RETRY_DELAY_MS / 1000,
      first_attempt: first.receipt, status: "cancelled", complete: false };
  }
  const second = await runWrapperOnce(shard.file, fixedArgs);
  return {
    shard: shard.label, prompt_file: shard.file, retried: true, retry_reason: retryReason,
    retry_backoff_seconds: RETRY_DELAY_MS / 1000,
    duration_seconds: first.duration + second.duration + RETRY_DELAY_MS / 1000,
    first_attempt: first.receipt,
    ...second.receipt,
  };
}

// ---------------------------------------------------------------------------
// Gates — transport usability and content review_gate are separate verdicts.
// ---------------------------------------------------------------------------

function aggregate(results, shards, args, started) {
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
        // Only a fully delivered shard may contribute to the content gate: a
        // truncated reply must not vote on the review verdict.
        if (result.review_gate === "PASS") reviewPass++;
        else if (result.review_gate === "FAIL") reviewFail++;
        else reviewNotEvaluated++;
      } else truncatedCount++;
    }
    if (result.retried) retriedCount++;
  }
  const transportGate = transportOkCount === shards.length ? "PASS" : "NOT_EVALUATED";
  let gate;
  if (args.mode === "chat") gate = "NOT_EVALUATED";
  else if (reviewFail > 0) gate = "FAIL"; // A confirmed finding outranks transport noise.
  else if (reviewPass === shards.length) gate = "PASS";
  else gate = "NOT_EVALUATED";
  const batchStatus = transportOkCount === shards.length ? "ok" : (transportOkCount > 0 ? "partial" : "failed");
  return {
    status: batchStatus,
    gate,
    transport_gate: transportGate,
    batch: {
      shards: shards.length, ok: okCount, transport_ok: transportOkCount,
      truncated_or_incomplete: truncatedCount, retried: retriedCount,
      review_pass: reviewPass, review_fail: reviewFail, review_not_evaluated: reviewNotEvaluated,
      mode: args.mode,
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
    process.stdout.write(JSON.stringify({ status: "usage", usage: "node zcode-batch.js --prompt-file FILE [--prompt-file FILE ...] | --prompts-dir DIR [--concurrency 2] [--mode chat|review|challenge --evidence-ids-file FILE] [--timeout-seconds 600] [--cli-path EXECUTABLE] [--receipt-file FILE]" }) + "\n");
    return;
  }

  const args = parseArgs(argv);
  if (args.evidenceIdsFile !== null) {
    // Fail fast at the batch level instead of letting every shard spawn a
    // wrapper that dies with input_error on the same malformed ids file.
    let raw;
    try { raw = fs.readFileSync(args.evidenceIdsFile); }
    catch { usageError(`--evidence-ids-file is not readable: ${args.evidenceIdsFile}`); }
    let parsed;
    try { parsed = JSON.parse(raw.toString("utf8")); }
    catch { usageError("--evidence-ids-file is not valid JSON."); }
    // The upstream validator owns the exact id rules; reuse it so the batch
    // gate cannot drift from the single-shot contract.
    const { validateIds } = require("./review.js");
    try { validateIds(parsed); }
    catch { usageError("--evidence-ids-file must be a nonempty unique array of plain id strings."); }
  }
  const shards = collectShardFiles(args);
  const timeout = args.timeout ?? DEFAULT_TIMEOUT_SECONDS;

  const fixedArgs = ["--mode", args.mode, "--timeout-seconds", String(timeout)];
  if (args.evidenceIdsFile !== null) fixedArgs.push("--evidence-ids-file", args.evidenceIdsFile);
  if (args.cliPath !== null) fixedArgs.push("--cli-path", args.cliPath);

  const concurrency = args.concurrency ?? DEFAULT_CONCURRENCY;
  const started = Date.now();
  const results = new Array(shards.length);
  let nextIndex = 0;

  async function worker() {
    while (!cancelled) {
      const index = nextIndex++;
      if (index >= shards.length) return;
      results[index] = await runShardWithRetries(shards[index], fixedArgs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, shards.length) }, worker));

  const envelope = { ...aggregate(results, shards, args, started), shards: results };
  if (args.receiptFile !== null) {
    envelope.receipt_file = args.receiptFile;
    try {
      fs.writeFileSync(args.receiptFile, JSON.stringify(envelope, null, 2) + "\n", { mode: 0o600 });
    } catch (err) {
      delete envelope.receipt_file;
      envelope.receipt_file_write_error = `could not write receipt file: ${err.code || err.message}`;
    }
  }
  if (envelope.status === "ok") emit(envelope);
  else fail(envelope);
}

function onSignal(code) {
  if (emitted) process.exit(code);
  cancelled = true;
  // Ask each wrapper to stop; the wrapper owns CLI cleanup and receipt writes.
  for (const child of liveChildren) { try { child.kill("SIGTERM"); } catch {} }
  fail({ status: "cancelled", transport_gate: "NOT_EVALUATED", gate: "NOT_EVALUATED",
    note: "batch interrupted; shard receipts up to this point are lost" });
}
process.on("SIGTERM", () => onSignal(143));
process.on("SIGINT", () => onSignal(130));
process.on("SIGHUP", () => onSignal(129));

if (require.main === module) {
  main().catch(error => {
    fail(error.envelope ?? { status: "batch_error", error: "zcode-batch failed locally." });
  });
} else {
  module.exports = { parseArgs, collectShardFiles, aggregate, MODES, RETRYABLE };
}
