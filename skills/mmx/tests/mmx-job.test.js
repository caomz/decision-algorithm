"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { start, status, cancel, verify, runtimeBinding } = require("../scripts/mmx-job.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-durable-job-"));
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
const prompt = path.join(root, "source.txt");
const fakeBatch = path.join(root, "fake-batch.cjs");
const counter = path.join(root, "invocations.log");
fs.writeFileSync(prompt, "SYNTHETIC REQUEST A\n");
fs.writeFileSync(fakeBatch, [
  '"use strict";',
  'const fs = require("node:fs");',
  'const args = process.argv.slice(2);',
  'const file = args[args.indexOf("--prompt-file") + 1];',
  'const profile = args[args.indexOf("--profile-file") + 1];',
  'const receipt = args[args.indexOf("--receipt-file") + 1];',
  'if (!fs.readFileSync(file,"utf8").includes("SYNTHETIC REQUEST A")) throw new Error("prompt not snapshotted");',
  'if (!JSON.parse(fs.readFileSync(profile,"utf8")).format) throw new Error("profile not snapshotted");',
  'fs.appendFileSync(process.env.MMX_JOB_FAKE_COUNTER, "1\\n");',
  'const done = () => {',
  '  const result = {status:"ok",gate:"PASS",batch:{shards:1},shards:[{status:"ok",complete:true,truncated:false}]};',
  '  fs.writeFileSync(receipt,JSON.stringify(result),{flag:"wx"});',
  '  process.stdout.write(JSON.stringify(result)+"\\n");',
  '};',
  'if (process.env.MMX_JOB_TEST_HANG === "1") {',
  '  if (process.env.MMX_JOB_IGNORE_TERM === "1") process.on("SIGTERM",()=>{});',
  '  if (process.env.MMX_JOB_FAKE_READY) fs.writeFileSync(process.env.MMX_JOB_FAKE_READY,String(process.pid));',
  '  setInterval(()=>{},100);',
  '}',
  'else setTimeout(done,Number(process.env.MMX_JOB_TEST_SLEEP_MS || 25));',
].join("\n") + "\n");
const script = path.join(__dirname, "../scripts/mmx-job.js");
process.env.MMX_JOB_FAKE_COUNTER = counter;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs=6000) {
  const stop = Date.now()+timeoutMs;
  while (Date.now()<stop) {
    const value=predicate();
    if (value) return value;
    await wait(25);
  }
  throw new Error("job status timeout");
}
function startFake(name) {
  return start(path.join(root,name),["--prompt-file",prompt,"--concurrency","1"],{batchPath:fakeBatch});
}
test("persisted snapshots survive source changes and completed receipt is queryable",async()=>{
  const launched=startFake("finished");
  assert.equal(launched.status,"started");
  assert.equal(status(launched.job_dir).job_dir,launched.job_dir);
  fs.writeFileSync(prompt,"CHANGED AFTER START\n");
  const finished=await until(()=>status(launched.job_dir).status==="finished" && status(launched.job_dir));
  assert.equal(finished.execution.reason,"child_exit");
  assert.equal(finished.execution.exit_code,0);
  assert.equal(finished.receipt.gate,"PASS");
  assert.equal(verify(launched.job_dir).integrity,"match");
  assert.equal(fs.readFileSync(path.join(launched.job_dir,"input/shard-0.txt"),"utf8"),"SYNTHETIC REQUEST A\n");
  fs.writeFileSync(prompt,"SYNTHETIC REQUEST A\n");
});
test("repeat start is rejected and does not spawn or spend a second request",async()=>{
  const first=startFake("duplicate");
  assert.throws(()=>startFake("duplicate"),/EEXIST/);
  await until(()=>status(first.job_dir).status==="finished");
  const count=fs.readFileSync(counter,"utf8").trim().split("\n").length;
  const result=spawnSync(process.execPath,[script,"resume",first.job_dir],{encoding:"utf8"});
  assert.equal(result.status,0);
  assert.equal(JSON.parse(result.stdout).resume_policy,"inspect_only_no_automatic_replay");
  assert.equal(fs.readFileSync(counter,"utf8").trim().split("\n").length,count);
});
test("input tampering is reported corrupt and never auto-repaired",async()=>{
  const job=startFake("tamper").job_dir;
  await until(()=>status(job).status==="finished");
  fs.appendFileSync(path.join(job,"input/shard-0.txt"),"tampered");
  assert.equal(verify(job).integrity,"corrupt");
});
test("a job without a terminal record remains unknown, not an automatic retry",()=>{
  const job=path.join(root,"unknown");
  fs.mkdirSync(job);
  fs.writeFileSync(path.join(job,"request.json"),JSON.stringify({format:1,prompts:[],profile:{}}));
  const current=status(job);
  assert.equal(current.status,"unknown");
  assert.match(current.note,/Never resubmit/);
  assert.equal(verify(job).integrity,"corrupt");
});
test("cancel writes an advisory marker without signaling an arbitrary PID",async()=>{
  const saved=process.env.MMX_JOB_TEST_HANG;
  process.env.MMX_JOB_TEST_HANG="1";
  try {
    const result=startFake("cancel");
    await until(()=>fs.existsSync(path.join(result.job_dir,"started.json")));
    const requested=cancel(result.job_dir);
    assert.equal(requested.status,"cancel_requested");
    const complete=await until(()=>status(result.job_dir).status==="finished" && status(result.job_dir),12000);
    assert.equal(complete.execution.reason,"cancelled");
    assert.equal(verify(result.job_dir).integrity,"match");
  } finally {
    if(saved===undefined)delete process.env.MMX_JOB_TEST_HANG;
    else process.env.MMX_JOB_TEST_HANG=saved;
  }
});

