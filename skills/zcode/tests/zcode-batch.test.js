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

const skillRoot = path.resolve(__dirname, "..");
const batch = path.join(skillRoot, "scripts", "zcode-batch.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-batch-contract-"));
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


test("MAC-03 refuses old receipts and symlinks before starting a wrapper", () => {
  const file = shardFile("zcode-claim.txt", "plain claim");
  const dest = path.join(root, "zcode-claimed.json");
  const sentinel = "DO NOT TOUCH";
  fs.writeFileSync(dest, sentinel);
  const pre = fs.existsSync(path.join(stateDir, path.basename(file))) ? fs.readFileSync(path.join(stateDir,path.basename(file)), "utf8") : null;
  const a = receiptOf(runBatch(["--prompt-file", file, "--receipt-file", dest]));
  assert.equal(a.status, "archive_error");
  assert.equal(a.gate, "NOT_EVALUATED");
  assert.equal(fs.readFileSync(dest, "utf8"), sentinel);
  assert.equal(fs.existsSync(path.join(stateDir,path.basename(file))) ? fs.readFileSync(path.join(stateDir,path.basename(file)), "utf8") : null, pre);
  const link = path.join(root, "zcode-symlink.json");
  try { fs.symlinkSync(dest, link); }
  catch (error) { if (process.platform === "win32") return; throw error; }
  const b = receiptOf(runBatch(["--prompt-file", file, "--receipt-file", link]));
  assert.equal(b.status, "archive_error");
  assert.equal(fs.readFileSync(dest, "utf8"), sentinel);
});
test("MAC-03 stores every completed shard as a write-once private receipt", () => {
  const files = [shardFile("zcode-archive-a.txt", "first"), shardFile("zcode-archive-b.txt", "second")];
  const dest = path.join(root, "zcode-fresh-archive.json");
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

test("MAC-04 double SIGINT preserves ZCode completed shard and never starts queued work", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const first = shardFile("cancel-z-first.txt", "first done");
  const second = shardFile("cancel-z-second.txt", "CONC_PROBE in progress");
  const third = shardFile("cancel-z-third.txt", "queued only");
  const receipt = path.join(root, "cancel-z-final.json");
  const child = spawn(process.execPath, [batch,
    "--prompt-file", first, "--prompt-file", second, "--prompt-file", third,
    "--concurrency", "1", "--receipt-file", receipt], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ZCODE_BATCH_WRAPPER: fakeWrapper, FAKE_STATE_DIR: stateDir,
      FAKE_ARGS_DUMP: argsDump, FAKE_CONC_LOG: concLog, ZCODE_BATCH_RETRY_MS: "10" },
  });
  let stdout = "";
  child.stdout.on("data", c=>{ stdout += c.toString(); });
  child.stderr.resume();
  const closed = new Promise(resolve=>child.once("close",(code,signal)=>resolve({code,signal})));
  try {
    let started = false;
    for(let i=0;i<150;i++) {
      started = fs.existsSync(path.join(stateDir,path.basename(second)));
      if(started)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(started,true,"second shard already started");
    child.kill("SIGINT"); child.kill("SIGINT");
    const result = await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error("batch did not stop")),16000))]);
    assert.equal(result.code,1);
    const out = JSON.parse(stdout.trim());
    assert.equal(out.status,"cancelled");
    assert.equal(out.gate,"NOT_EVALUATED");
    assert.equal(out.transport_gate,"NOT_EVALUATED");
    assert.equal(out.shards[0].status,"ok");
    assert.equal(out.shards[2],null);
    assert.equal(fs.existsSync(path.join(stateDir,path.basename(third))),false);
    assert.equal(JSON.parse(fs.readFileSync(receipt,"utf8")).status,"cancelled");
    assert.equal(fs.existsSync(path.join(receipt+".shards","000.json")),true);
  } finally {
    if(child.exitCode===null&&child.signalCode===null)try{child.kill("SIGKILL");}catch{}
  }
});

