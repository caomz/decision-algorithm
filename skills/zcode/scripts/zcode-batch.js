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
const { createBatch, limitSeconds, sourceBytes, resolveWrapper } = require("./batch-safety.js");
const { validateReview, strictJson } = require("./review.js");

const VERSION = "1.0.0";
const DEFAULT_WRAPPER = path.join(__dirname, "zcode-chat.js");
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
const MAX_SHARDS = 32;
const DEFAULT_TIMEOUT_SECONDS = 1200;
const MAX_TIMEOUT_SECONDS = 21600;
const MODES = ["chat", "review", "challenge"];
const RETRYABLE = new Set(); // legacy export; no automatic replay

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
    evidenceIdsFile: null, cliPath: null, timeout: null, receiptFile: null, supervisorTimeout: null, batchTimeout: null };
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
      case "--supervisor-timeout-seconds":
      case "--batch-timeout-seconds": {
        const value = next();
        if (!/^\d+$/.test(value) || !limitSeconds(Number(value))) usageError("supervisor/batch timeout must be 1..86400 seconds");
        out[arg === "--supervisor-timeout-seconds" ? "supervisorTimeout" : "batchTimeout"] = Number(value);
        break;
      }
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

let cancelled = false;
let controller = null;

// ---------------------------------------------------------------------------
// Gates — transport usability and content review_gate are separate verdicts.
// ---------------------------------------------------------------------------

function verifiedReviewVote(receipt, evidenceIds) {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0 ||
      receipt.status !== "ok" || receipt.binding_status !== "VERIFIED_LOCAL" || receipt.transport_validation !== "PASS" || receipt.cli_invoked !== true ||
      receipt.wrapper_exit_code !== 0 || receipt.wrapper_signal !== null ||
      receipt.exit_code !== 0 || receipt.signal !== null ||
      receipt.complete !== true || receipt.truncated !== false ||
      receipt.cleanup_confirmed !== true ||
      typeof receipt.model !== "string" || !/^glm(?:[-_.]|$)/i.test(receipt.model) ||
      typeof receipt.provider !== "string" || !receipt.provider.trim() ||
      receipt.model_identity_source !== "runtime.model_request" ||
      receipt.tool_calls !== 0 || receipt.tool_requests !== 0 ||
      !["stop", "end_turn", "stop_sequence"].includes(receipt.stop_reason) ||
      typeof receipt.text !== "string" || !receipt.text.trim()) return null;
  try {
    const checked = validateReview(receipt.text, evidenceIds);
    if (receipt.review_gate !== checked.review_gate ||
        JSON.stringify(receipt.review) !== JSON.stringify(checked.review)) return null;
    return checked.review_gate;
  } catch { return null; }
}

