"use strict";

// Offline contract tests for mmx-batch.js. No real model calls: every shard
// is served by a fake wrapper (MMX_BATCH_WRAPPER) that scripts replies from
// the prompt content and a per-shard invocation counter.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const skillRoot = path.resolve(__dirname, "..");
const batch = path.join(skillRoot, "scripts", "mmx-batch.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-batch-contract-"));
const fakeWrapper = path.join(root, "fake-wrapper.cjs");
const argsDump = path.join(root, "args-dump.txt");
const stateDir = path.join(root, "state");

fs.mkdirSync(stateDir);
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
fs.writeFileSync(fakeWrapper, `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const promptIndex = argv.indexOf("--prompt-file");
const promptFile = argv[promptIndex + 1];
const prompt = fs.readFileSync(promptFile, "utf8");
const counterFile = path.join(process.env.FAKE_STATE_DIR, path.basename(promptFile));
let invocations = 0;
try { invocations = Number(fs.readFileSync(counterFile, "utf8")) || 0; } catch {}
fs.writeFileSync(counterFile, String(invocations + 1));
if (process.env.FAKE_ARGS_DUMP) fs.appendFileSync(process.env.FAKE_ARGS_DUMP, argv.join(" ") + "\\n");
const ok = extra => Object.assign({
  status: "ok", text: "REPLY:" + prompt.trim().slice(0, 30), model: "Fake-M3",
  model_identity_source: "response.model", stop_reason: "end_turn",
  complete: true, truncated: false, input_tokens: 12, output_tokens: 34, exit_code: 0,
}, extra);
const emit = receipt => { process.stdout.write(JSON.stringify(receipt) + "\\n"); process.exitCode = 0; };
if (prompt.includes("CHILD_ERR")) { process.stdout.write("definitely not json"); process.exitCode = 1; return; }
if (prompt.includes("FAIL_SHARD")) { emit({ status: "api_error", error: "upstream failed", exit_code: 1 }); return; }
if (prompt.includes("TRUNCATE") && invocations === 0) { emit(ok({ stop_reason: "max_tokens", complete: false, truncated: true })); process.exitCode = 1; return; }
if (prompt.includes("THINK") && invocations === 0) { emit({ status: "thinking_budget_exhausted", exit_code: 1, note: "budget consumed by thinking" }); process.exitCode = 1; return; }
if (prompt.includes("QUOTA") && invocations === 0) { emit({ status: "quota_error", error: "rate limited", exit_code: 1 }); process.exitCode = 1; return; }
emit(ok());
`);

function runBatch(args, extraEnv = {}) {
  return spawnSync(process.execPath, [batch, ...args], {
    encoding: "utf8", windowsHide: true, shell: false,
    env: { ...process.env, MMX_BATCH_WRAPPER: fakeWrapper, FAKE_STATE_DIR: stateDir,
           FAKE_ARGS_DUMP: argsDump, MMX_BATCH_QUOTA_RETRY_MS: "10", ...extraEnv },
  });
}

function receiptOf(run) {
  assert.ok(run.status === 0 || run.status === 1, `batch spawn failed: ${run.stderr}`);
  assert.ok(run.stdout.trim().length > 0, "batch produced no stdout envelope");
  return JSON.parse(run.stdout.trim().split("\n").pop());
}

function shardFile(name, content) {
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  return file;
}

test("usage: rejects a request with no shard source", () => {
  const run = runBatch([]);
  assert.equal(run.status, 1);
  assert.equal(receiptOf(run).status, "usage_error");
});

test("--help prints usage and exits 0 without touching a wrapper", () => {
  const run = runBatch(["--help"]);
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).status, "usage");
});

test("usage: rejects --prompt-file combined with --prompts-dir", () => {
  const run = runBatch(["--prompt-file", shardFile("x.txt", "hi"), "--prompts-dir", root]);
  assert.equal(receiptOf(run).status, "usage_error");
});

test("usage: rejects unknown flags entirely", () => {
  const run = runBatch(["--prompt-file", shardFile("x.txt", "hi"), "--evil", "1"]);
  assert.equal(receiptOf(run).status, "usage_error");
});

test("usage: rejects duplicate prompt files", () => {
  const file = shardFile("dup.txt", "hi");
  const run = runBatch(["--prompt-file", file, "--prompt-file", file]);
  assert.equal(receiptOf(run).status, "usage_error");
});

test("usage: rejects a missing prompt file", () => {
  const run = runBatch(["--prompt-file", path.join(root, "nope.txt")]);
  assert.equal(receiptOf(run).status, "usage_error");
});

test("usage: concurrency outside 1..8 is refused", () => {
  const run = runBatch(["--prompt-file", shardFile("x.txt", "hi"), "--concurrency", "9"]);
  assert.equal(receiptOf(run).status, "usage_error");
});

test("usage: a credential-looking --model is refused like the single-shot wrapper", () => {
  const run = runBatch(["--prompt-file", shardFile("x.txt", "hi"), "--model", "sk-secret-value"]);
  assert.equal(receiptOf(run).status, "usage_error");
});

test("usage: a repeated flag is refused instead of silently taking the last value", () => {
  const file = shardFile("x.txt", "hi");
  const run = runBatch(["--prompt-file", file, "--concurrency", "2", "--concurrency", "4"]);
  assert.equal(receiptOf(run).status, "usage_error");
});