test("MAC-03 default batches have durable private receipts without an explicit output path", () => {
  const file = shardFile("zcode-default-evidence.txt", "hello stable archive");
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
  const file=shardFile("zcode-post-eio.txt", "EIO must be reported");
  const archive=path.join(root,"zcode-post-eio-final.json");
  const preload=path.join(root,"zcode-fault-open.cjs");
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

test("truth table: review votes require independently verified process, identity, cleanup and text", () => {
  const { verifiedReviewVote, aggregate } = require("../scripts/zcode-batch.js");
  const goodReview = { version: 1, summary: "Checked: unit; Not checkable: none", findings: [] };
  const good = {
    status: "ok", cli_invoked: true, wrapper_exit_code: 0, wrapper_signal: null,
    exit_code: 0, signal: null, complete: true, truncated: false,
    cleanup_confirmed: true, model: "GLM-5.3-Flash", provider: "ZCode",
    model_identity_source: "runtime.model_request", tool_calls: 0, tool_requests: 0,
    stop_reason: "stop", text: JSON.stringify(goodReview), review: goodReview, review_gate: "PASS",
  };
  const judge = x => aggregate([x], [{ label: "shard" }], { mode: "review", validatedIds: ["E1", "E2"] }, Date.now());
  assert.equal(verifiedReviewVote(good, ["E1", "E2"]), "PASS");
  assert.equal(judge(good).gate, "PASS");
  const bad = [
    ["unknown cleanup", { cleanup_confirmed: null }],
    ["false cleanup", { cleanup_confirmed: false }],
    ["missing cleanup", { cleanup_confirmed: undefined }],
    ["nonzero actual wrapper", { wrapper_exit_code: 9 }],
    ["signaled wrapper", { wrapper_signal: "SIGTERM" }],
    ["nonzero model CLI", { exit_code: 3 }],
    ["signaled model CLI", { signal: "SIGTERM" }],
    ["provider missing", { provider: undefined }],
    ["forged source", { model_identity_source: "environment" }],
    ["wrong native family", { model: "MiniMax-M3" }],
    ["model missing", { model: null }],
    ["unobserved tools", { tool_calls: undefined }],
    ["tool invoked", { tool_calls: 1 }],
    ["tool request", { tool_requests: 1 }],
    ["truncated", { truncated: true }],
    ["incomplete", { complete: false }],
    ["forged verdict", { review_gate: "FAIL" }],
    ["forged review", { review: { ...goodReview, summary: "tampered" } }],
    ["duplicate JSON key inside text", { text: '{"version":1,"version":1,"summary":"good","findings":[]}' }],
  ];
  for (const [name, change] of bad) {
    const data = { ...good, ...change };
    assert.equal(verifiedReviewVote(data, ["E1", "E2"]), null, name);
    assert.equal(judge(data).gate, "NOT_EVALUATED", name);
  }
});
test("fake wrappers cannot vote PASS when they fail, signal, forge review or omit cleanup", () => {
  for (const [name, marker] of [
    ["bad-exit.txt", "REVIEW_BAD_EXIT"],
    ["bad-signal.txt", "REVIEW_BAD_SIGNAL"],
    ["bad-key.txt", "REVIEW_DUP_KEY"],
    ["bad-gate.txt", "REVIEW_FAKE_GATE"],
    ["bad-cleanup.txt", "REVIEW_CLEANUP_NULL"],
    ["bad-model.txt", "REVIEW_MODEL_FALSE"],
    ["bad-tools.txt", "REVIEW_TOOLS"],
  ]) {
    const file = shardFile(name, marker);
    const receipt = receiptOf(runBatch(["--prompt-file", file, "--mode", "review", "--evidence-ids-file", idsFile]));
    assert.equal(receipt.gate, "NOT_EVALUATED", name);
    assert.equal(receipt.batch.review_pass, 0, name);
    if (name === "bad-exit.txt" || name === "bad-signal.txt") {
      assert.equal(receipt.shards[0].status, "child_error", name);
      assert.equal(receipt.shards[0].diagnostic_receipt.review_gate, "PASS", name);
    }
  }
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

test("default never replays timed out or quota-rejected requests", () => {
  for (const [name, scenario, status] of [
    ["one-quota.txt", "QUOTA_ALWAYS shard", "quota_error"],
    ["one-timeout.txt", "TIMEOUT_ONCE shard", "timeout"],
  ]) {
    const file = shardFile(name, scenario);
    const receipt = receiptOf(runBatch(["--prompt-file", file]));
    assert.equal(receipt.shards[0].status, status, name);
    assert.equal(receipt.shards[0].retried, false, name);
    assert.equal(receipt.shards[0].retry_skipped_reason, "paid_retry_not_authorized", name);
    assert.equal(receipt.batch.paid_retry_authorized, false, name);
    assert.equal(fs.readFileSync(path.join(stateDir, name), "utf8"), "1", name);
  }
});
test("ZCode paid retry requires per-request flag; environment cannot grant consent", () => {
  const { parseArgs } = require("../scripts/zcode-batch.js");
  assert.equal(parseArgs(["--prompt-file", "a.txt"]).allowPaidRetry, false);
  assert.equal(parseArgs(["--prompt-file", "a.txt", "--allow-paid-retry"]).allowPaidRetry, true);
  assert.throws(() => parseArgs(["--prompt-file", "a.txt", "--allow-paid-retry", "--allow-paid-retry"]), /more than once/);
  const file = shardFile("env-quota.txt", "QUOTA_ALWAYS shard");
  receiptOf(runBatch(["--prompt-file", file], { ZCODE_BATCH_ALLOW_PAID_RETRY: "1" }));
  assert.equal(fs.readFileSync(path.join(stateDir, "env-quota.txt"), "utf8"), "1");
});
test("opt-in quota retry: first attempt retained", () => {
  const run = runBatch(["--prompt-file", shardFile("q.txt", "QUOTA_ONCE shard"), "--allow-paid-retry"]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0);
  const shard = receipt.shards[0];
  assert.equal(shard.retried, true);
  assert.equal(shard.retry_reason, "quota_error");
  assert.equal(shard.first_attempt.status, "quota_error");
  assert.equal(shard.status, "ok");
  assert.ok(shard.retry_backoff_seconds > 0);
});

test("opt-in timeout retry: one bounded replay", () => {
  const run = runBatch(["--prompt-file", shardFile("to.txt", "TIMEOUT_ONCE shard"), "--allow-paid-retry"]);
  const receipt = receiptOf(run);
  assert.equal(run.status, 0);
  assert.equal(receipt.shards[0].retry_reason, "timeout");
  assert.equal(receipt.shards[0].status, "ok");
});

test("opt-in persistent quota failure: exactly two attempts, no third", () => {
  const file = shardFile("qa.txt", "QUOTA_ALWAYS shard");
  const run = runBatch(["--prompt-file", file, "--allow-paid-retry"]);
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
