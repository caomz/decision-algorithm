"use strict";

// Offline contract tests for mmx-batch.js. No real model calls: every shard
// is served by a fake wrapper (MMX_BATCH_WRAPPER) that scripts replies from
// the prompt content and a per-shard invocation counter.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { cleanEnv } = require("./support/env.js");

const skillRoot = path.resolve(__dirname, "..");
const batch = path.join(skillRoot, "scripts", "mmx-batch.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-batch-contract-"));
const archiveTmp = path.join(root, "archives"); fs.mkdirSync(archiveTmp);
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
  status: "ok", cli_invoked: true, text: "REPLY:" + prompt.trim().slice(0, 30), model: "Fake-M3",
  model_identity_source: "response.model", stop_reason: "end_turn",
  complete: true, truncated: false, input_tokens: 12, output_tokens: 34, exit_code: 0,
}, extra);
const digest = data => require("node:crypto").createHash("sha256").update(data).digest("hex");
const configIndex = argv.indexOf("--profile-file");
const bind = receipt => ({ ...receipt, batch_attempt_id: process.env.ZMX_BATCH_ATTEMPT_ID,
  batch_material_sha256: digest(fs.readFileSync(promptFile)),
  batch_config_sha256: configIndex < 0 ? "" : digest(fs.readFileSync(argv[configIndex + 1])) });
