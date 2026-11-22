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
if (prompt.includes("OK_BAD_EXIT")) { emit(ok()); process.exitCode = 9; return; }
if (prompt.includes("OK_SIGNAL")) { process.stdout.write(JSON.stringify(ok()) + "\\n", () => process.kill(process.pid,"SIGTERM")); return; }
if (prompt.includes("FAIL_SHARD")) { emit({ status: "api_error", error: "upstream failed", exit_code: 1 }); return; }
if (prompt.includes("TRUNCATE") && invocations === 0) { emit(ok({ stop_reason: "max_tokens", complete: false, truncated: true })); process.exitCode = 1; return; }
if (prompt.includes("THINK") && invocations === 0) { emit({ status: "thinking_budget_exhausted", exit_code: 1, note: "budget consumed by thinking" }); process.exitCode = 1; return; }
if (prompt.includes("QUOTA") && invocations === 0) { emit({ status: "quota_error", error: "rate limited", exit_code: 1 }); process.exitCode = 1; return; }
if (prompt.includes("SLOW_CANCEL")) { setTimeout(() => emit(ok()), 750); return; }
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


test("MAC-03 refuses old receipts and symlinks before starting a wrapper", () => {
  const file = shardFile("mmx-claim.txt", "plain claim");
  const dest = path.join(root, "mmx-claimed.json");
  const sentinel = "DO NOT TOUCH";
  fs.writeFileSync(dest, sentinel);
  const pre = fs.existsSync(path.join(stateDir, path.basename(file))) ? fs.readFileSync(path.join(stateDir,path.basename(file)), "utf8") : null;
  const a = receiptOf(runBatch(["--prompt-file", file, "--receipt-file", dest]));
  assert.equal(a.status, "archive_error");
  assert.equal(a.gate, "NOT_EVALUATED");
  assert.equal(fs.readFileSync(dest, "utf8"), sentinel);
  assert.equal(fs.existsSync(path.join(stateDir,path.basename(file))) ? fs.readFileSync(path.join(stateDir,path.basename(file)), "utf8") : null, pre);
  const link = path.join(root, "mmx-symlink.json");
  try { fs.symlinkSync(dest, link); }
  catch (error) { if (process.platform === "win32") return; throw error; }
  const b = receiptOf(runBatch(["--prompt-file", file, "--receipt-file", link]));
  assert.equal(b.status, "archive_error");
  assert.equal(fs.readFileSync(dest, "utf8"), sentinel);
});
test("MAC-03 stores every completed shard as a write-once private receipt", () => {
  const files = [shardFile("mmx-archive-a.txt", "first"), shardFile("mmx-archive-b.txt", "second")];
  const dest = path.join(root, "mmx-fresh-archive.json");
  const x = receiptOf(runBatch([...files.flatMap(f=>["--prompt-file",f]), "--receipt-file", dest]));
  assert.equal(x.status, "ok");
  const dir = dest + ".shards";
  assert.equal(fs.readdirSync(dir).filter(f=>f.endsWith(".json")).length,2);
  for (let i=0;i<files.length;i++) {
    const saved = JSON.parse(fs.readFileSync(path.join(dir,String(i).padStart(3,"0")+".json"),"utf8"));
    assert.equal(saved.shard, x.shards[i].shard);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(dest,"utf8")).shards,x.shards);
  const repeat = receiptOf(runBatch(["--prompt-file",files[0],"--receipt-file",dest]));
  assert.equal(repeat.status,"archive_error");
});

