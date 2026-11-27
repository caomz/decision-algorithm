"use strict";

// Offline contract tests for zcode-batch.js. No real model calls: every shard
// is served by a fake wrapper (ZCODE_BATCH_WRAPPER) that scripts replies from
// the prompt content and a per-shard invocation counter.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { cleanEnv, fixtureEnv } = require("./support/env.js");

const skillRoot = path.resolve(__dirname, "..");
const batch = path.join(skillRoot, "scripts", "zcode-batch.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-batch-contract-"));
const archiveTmp = path.join(root, "archives"); fs.mkdirSync(archiveTmp);
const fakeWrapper = path.join(root, "fake-wrapper.cjs");
const argsDump = path.join(root, "args-dump.txt");
const concLog = path.join(root, "conc.log");
const stateDir = path.join(root, "state");
const idsFile = path.join(root, "ids.json");

fs.mkdirSync(stateDir);
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
// The upstream validator requires a nonempty unique array of plain id
// STRINGS; an object array is rejected as input_error.
fs.writeFileSync(idsFile, JSON.stringify(["E1", "E2"]));
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
  model: "GLM-5.3-Flash", provider: "ZCode", model_identity_source: "runtime.model_request",
  tool_calls: 0, tool_requests: 0, stop_reason: "stop", truncated: false,
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  review_gate: "NOT_EVALUATED", artifacts_dir: "C:\\\\fake\\\\zcode-text-fake",
  cleanup_confirmed: true, text: "REPLY:" + prompt.trim().slice(0, 30),
}, extra);
const passReview = { version: 1, summary: "Checked: unit; Not checkable: none", findings: [] };
const failReview = { version: 1, summary: "Checked: unit; Not checkable: none", findings: [{
  kind: "confirmed_defect", severity: "P1", title: "defect", evidence_refs: ["E1"],
  condition: "a", impact: "b", recommendation: "c",
}] };
const reviewed = (review, gate, extra = {}) => ok({
  text: JSON.stringify(review), review, review_gate: gate, ...extra,
});
const digest = data => require("node:crypto").createHash("sha256").update(data).digest("hex");
const configIndex = argv.indexOf("--evidence-ids-file");
const bind = receipt => ({ ...receipt, batch_attempt_id: process.env.ZMX_BATCH_ATTEMPT_ID,
  batch_material_sha256: digest(fs.readFileSync(promptFile)),
  batch_config_sha256: configIndex < 0 ? "" : digest(fs.readFileSync(argv[configIndex + 1])) });