const emit = receipt => { process.stdout.write(JSON.stringify(bind(receipt)) + "\\n"); process.exitCode = 0; };
if (prompt.includes("BAD_EXIT")) { emit(ok()); process.exitCode = 9; return; }
if (prompt.includes("SECRET_STDERR")) { process.stderr.write("synthetic-secret-canary"); process.exitCode = 1; return; }
if (prompt.includes("WRONG_BINDING")) { process.stdout.write(JSON.stringify(ok()) + "\\n"); return; }
if (prompt.includes("HANG_WRAPPER")) { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); return; }
if (prompt.includes("PIPE_HOLDER")) {
  // Finite, test-owned child keeps the inherited pipe open after the wrapper exits.
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{},11000)"],
    { stdio: ["ignore", process.stdout, process.stderr], detached: true, windowsHide: true });
  child.unref(); emit(ok()); return;
}
if (prompt.includes("CHILD_ERR")) { process.stdout.write("definitely not json"); process.exitCode = 1; return; }
if (prompt.includes("FAIL_SHARD")) { emit({ status: "api_error", error: "upstream failed", exit_code: 1 }); return; }
if (prompt.includes("TRUNCATE") && invocations === 0) { emit(ok({ stop_reason: "max_tokens", complete: false, truncated: true })); process.exitCode = 0; return; }
if (prompt.includes("THINK") && invocations === 0) { emit({ status: "thinking_budget_exhausted", exit_code: 1, note: "budget consumed by thinking" }); process.exitCode = 1; return; }
if (prompt.includes("QUOTA") && invocations === 0) { emit({ status: "quota_error", error: "rate limited", exit_code: 1 }); process.exitCode = 1; return; }
emit(ok());
`);

function runBatch(args, extraEnv = {}) {
  return spawnSync(process.execPath, [batch, ...args], {
    encoding: "utf8", windowsHide: true, shell: false, timeout: 20000,
    env: cleanEnv({ TMPDIR: archiveTmp, TMP: archiveTmp, TEMP: archiveTmp, MMX_BATCH_WRAPPER: fakeWrapper, FAKE_STATE_DIR: stateDir,
                    FAKE_ARGS_DUMP: argsDump, MMX_BATCH_QUOTA_RETRY_MS: "10", ...extraEnv }),
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

test("default budget exhaustion is never automatically replayed", () => {
  const run = runBatch(["--prompt-file", shardFile("t.txt", "THINK hard shard"), "--max-tokens", "128"]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.shards[0].status, "thinking_budget_exhausted");
  assert.equal(receipt.shards[0].retried, false);
  assert.equal(fs.readFileSync(path.join(stateDir, "t.txt"), "utf8"), "1");
});

test("truncation at the profile budget: no pointless retry", () => {
  // Caller budget equals the profile ceiling, so a retry cannot raise it.
  const run = runBatch(["--prompt-file", shardFile("n.txt", "TRUNCATE anyway"), "--max-tokens", "524288"]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.shards[0].retried, false);
  assert.equal(receipt.shards[0].truncated, true);
});

test("real wrapper chain: no budget exhaustion or thinking-only reply is replayed", { skip: process.platform === "win32" && "POSIX fake mmx launcher" }, () => {
  // No fake wrapper: mmx-batch -> mmx-chat.js -> a fake mmx CLI, so the
  // wrapper's own classification decides what the batch retries.
  const bin = path.join(root, "chain-bin");
  const chainTmp = path.join(root, "chain-tmp");
  const cliLog = path.join(root, "chain-cli.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(chainTmp);
  fs.writeFileSync(path.join(bin, "mmx"), `#!${process.execPath}
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const budget = Number(args[args.indexOf("--max-tokens") + 1]);
const messages = fs.readFileSync(args[args.indexOf("--messages-file") + 1], "utf8");
const scenario = (/CHAIN_[A-Z_]+/.exec(messages) || ["CHAIN_NONE"])[0];
fs.appendFileSync(${JSON.stringify(cliLog)}, scenario + " " + budget + "\\n");
const reply = { content: [{ type: "text", text: "HEALED" }], model: "MiniMax-M3", stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 3 }, base_resp: { status_code: 0, status_msg: "" } };
if (budget < 524288 && scenario === "CHAIN_THINK_MAX") { reply.content = [{ type: "thinking", thinking: "internal" }]; reply.stop_reason = "max_tokens"; }
if (budget < 524288 && scenario === "CHAIN_TEXT_MAX") { reply.content = [{ type: "text", text: "partial" }]; reply.stop_reason = "max_tokens"; }
if (scenario === "CHAIN_THINK_END") reply.content = [{ type: "thinking", thinking: "internal" }];
process.stdout.write(JSON.stringify(reply));
`, { mode: 0o755 });
  const files = [shardFile("chain-think-max.txt", "CHAIN_THINK_MAX shard"),
    shardFile("chain-text-max.txt", "CHAIN_TEXT_MAX shard"), shardFile("chain-think-end.txt", "CHAIN_THINK_END shard")];
  const run = runBatch([...files.flatMap(file => ["--prompt-file", file]), "--max-tokens", "128", "--concurrency", "1"], {
    MMX_BATCH_WRAPPER: undefined, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    TMPDIR: chainTmp, TMP: chainTmp, TEMP: chainTmp, MMX_CONFIG_DIR: path.join(root, "chain-config-absent"),
  });
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.gate, "NOT_EVALUATED");
  const [thinkMax, textMax, thinkEnd] = receipt.shards;
  assert.equal(thinkMax.status, "thinking_budget_exhausted");
  assert.equal(thinkMax.retried, false);
  assert.equal(textMax.status, "ok");
  assert.equal(textMax.truncated, true);
  assert.equal(textMax.retried, false);
  assert.equal(thinkEnd.status, "schema_mismatch");
  assert.equal(thinkEnd.stop_reason, "end_turn");
  assert.equal(thinkEnd.retried, false);
  assert.deepEqual(fs.readFileSync(cliLog, "utf8").trim().split("\n"), [
    "CHAIN_THINK_MAX 128", "CHAIN_TEXT_MAX 128", "CHAIN_THINK_END 128",
  ]);
});

test("default quota failure sends one wrapper invocation", () => {
  const run = runBatch(["--prompt-file", shardFile("q.txt", "QUOTA limited shard")]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.shards[0].status, "quota_error");
  assert.equal(receipt.shards[0].retried, false);
  assert.equal(fs.readFileSync(path.join(stateDir, "q.txt"), "utf8"), "1");
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
  for (const [name, marker] of [["p2-unbound.txt", "WRONG_BINDING"], ["p2-exit.txt", "BAD_EXIT"]]) {
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
    env: cleanEnv({ MMX_BATCH_WRAPPER: fakeWrapper, FAKE_STATE_DIR: stateDir,
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

test("Phase 2: raw stderr is never in the public envelope", () => {
  const run = runBatch(["--prompt-file", shardFile("p2-stderr.txt", "SECRET_STDERR")]);
  const result = receiptOf(run);
  assert.equal(result.shards[0].stderr_present, true);
  assert.equal(run.stdout.includes("synthetic-secret-canary"), false);
});
