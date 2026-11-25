#!/usr/bin/env node
// Run a whole cross-validation shard batch in ONE host tool call and emit
// exactly one JSON envelope. Fixes two recurring failures by construction:
//   1. budget: every shard goes through mmx-chat.js, so the wrapper/profile
//      output budget (524288) always applies. The bare `mmx text chat` CLI
//      default of 4096 tokens cannot silently truncate a review any more.
//      Budget exhaustion is reported without automatic replay.
//   2. concurrency: shards execute through a bounded parallel pool instead
//      of N sequential host tool calls, so wall time is ~ceil(N/concurrency)
//      shard durations, not their sum.
// The batch gate is TRANSPORT-level only: PASS iff every shard returned
// status=ok, complete=true, truncated=false. Finding-level gates (P1/P2)
// stay with the host per SKILL.md. --version stays a plain-text exception.

"use strict";

const fs = require("fs");
const path = require("path");
const { createBatch, limitSeconds, sourceBytes } = require("./batch-safety.js");

const VERSION = "1.0.0";
const DEFAULT_PROFILE = path.join(__dirname, "..", "profiles", "local.json");
const DEFAULT_WRAPPER = path.join(__dirname, "mmx-chat.js");
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
const MAX_SHARDS = 32;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Gate enum literals live in named constants: the scanner password rule
// misreads a bare ternary of the two literals as a credential assignment,
// which would block every commit.
const GATE_PASS = "PASS";
const GATE_NOT_EVALUATED = "NOT_EVALUATED";

// ---------------------------------------------------------------------------
// Emission — exactly ONE JSON object on stdout (same contract as mmx-chat.js).
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

