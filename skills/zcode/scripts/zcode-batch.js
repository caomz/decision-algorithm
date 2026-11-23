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
const os = require("os");
const { spawn } = require("child_process");
const { strictJson, validateReview, validateIds } = require("./review.js");

const VERSION = "1.0.0";
const DEFAULT_WRAPPER = path.join(__dirname, "zcode-chat.js");
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const MAX_SHARDS = 32;
const DEFAULT_TIMEOUT_SECONDS = 1200;
const MAX_TIMEOUT_SECONDS = 21600;
const RETRY_DELAY_MS = 30000;
const STDOUT_CAP_BYTES = 16 * 1024 * 1024;
const MODES = ["chat", "review", "challenge"];
const RETRYABLE = new Set(["quota_error"]);

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


function claimArchive(file) {
  // Even callers without --receipt-file get a private, crash-retained archive.
  // Never silently run an unarchived billed request.
  if (file === null) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-batch-evidence-"));
    file = path.join(root, "receipt.json");
  }
  // O_EXCL prevents following symlinks and overwriting existing evidence.
  // The reserved file is intentionally left in place after any failure.
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    const dir = file + ".shards";
    fs.mkdirSync(dir, { mode: 0o700 });
    return { fd, file, dir };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function saveShardReceipt(archive, index, receipt) {
  if (!archive) return;
  const file = path.join(archive.dir, String(index).padStart(3, "0") + ".json");
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(receipt, null, 2) + "\n", null, "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function finishArchive(archive, envelope) {
  if (!archive) return;
  try {
    fs.writeSync(archive.fd, JSON.stringify(envelope, null, 2) + "\n", null, "utf8");
    fs.fsyncSync(archive.fd);
  } finally { fs.closeSync(archive.fd); }
}
function archiveErrorCode(err) {
  return typeof err?.code === "string" ? err.code : "IO";
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
    evidenceIdsFile: null, cliPath: null, timeout: null, maxOutputTokens: null, receiptFile: null, allowPaidRetry: false };
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
      case "--max-output-tokens": {
        const value = next();
        if (!/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > 524288) usageError("--max-output-tokens must be in 1..524288.");
        out.maxOutputTokens = Number(value);
        break;
      }
      case "--timeout-seconds": {
        const value = next();
        if (!/^\d+$/.test(value) || !positiveInteger(Number(value))) {
          usageError("--timeout-seconds must be a positive integer.");
        }
        out.timeout = Number(value);
        break;
      }
      case "--receipt-file": out.receiptFile = path.resolve(next()); break;
      // Only a per-invocation flag may authorize a possible second paid request.
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
let signalRequested = false;
let cancellationEscalation = null;

function runWrapperOnce(promptFile, fixedArgs) {
  return new Promise(resolve => {
    const args = [DEFAULT_WRAPPER, "--prompt-file", promptFile, ...fixedArgs];
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
    child.on("close", (code, signal) => {
      liveChildren.delete(child);
      const duration = (Date.now() - started) / 1000;
      if (cancelled) {
        resolve({ receipt: { status: "cancelled", wrapper_exit_code: code, wrapper_signal: signal }, duration });
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
      try { receipt = strictJson(outText); }
      catch {
        resolve({ receipt: { status: "child_error", exit_code: code, error: "wrapper stdout was not valid JSON" }, duration });
        return;
      }
      if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt) ||
          typeof receipt.status !== "string") {
        resolve({ receipt: { status: "child_error", exit_code: code, error: "wrapper envelope is not a JSON object with a status" }, duration });
        return;
      }
      // A clean stdout reply is never evidence that its wrapper exited cleanly.
      // Keep diagnostic content but disqualify an abnormal wrapper process.
      if (code !== 0 || signal !== null) {
        resolve({ receipt: { status: "child_error", wrapper_exit_code: code, wrapper_signal: signal,
          diagnostic_receipt: receipt, error: "wrapper process did not exit cleanly" }, duration });
        return;
      }
      resolve({ receipt: { ...receipt, wrapper_exit_code: code, wrapper_signal: signal }, duration });
    });
  });
}

// ---------------------------------------------------------------------------
// Default: one possibly billed provider request per shard. Retrying an
// unknown remote outcome always requires explicit authorization. First-attempt
// receipts remain available when the caller opts into a second attempt.
// ---------------------------------------------------------------------------

