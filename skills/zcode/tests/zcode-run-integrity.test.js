"use strict";
// NEW offline-only Durable Job adversarial contract tests. No provider access.
// Every wrapper invocation is recorded independently, outside the supervisor.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const supervisor = require("../scripts/zcode-run.js");

const program = path.resolve(__dirname, "../scripts/zcode-run.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-run-integrity-"));
let nextId = 0;
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await wait(30);
  }
  throw new Error("timed out waiting for fake job evidence");
}
function fresh(name) {
  const dir = path.join(root, name + "-" + nextId++);
  fs.mkdirSync(dir);
  const prompt = path.join(dir, "中文 with space.txt");
  fs.writeFileSync(prompt, Buffer.from("RAW\\r\\n输入\\r\\n", "utf8"));
  return { dir, prompt, job: path.join(dir, "job"), count: path.join(dir, "count.txt") };
}
function fakeWrapper(dir, count) {
  const file = path.join(dir, "fake-wrapper.cjs");
  fs.writeFileSync(file, [
    '"use strict";',
    'const fs=require("node:fs"),path=require("node:path");',
    'const buffers=[];',
    'process.stdin.on("data",chunk=>buffers.push(chunk));',
    'process.stdin.on("end",()=>{',
    ' const req=JSON.parse(Buffer.concat(buffers).toString("utf8"));',
    ' fs.appendFileSync(' + JSON.stringify(count) + ',"call;");',
    ' const args=process.argv.slice(2),out=args[args.indexOf("--output-dir")+1];',
    ' fs.mkdirSync(out,{recursive:true});',
    ' const receipt={status:"ok",complete:true,truncated:false,model:"FAKE-GLM",',
    '   model_identity_source:"runtime.model_request",job_request_sha256:req.request_sha256,',
    '   job_input_sha256:Object.fromEntries(req.inputs.map(i=>[i.name,i.sha256]))};',
    ' const json=JSON.stringify(receipt);',
    ' fs.writeFileSync(path.join(out,"receipt.json"),json,{flag:"wx"});',
    ' process.stdout.write(json);',
    '});',
  ].join("\n"));
  return file;
}
function mockedWorker() {
  const fake = new EventEmitter();
  fake.unref = () => {};
  return fake;
}
function workerOnce(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [program, "worker", job], { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("close", code => resolve(code));
  });
}
function digest(bytes) {
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
test("parallel workers compete for one permanent claim and send one request only", { timeout: 15000 }, async () => {
  const c = fresh("parallel");
  const fake = fakeWrapper(c.dir, c.count);
  supervisor.start(c.job, ["--prompt-file", c.prompt], { wrapperPath: fake, spawnWorker: mockedWorker });
  const codes = await Promise.all([workerOnce(c.job), workerOnce(c.job)]);
  assert.deepEqual(codes.sort(), [0, 1], "one worker owns execution, the other must refuse");
  assert.equal(fs.readFileSync(c.count, "utf8"), "call;");
  assert.equal(supervisor.verify(c.job).integrity, "match");
  assert.equal(supervisor.status(c.job).status, "finished");
  assert.equal(fs.existsSync(path.join(c.job, "worker.lock")), true);
});

test("BOM/CRLF evidence ID snapshot cannot be rebound even when request digest is rewritten", () => {
  const c = fresh("ids");
  const ids = path.join(c.dir, "证据 IDs.json");
  const original = Buffer.from('\uFEFF["E1","E2"]\r\n', "utf8");
  fs.writeFileSync(ids, original);
  const fake = fakeWrapper(c.dir, c.count);
  supervisor.start(c.job, ["--prompt-file", c.prompt, "--mode", "review", "--evidence-ids-file", ids],
    { wrapperPath: fake, spawnWorker: mockedWorker });
  const requestFile = path.join(c.job, "request.json");
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  assert.equal(request.inputs.length, 2);
  const snapshot = request.inputs.find(i => i.name === "evidence-ids.json");
  assert.equal(snapshot.sha256, digest(original).sha256);
  assert.deepEqual(fs.readFileSync(snapshot.file), original);
  request.args[snapshot.index] = ids; // wrong role/path, attacker also rewrites digest
  const bytes = Buffer.from(JSON.stringify(request));
  fs.writeFileSync(requestFile, bytes);
  fs.writeFileSync(path.join(c.job, "request-digest.json"), JSON.stringify(digest(bytes)));
  const attempt = spawnSync(process.execPath, [program, "worker", c.job], { encoding: "utf8", timeout: 15000 });
  assert.equal(attempt.status, 1);
  assert.equal(fs.existsSync(c.count), false, "no paid backend requests");
  assert.equal(fs.existsSync(path.join(c.job, "worker.lock")), true);
  assert.equal(supervisor.status(c.job).status, "unknown");
});


test("status and verify consume a single hashed request and receipt snapshot", { timeout: 15000 }, async () => {
  const c = fresh("verified-read-once");
  const fake = fakeWrapper(c.dir, c.count);
  supervisor.start(c.job, ["--prompt-file", c.prompt], { wrapperPath: fake });
  await until(() => fs.existsSync(path.join(c.job, "completion.json")));
  const request = path.join(c.job, "request.json");
  const receipt = path.join(c.job, "run", "receipt.json");
  const original = fs.readFileSync;
  const counts = new Map([[request, 0], [receipt, 0]]);
  fs.readFileSync = function(file, ...args) {
    if (counts.has(file)) {
      const count = counts.get(file) + 1;
      counts.set(file, count);
      // Simulate replacement after the authenticated first read. A second
      // read would consume different evidence and MUST NOT be attempted.
      if (count > 1) throw new Error("unsafe second read of verified path");
    }
    return original.call(this, file, ...args);
  };
  try {
    const status = supervisor.status(c.job);
    assert.equal(status.status, "finished");
    assert.equal(status.integrity, "match");
    assert.equal(status.receipt.status, "ok");
    assert.deepEqual([...counts], [[request, 1], [receipt, 1]]);
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(supervisor.verify(c.job).integrity, "match");
  assert.equal(fs.readFileSync(c.count, "utf8"), "call;");
});

test("receipt truncation invalidates completion but never permits re-execution", { timeout: 15000 }, async () => {
  const c = fresh("receipt-truncation");
  const fake = fakeWrapper(c.dir, c.count);
  supervisor.start(c.job, ["--prompt-file", c.prompt], { wrapperPath: fake });
  await until(() => fs.existsSync(path.join(c.job, "completion.json")));
  assert.equal(supervisor.verify(c.job).integrity, "match");
  fs.writeFileSync(path.join(c.job, "run", "receipt.json"), '{"status":"ok"');
  assert.equal(supervisor.verify(c.job).integrity, "corrupt");
  assert.equal(supervisor.status(c.job).status, "unknown");
  const replay = spawnSync(process.execPath, [program, "worker", c.job], { encoding: "utf8", timeout: 15000 });
  assert.equal(replay.status, 1);
  assert.equal(fs.readFileSync(c.count, "utf8"), "call;");
});

test("atomic request publication never overwrites an injected competing record", () => {
  const c = fresh("request-race");
  const target = path.join(c.job, "request.json");
  const preload = path.join(c.dir, "request-race.cjs");
  fs.writeFileSync(preload, [
    'const fs=require("node:fs"),old=fs.linkSync;',
    'fs.linkSync=function(src,dst){',
    ' if(dst===' + JSON.stringify(target) + ' && !fs.existsSync(dst)) fs.writeFileSync(dst,"PRIOR",{flag:"wx"});',
    ' return old.apply(this,arguments);',
    '};',
  ].join("\n"));
  const evalCode = [
    'const s=require(' + JSON.stringify(program) + ');',
    'try{s.start(' + JSON.stringify(c.job) + ',["--prompt-file",' + JSON.stringify(c.prompt) + ']);process.exit(40);}',
    'catch{process.exit(0);}',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--require", preload, "-e", evalCode],
    { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), "PRIOR");
  assert.equal(fs.existsSync(path.join(c.job, "launch.json")), false);
  assert.equal(fs.existsSync(path.join(c.job, "worker.lock")), false);
});

test("preexisting completion wins the publication race; no fabricated PASS or retry", { timeout: 20000 }, async () => {
  const c = fresh("completion-race");
  const fake = fakeWrapper(c.dir, c.count);
  const target = path.join(c.job, "completion.json");
  const done = path.join(c.dir, "worker-exited");
  const preload = path.join(c.dir, "completion-race.cjs");
  fs.writeFileSync(preload, [
    'if(process.argv[2]==="worker"){',
    ' const fs=require("node:fs"),old=fs.linkSync;',
    ' process.on("exit",()=>fs.writeFileSync(' + JSON.stringify(done) + ',"done"));',
    ' fs.linkSync=function(src,dst){',
    '  if(dst===' + JSON.stringify(target) + ' && !fs.existsSync(dst)) fs.writeFileSync(dst,"PRIOR_COMPLETION",{flag:"wx"});',
    '  return old.apply(this,arguments);',
    ' };',
    '}',
  ].join("\n"));
  const previous = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = "--require " + JSON.stringify(preload);
    supervisor.start(c.job, ["--prompt-file", c.prompt], { wrapperPath: fake });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
  await until(() => fs.existsSync(done), 15000);
  assert.equal(fs.readFileSync(target, "utf8"), "PRIOR_COMPLETION");
  assert.equal(supervisor.verify(c.job).integrity, "corrupt");
  assert.equal(supervisor.status(c.job).status, "unknown");
  assert.equal(fs.readFileSync(c.count, "utf8"), "call;");
  assert.equal(spawnSync(process.execPath, [program, "worker", c.job], { encoding: "utf8" }).status, 1);
  assert.equal(fs.readFileSync(c.count, "utf8"), "call;");
});

test("abnormal native wrapper exit without receipt stays unknown on all operating systems", { timeout: 15000 }, async () => {
  const c = fresh("abnormal-exit");
  const fake = path.join(c.dir, "abnormal.cjs");
  fs.writeFileSync(fake, 'process.stdin.resume();process.stdin.on("end",()=>process.exit(23));');
  supervisor.start(c.job, ["--prompt-file", c.prompt], { wrapperPath: fake });
  await until(() => fs.existsSync(path.join(c.job, "execution.json")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.job, "execution.json"), "utf8")).exit_code, 23);
  assert.equal(supervisor.verify(c.job).integrity, "incomplete");
  assert.equal(supervisor.status(c.job).status, "unknown");
  assert.equal(fs.existsSync(path.join(c.job, "worker.lock")), true);
});
function controlledCancelFault(c, scenario, failureCode = null) {
  const ready = path.join(c.dir, "wrapper-ready");
  const wrapperExit = path.join(c.dir, "wrapper-failsafe-exit");
  const stdinSeen = path.join(c.dir, "stdin-error-seen");
  const deadlineSeen = path.join(c.dir, "supervisor-deadline-seen");
  const markerErrorSeen = path.join(c.dir, "marker-error-seen");
  const wrapper = path.join(c.dir, "held-wrapper.cjs");
  const preload = path.join(c.dir, "worker-inject.cjs");
  // Independently count receipt material arriving at the fake wrapper.
  // It deliberately ignores cancellation, so only the worker's bounded
  // owned-child cleanup can finish promptly. Failsafe prevents test leaks.
  fs.writeFileSync(wrapper, [
    'const fs=require("node:fs");',
    'process.stdin.once("data",()=>{fs.appendFileSync(' + JSON.stringify(c.count) + ',"request\\n");',
    '  fs.writeFileSync(' + JSON.stringify(ready) + ',"ready",{flag:"wx"});});',
    'process.stdin.resume();',
    'setInterval(()=>{},1000);',
    'setTimeout(()=>{fs.writeFileSync(' + JSON.stringify(wrapperExit) + ',"natural failsafe");process.exit(89);},2500).unref();'
  ].join("\n"));
  fs.writeFileSync(preload, [
    'if(process.argv[2]==="worker"){',
    ' const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process");',
    ' const scenario=' + JSON.stringify(scenario) + ',code=' + JSON.stringify(failureCode) + ';',
    ' const ready=' + JSON.stringify(ready) + ',seen=' + JSON.stringify(stdinSeen) + ';',
    ' const mark=' + JSON.stringify(markerErrorSeen) + ',deadline=' + JSON.stringify(deadlineSeen) + ';',
    ' const wrapper=' + JSON.stringify(wrapper) + ',cancel=' + JSON.stringify(path.join(c.job, "cancel.request")) + ';',
    ' const origTimeout=global.setTimeout;',
    ' global.setTimeout=function(fn,ms,...args){',
    '   const mapped=ms===15000?120:ms===17000?520:ms===2000?250:ms===46000?320:ms;',
    '   if(ms===46000 && scenario==="epipe-deadline")',
    '     return origTimeout(function(){fs.writeFileSync(deadline,"deadline",{flag:"wx"});fn();},mapped,...args);',
    '   return origTimeout(fn,mapped,...args);',
    ' };',
    ' if(scenario==="marker-write-error"){',
    '   const orig=fs.writeFileSync;',
    '   fs.writeFileSync=function(file,...args){',
    '     if(String(file)===cancel){orig.call(fs,mark,code,{flag:"wx"});',
    '       throw Object.assign(new Error("synthetic cancellation marker error"),{code});}',
    '     return orig.call(this,file,...args);',
    '   };',
    ' }',
    ' if(scenario==="epipe-cancel" || scenario==="epipe-deadline"){',
    '   const orig=cp.spawn;',
    '   cp.spawn=function(...args){',
    '     const child=orig.apply(this,args);',
    '     if(args[1]?.[0] && fs.realpathSync(args[1][0])===fs.realpathSync(wrapper)){',
    '       const poll=setInterval(()=>{',
    '         if(!fs.existsSync(ready))return;',
    '         clearInterval(poll);',
    '         child.stdin.emit("error",Object.assign(new Error("synthetic EPIPE"),{code:"EPIPE"}));',
    '         fs.writeFileSync(seen,"EPIPE",{flag:"wx"});',
    '       },10);',
    '     }',
    '     return child;',
    '   };',
    ' }',
    ' if(scenario==="force-ignored"){',
    '   const origSync=cp.spawnSync;',
    '   cp.spawnSync=function(command,...args){if(command==="taskkill.exe")return {status:0};',
    '     return origSync.call(this,command,...args);};',
    '   const origKill=process.kill;',
    '   process.kill=function(pid,signal){if(pid<0 && signal==="SIGKILL")return true;',
    '     return origKill.apply(this,arguments);};',
    ' }',
    '}',
  ].join("\n"));
  supervisor.start(c.job, ["--prompt-file", c.prompt, "--timeout-seconds",
    scenario === "epipe-deadline" ? "1" : "600"], { wrapperPath: wrapper, spawnWorker: mockedWorker });
  const child = spawn(process.execPath, ["--require", preload, program, "worker", c.job], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, closed, ready, wrapperExit, stdinSeen, deadlineSeen, markerErrorSeen };
}