test("MAC-04 double SIGINT preserves completed MMX shards and prevents queued requests", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const first = shardFile("cancel-mmx-first.txt", "fast done");
  const second = shardFile("cancel-mmx-second.txt", "SLOW_CANCEL in progress");
  const third = shardFile("cancel-mmx-third.txt", "queued only");
  const receipt = path.join(root, "cancel-mmx-final.json");
  const child = spawn(process.execPath, [batch,
    "--prompt-file", first, "--prompt-file", second, "--prompt-file", third,
    "--concurrency", "1", "--receipt-file", receipt], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MMX_BATCH_WRAPPER: fakeWrapper, FAKE_STATE_DIR: stateDir, MMX_BATCH_QUOTA_RETRY_MS: "10" },
  });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.resume();
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    let started = false;
    for (let n=0;n<150;n++) {
      started = fs.existsSync(path.join(stateDir, path.basename(second)));
      if (started) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(started, true, "second shard was in flight before cancel");
    child.kill("SIGINT");
    child.kill("SIGINT");
    const result = await Promise.race([closed, new Promise((_,reject)=>setTimeout(()=>reject(new Error("cancel hung")),16000))]);
    assert.equal(result.code,1);
    const got = JSON.parse(stdout.trim());
    assert.equal(got.status,"cancelled");
    assert.equal(got.gate,"NOT_EVALUATED");
    assert.equal(got.shards[0].status,"ok");
    assert.equal(got.shards[2],null);
    assert.equal(fs.existsSync(path.join(stateDir,path.basename(third))),false);
    assert.equal(JSON.parse(fs.readFileSync(receipt,"utf8")).status,"cancelled");
    assert.equal(fs.existsSync(path.join(receipt+".shards","000.json")),true);
  } finally {
    if(child.exitCode===null&&child.signalCode===null)try{child.kill("SIGKILL");}catch{}
  }
});

test("MAC-03 default batches have durable private receipts without an explicit output path", () => {
  const file = shardFile("mmx-default-evidence.txt", "hello stable archive");
  const envelope = receiptOf(runBatch(["--prompt-file", file]));
  assert.equal(typeof envelope.receipt_file, "string");
  assert.equal(fs.existsSync(envelope.receipt_file),true);
  assert.deepEqual(JSON.parse(fs.readFileSync(envelope.receipt_file,"utf8")).shards,envelope.shards);
  assert.equal(fs.existsSync(path.join(envelope.receipt_file+".shards","000.json")),true);
  if(process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(envelope.receipt_file)).mode & 0o077,0);
    assert.equal(fs.statSync(envelope.receipt_file).mode & 0o077,0);
  }
});

test("MAC-03 post-request EIO fails closed without replay or lost initial call count", () => {
  const file=shardFile("mmx-post-eio.txt", "QUOTA limited shard must be reported");
  const archive=path.join(root,"mmx-post-eio-final.json");
  const preload=path.join(root,"mmx-fault-open.cjs");
  fs.writeFileSync(preload, [
    "const fs=require('node:fs');",
    "const open=fs.openSync;",
    "fs.openSync=function(file,flags,mode) {",
    "if(typeof file==='string' && file.includes('.shards') && file.endsWith('000.json')) {",
    "const e=new Error('synthetic post-request I/O failure'); e.code='EIO'; throw e; }",
    "return open.call(this,file,flags,mode); };"
  ].join("\n"));
  const run=spawnSync(process.execPath,["--require",preload,batch,"--prompt-file",file,"--receipt-file",archive],{
    encoding:"utf8",shell:false,windowsHide:true,
    env:{...process.env,MMX_BATCH_WRAPPER:fakeWrapper,FAKE_STATE_DIR:stateDir,
      MMX_BATCH_QUOTA_RETRY_MS:"10"},
  });
  const receipt=receiptOf(run);
  assert.equal(run.status,1);
  assert.equal(receipt.status,"archive_error");
  assert.equal(receipt.gate,"NOT_EVALUATED");
  assert.equal(receipt.archive_error,"EIO");
  assert.equal(fs.readFileSync(path.join(stateDir,path.basename(file)),"utf8"),"1");
  assert.equal(JSON.parse(fs.readFileSync(archive,"utf8")).status,"archive_error");
});
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

