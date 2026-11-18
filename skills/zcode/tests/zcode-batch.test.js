"use strict";

// Offline contract tests for zcode-batch.js. No real model calls: every shard
// is served by a fake wrapper (ZCODE_BATCH_WRAPPER) that scripts replies from
// the prompt content and a per-shard invocation counter.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const skillRoot = path.resolve(__dirname, "..");
const batch = path.join(skillRoot, "scripts", "zcode-batch.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-batch-contract-"));
const fakeWrapper = path.join(root, "fake-wrapper.cjs");
const argsDump = path.join(root, "args-dump.txt");
const concLog = path.join(root, "conc.log");
const stateDir = path.join(root, "state");
const idsFile = path.join(root, "ids.json");

fs.mkdirSync(stateDir);
fs.writeFileSync(idsFile, JSON.stringify([{ id: "E1", quote: "evidence one" }]));
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
  status: "ok", cli_invoked: true, exit_code: 0, signal: null, complete: true,
  model: "Fake-GLM", stop_reason: "stop", truncated: false,
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  review_gate: "NOT_EVALUATED", artifacts_dir: "C:\\\\fake\\\\zcode-text-fake",
  cleanup_confirmed: true, text: "REPLY:" + prompt.trim().slice(0, 30),
}, extra);
const emit = receipt => { process.stdout.write(JSON.stringify(receipt) + "\\n"); };
if (prompt.includes("CONC_PROBE")) {
  if (process.env.FAKE_CONC_LOG) fs.appendFileSync(process.env.FAKE_CONC_LOG, "START " + process.pid + " " + Date.now() + "\\n");
  setTimeout(() => {
    if (process.env.FAKE_CONC_LOG) fs.appendFileSync(process.env.FAKE_CONC_LOG, "END " + process.pid + " " + Date.now() + "\\n");
    emit(ok());
  }, 250);
  return;
}
if (prompt.includes("CHILD_ERR")) { process.stdout.write("definitely not json"); process.exitCode = 1; return; }
if (prompt.includes("REVIEW_PASS")) { emit(ok({ review_gate: "PASS" })); return; }
if (prompt.includes("REVIEW_FAIL")) { emit(ok({ review_gate: "FAIL" })); return; }
if (prompt.includes("AUTH_ERR")) { emit({ status: "auth_error", cli_invoked: false, complete: false, review_gate: "NOT_EVALUATED", error: "auth failed" }); return; }
if (prompt.includes("POLICY_ERR")) { emit({ status: "policy_violation", cli_invoked: true, complete: false, review_gate: "NOT_EVALUATED", error: "tool used" }); return; }
if (prompt.includes("TRUNC")) { emit(ok({ truncated: true, complete: false, stop_reason: "max_tokens" })); return; }
if (prompt.includes("QUOTA_ONCE") && invocations === 0) { emit({ status: "quota_error", cli_invoked: true, complete: false, review_gate: "NOT_EVALUATED", error: "rate limited" }); return; }
if (prompt.includes("TIMEOUT_ONCE") && invocations === 0) { emit({ status: "timeout", cli_invoked: true, complete: false, review_gate: "NOT_EVALUATED", error: "timed out" }); return; }
if (prompt.includes("QUOTA_ALWAYS")) { emit({ status: "quota_error", cli_invoked: true, complete: false, review_gate: "NOT_EVALUATED", error: "rate limited" }); return; }
emit(ok());
`);

function runBatch(args, extraEnv = {}) {
  return spawnSync(process.execPath, [batch, ...args], {
    encoding: "utf8", windowsHide: true, shell: false,
    env: { ...process.env, ZCODE_BATCH_WRAPPER: fakeWrapper, FAKE_STATE_DIR: stateDir,
           FAKE_ARGS_DUMP: argsDump, FAKE_CONC_LOG: concLog, ZCODE_BATCH_RETRY_MS: "10", ...extraEnv },
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
  assert.equal(receiptOf(runBatch([])).status, "usage_error");
});

test("usage: rejects --prompt-file combined with --prompts-dir", () => {
  const run = runBatch(["--prompt-file", shardFile("x.txt", "hi"), "--prompts-dir", root]);
  assert.equal(receiptOf(run).status, "usage_error");
});

test("usage: rejects unknown flags entirely", () => {
  assert.equal(receiptOf(runBatch(["--prompt-file", shardFile("x.txt", "hi"), "--evil", "1"])).status, "usage_error");
});

test("usage: rejects duplicate prompt files", () => {
  const file = shardFile("dup.txt", "hi");
  assert.equal(receiptOf(runBatch(["--prompt-file", file, "--prompt-file", file])).status, "usage_error");
});

test("usage: rejects a missing prompt file", () => {
  assert.equal(receiptOf(runBatch(["--prompt-file", path.join(root, "nope.txt")])).status, "usage_error");
});

test("usage: concurrency outside 1..8 is refused", () => {
  assert.equal(receiptOf(runBatch(["--prompt-file", shardFile("x.txt", "hi"), "--concurrency", "9"])).status, "usage_error");
});

test("usage: mode and evidence-id combinations follow the single-shot contract", () => {
  const file = shardFile("x.txt", "hi");
  assert.equal(receiptOf(runBatch(["--prompt-file", file, "--mode", "review"])).status, "usage_error");
  assert.equal(receiptOf(runBatch(["--prompt-file", file, "--mode", "chat", "--evidence-ids-file", idsFile])).status, "usage_error");
  assert.equal(receiptOf(runBatch(["--prompt-file", file, "--mode", "bogus"])).status, "usage_error");
});

test("usage: a missing evidence-ids file fails fast at the batch level", () => {
  const file = shardFile("x.txt", "hi");
  const missing = path.join(root, "no-such-ids.json");
  const run = runBatch(["--prompt-file", file, "--mode", "review", "--evidence-ids-file", missing]);
  assert.equal(receiptOf(run).status, "usage_error");
  assert.ok(run.stderr === "", "no wrapper is spawned for a batch-level usage error");
});

test("pass-through: mode, evidence ids, cli path and timeout reach every shard", () => {
  const before = fs.existsSync(argsDump) ? fs.readFileSync(argsDump, "utf8").split("\n").filter(Boolean).length : 0;
  const file = shardFile("pt.txt", "plain shard");
  const run = runBatch(["--prompt-file", file, "--mode", "review", "--evidence-ids-file", idsFile,
    "--cli-path", "C:\\fake\\zcode.cmd", "--timeout-seconds", "123"]);
  assert.equal(run.status, 0);
  const line = fs.readFileSync(argsDump, "utf8").split("\n").filter(Boolean).slice(before)[0];
  assert.ok(line.includes("--mode review"));
  assert.ok(line.includes("--evidence-ids-file"));
  assert.ok(line.includes("--cli-path"));
  assert.ok(line.includes("--timeout-seconds 123"));
});

test("all shards PASS: content and transport gates PASS, input order preserved", () => {
  const files = [shardFile("r2.txt", "REVIEW_PASS two"), shardFile("r1.txt", "REVIEW_PASS one")];
  const run = runBatch(["--prompt-file", files[0], "--prompt-file", files[1], "--mode", "review", "--evidence-ids-file", idsFile, "--concurrency", "2"]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0);
  assert.equal(receipt.gate, "PASS");
  assert.equal(receipt.transport_gate, "PASS");
  assert.equal(receipt.status, "ok");
  assert.deepEqual(receipt.shards.map(s => s.shard), ["r2", "r1"]);
  assert.equal(receipt.batch.review_pass, 2);
});

test("PASS plus FAIL: content gate FAIL but the batch still exits 0", () => {
  const files = [shardFile("g1.txt", "REVIEW_PASS fine"), shardFile("g2.txt", "REVIEW_FAIL blocker")];
  const run = runBatch(["--prompt-file", files[0], "--prompt-file", files[1], "--mode", "review", "--evidence-ids-file", idsFile]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0, "a confirmed finding is a valid review result, not a transport failure");
  assert.equal(receipt.gate, "FAIL");
  assert.equal(receipt.transport_gate, "PASS");
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.batch.review_fail, 1);
});

test("PASS plus NOT_EVALUATED: content gate stays NOT_EVALUATED", () => {
  const files = [shardFile("n1.txt", "REVIEW_PASS ok"), shardFile("n2.txt", "plain reply")];
  const run = runBatch(["--prompt-file", files[0], "--prompt-file", files[1], "--mode", "review", "--evidence-ids-file", idsFile]);
  const receipt = receiptOf(run);
  assert.equal(receipt.gate, "NOT_EVALUATED");
  assert.equal(receipt.transport_gate, "PASS");
});

test("chat mode: transport PASS but content gate never claims a review verdict", () => {
  const run = runBatch(["--prompt-file", shardFile("c.txt", "plain chat")]);
  const receipt = receiptOf(run);
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.transport_gate, "PASS");
  assert.equal(receipt.gate, "NOT_EVALUATED");
  assert.equal(receipt.batch.mode, "chat");
});

test("content FAIL survives a transport failure on another shard", () => {
  const files = [shardFile("f1.txt", "REVIEW_FAIL blocker"), shardFile("f2.txt", "TRUNC incomplete")];
  const run = runBatch(["--prompt-file", files[0], "--prompt-file", files[1], "--mode", "review", "--evidence-ids-file", idsFile]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.gate, "FAIL", "a confirmed finding is not masked by transport noise");
  assert.equal(receipt.transport_gate, "NOT_EVALUATED");
  assert.equal(receipt.status, "partial");
});

test("truncated shard: transport NOT_EVALUATED and counted", () => {
  const run = runBatch(["--prompt-file", shardFile("t.txt", "TRUNC shard")]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.transport_gate, "NOT_EVALUATED");
  assert.equal(receipt.batch.truncated_or_incomplete, 1);
});

test("quota retry: one backoff retry then ok, first attempt kept", () => {
  const run = runBatch(["--prompt-file", shardFile("q.txt", "QUOTA_ONCE shard")]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0);
  const shard = receipt.shards[0];
  assert.equal(shard.retried, true);
  assert.equal(shard.retry_reason, "quota_error");
  assert.equal(shard.first_attempt.status, "quota_error");
  assert.equal(shard.status, "ok");
  assert.ok(shard.retry_backoff_seconds > 0);
});

test("timeout retry: one backoff retry then ok", () => {
  const run = runBatch(["--prompt-file", shardFile("to.txt", "TIMEOUT_ONCE shard")]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0);
  assert.equal(receipt.shards[0].retry_reason, "timeout");
  assert.equal(receipt.shards[0].status, "ok");
});

test("persistent quota failure: exactly two attempts, no third", () => {
  const file = shardFile("qa.txt", "QUOTA_ALWAYS shard");
  const run = runBatch(["--prompt-file", file]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.shards[0].retried, true);
  assert.equal(receipt.shards[0].status, "quota_error");
  assert.equal(fs.readFileSync(path.join(stateDir, "qa.txt"), "utf8"), "2");
});

test("auth and policy failures are never retried", () => {
  for (const [name, marker, status] of [["auth.txt", "AUTH_ERR", "auth_error"], ["pol.txt", "POLICY_ERR", "policy_violation"]]) {
    const file = shardFile(name, marker + " shard");
    const run = runBatch(["--prompt-file", file]);
    const receipt = receiptOf(run);
    assert.equal(receipt.shards[0].status, status);
    assert.equal(receipt.shards[0].retried, false);
    assert.equal(fs.readFileSync(path.join(stateDir, name), "utf8"), "1");
  }
});

test("garbage stdout becomes child_error without crashing the batch", () => {
  const run = runBatch(["--prompt-file", shardFile("ce.txt", "CHILD_ERR shard")]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.shards[0].status, "child_error");
  assert.equal(receipt.shards[0].error, "wrapper stdout was not valid JSON");
});

test("--prompts-dir: .txt only, natural order, receipt file mirrors stdout", () => {
  const dir = path.join(root, "shards");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "p1.txt"), "REVIEW_PASS one");
  fs.writeFileSync(path.join(dir, "p2.txt"), "REVIEW_PASS two");
  fs.writeFileSync(path.join(dir, "p10.txt"), "REVIEW_PASS ten");
  fs.writeFileSync(path.join(dir, "ignored.md"), "not a shard");
  const receiptPath = path.join(root, "receipt.json");
  const run = runBatch(["--prompts-dir", dir, "--mode", "review", "--evidence-ids-file", idsFile, "--receipt-file", receiptPath]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0);
  assert.equal(receipt.gate, "PASS");
  assert.deepEqual(receipt.shards.map(s => s.shard), ["p1", "p2", "p10"]);
  const onDisk = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(onDisk.receipt_file, receiptPath);
  assert.deepEqual(onDisk.shards.map(s => s.shard), ["p1", "p2", "p10"]);
});

test("actual parallelism never exceeds --concurrency", () => {
  if (fs.existsSync(concLog)) fs.unlinkSync(concLog);
  const files = ["c1.txt", "c2.txt", "c3.txt", "c4.txt"].map(name => shardFile(name, "CONC_PROBE " + name));
  const run = runBatch(["--prompt-file", files[0], "--prompt-file", files[1], "--prompt-file", files[2], "--prompt-file", files[3], "--concurrency", "2"]);
  assert.equal(run.status, 0);
  const events = fs.readFileSync(concLog, "utf8").split("\n").filter(Boolean)
    .map(line => { const [kind, pid, ts] = line.split(" "); return { kind, pid, ts: Number(ts) }; });
  let active = 0;
  let peak = 0;
  for (const event of events.sort((a, b) => a.ts - b.ts)) {
    if (event.kind === "START") { active++; peak = Math.max(peak, active); }
    else active--;
  }
  assert.equal(peak, 2, `peak concurrency was ${peak}, expected exactly 2`);
});