function aggregate(results, shards, args, started) {
  let okCount = 0;
  let transportOkCount = 0;
  let truncatedCount = 0;
  let retriedCount = 0;
  let reviewPass = 0;
  let reviewFail = 0;
  let reviewNotEvaluated = 0;
  let lifecycleOkCount = 0;
  for (const result of results) {
    if (!result) continue; // A cancelled batch may leave unscheduled shards empty.
    if (result.lifecycle_validation === "PASS") lifecycleOkCount++;
    if (result.status === "ok") {
      okCount++;
      if (result.transport_validation === "PASS") {
        transportOkCount++;
        // Only a fully delivered shard may contribute to the content gate: a
        // truncated reply must not vote on the review verdict.
        const vote = verifiedReviewVote(result, args.validatedIds);
        if (vote === "PASS") reviewPass++;
        else if (vote === "FAIL") reviewFail++;
        else reviewNotEvaluated++;
      } else truncatedCount++;
    }
    if (result.retried) retriedCount++;
  }
  const transportGate = transportOkCount === shards.length ? "PASS" : "NOT_EVALUATED";
  let gate;
  if (args.mode === "chat") gate = "NOT_EVALUATED";
  else if (reviewFail > 0) gate = "FAIL"; // A confirmed finding outranks transport noise.
  // A complete content PASS also needs every shard's local cleanup confirmed.
  else if (reviewPass === shards.length && lifecycleOkCount === shards.length) gate = "PASS";
  else gate = "NOT_EVALUATED";
  const batchStatus = transportOkCount === shards.length ? "ok" : (transportOkCount > 0 ? "partial" : "failed");
  return {
    status: batchStatus,
    gate,
    transport_gate: transportGate,
    lifecycle_gate: lifecycleOkCount === shards.length ? "PASS" : "NOT_EVALUATED",
    batch: {
      shards: shards.length, ok: okCount, transport_ok: transportOkCount,
      truncated_or_incomplete: truncatedCount, retried: retriedCount,
      review_pass: reviewPass, review_fail: reviewFail, review_not_evaluated: reviewNotEvaluated,
      lifecycle_ok: lifecycleOkCount,
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
    process.stdout.write(JSON.stringify({ status: "usage", usage: "node zcode-batch.js --prompt-file FILE [--prompt-file FILE ...] | --prompts-dir DIR [--concurrency 1] [--mode chat|review|challenge --evidence-ids-file FILE] [--timeout-seconds 1200] [--cli-path EXECUTABLE] [--receipt-file FILE] [--supervisor-timeout-seconds SEC] [--batch-timeout-seconds SEC]" }) + "\n");
    return;
  }

  const args = parseArgs(argv);
  let idsBytes = null;
  if (args.evidenceIdsFile !== null) {
    // Fail fast at the batch level instead of letting every shard spawn a
    // wrapper that dies with input_error on the same malformed ids file.
    let raw;
    try { raw = sourceBytes(args.evidenceIdsFile); idsBytes = raw; }
    catch { usageError(`--evidence-ids-file is not readable: ${args.evidenceIdsFile}`); }
    let parsed;
    try { parsed = JSON.parse(raw.toString("utf8")); }
    catch { usageError("--evidence-ids-file is not valid JSON."); }
    // The upstream validator owns the exact id rules; reuse it so the batch
    // gate cannot drift from the single-shot contract.
    const { validateIds } = require("./review.js");
    try { args.validatedIds = validateIds(parsed); }
    catch { usageError("--evidence-ids-file must be a nonempty unique array of plain id strings."); }
  }
  const shards = collectShardFiles(args);
  const timeout = args.timeout ?? DEFAULT_TIMEOUT_SECONDS;

  const fixedArgs = ["--mode", args.mode, "--timeout-seconds", String(timeout)];
  if (args.cliPath !== null) fixedArgs.push("--cli-path", args.cliPath);

  const started = Date.now();
  const supervisorSeconds = args.supervisorTimeout ?? timeout + 45;
  // Resolve the per-shard wrapper before any evidence directory is reserved.
  let wrapper;
  try { wrapper = resolveWrapper(process.env, "zcode", DEFAULT_WRAPPER); }
  catch (error) { fail({ status: "usage_error", gate: "NOT_EVALUATED", transport_gate: "NOT_EVALUATED", error: error.message }); return; }
  try { controller = createBatch({ side: "zcode", args, shards, fixedArgs,
    configFiles: idsBytes === null ? [] : [{ flag: "--evidence-ids-file", bytes: idsBytes, name: "evidence.json" }],
    supervisorSeconds, parseReceipt: strictJson }); }
  catch { fail({ status: "archive_error", gate: "NOT_EVALUATED", transport_gate: "NOT_EVALUATED", error: "could not reserve or snapshot batch evidence" }); return; }
  await new Promise(resolve => setImmediate(resolve));
  if (cancelled) controller.stop("cancelled");
  const results = await controller.run(wrapper);

  const envelope = { ...aggregate(results, shards, args, started), shards: results };
  controller.finalize(envelope);
  if (envelope.status === "ok") emit(envelope);
  else fail(envelope);
}

function onSignal() {
  if (emitted || cancelled) return;
  cancelled = true;
  controller?.stop("cancelled");
}
if (require.main === module) {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, onSignal);
  main().catch(error => {
    fail(error.envelope ?? { status: "batch_error", error: "zcode-batch failed locally." });
  });
} else {
  module.exports = { parseArgs, collectShardFiles, aggregate, verifiedReviewVote, MODES, RETRYABLE };
}
