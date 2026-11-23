#!/usr/bin/env node
// Run a whole cross-validation shard batch in ONE host tool call and emit
// exactly one JSON envelope. Fixes two recurring failures by construction:
//   1. budget: every shard goes through mmx-chat.js, so the wrapper/profile
//      output budget (524288) always applies. The bare `mmx text chat` CLI
//      default of 4096 tokens cannot silently truncate a review any more.
//      A shard that still exhausts its budget (caller passed a small
//      --max-tokens) is retried once at the profile budget, both receipts
//      kept — never hidden.
//   2. concurrency: shards execute through a bounded parallel pool instead
//      of N sequential host tool calls, so wall time is ~ceil(N/concurrency)
//      shard durations, not their sum.
// The batch gate is TRANSPORT-level only: PASS iff every shard returned
// status=ok, complete=true, truncated=false. Finding-level gates (P1/P2)
// stay with the host per SKILL.md. --version stays a plain-text exception.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { terminateChildTree } = require("./mmx-chat.js");

const VERSION = "1.0.0";
const DEFAULT_PROFILE = path.join(__dirname, "..", "profiles", "local.json");
const DEFAULT_WRAPPER = path.join(__dirname, "mmx-chat.js");
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const MAX_SHARDS = 32;
// Test hook only: a production run never overrides the quota backoff.
const QUOTA_RETRY_DELAY_MS = (() => {
  const raw = process.env.MMX_BATCH_QUOTA_RETRY_MS;
  if (raw === undefined) return 30000;
  if (!/^\d+$/.test(raw) || Number(raw) > 30000) return 30000;
  return Number(raw);
})();
const STDOUT_CAP_BYTES = 16 * 1024 * 1024;
const STDERR_CAP_BYTES = 64 * 1024;
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
    maxTokens: null, timeout: null, wrapTimeout: null, profileFile: null, receiptFile: null };
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

const liveChildren = new Set();
let cancelled = false;