const emit = receipt => { process.stdout.write(JSON.stringify(bind(receipt)) + "\\n"); };
if (prompt.includes("CONC_PROBE")) {
  if (process.env.FAKE_CONC_LOG) fs.appendFileSync(process.env.FAKE_CONC_LOG, "START " + process.pid + " " + Date.now() + "\\n");
  setTimeout(() => {
    if (process.env.FAKE_CONC_LOG) fs.appendFileSync(process.env.FAKE_CONC_LOG, "END " + process.pid + " " + Date.now() + "\\n");
    emit(ok());
  }, 250);
  return;
}
if (prompt.includes("OK_SIGNAL_EXIT")) {
  process.stdout.write(JSON.stringify(bind(ok())) + "\\n", () => process.kill(process.pid, "SIGTERM")); return;
}
if (prompt.includes("BAD_CLI_SIGNAL")) { emit(ok({ signal: "SIGTERM" })); return; }
if (prompt.includes("MISSING_TRUNCATED")) { const receipt = ok(); delete receipt.truncated; emit(receipt); return; }
if (prompt.includes("OUTPUT_OVERFLOW")) { process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1024, 32)); return; }
if (prompt.includes("CRASH_HOLD")) { setTimeout(() => {}, 2500); return; }
if (prompt.includes("WRONG_BINDING")) { process.stdout.write(JSON.stringify(ok()) + "\\n"); return; }
if (prompt.includes("HANG_WRAPPER")) { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); return; }
if (prompt.includes("PIPE_HOLDER")) {
  // Finite, test-owned child keeps the inherited pipe open after the wrapper exits.
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{},11000)"],
    { stdio: ["ignore", process.stdout, process.stderr], detached: true, windowsHide: true });
  child.unref(); emit(ok()); return;
}
if (prompt.includes("CHILD_ERR")) { process.stdout.write("definitely not json"); process.exitCode = 1; return; }
if (prompt.includes("REVIEW_BAD_EXIT")) { emit(reviewed(passReview, "PASS")); process.exitCode = 9; return; }
if (prompt.includes("REVIEW_BAD_SIGNAL")) { emit(reviewed(passReview, "PASS")); process.kill(process.pid, "SIGTERM"); return; }
if (prompt.includes("REVIEW_DUP_KEY")) { process.stdout.write('{"status":"ok","status":"ok","review_gate":"PASS"}\\n'); return; }
if (prompt.includes("REVIEW_FAKE_GATE")) { emit(reviewed(passReview, "FAIL")); return; }
if (prompt.includes("REVIEW_CLEANUP_NULL")) { emit(reviewed(passReview, "PASS", { cleanup_confirmed: null })); return; }
if (prompt.includes("REVIEW_MODEL_FALSE")) { emit(reviewed(passReview, "PASS", { model_identity_source: "environment" })); return; }
if (prompt.includes("REVIEW_TOOLS")) { emit(reviewed(passReview, "PASS", { tool_calls: 1 })); return; }
if (prompt.includes("REVIEW_PASS")) { emit(reviewed(passReview, "PASS")); return; }
if (prompt.includes("REVIEW_FAIL")) { emit(reviewed(failReview, "FAIL")); return; }
if (prompt.includes("AUTH_ERR")) { emit({ status: "auth_error", cli_invoked: false, complete: false, review_gate: "NOT_EVALUATED", error: "auth failed" }); return; }
if (prompt.includes("POLICY_ERR")) { emit({ status: "policy_violation", cli_invoked: true, complete: false, review_gate: "NOT_EVALUATED", error: "tool used" }); return; }
if (prompt.includes("TRUNC")) { emit(ok({ truncated: true, complete: false, stop_reason: "max_tokens", review_gate: "PASS" })); return; }
if (prompt.includes("QUOTA_ONCE") && invocations === 0) { emit({ status: "quota_error", cli_invoked: true, complete: false, review_gate: "NOT_EVALUATED", error: "rate limited" }); return; }
if (prompt.includes("TIMEOUT_ONCE") && invocations === 0) { emit({ status: "timeout", cli_invoked: true, complete: false, review_gate: "NOT_EVALUATED", error: "timed out" }); return; }
if (prompt.includes("QUOTA_ALWAYS")) { emit({ status: "quota_error", cli_invoked: true, complete: false, review_gate: "NOT_EVALUATED", error: "rate limited" }); return; }
emit(ok());
`);

function runBatch(args, extraEnv = {}) {
  return spawnSync(process.execPath, [batch, ...args], {
    encoding: "utf8", windowsHide: true, shell: false, timeout: 20000,
    env: cleanEnv({ TMPDIR: archiveTmp, TMP: archiveTmp, TEMP: archiveTmp, ...fixtureEnv("zcode", fakeWrapper), FAKE_STATE_DIR: stateDir,
                    FAKE_ARGS_DUMP: argsDump, FAKE_CONC_LOG: concLog, ZCODE_BATCH_RETRY_MS: "10", ...extraEnv }),
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

test("usage: a malformed evidence-ids file fails fast at the batch level", () => {
  const file = shardFile("x.txt", "hi");
  const bad = path.join(root, "bad-ids.json");
  fs.writeFileSync(bad, JSON.stringify([{ id: "E1", quote: "q" }]));
  const run = runBatch(["--prompt-file", file, "--mode", "review", "--evidence-ids-file", bad]);
  assert.equal(receiptOf(run).status, "usage_error");
});

test("usage: a repeated flag is refused instead of silently taking the last value", () => {
  const file = shardFile("x.txt", "hi");
  const run = runBatch(["--prompt-file", file, "--mode", "chat", "--mode", "review"]);
  assert.equal(receiptOf(run).status, "usage_error");
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

test("a truncated shard must not vote on the content gate", () => {
  // TRUNC replies with complete=false but a review_gate of its own; a shard
  // that was not fully delivered must not contribute to the review verdict.
  const files = [shardFile("tv.txt", "REVIEW_PASS delivered"), shardFile("tv2.txt", "TRUNC partial")];
  const run = runBatch(["--prompt-file", files[0], "--prompt-file", files[1], "--mode", "review", "--evidence-ids-file", idsFile]);
  const receipt = receiptOf(run);
  assert.equal(receipt.transport_gate, "NOT_EVALUATED");
  assert.equal(receipt.batch.review_pass, 1, "only the fully delivered shard votes");
  assert.equal(receipt.batch.truncated_or_incomplete, 1);
  assert.equal(receipt.gate, "NOT_EVALUATED", "a truncated shard cannot make the batch PASS");
});

test("default quota and timeout failures never replay", () => {
  for (const [name, marker, status] of [["q.txt","QUOTA_ONCE","quota_error"],["to.txt","TIMEOUT_ONCE","timeout"],["qa.txt","QUOTA_ALWAYS","quota_error"]]) {
    const run = runBatch(["--prompt-file", shardFile(name, marker + " shard")]);
    const receipt = receiptOf(run);
    assert.equal(run.status, 1);
    assert.equal(receipt.shards[0].status, status);
    assert.equal(receipt.shards[0].retried, false);
    assert.equal(fs.readFileSync(path.join(stateDir, name), "utf8"), "1");
  }
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

test("Phase 2: archive is exclusive and contains independently bound shard evidence", () => {
  const p = shardFile("phase2-archive.txt", "synthetic success");
  const output = path.join(root, "phase2-receipt.json");
  const run = runBatch(["--prompt-file", p, "--receipt-file", output]);
  const envelope = receiptOf(run);
  assert.equal(run.status, 0);
  const plan = JSON.parse(fs.readFileSync(output + ".shards/plan.json", "utf8"));
  const shard = JSON.parse(fs.readFileSync(output + ".shards/000.json", "utf8"));
  const intent = JSON.parse(fs.readFileSync(output + ".shards/000.started.json", "utf8"));
  assert.equal(plan.shards[0].request_state, "NOT_STARTED");
  assert.equal(intent.request_state, "UNKNOWN");
  assert.equal(shard.attempt_id, plan.shards[0].attempt_id);
  assert.equal(shard.request_sha256, plan.shards[0].request_sha256);
  assert.equal(shard.material_sha256, require("node:crypto").createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
  assert.equal(shard.binding_status, "VERIFIED_LOCAL");
  const raw = fs.readFileSync(path.join(output + ".shards", shard.raw_receipt_file));
  assert.equal(require("node:crypto").createHash("sha256").update(raw).digest("hex"), shard.captured_stdout_sha256);
  assert.equal(JSON.parse(raw).batch_material_sha256, shard.material_sha256);
  const snapshot = fs.readFileSync(path.join(output + ".shards", plan.shards[0].snapshot));
  assert.equal(require("node:crypto").createHash("sha256").update(snapshot).digest("hex"), shard.material_sha256);
  assert.equal(JSON.parse(raw).batch_attempt_id, shard.attempt_id);
  assert.equal(shard.transport_validation, "PASS");
  assert.equal(shard.wrapper_exit_code, 0);
  assert.deepEqual(shard, envelope.shards[0]);
  const again = receiptOf(runBatch(["--prompt-file", p, "--receipt-file", output]));
  assert.equal(again.status, "archive_error");
  assert.equal(fs.readFileSync(path.join(stateDir, "phase2-archive.txt"), "utf8"), "1");
});
test("Phase 2: missing binding and successful JSON followed by abnormal exit cannot PASS", () => {
  for (const [name, marker] of [["p2-unbound.txt", "WRONG_BINDING"], ["p2-exit.txt", "REVIEW_BAD_EXIT"]]) {
    const result = receiptOf(runBatch(["--prompt-file", shardFile(name, marker)]));
    assert.equal(result.shards[0].status, "child_error");
    assert.equal(result.gate, "NOT_EVALUATED");
    assert.equal(result.shards[0].transport_validation, "NOT_EVALUATED");
  }
});
test("Phase 2: supervisor bounds an unresponsive wrapper without replay", { timeout: 16000 }, () => {
  const before = Date.now();
  const result = receiptOf(runBatch(["--prompt-file", shardFile("p2-hang.txt", "HANG_WRAPPER"),
    "--supervisor-timeout-seconds", "1", "--batch-timeout-seconds", "12"]));
  assert.equal(result.shards[0].status, "timeout");
  assert.equal(result.shards[0].supervisor_timeout_origin, "supervisor");
  assert.equal(result.shards[0].request_state, "UNKNOWN");
  assert.equal(result.shards[0].provider_remote_state, "UNKNOWN");
  assert.equal(result.shards[0].retried, false);
  assert.equal(result.gate, "NOT_EVALUATED");
  assert.ok(Date.now() - before < 15000);
});
test("Phase 2: batch budget prevents new shard launch after expiration", { timeout: 16000 }, () => {
  const files = [shardFile("p2-first.txt", "HANG_WRAPPER"), shardFile("p2-queued.txt", "never launched")];
  const result = receiptOf(runBatch([...files.flatMap(f => ["--prompt-file", f]), "--concurrency", "1",
    "--supervisor-timeout-seconds", "12", "--batch-timeout-seconds", "1"]));
  assert.equal(result.status, "timeout");
  assert.equal(result.shards[0].request_state, "UNKNOWN");
  assert.equal(result.shards[1].request_state, "NOT_STARTED");
  assert.equal(fs.existsSync(path.join(stateDir, "p2-queued.txt")), false);
});
test("Phase 2: inherited pipe cannot keep the supervisor waiting for close", { timeout: 16000 }, () => {
  const result = receiptOf(runBatch(["--prompt-file", shardFile("p2-pipe.txt", "PIPE_HOLDER"),
    "--supervisor-timeout-seconds", "1", "--batch-timeout-seconds", "12"]));
  assert.equal(result.shards[0].status, "timeout");
  assert.equal(result.shards[0].wrapper_exit_observed, true);
  assert.equal(result.shards[0].wrapper_close_observed, false);
  assert.equal(result.shards[0].supervisor_tree_cleanup, "UNKNOWN");
  assert.equal(result.gate, "NOT_EVALUATED");
});
test("Phase 2: repeated cancellation preserves completed evidence and prevents queued work",
  { skip: process.platform === "win32" && "POSIX signal fixture; native Windows marker/console test pending", timeout: 20000 }, async () => {
  const a = shardFile("p2-cancel-a.txt", "completed");
  const b = shardFile("p2-cancel-b.txt", "HANG_WRAPPER");
  const c = shardFile("p2-cancel-c.txt", "queued");
  const output = path.join(root, "p2-cancel.json");
  const child = spawn(process.execPath, [batch, "--prompt-file", a, "--prompt-file", b, "--prompt-file", c,
    "--concurrency", "1", "--receipt-file", output], { stdio: ["ignore","pipe","pipe"],
    env: cleanEnv({ ...fixtureEnv("zcode", fakeWrapper), FAKE_STATE_DIR: stateDir,
      TMPDIR: archiveTmp, TMP: archiveTmp, TEMP: archiveTmp }) });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const terminal = new Promise(resolve => child.once("close", (code, signal) => resolve({code, signal})));
  try {
    for (let i=0; i<200 && !(fs.existsSync(output+".shards/000.json") && fs.existsSync(path.join(stateDir,"p2-cancel-b.txt"))); i++)
      await new Promise(resolve=>setTimeout(resolve,25));
    assert.ok(fs.existsSync(output+".shards/000.json"));
    assert.ok(fs.existsSync(path.join(stateDir,"p2-cancel-b.txt")));
    const first = JSON.parse(fs.readFileSync(output+".shards/000.json","utf8"));
    assert.equal(first.transport_validation,"PASS");
    child.kill("SIGTERM"); child.kill("SIGTERM");
    const ended = await terminal;
    assert.equal(ended.code,1);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.status,"cancelled");
    assert.deepEqual(receipt.shards[0],first);
    assert.equal(receipt.shards[1].request_state,"UNKNOWN");
    assert.equal(receipt.shards[2].request_state,"NOT_STARTED");
    assert.equal(fs.existsSync(path.join(stateDir,"p2-cancel-c.txt")),false);
  } finally { if (child.exitCode===null && child.signalCode===null) child.kill("SIGTERM"); }
});

test("Phase 2: contradictory CLI signal or missing truncation is rejected", () => {
  for (const marker of ["BAD_CLI_SIGNAL","MISSING_TRUNCATED"]) {
    const result = receiptOf(runBatch(["--prompt-file", shardFile("p2-"+marker+".txt", marker)]));
    assert.equal(result.shards[0].status,"child_error");
    assert.equal(result.shards[0].transport_validation,"NOT_EVALUATED");
    assert.equal(result.gate,"NOT_EVALUATED");
  }
});
test("Phase 2: success JSON followed by actual signal exit cannot pass",
  { skip: process.platform === "win32" && "POSIX signal fixture; native Windows verification pending" }, () => {
  const result = receiptOf(runBatch(["--prompt-file", shardFile("p2-signal.txt","OK_SIGNAL_EXIT")]));
  assert.equal(result.shards[0].status,"child_error");
  assert.equal(result.shards[0].wrapper_signal,"SIGTERM");
  assert.equal(result.gate,"NOT_EVALUATED");
});
test("Phase 2: partially captured oversized chunk fails closed", () => {
  const result = receiptOf(runBatch(["--prompt-file", shardFile("p2-overflow.txt","OUTPUT_OVERFLOW")]));
  assert.equal(result.shards[0].status,"child_error");
  assert.equal(result.shards[0].capture_truncated,true);
  assert.equal(result.gate,"NOT_EVALUATED");
});
test("Phase 2: abrupt batch crash leaves completed shard and unknown intent",
  { skip: process.platform === "win32" && "POSIX crash fixture; native Windows verification pending", timeout: 12000 }, async () => {
  const a = shardFile("p2-crash-a.txt","completed");
  const b = shardFile("p2-crash-b.txt","CRASH_HOLD");
  const c = shardFile("p2-crash-c.txt","queued");
  const output = path.join(root,"p2-crash.json");
  const child = spawn(process.execPath,[batch,"--prompt-file",a,"--prompt-file",b,"--prompt-file",c,
    "--concurrency","1","--receipt-file",output], {stdio:["ignore","pipe","pipe"],
    env:cleanEnv({ ...fixtureEnv("zcode", fakeWrapper), FAKE_STATE_DIR:stateDir,
      TMPDIR:archiveTmp,TMP:archiveTmp,TEMP:archiveTmp })});
  child.stdout.resume(); child.stderr.resume();
  const terminal = new Promise(resolve=>child.once("close",(code,signal)=>resolve({code,signal})));
  try {
    for(let i=0;i<200 && !(fs.existsSync(output+".shards/000.json") &&
      fs.existsSync(path.join(stateDir,"p2-crash-b.txt")));i++) await new Promise(resolve=>setTimeout(resolve,25));
    assert.ok(fs.existsSync(output+".shards/000.json"));
    assert.ok(fs.existsSync(path.join(stateDir,"p2-crash-b.txt")));
    child.kill("SIGKILL");
    assert.equal((await terminal).signal,"SIGKILL");
    const first=JSON.parse(fs.readFileSync(output+".shards/000.json","utf8"));
    const raw=fs.readFileSync(path.join(output+".shards",first.raw_receipt_file));
    assert.equal(require("node:crypto").createHash("sha256").update(raw).digest("hex"),first.captured_stdout_sha256);
    assert.equal(first.transport_validation,"PASS");
    assert.equal(JSON.parse(fs.readFileSync(output+".shards/001.started.json","utf8")).request_state,"UNKNOWN");
    assert.equal(fs.existsSync(output+".shards/001.json"),false);
    assert.equal(fs.existsSync(output+".shards/002.started.json"),false);
    assert.equal(fs.existsSync(path.join(stateDir,"p2-crash-c.txt")),false);
    // The finite synthetic wrapper has no descendants, no provider request and
    // exits by itself after 2.5s; give it time before removing fixture paths.
    await new Promise(resolve=>setTimeout(resolve,2700));
  } finally { if(child.exitCode===null&&child.signalCode===null) child.kill("SIGKILL"); }
});