function fileDigest(file) {
  const bytes=fs.readFileSync(file);
  return {bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
}
function invocationCount() {
  return fs.existsSync(counter) ? fs.readFileSync(counter,"utf8").trim().split("\n").filter(Boolean).length : 0;
}
// Build an unlaunched archive so cancellation and validation can be exercised
// before any supervisor or batch exists, without timing-dependent sleeps.
function preparedJob(name) {
  const job=path.join(fs.realpathSync(root),name);
  fs.mkdirSync(job);
  fs.mkdirSync(path.join(job,"input"));
  const file=path.join(job,"input/shard-0.txt");
  const profileFile=path.join(job,"input/profile.json");
  fs.writeFileSync(file,"SYNTHETIC REQUEST A\n");
  fs.copyFileSync(path.join(__dirname,"../profiles/local.json"),profileFile);
  const request={format:2,created_at:new Date().toISOString(),
    prompts:[{file,...fileDigest(file)}],profile:{file:profileFile,...fileDigest(profileFile)},
    batch_script:fs.realpathSync(fakeBatch),batch_script_digest:fileDigest(fakeBatch),
    runtime:runtimeBinding(),
    batch_args:["--prompt-file",file,"--concurrency","1","--profile-file",profileFile,"--receipt-file",path.join(job,"receipt.json")]};
  fs.writeFileSync(path.join(job,"request.json"),JSON.stringify(request));
  fs.writeFileSync(path.join(job,"request-digest.json"),JSON.stringify(fileDigest(path.join(job,"request.json"))));
  return job;
}
function runWorker(job) {
  return spawnSync(process.execPath,[script,"worker",job],{encoding:"utf8",timeout:12000});
}


test("MAC-10 verified runtime binds Node, MMX wrapper, guard and CLI before worker launch", () => {
  const runtime=runtimeBinding();
  assert.equal(runtime.format,1);
  assert.equal(runtime.node_version,process.version);
  assert.equal(runtime.files.length,4);
  assert.ok(runtime.files.some(v=>v.file.endsWith("fetch-timeout-guard.js")));
  for(const record of runtime.files)assert.equal(record.sha256,fileDigest(record.file).sha256);
  for(const [name,mutate]of [
    ["node-version", req=>{req.runtime.node_version="v0.0.0";}],
    ["guard-digest", req=>{req.runtime.files.find(f=>f.file.endsWith("fetch-timeout-guard.js")).sha256="a".repeat(64);}],
    ["cli-entry", req=>{req.runtime.cli={file:"/fake/mmx",sha256:"a".repeat(64),bytes:4,package:null};}],
  ]) {
    const job=preparedJob("runtime-drift-"+name);
    const reqFile=path.join(job,"request.json");
    const req=JSON.parse(fs.readFileSync(reqFile,"utf8"));
    mutate(req);
    fs.writeFileSync(reqFile,JSON.stringify(req));
    fs.writeFileSync(path.join(job,"request-digest.json"),JSON.stringify(fileDigest(reqFile)));
    const count=invocationCount();
    assert.equal(verify(job).integrity,"corrupt",name);
    assert.equal(runWorker(job).status,2,name);
    assert.equal(invocationCount(),count,name+" may not call provider");
  }
});
// Build a macOS-shaped launcher sandbox: a shell wrapper on PATH that execs a
// real mmx-cli package entry, so the package is not reachable by walking up
// from the launcher directory.
function launcherSandbox(label, version) {
  const sandbox = fs.mkdtempSync(path.join(root, label + "-"));
  const binDir = path.join(sandbox, "bin");
  const pkgDir = path.join(sandbox, "npm", "node_modules", "mmx-cli");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
    name: "mmx-cli", version: version || "9.9.9", bin: { mmx: "dist/mmx.mjs" },
  }));
  const entry = path.join(pkgDir, "dist", "mmx.mjs");
  fs.writeFileSync(entry, "// synthetic CLI entry\n");
  // The npm .bin shim is a symlink on POSIX. Where a symlink cannot be created
  // the wrapper references the package entry directly, which resolves to the
  // same owning package.
  const shim = path.join(sandbox, "npm", "node_modules", ".bin", "mmx");
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  let target = entry;
  try {
    fs.symlinkSync(entry, shim);
    target = shim;
  } catch { target = entry; }
  const wrapper = path.join(binDir, "mmx");
  fs.writeFileSync(wrapper, ["#!/bin/bash", `exec env "${target}" "$@"`, ""].join("\n"));
  fs.chmodSync(wrapper, 0o755);
  return { sandbox, binDir, pkgDir, entry, shim, wrapper };
}
function withPath(binDir, run) {
  const saved = process.env.PATH;
  process.env.PATH = binDir + path.delimiter + saved;
  try { return run(); } finally { process.env.PATH = saved; }
}
test("MAC-10 a PATH launcher that shadows the npm shim still pins the CLI version", () => {
  // Reproduces the macOS layout where ~/.local/bin/mmx is a shell wrapper that
  // execs the real CLI, so the npm package is not reachable by walking up from
  // the launcher directory. The version must still be bound.
  const box = launcherSandbox("wrapper-path", "9.9.9");
  withPath(box.binDir, () => {
    const runtime = runtimeBinding();
    assert.ok(runtime.cli, "the CLI launcher must stay bound");
    assert.equal(runtime.cli.file, fs.realpathSync(box.wrapper));
    assert.equal(runtime.cli.resolution, "resolved");
    assert.ok(runtime.cli.package, "the CLI package version must stay bound");
    assert.equal(runtime.cli.package.version, "9.9.9");
    assert.equal(runtime.cli.package.file, fs.realpathSync(path.join(box.pkgDir, "package.json")));
    assert.ok(runtime.cli.entry, "the executed CLI entry must stay bound");
    assert.equal(runtime.cli.entry.file, fs.realpathSync(box.entry));
  });
});
test("MAC-10 a same-named package in an unrelated directory is not a binding", () => {
  // An mmx-cli package.json that exists somewhere else on disk must never be
  // accepted as the binding for a launcher that does not execute it.
  const box = launcherSandbox("unrelated-pkg", "9.9.9");
  const decoy = path.join(box.sandbox, "elsewhere");
  fs.mkdirSync(decoy, { recursive: true });
  fs.writeFileSync(path.join(decoy, "package.json"), JSON.stringify({
    name: "mmx-cli", version: "0.0.1-decoy",
  }));
  withPath(box.binDir, () => {
    const runtime = runtimeBinding();
    assert.ok(runtime.cli.package, "the executed package must stay bound");
    assert.equal(runtime.cli.package.version, "9.9.9", "a decoy package must not win");
    assert.notEqual(runtime.cli.package.file, fs.realpathSync(path.join(decoy, "package.json")));
  });
});
test("MAC-10 an undeterminable execution chain is reported as unknown", () => {
  // A launcher that executes no resolvable mmx-cli entry leaves the binding
  // explicitly unresolved instead of fabricating a package identity.
  const sandbox = fs.mkdtempSync(path.join(root, "unresolved-"));
  const binDir = path.join(sandbox, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, "mmx");
  fs.writeFileSync(wrapper, ["#!/bin/bash", "exec /usr/bin/true \"$@\"", ""].join("\n"));
  fs.chmodSync(wrapper, 0o755);
  withPath(binDir, () => {
    const runtime = runtimeBinding();
    assert.ok(runtime.cli, "the launcher must stay bound");
    assert.equal(runtime.cli.resolution, "unresolved");
    assert.equal(runtime.cli.package, null, "no package identity may be invented");
    assert.equal(runtime.cli.entry, null, "no entry identity may be invented");
  });
});
test("MAC-10 a package upgrade is a runtime drift that refuses to launch", () => {
  const box = launcherSandbox("pkg-upgrade", "9.9.9");
  const job = withPath(box.binDir, () => preparedJob("runtime-drift-package-upgrade"));
  // The package is upgraded in place after the job was recorded.
  fs.writeFileSync(path.join(box.pkgDir, "package.json"), JSON.stringify({
    name: "mmx-cli", version: "9.9.10", bin: { mmx: "dist/mmx.mjs" },
  }));
  const count = invocationCount();
  withPath(box.binDir, () => {
    assert.equal(verify(job).integrity, "corrupt");
    assert.equal(runWorker(job).status, 2);
  });
  assert.equal(invocationCount(), count, "a package upgrade may not call the provider");
});
test("MAC-10 a changed CLI entry is a runtime drift that refuses to launch", () => {
  const box = launcherSandbox("entry-change", "9.9.9");
  const job = withPath(box.binDir, () => preparedJob("runtime-drift-entry-change"));
  // The executed entry changes while the declared version stays the same.
  fs.writeFileSync(box.entry, "// synthetic CLI entry, changed\n");
  const count = invocationCount();
  withPath(box.binDir, () => {
    assert.equal(verify(job).integrity, "corrupt");
    assert.equal(runWorker(job).status, 2);
  });
  assert.equal(invocationCount(), count, "a changed entry may not call the provider");
});
test("MAC-10 a PATH drift is a runtime drift that refuses to launch", () => {
  const first = launcherSandbox("path-drift-a", "9.9.9");
  const second = launcherSandbox("path-drift-b", "9.9.9");
  const job = withPath(first.binDir, () => preparedJob("runtime-drift-path"));
  const count = invocationCount();
  // The same job is verified against a different launcher on PATH.
  withPath(second.binDir, () => {
    assert.equal(verify(job).integrity, "corrupt");
    assert.equal(runWorker(job).status, 2);
  });
  assert.equal(invocationCount(), count, "a PATH drift may not call the provider");
});
test("legacy MMX jobs without runtime identity remain inspect-only and cannot execute", () => {
  const job=preparedJob("legacy-runtime");
  const reqFile=path.join(job,"request.json");
  const req=JSON.parse(fs.readFileSync(reqFile,"utf8"));
  delete req.runtime;
  fs.writeFileSync(reqFile,JSON.stringify(req));
  fs.writeFileSync(path.join(job,"request-digest.json"),JSON.stringify(fileDigest(reqFile)));
  const count=invocationCount();
  assert.equal(status(job).status,"unknown");
  assert.equal(runWorker(job).status,2);
  assert.equal(invocationCount(),count);
});
test("a cancel marker published before worker start never invokes the batch",()=>{
  const job=preparedJob("pre-cancelled");
  const count=invocationCount();
  assert.equal(cancel(job).status,"cancel_requested");
  const run=runWorker(job);
  assert.equal(run.status,0,run.stdout+run.stderr);
  assert.equal(invocationCount(),count);
  const current=status(job);
  assert.equal(current.status,"finished");
  assert.equal(current.execution.reason,"cancelled");
  assert.equal(current.execution.batch_started,false);
  assert.equal(current.execution.termination_confirmed,true);
  assert.equal(verify(job).integrity,"match");
});