async function boundedWorkerExit(control, ms = 1750) {
  const outcome = await Promise.race([control.closed, wait(ms).then(() => null)]);
  assert.ok(outcome, "worker must terminate within bounded cleanup, not wait for fake wrapper failsafe");
  assert.equal(outcome.code, 0, outcome.stderr);
  return outcome;
}

for (const code of ["EACCES", "ENOSPC"]) {
  test("R53 runtime cancel marker " + code + " forces owned cleanup without replay", { timeout: 12000 }, async t => {
    const c = fresh("cancel-" + code);
    const f = controlledCancelFault(c, "marker-write-error", code);
    t.after(() => { if (f.child.exitCode === null && f.child.signalCode === null) f.child.kill("SIGKILL"); });
    await until(() => fs.existsSync(f.ready));
    assert.equal(fs.readFileSync(c.count, "utf8"), "request\n", "one fake backend request");
    supervisor.cancel(c.job);
    await until(() => fs.existsSync(f.markerErrorSeen));
    await boundedWorkerExit(f);
    const execution = JSON.parse(fs.readFileSync(path.join(c.job, "execution.json"), "utf8"));
    assert.equal(execution.cancel_marker_write_error, code);
    assert.equal(execution.receipt_exists, false);
    assert.equal(supervisor.status(c.job).status, "unknown");
    assert.equal(supervisor.verify(c.job).integrity, "incomplete");
    assert.equal(fs.existsSync(path.join(c.job, "completion.json")), false);
    assert.equal(fs.existsSync(path.join(c.job, "worker.lock")), true);
    assert.equal(fs.readFileSync(c.count, "utf8"), "request\n", "no second backend request");
  });
}
for (const scenario of ["epipe-cancel", "epipe-deadline"]) {
  test("R53 EPIPE cannot disable " + scenario + " cleanup or promote PASS", { timeout: 12000 }, async t => {
    const c = fresh(scenario);
    const f = controlledCancelFault(c, scenario);
    t.after(() => { if (f.child.exitCode === null && f.child.signalCode === null) f.child.kill("SIGKILL"); });
    await until(() => fs.existsSync(f.ready));
    await until(() => fs.existsSync(f.stdinSeen));
    if (scenario === "epipe-cancel") supervisor.cancel(c.job);
    else await until(() => fs.existsSync(f.deadlineSeen));
    await boundedWorkerExit(f);
    const execution = JSON.parse(fs.readFileSync(path.join(c.job, "execution.json"), "utf8"));
    assert.equal(execution.stdin_error, true);
    assert.equal(execution.reason, scenario === "epipe-cancel" ? "cancelled" : "supervisor_timeout");
    assert.equal(supervisor.verify(c.job).integrity, "incomplete");
    assert.equal(supervisor.status(c.job).status, "unknown");
    assert.equal(fs.existsSync(path.join(c.job, "completion.json")), false);
    assert.equal(fs.readFileSync(c.count, "utf8"), "request\n");
  });
}
test("R53 repeated cancel and ignored force remain bounded, permanently unknown", { timeout: 12000 }, async t => {
  const c = fresh("force-failed");
  const f = controlledCancelFault(c, "force-ignored");
  t.after(() => { if (f.child.exitCode === null && f.child.signalCode === null) f.child.kill("SIGKILL"); });
  await until(() => fs.existsSync(f.ready));
  supervisor.cancel(c.job);
  supervisor.cancel(c.job); // independent repeated cancellation, no restart
  await boundedWorkerExit(f);
  assert.equal(fs.existsSync(f.wrapperExit), false, "worker must not wait for the wrapper's natural exit");
  assert.equal(fs.existsSync(path.join(c.job, "execution.json")), false);
  assert.equal(fs.existsSync(path.join(c.job, "completion.json")), false);
  const unknown = JSON.parse(fs.readFileSync(path.join(c.job, "cleanup-unverified.json"), "utf8"));
  assert.equal(unknown.wrapper_started, true);
  assert.equal(supervisor.status(c.job).status, "unknown");
  assert.equal(fs.existsSync(path.join(c.job, "worker.lock")), true);
  assert.equal(fs.readFileSync(c.count, "utf8"), "request\n");
  await until(() => fs.existsSync(f.wrapperExit), 5000); // fixture failsafe cleanup, not a replay
});
test("R53 cancellation after child has exited never replays or overwrites completion", { timeout: 12000 }, async () => {
  const c = fresh("already-exited");
  const fake = fakeWrapper(c.dir, c.count);
  supervisor.start(c.job, ["--prompt-file", c.prompt], { wrapperPath: fake, spawnWorker: mockedWorker });
  assert.equal(await workerOnce(c.job), 0);
  const completion = fs.readFileSync(path.join(c.job, "completion.json"));
  assert.equal(supervisor.cancel(c.job).cancel_requested, false);
  assert.equal(supervisor.cancel(c.job).cancel_requested, false);
  assert.deepEqual(fs.readFileSync(path.join(c.job, "completion.json")), completion);
  assert.equal(fs.readFileSync(c.count, "utf8"), "call;");
});