function runWrapperOnce(promptFile, fixedArgs) {
  return new Promise(resolve => {
    const wrapperPath = process.env.MMX_BATCH_WRAPPER || DEFAULT_WRAPPER;
    const args = ["--prompt-file", promptFile, ...fixedArgs];
    let child;
    try {
      child = spawn(process.execPath, [wrapperPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
      });
    } catch (err) {
      resolve({ receipt: { status: "child_error", error: `could not spawn wrapper: ${err.code || err.message}` }, duration: 0 });
      return;
    }
    liveChildren.add(child);
    const stdout = [];
    const stderr = [];
    let truncated = false;
    const started = Date.now();
    const absorb = (chunks, counter, chunk, limit) => {
      if (counter.value >= limit) { truncated = true; return; }
      const take = Math.min(chunk.length, limit - counter.value);
      chunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
      counter.value += take;
    };
    const stdoutCounter = { value: 0 };
    const stderrCounter = { value: 0 };
    child.stdout.on("data", chunk => absorb(stdout, stdoutCounter, chunk, STDOUT_CAP_BYTES));
    child.stderr.on("data", chunk => absorb(stderr, stderrCounter, chunk, STDERR_CAP_BYTES));
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
      const errText = Buffer.concat(stderr).toString("utf8").trim();
      if (!outText) {
        resolve({ receipt: {
          status: "child_error", exit_code: code,
          error: "wrapper produced no stdout envelope",
          ...(errText ? { stderr_tail: errText.slice(0, 1000) } : {}),
        }, duration });
        return;
      }
      if (truncated) {
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
// Retry policy — one explicit retry, both receipts kept. Budget retries only
// make sense when the retry target exceeds the effective budget; a shard that
// still truncates at the profile budget is reported honestly for re-sharding.
// ---------------------------------------------------------------------------

async function runShardWithRetries(shard, fixedArgs, effectiveBudget, retryBudget) {
  const first = await runWrapperOnce(shard.file, fixedArgs);
  let retryReason = null;
  let backoffSeconds = 0;
  if (first.receipt.status === "quota_error") retryReason = "quota_error";
  else if ((first.receipt.status === "thinking_budget_exhausted" ||
            (first.receipt.status === "ok" && first.receipt.truncated === true)) &&
           effectiveBudget !== null && retryBudget > effectiveBudget) {
    retryReason = "budget_exhausted";
  }

  if (retryReason === null || cancelled) {
    return { shard: shard.label, prompt_file: shard.file, retried: false, retry_reason: null,
      duration_seconds: first.duration, ...first.receipt };
  }

  let second = first;
  if (retryReason === "quota_error") {
    await new Promise(resolve => setTimeout(resolve, QUOTA_RETRY_DELAY_MS));
    backoffSeconds = QUOTA_RETRY_DELAY_MS / 1000;
    // A cancellation during the backoff must not spawn a new child.
    if (cancelled) {
      return { shard: shard.label, prompt_file: shard.file, retried: false, retry_reason: retryReason,
        retry_backoff_seconds: backoffSeconds, duration_seconds: first.duration + backoffSeconds,
        first_attempt: first.receipt, status: "cancelled", complete: false };
    }
    second = await runWrapperOnce(shard.file, fixedArgs);
  } else {
    // Swap the caller budget for the profile budget on the retry attempt.
    const retryArgs = [...fixedArgs];
    const budgetIndex = retryArgs.indexOf("--max-tokens");
    if (budgetIndex >= 0) retryArgs.splice(budgetIndex, 2);
    retryArgs.push("--max-tokens", String(retryBudget));
    second = await runWrapperOnce(shard.file, retryArgs);
  }

  return {
    shard: shard.label, prompt_file: shard.file, retried: true, retry_reason: retryReason,
    retry_backoff_seconds: backoffSeconds,
    duration_seconds: first.duration + second.duration + backoffSeconds,
    first_attempt: first.receipt,
    ...second.receipt,
  };
}

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
    process.stdout.write(JSON.stringify({ status: "usage", usage: "node mmx-batch.js --prompt-file FILE [--prompt-file FILE ...] | --prompts-dir DIR [--concurrency 2] [--model ID] [--max-tokens N] [--timeout SEC] [--wrap-timeout SEC] [--profile-file FILE] [--receipt-file FILE]" }) + "\n");
    return;
  }

  const args = parseArgs(argv);
  const shards = collectShardFiles(args);
  const profileFile = args.profileFile || DEFAULT_PROFILE;
  const retryBudget = readProfileBudget(profileFile);
  const effectiveBudget = args.maxTokens !== null ? args.maxTokens : retryBudget;

  const fixedArgs = [];
  if (args.profileFile !== null) fixedArgs.push("--profile-file", args.profileFile);
  if (args.model !== null) fixedArgs.push("--model", args.model);
  if (args.maxTokens !== null) fixedArgs.push("--max-tokens", String(args.maxTokens));
  if (args.timeout !== null) fixedArgs.push("--timeout", String(args.timeout));
  if (args.wrapTimeout !== null) fixedArgs.push("--wrap-timeout", String(args.wrapTimeout));

  const concurrency = args.concurrency ?? DEFAULT_CONCURRENCY;
  const started = Date.now();
  const results = new Array(shards.length);
  let nextIndex = 0;

  async function worker() {
    while (!cancelled) {
      const index = nextIndex++;
      if (index >= shards.length) return;
      results[index] = await runShardWithRetries(shards[index], fixedArgs, effectiveBudget, retryBudget);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, shards.length) }, worker));

  let okCount = 0;
  let transportOkCount = 0;
  let truncatedCount = 0;
  let retriedCount = 0;
  for (const result of results) {
    if (!result) continue; // A cancelled batch may leave unscheduled shards empty.
    if (result.status === "ok") {
      okCount++;
      if (result.complete === true && result.truncated !== true) transportOkCount++;
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
    batch: {
      shards: shards.length, ok: okCount, transport_ok: transportOkCount,
      truncated_or_incomplete: truncatedCount, retried: retriedCount,
      concurrency, wall_seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      effective_max_tokens: effectiveBudget, retry_max_tokens: retryBudget,
    },
    shards: results,
  };
  if (args.receiptFile !== null) {
    envelope.receipt_file = args.receiptFile;
    try {
      fs.writeFileSync(args.receiptFile, JSON.stringify(envelope, null, 2) + "\n", { mode: 0o600 });
    } catch (err) {
      delete envelope.receipt_file;
      envelope.receipt_file_write_error = `could not write receipt file: ${err.code || err.message}`;
    }
  }
  if (gate === GATE_PASS) emit(envelope);
  else fail(envelope);
}

function onSignal(code) {
  if (emitted) process.exit(code);
  cancelled = true;
  for (const child of liveChildren) terminateChildTree(child, true, process.platform !== "win32");
  fail({ status: "cancelled", exit_code: code, note: "batch interrupted; shard receipts up to this point are lost" });
}
process.on("SIGTERM", () => onSignal(143));
process.on("SIGINT", () => onSignal(130));
process.on("SIGHUP", () => onSignal(129));

if (require.main === module) {
  main().catch(error => {
    fail(error.envelope ?? { status: "batch_error", error: "mmx-batch failed locally." });
  });
} else {
  module.exports = { parseArgs, collectShardFiles, readProfileBudget };
}