test("changed batch arguments cannot substitute an unsnapshotted prompt",()=>{
  const job=preparedJob("argv-binding");
  const requestFile=path.join(job,"request.json");
  const request=JSON.parse(fs.readFileSync(requestFile,"utf8"));
  request.batch_args[1]=prompt;
  fs.writeFileSync(requestFile,JSON.stringify(request));
  // Even a consistently rehashed request must still bind the declared snapshots.
  fs.writeFileSync(path.join(job,"request-digest.json"),JSON.stringify(fileDigest(requestFile)));
  const count=invocationCount();
  assert.equal(verify(job).integrity,"corrupt");
  assert.equal(runWorker(job).status,2);
  assert.equal(invocationCount(),count);
});

test("input directory symlinks cannot bypass snapshot containment",{skip:process.platform==="win32"},()=>{
  const job=preparedJob("symlink-input");
  const outside=path.join(root,"outside-input");
  fs.renameSync(path.join(job,"input"),outside);
  fs.symlinkSync(outside,path.join(job,"input"),"dir");
  assert.equal(verify(job).integrity,"corrupt");
  const count=invocationCount();
  assert.equal(runWorker(job).status,2);
  assert.equal(invocationCount(),count);
});

test("completion hashes detect changed receipt, output, and exit status",async()=>{
  for (const [name,mutate] of [
    ["receipt",job=>fs.writeFileSync(path.join(job,"receipt.json"),JSON.stringify({status:"ok",gate:"FAIL"}))],
    ["stdout",job=>fs.appendFileSync(path.join(job,"stdout.json"),"changed\n")],
    ["execution",job=>{
      const file=path.join(job,"execution.json");
      const record=JSON.parse(fs.readFileSync(file,"utf8"));
      record.exit_code=17;
      fs.writeFileSync(file,JSON.stringify(record));
    }],
  ]) {
    const job=startFake("output-tamper-"+name).job_dir;
    await until(()=>status(job).status==="finished");
    mutate(job);
    assert.equal(verify(job).integrity,"corrupt",name);
    assert.equal(status(job).status,"unknown",name);
  }
});