test("default never replays a quota error, truncated output or exhausted thinking budget", () => {
  for (const [name, scenario, status] of [
    ["one-quota.txt", "QUOTA limited shard", "quota_error"],
    ["one-truncated.txt", "TRUNCATE hard shard", "ok"],
    ["one-thinking.txt", "THINK hard shard", "thinking_budget_exhausted"],
  ]) {
    const file = shardFile(name, scenario);
    const receipt = receiptOf(runBatch(["--prompt-file", file, "--max-tokens", "128"]));
    assert.equal(receipt.gate, "NOT_EVALUATED", name);
    assert.equal(receipt.shards[0].status, status, name);
    assert.equal(receipt.shards[0].retried, false, name);
    assert.equal(receipt.shards[0].retry_skipped_reason, "paid_retry_not_authorized", name);
    assert.equal(receipt.batch.paid_retry_authorized, false, name);
    assert.equal(fs.readFileSync(path.join(stateDir, name), "utf8"), "1", name);
  }
});
test("MMX paid retry requires an explicit per-call flag", () => {
  const { parseArgs } = require("../scripts/mmx-batch.js");
  assert.equal(parseArgs(["--prompt-file", "a.txt"]).allowPaidRetry, false);
  assert.equal(parseArgs(["--prompt-file", "a.txt", "--allow-paid-retry"]).allowPaidRetry, true);
  assert.throws(() => parseArgs(["--prompt-file", "a.txt", "--allow-paid-retry", "--allow-paid-retry"]), /more than once/);
  const file = shardFile("env-thinking.txt", "THINK hard shard");
  receiptOf(runBatch(["--prompt-file", file, "--max-tokens", "128"], { MMX_BATCH_ALLOW_PAID_RETRY: "1" }));
  assert.equal(fs.readFileSync(path.join(stateDir, "env-thinking.txt"), "utf8"), "1");
});
test("opt-in budget retry: both attempts are retained", () => {
  const dumpLines = fs.existsSync(argsDump) ? fs.readFileSync(argsDump, "utf8").split("\n").filter(Boolean) : [];
  const before = dumpLines.length;
  const run = runBatch(["--prompt-file", shardFile("t.txt", "THINK hard shard"), "--max-tokens", "128", "--allow-paid-retry"]);
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

test("real wrapper chain: budget-exhausted replies heal once, a thinking-only end_turn reply is not retried", { skip: process.platform === "win32" && "POSIX fake mmx launcher" }, () => {
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
  const run = runBatch([...files.flatMap(file => ["--prompt-file", file]), "--max-tokens", "128", "--concurrency", "1", "--allow-paid-retry"], {
    MMX_BATCH_WRAPPER: undefined, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    TMPDIR: chainTmp, TMP: chainTmp, TEMP: chainTmp, MMX_CONFIG_DIR: path.join(root, "chain-config-absent"),
  });
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.gate, "NOT_EVALUATED");
  const [thinkMax, textMax, thinkEnd] = receipt.shards;
  assert.equal(thinkMax.first_attempt.status, "thinking_budget_exhausted");
  assert.equal(thinkMax.retried, true);
  assert.equal(thinkMax.retry_reason, "budget_exhausted");
  assert.equal(thinkMax.status, "ok");
  assert.equal(textMax.first_attempt.status, "ok");
  assert.equal(textMax.first_attempt.truncated, true);
  assert.equal(textMax.retried, true);
  assert.equal(textMax.status, "ok");
  assert.equal(textMax.truncated, false);
  assert.equal(thinkEnd.status, "schema_mismatch");
  assert.equal(thinkEnd.stop_reason, "end_turn");
  assert.equal(thinkEnd.retried, false);
  assert.deepEqual(fs.readFileSync(cliLog, "utf8").trim().split("\n"), [
    "CHAIN_THINK_MAX 128", "CHAIN_THINK_MAX 524288", "CHAIN_TEXT_MAX 128", "CHAIN_TEXT_MAX 524288", "CHAIN_THINK_END 128",
  ]);
});

test("opt-in quota retry: both attempts retained", () => {
  const run = runBatch(["--prompt-file", shardFile("q.txt", "QUOTA limited shard"), "--allow-paid-retry"]);
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

test("a complete receipt cannot turn an unsuccessful wrapper exit into PASS", () => {
  const run = runBatch(["--prompt-file", shardFile("bad-exit.txt", "OK_BAD_EXIT")]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.gate, "NOT_EVALUATED");
  assert.equal(receipt.shards[0].status, "child_error");
  assert.equal(receipt.shards[0].exit_code, 9);
  assert.equal(receipt.shards[0].retried, false);
});

test("a complete receipt from a signal-terminated wrapper is not usable", { skip: process.platform === "win32" }, () => {
  const run = runBatch(["--prompt-file", shardFile("bad-signal.txt", "OK_SIGNAL")]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 1);
  assert.equal(receipt.gate, "NOT_EVALUATED");
  assert.equal(receipt.shards[0].status, "child_error");
  assert.equal(receipt.shards[0].signal, "SIGTERM");
  assert.equal(receipt.shards[0].retried, false);
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