test("all shards ok: gate PASS, input order preserved", () => {
  const files = [shardFile("p2.txt", "second shard"), shardFile("p1.txt", "first shard")];
  const run = runBatch(["--prompt-file", files[0], "--prompt-file", files[1], "--concurrency", "2"]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0);
  assert.equal(receipt.gate, "PASS");
  assert.equal(receipt.status, "ok");
  assert.deepEqual(receipt.shards.map(s => s.shard), ["p2", "p1"]);
  assert.equal(receipt.batch.transport_ok, 2);
});

test("one truncated shard: gate NOT_EVALUATED and exit code 1", () => {
  // TRUNCATE with a budget already at the profile ceiling: no retry can help.
  const files = [shardFile("a.txt", "good shard"), shardFile("b.txt", "TRUNCATE shard")];
  const run = runBatch(["--prompt-file", files[0], "--prompt-file", files[1]]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.gate, "NOT_EVALUATED");
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.batch.truncated_or_incomplete, 1);
});

test("failed shard: batch failed gate, honest per-shard status", () => {
  const run = runBatch(["--prompt-file", shardFile("f.txt", "FAIL_SHARD")]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.gate, "NOT_EVALUATED");
  assert.equal(receipt.shards[0].status, "api_error");
});

test("budget retry: small caller budget heals at the profile budget, both receipts kept", () => {
  const dumpLines = fs.existsSync(argsDump) ? fs.readFileSync(argsDump, "utf8").split("\n").filter(Boolean) : [];
  const before = dumpLines.length;
  const run = runBatch(["--prompt-file", shardFile("t.txt", "THINK hard shard"), "--max-tokens", "128"]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0);
  assert.equal(receipt.gate, "PASS");
  const shard = receipt.shards[0];
  assert.equal(shard.retried, true);
  assert.equal(shard.retry_reason, "budget_exhausted");
  assert.equal(shard.first_attempt.status, "thinking_budget_exhausted");
  assert.equal(shard.status, "ok");
  const lines = fs.readFileSync(argsDump, "utf8").split("\n").filter(Boolean).slice(before);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("--max-tokens 128"));
  assert.ok(lines[1].includes("--max-tokens 524288"));
});

test("truncation at the profile budget: no pointless retry", () => {
  // Caller budget equals the profile ceiling, so a retry cannot raise it.
  const run = runBatch(["--prompt-file", shardFile("n.txt", "TRUNCATE anyway"), "--max-tokens", "524288"]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.shards[0].retried, false);
  assert.equal(receipt.shards[0].truncated, true);
});

test("quota retry: one backoff retry then ok", () => {
  const run = runBatch(["--prompt-file", shardFile("q.txt", "QUOTA limited shard")]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0);
  const shard = receipt.shards[0];
  assert.equal(shard.retried, true);
  assert.equal(shard.retry_reason, "quota_error");
  assert.equal(shard.status, "ok");
  assert.ok(shard.retry_backoff_seconds > 0);
});

test("child garbage stdout: child_error without a batch crash", () => {
  const run = runBatch(["--prompt-file", shardFile("g.txt", "CHILD_ERR shard")]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.shards[0].status, "child_error");
});

test("--prompts-dir: .txt files only, natural order, receipts written to disk", () => {
  const dir = path.join(root, "shards");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "p1.txt"), "dir one");
  fs.writeFileSync(path.join(dir, "p2.txt"), "dir two");
  fs.writeFileSync(path.join(dir, "p10.txt"), "dir ten");
  fs.writeFileSync(path.join(dir, "ignored.md"), "not a shard");
  const receiptPath = path.join(root, "receipt.json");
  const run = runBatch(["--prompts-dir", dir, "--receipt-file", receiptPath]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0);
  assert.equal(receipt.gate, "PASS");
  assert.deepEqual(receipt.shards.map(s => s.shard), ["p1", "p2", "p10"]);
  assert.equal(receipt.receipt_file, receiptPath);
  assert.ok(fs.statSync(receiptPath).isFile());
  const onDisk = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.deepEqual(onDisk.shards.map(s => s.shard), ["p1", "p2", "p10"]);
  assert.equal(onDisk.receipt_file, receiptPath, "on-disk receipt carries the same receipt_file field as stdout");
});

test("module exports: parseArgs / collectShardFiles contracts", () => {
  const { parseArgs, collectShardFiles, readProfileBudget } = require(path.join(skillRoot, "scripts", "mmx-batch.js"));
  const parsed = parseArgs(["--prompt-file", "a.txt", "--concurrency", "3"]);
  assert.equal(parsed.concurrency, 3);
  assert.throws(() => parseArgs(["--nope"]), /Unknown flag/);
  const dir = path.join(root, "exports");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "same.txt"), "one");
  assert.throws(() => collectShardFiles({ promptFiles: [path.join(dir, "same.txt"), path.join(dir, "same.txt")], promptsDir: null }), /Duplicate/);
  const labels = collectShardFiles({ promptFiles: [path.join(root, "p2.txt"), path.join(root, "p1.txt")], promptsDir: null });
  assert.deepEqual(labels.map(s => s.label), ["p2", "p1"]);
  assert.equal(readProfileBudget(path.join(skillRoot, "profiles", "local.json")), 524288);
});