test("a partial completion publication is unknown and never replayed",async()=>{
  const job=startFake("incomplete-publication").job_dir;
  await until(()=>status(job).status==="finished");
  fs.unlinkSync(path.join(job,"completion.json"));
  const count=invocationCount();
  assert.equal(status(job).status,"unknown");
  assert.equal(verify(job).integrity,"incomplete");
  assert.equal(runWorker(job).status,2);
  assert.equal(invocationCount(),count);
});

test("worker re-entry cannot overwrite a completed archive or launch twice",async()=>{
  const job=startFake("worker-reentry").job_dir;
  await until(()=>status(job).status==="finished");
  const before=fs.readFileSync(path.join(job,"execution.json"),"utf8");
  const count=invocationCount();
  assert.equal(runWorker(job).status,2);
  assert.equal(invocationCount(),count);
  assert.equal(fs.readFileSync(path.join(job,"execution.json"),"utf8"),before);
  assert.equal(verify(job).integrity,"match");
});

test("ignored SIGTERM is escalated without claiming all descendants stopped",{skip:process.platform==="win32"},async()=>{
  const keys=["MMX_JOB_TEST_HANG","MMX_JOB_IGNORE_TERM","MMX_JOB_FAKE_READY"];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const ready=path.join(root,"ignore-term-ready");
  process.env.MMX_JOB_TEST_HANG="1";
  process.env.MMX_JOB_IGNORE_TERM="1";
  process.env.MMX_JOB_FAKE_READY=ready;
  let job;
  try {
    job=startFake("ignore-term").job_dir;
    await until(()=>fs.existsSync(ready));
    cancel(job);
    const finished=await until(()=>status(job).status==="finished" && status(job),12000);
    assert.equal(finished.execution.reason,"cancelled");
    assert.equal(finished.execution.signal,"SIGKILL");
    assert.equal(finished.execution.batch_exit_observed,true);
    assert.equal(finished.execution.termination_confirmed,false);
    assert.equal(verify(job).integrity,"match");
  } finally {
    for(const key of keys) if(saved[key]===undefined) delete process.env[key]; else process.env[key]=saved[key];
    if(fs.existsSync(ready)) try { process.kill(Number(fs.readFileSync(ready,"utf8")),"SIGKILL"); } catch {}
    if(job && status(job).status!=="finished") cancel(job);
  }
});