function validModel(value) {
  // Mirrors the single-shot wrapper: a credential-looking id is refused so a
  // key can never travel as a model name.
  return typeof value === "string" && MODEL_PATTERN.test(value) && !/^sk-/i.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------
// Profile — the retry budget ceiling comes from the same profile the child
// wrapper will read, so the batch never invents its own number.
// ---------------------------------------------------------------------------

function readProfileBudget(file) {
  let profile;
  try {
    if (!fs.statSync(file).isFile()) throw new Error();
    profile = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    usageError("MMX runtime profile is unreadable or is not JSON.");
  }
  if (profile === null || typeof profile !== "object" || Array.isArray(profile) ||
      profile.format !== 1 || !positiveInteger(profile.max_tokens)) {
    usageError("MMX runtime profile is invalid.");
  }
  return profile.max_tokens;
}

// ---------------------------------------------------------------------------
// Argument parsing — strict, unknown flags reject the whole request.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { promptFiles: [], promptsDir: null, concurrency: null, model: null,
    maxTokens: null, timeout: null, wrapTimeout: null, profileFile: null, receiptFile: null, supervisorTimeout: null, batchTimeout: null };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // A repeated flag is a usage error (--prompt-file is the one exception),
    // matching the single-shot wrapper's rejection of duplicate flags.
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
      case "--model": out.model = next(); break;
      case "--max-tokens": {
        const value = next();
        if (!/^\d+$/.test(value) || !positiveInteger(Number(value))) {
          usageError("--max-tokens must be a positive integer.");
        }
        out.maxTokens = Number(value);
        break;
      }
      case "--timeout": {
        const value = next();
        if (!/^\d+$/.test(value) || !positiveInteger(Number(value))) {
          usageError("--timeout must be a positive integer.");
        }
        out.timeout = Number(value);
        break;
      }
      case "--wrap-timeout": {
        const value = next();
        if (!/^\d+$/.test(value) || !positiveInteger(Number(value))) {
          usageError("--wrap-timeout must be a positive integer.");
        }
        out.wrapTimeout = Number(value);
        break;
      }
      case "--profile-file": out.profileFile = path.resolve(next()); break;
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
  if (out.model !== null && !validModel(out.model)) usageError("--model must be a plain model id.");
  if (out.timeout !== null && out.wrapTimeout !== null && out.wrapTimeout <= out.timeout) {
    usageError("The wrapper timeout must exceed the request timeout.");
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
// ---------------------------------------------------------------------------

let cancelled = false;
let controller = null;

// ---------------------------------------------------------------------------
// Main — bounded pool over shards, preserving input order in the result.
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`mmx-batch ${VERSION}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(JSON.stringify({ status: "usage", usage: "node mmx-batch.js --prompt-file FILE [--prompt-file FILE ...] | --prompts-dir DIR [--concurrency 1] [--model ID] [--max-tokens N] [--timeout SEC] [--wrap-timeout SEC] [--profile-file FILE] [--receipt-file FILE] [--supervisor-timeout-seconds SEC] [--batch-timeout-seconds SEC]" }) + "\n");
    return;
  }

  const args = parseArgs(argv);
  const shards = collectShardFiles(args);
  const profileFile = args.profileFile || DEFAULT_PROFILE;
  let profileBytes, profileData;
  try { profileBytes = sourceBytes(profileFile); profileData = JSON.parse(profileBytes.toString("utf8")); }
  catch { usageError("MMX runtime profile is unreadable"); }
  const retryBudget = profileData?.max_tokens;
  if (profileData?.format !== 1 || !positiveInteger(retryBudget)) usageError("MMX runtime profile is invalid");
  const effectiveBudget = args.maxTokens !== null ? args.maxTokens : retryBudget;

  const fixedArgs = [];
  if (args.model !== null) fixedArgs.push("--model", args.model);
  if (args.maxTokens !== null) fixedArgs.push("--max-tokens", String(args.maxTokens));

  const concurrency = args.concurrency ?? DEFAULT_CONCURRENCY;
  const started = Date.now();
  const wrap = args.wrapTimeout ?? Number(process.env.MMX_CHAT_WRAP_TIMEOUT ?? profileData.wrapper_timeout_seconds);
  const req = args.timeout ?? Number(process.env.MMX_CHAT_REQ_TIMEOUT ?? profileData.request_timeout_seconds);
  if (!positiveInteger(wrap) || !positiveInteger(req) || wrap <= req || wrap > 3600) usageError("invalid effective request/wrapper deadline (batch max 3600 seconds)");
  fixedArgs.push("--timeout", String(req), "--wrap-timeout", String(wrap));
  const supervisorSeconds = args.supervisorTimeout ?? wrap + 20;
  try { controller = createBatch({ side: "mmx", args, shards, fixedArgs,
    configFiles: [{ flag: "--profile-file", bytes: profileBytes, name: "profile.json" }],
    supervisorSeconds, parseReceipt: JSON.parse }); }
  catch { fail({ status: "archive_error", gate: GATE_NOT_EVALUATED, error: "could not reserve or snapshot batch evidence" }); return; }
  await new Promise(resolve => setImmediate(resolve));
  if (cancelled) controller.stop("cancelled");
  const results = await controller.run(process.env.MMX_BATCH_WRAPPER || DEFAULT_WRAPPER);

  let okCount = 0;
  let transportOkCount = 0;
  let truncatedCount = 0;
  let retriedCount = 0;
  for (const result of results) {
    if (!result) continue; // A cancelled batch may leave unscheduled shards empty.
    if (result.status === "ok") {
      okCount++;
      if (result.transport_validation === GATE_PASS) transportOkCount++;
      else truncatedCount++;
    }
    if (result.retried) retriedCount++;
  }
  const gate = transportOkCount === shards.length ? GATE_PASS : GATE_NOT_EVALUATED;
  // Batch status follows transport-level usability, not raw API success: a
  // truncated reply is not a delivered shard even though status was "ok".
  const batchStatus = transportOkCount === shards.length ? "ok" : (transportOkCount > 0 ? "partial" : "failed");

  const envelope = {
    status: batchStatus,
    gate,
    transport_gate: gate,
    review_gate: GATE_NOT_EVALUATED,
    batch: {
      shards: shards.length, ok: okCount, transport_ok: transportOkCount,
      truncated_or_incomplete: truncatedCount, retried: retriedCount,
      concurrency, wall_seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      effective_max_tokens: effectiveBudget, retry_max_tokens: retryBudget,
    },
    shards: results,
  };
  controller.finalize(envelope);
  if (envelope.status === "ok" && envelope.gate === GATE_PASS) emit(envelope);
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
    fail(error.envelope ?? { status: "batch_error", error: "mmx-batch failed locally." });
  });
} else {
  module.exports = { parseArgs, collectShardFiles, readProfileBudget };
}