async function runShardWithRetries(shard, fixedArgs, allowPaidRetry) {
  const first = await runWrapperOnce(shard.file, fixedArgs);
  // Local cleanup/timeout never proves the remote provider did not execute.
  if (!allowPaidRetry || !RETRYABLE.has(first.receipt.status) || cancelled) {
    return { shard: shard.label, prompt_file: shard.file, retried: false, retry_reason: null,
      ...(first.receipt.status === "timeout" ? { retry_skipped_reason: "remote_outcome_unknown" } :
        !allowPaidRetry && RETRYABLE.has(first.receipt.status) ? { retry_skipped_reason: "paid_retry_not_authorized" } : {}),
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

// Review votes are independently derived from the original text, never from
// the wrapper's review_gate alone. This stays outside the cross-review runner
// to avoid a large dependency/call cycle.
function verifiedReviewVote(receipt, evidenceIds) {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0 ||
      receipt.status !== "ok" || receipt.cli_invoked !== true ||
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
  for (const result of results) {
    if (!result) continue; // A cancelled batch may leave unscheduled shards empty.
    if (result.status === "ok") {
      okCount++;
      if (result.complete === true && result.truncated !== true) {
        transportOkCount++;
        // Independently revalidate schema, evidence IDs, native model identity,
        // wrapper exit and descendant cleanup before accepting a content vote.
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
      mode: args.mode, paid_retry_authorized: args.allowPaidRetry,
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
    process.stdout.write(JSON.stringify({ status: "usage", usage: "node zcode-batch.js --prompt-file FILE [--prompt-file FILE ...] | --prompts-dir DIR [--concurrency 2] [--mode chat|review|challenge --evidence-ids-file FILE] [--timeout-seconds 1200] [--max-output-tokens N] [--cli-path EXECUTABLE] [--receipt-file FILE] [--allow-paid-retry]" }) + "\n");
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
    try { parsed = strictJson(raw.toString("utf8")); }
    catch { usageError("--evidence-ids-file is not valid strict JSON."); }
    try { args.validatedIds = validateIds(parsed); }
    catch { usageError("--evidence-ids-file must be a nonempty unique array of plain id strings."); }
  }
  const shards = collectShardFiles(args);
  const timeout = args.timeout ?? DEFAULT_TIMEOUT_SECONDS;

  const fixedArgs = ["--mode", args.mode, "--timeout-seconds", String(timeout)];
  if (args.evidenceIdsFile !== null) fixedArgs.push("--evidence-ids-file", args.evidenceIdsFile);
  if (args.cliPath !== null) fixedArgs.push("--cli-path", args.cliPath);
  if (args.maxOutputTokens !== null) fixedArgs.push("--max-output-tokens", String(args.maxOutputTokens));

  // Claim the final receipt BEFORE a wrapper may send any provider request.
  let archive;
  try { archive = claimArchive(args.receiptFile); }
  catch (error) { fail({ status: "archive_error", gate: "NOT_EVALUATED",
    error: "cannot exclusively reserve receipt archive", code: archiveErrorCode(error) }); return; }
  let archiveFailure = null;
  const concurrency = args.concurrency ?? DEFAULT_CONCURRENCY;
  const started = Date.now();
  const results = new Array(shards.length);
  let nextIndex = 0;

  async function worker() {
    while (!cancelled && !archiveFailure) {
      const index = nextIndex++;
      if (index >= shards.length) return;
      results[index] = await runShardWithRetries(shards[index], fixedArgs, args.allowPaidRetry);
      try { saveShardReceipt(archive, index, results[index]); }
      catch (error) { archiveFailure = archiveFailure || archiveErrorCode(error); }
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(concurrency, shards.length) }, worker)); }
  finally { if (cancellationEscalation) clearTimeout(cancellationEscalation); }

  const envelope = { ...aggregate(results, shards, args, started), shards: results };
  if (cancelled) {
    envelope.status = "cancelled";
    envelope.gate = "NOT_EVALUATED";
    envelope.transport_gate = "NOT_EVALUATED";
    envelope.note = "Completed shards retained; uncertain requests must not be replayed.";
  }
  if (archive) envelope.receipt_file = archive.file;
  if (archiveFailure) {
    envelope.status = "archive_error";
    envelope.gate = "NOT_EVALUATED";
    envelope.archive_error = archiveFailure;
  }
  if (archive) {
    try { finishArchive(archive, envelope); }
    catch (error) {
      envelope.status = "archive_error";
      envelope.gate = "NOT_EVALUATED";
      envelope.archive_error = archiveErrorCode(error);
      envelope.note = "Original requests may have been sent; do not replay.";
    }
  }
  if (envelope.status === "archive_error") fail(envelope);
  else if (envelope.status === "ok") emit(envelope);
  else fail(envelope);
}

function onSignal(code) {
  if (emitted || signalRequested) return;
  signalRequested = true;
  cancelled = true;
  // Signal owned wrappers cooperatively but let main publish the COMPLETE
  // batch receipt after all in-flight shards settle. Never emit from here.
  for (const child of liveChildren) { try { child.kill("SIGTERM"); } catch {} }
  cancellationEscalation = setTimeout(() => {
    for (const child of liveChildren) {
      try { child.kill("SIGKILL"); } catch {}
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
    }
  }, 12000);
  cancellationEscalation.unref();
}
process.on("SIGTERM", () => onSignal(143));
process.on("SIGINT", () => onSignal(130));
process.on("SIGHUP", () => onSignal(129));

if (require.main === module) {
  main().catch(error => {
    fail(error.envelope ?? { status: "batch_error", error: "zcode-batch failed locally." });
  });
} else {
  module.exports = { parseArgs, collectShardFiles, aggregate, verifiedReviewVote, MODES, RETRYABLE };
}