test("importing job and batch parsers installs no process signal handlers",()=>{
  const code=`const before=["SIGTERM","SIGINT","SIGHUP"].map(s=>process.listenerCount(s));require(${JSON.stringify(script)});process.stdout.write(JSON.stringify(["SIGTERM","SIGINT","SIGHUP"].map((s,i)=>process.listenerCount(s)-before[i])));`;
  const result=spawnSync(process.execPath,["-e",code],{encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),[0,0,0]);
});

test("verify CLI fails closed for corrupt or incomplete archives",async()=>{
  const complete=startFake("verify-cli-complete").job_dir;
  await until(()=>status(complete).status==="finished");
  const incomplete=preparedJob("verify-cli-incomplete");
  for(const [job,integrity,exitCode] of [
    [complete,"match",0], [incomplete,"incomplete",2], [path.join(root,"absent"),"corrupt",2],
  ]) {
    const result=spawnSync(process.execPath,[script,"verify",job],{encoding:"utf8"});
    assert.equal(JSON.parse(result.stdout).integrity,integrity);
    assert.equal(result.status,exitCode);
  }
});

test("MAC-01 durable job to real batch to fake wrapper sends one request on quota", { timeout: 16000 }, async () => {
  const wrapper = path.join(root, "quota-job-wrapper.cjs");
  const independentCount = path.join(root, "quota-job-invocations");
  fs.writeFileSync(wrapper, [
    '"use strict";',
    'const fs=require("node:fs");',
    'fs.appendFileSync(process.env.MMX_E2E_COUNT, "1\\n");',
    'process.stdout.write(JSON.stringify({status:"quota_error",cli_invoked:true,complete:false,truncated:false,error:"synthetic 429"})+"\\n");',
  ].join("\n")+"\n");
  const oldWrapper = process.env.MMX_BATCH_WRAPPER;
  const oldCount = process.env.MMX_E2E_COUNT;
  process.env.MMX_BATCH_WRAPPER = wrapper;
  process.env.MMX_E2E_COUNT = independentCount;
  let job;
  try {
    job = start(path.join(root, "real-batch-quota"), ["--prompt-file", prompt, "--concurrency", "1"]).job_dir;
    const finished = await until(() => status(job).status === "finished" && status(job), 12000);
    assert.equal(finished.receipt.shards.length, 1);
    assert.equal(finished.receipt.shards[0].status, "quota_error");
    assert.equal(finished.receipt.shards[0].retried, false);
    assert.equal(finished.receipt.shards[0].retry_skipped_reason, "paid_retry_not_authorized");
    assert.equal(fs.readFileSync(independentCount, "utf8").trim().split("\n").length, 1);
    assert.equal(verify(job).integrity, "match");
  } finally {
    if (oldWrapper === undefined) delete process.env.MMX_BATCH_WRAPPER;
    else process.env.MMX_BATCH_WRAPPER = oldWrapper;
    if (oldCount === undefined) delete process.env.MMX_E2E_COUNT;
    else process.env.MMX_E2E_COUNT = oldCount;
    if (job && status(job).status !== "finished") cancel(job);
  }
});

test("real batch cancellation lets wrappers clean their detached CLI before exit",{skip:process.platform==="win32"},async()=>{
  const wrapper=path.join(root,"cleanup-wrapper.cjs");
  const ready=path.join(root,"cleanup-child-pid");
  const cleaned=path.join(root,"cleanup-confirmed");
  fs.writeFileSync(wrapper,`
const fs=require("node:fs");
const {spawn}=require("node:child_process");
const child=spawn(process.execPath,["-e","setInterval(()=>{},100)"],{detached:true,stdio:"ignore"});
child.on("spawn",()=>fs.writeFileSync(${JSON.stringify(ready)},String(child.pid)));
process.on("SIGTERM",()=>{
  try { process.kill(-child.pid,"SIGTERM"); } catch {}
});
child.on("close",()=>{fs.writeFileSync(${JSON.stringify(cleaned)},"cleaned");process.exit(0);});
setInterval(()=>{},100);
`);
  const saved=process.env.MMX_BATCH_WRAPPER;
  process.env.MMX_BATCH_WRAPPER=wrapper;
  let job;
  try {
    job=start(path.join(root,"batch-cleanup"),["--prompt-file",prompt,"--concurrency","1"]).job_dir;
    await until(()=>fs.existsSync(ready));
    cancel(job);
    const finished=await until(()=>status(job).status==="finished" && status(job),12000);
    assert.equal(finished.execution.reason,"cancelled");
    assert.equal(finished.execution.batch_exit_observed,true);
    assert.equal(finished.execution.termination_confirmed,false);
    assert.ok(fs.existsSync(cleaned),"wrapper must receive TERM and observe its detached CLI exit before batch closes");
    assert.equal(verify(job).integrity,"match");
  } finally {
    if(saved===undefined) delete process.env.MMX_BATCH_WRAPPER; else process.env.MMX_BATCH_WRAPPER=saved;
    if(fs.existsSync(ready)) try { process.kill(-Number(fs.readFileSync(ready,"utf8")),"SIGKILL"); } catch {}
    if(job && status(job).status!=="finished") cancel(job);
  }
});
