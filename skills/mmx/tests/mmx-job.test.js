"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { start, status, cancel, verify } = require("../scripts/mmx-job.js");

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
  '  const mismatch = args.includes("--model") && args[args.indexOf("--model")+1] === "Expected-M3";',
  '  const result = mismatch',
  '    ? {status:"failed",gate:"NOT_EVALUATED",batch:{shards:1,retried:0},shards:[{status:"model_mismatch",complete:false,model:"Wrong-M3",requested_model:"Expected-M3",retried:false}]}',
  '    : {status:"ok",gate:"PASS",batch:{shards:1},shards:[{status:"ok",complete:true,truncated:false}]};',
  '  fs.writeFileSync(receipt,JSON.stringify(result),{flag:"wx"});',
  '  process.stdout.write(JSON.stringify(result)+"\\n");',
  '  if (mismatch) process.exitCode = 1;',
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
test("model mismatch persists as a failed job and inspection cannot replay it", async () => {
  const job = start(path.join(root,"model-mismatch-job"),
    ["--prompt-file",prompt,"--concurrency","1","--model","Expected-M3","--allow-paid-retry"],
    {batchPath:fakeBatch}).job_dir;
  const completed = await until(() => status(job).status==="finished" && status(job));
  assert.equal(completed.execution.exit_code,1);
  assert.equal(completed.receipt.status,"failed");
  assert.equal(completed.receipt.gate,"NOT_EVALUATED");
  assert.equal(completed.receipt.shards[0].status,"model_mismatch");
  assert.equal(completed.receipt.shards[0].model,"Wrong-M3");
  assert.equal(completed.receipt.shards[0].retried,false);
  assert.equal(verify(job).integrity,"match");
  const before=fs.readFileSync(counter,"utf8");
  const resumed=spawnSync(process.execPath,[script,"resume",job],{encoding:"utf8"});
  assert.equal(resumed.status,0);
  assert.equal(JSON.parse(resumed.stdout).resume_policy,"inspect_only_no_automatic_replay");
  assert.equal(fs.readFileSync(counter,"utf8"),before);
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
    batch_args:["--prompt-file",file,"--concurrency","1","--profile-file",profileFile,"--receipt-file",path.join(job,"receipt.json")]};
  fs.writeFileSync(path.join(job,"request.json"),JSON.stringify(request));
  fs.writeFileSync(path.join(job,"request-digest.json"),JSON.stringify(fileDigest(path.join(job,"request.json"))));
  return job;
}
function runWorker(job) {
  return spawnSync(process.execPath,[script,"worker",job],{encoding:"utf8",timeout:12000});
}

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

test("input directory symlinks or Windows junctions cannot bypass snapshot containment",()=>{
  const job=preparedJob("symlink-input");
  const outside=path.join(root,"outside-input");
  fs.renameSync(path.join(job,"input"),outside);
  fs.symlinkSync(outside,path.join(job,"input"),process.platform==="win32" ? "junction" : "dir");
  assert.equal(verify(job).integrity,"corrupt");
  const count=invocationCount();
  assert.equal(runWorker(job).status,2);
  assert.equal(invocationCount(),count);
});

test("read-only completed job inspection survives a runtime code update",async()=>{
  const localBatch=path.join(root,"versioned-batch.cjs");
  fs.copyFileSync(fakeBatch,localBatch);
  const job=start(path.join(root,"中文 completed job"),["--prompt-file",prompt,"--concurrency","1"],{batchPath:localBatch}).job_dir;
  await until(()=>status(job).status==="finished");
  assert.equal(status(job).runtime_code,"match");
  fs.appendFileSync(localBatch,"\n// Later git update.\n");
  const inspected=status(job);
  assert.equal(inspected.status,"finished");
  assert.equal(inspected.runtime_code,"changed_or_missing");
  assert.equal(inspected.receipt.gate,"PASS");
  assert.equal(verify(job).integrity,"match");
  assert.equal(verify(job).runtime_code,"changed_or_missing");
  fs.unlinkSync(localBatch);
  assert.equal(status(job).status,"finished");
  assert.equal(verify(job).integrity,"match");
});

test("runtime drift still blocks an unstarted worker without a provider invocation",()=>{
  const job=preparedJob("runtime-drift");
  const localBatch=path.join(root,"unstarted-versioned-batch.cjs");
  fs.copyFileSync(fakeBatch,localBatch);
  const requestFile=path.join(job,"request.json");
  const request=JSON.parse(fs.readFileSync(requestFile,"utf8"));
  request.batch_script=fs.realpathSync(localBatch);
  request.batch_script_digest=fileDigest(localBatch);
  fs.writeFileSync(requestFile,JSON.stringify(request));
  fs.writeFileSync(path.join(job,"request-digest.json"),JSON.stringify(fileDigest(requestFile)));
  fs.appendFileSync(localBatch,"\n// Changed after request pinning.\n");
  const before=invocationCount();
  assert.equal(runWorker(job).status,2);
  assert.equal(invocationCount(),before);
  assert.equal(status(job).status,"unknown");
  assert.equal(status(job).runtime_code,"changed_or_missing");
  assert.equal(verify(job).integrity,"incomplete");
});

test("unsupported atomic publication fails before supervisor launch with an actionable code",()=>{
  const job=path.join(root,"unsupported-volume");
  // Invoke start directly because requiring the CLI does not run it.
  const code=`const fs=require("node:fs");fs.linkSync=()=>{throw Object.assign(new Error("unsupported"),{code:"ENOTSUP"});};try {require(${JSON.stringify(script)}).start(${JSON.stringify(job)},["--prompt-file",${JSON.stringify(prompt)}]);process.exitCode=9;}catch(error){process.stdout.write(JSON.stringify({code:error.code,message:error.message}));}`;
  const run=spawnSync(process.execPath,["-e",code],{encoding:"utf8"});
  assert.equal(run.status,0,run.stderr);
  const failure=JSON.parse(run.stdout);
  assert.equal(failure.code,"MMX_JOB_PUBLICATION_UNAVAILABLE");
  assert.match(failure.message,/local NTFS/);
  assert.equal(fs.existsSync(path.join(job,"launch.json")),false);
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
for (const [code, simulateForceFailure] of [["EACCES", false], ["ENOSPC", true]]) {
  test("Windows worker preserves publication + " + code + " marker faults and attempts owned force", {
    skip: process.platform !== "win32" ? "native Windows cancellation publication" : false,
    timeout: 15000,
  }, async () => {
    const tag = "marker-failure-" + code.toLowerCase();
    const job = preparedJob(tag);
    const ready = path.join(root, tag + ".ready");
    const sent = path.join(root, tag + ".marker-fault");
    const forced = path.join(root, tag + ".force-attempted");
    const count = path.join(root, tag + ".fake-calls");
    const failsafe = path.join(root, tag + ".batch-failsafe");
    const hungBatch = path.join(root, tag + ".batch.cjs");
    const preload = path.join(root, tag + ".preload.cjs");

    fs.writeFileSync(hungBatch, [
      '"use strict";',
      'const fs=require("node:fs");',
      'fs.appendFileSync(' + JSON.stringify(count) + ',"request\\n");',
      'fs.writeFileSync(' + JSON.stringify(ready) + ',"ready",{flag:"wx"});',
      'setInterval(()=>{},100);',
      'setTimeout(()=>{fs.writeFileSync(' + JSON.stringify(failsafe) + ',"self-exit");process.exit(89)},4500).unref();',
    ].join("\n"));

    // The job is created but unlaunched. The only executable is the fake batch
    // above. Rebind the pinned request and independently count its invocations.
    const requestFile = path.join(job, "request.json");
    const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    request.batch_script = fs.realpathSync(hungBatch);
    request.batch_script_digest = fileDigest(hungBatch);
    fs.writeFileSync(requestFile, JSON.stringify(request));
    fs.writeFileSync(path.join(job, "request-digest.json"), JSON.stringify(fileDigest(requestFile)));

    fs.writeFileSync(preload, [
      '"use strict";',
      'const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process");',
      'if(path.resolve(process.argv[1]||"")===' + JSON.stringify(path.resolve(script)) + '&&process.argv[2]==="worker"){',
      'const realLink=fs.linkSync,realWrite=fs.writeFileSync,realSpawnSync=cp.spawnSync;',
      'const ready=' + JSON.stringify(ready) + ',sent=' + JSON.stringify(sent) +
        ',forced=' + JSON.stringify(forced) + ';',
      'fs.linkSync=function(from,to){',
      ' if(path.basename(String(to))==="started.json"){',
      '   const deadline=Date.now()+3000, barrier=new Int32Array(new SharedArrayBuffer(4));',
      '   while(!fs.existsSync(ready)&&Date.now()<deadline) Atomics.wait(barrier,0,0,10);',
      '   if(!fs.existsSync(ready)) throw new Error("fake batch did not start");',
      '   throw Object.assign(new Error("synthetic started publication failure"),{code:"EACCES"});',
      ' } return realLink.apply(this,arguments);',
      '};',
      'fs.writeFileSync=function(file){',
      ' if(path.basename(String(file))==="cancel.request"){',
      '   realWrite(sent,' + JSON.stringify(code) + ',{flag:"wx"});',
      '   throw Object.assign(new Error("synthetic cancel marker failure"),{code:' + JSON.stringify(code) + '});',
      ' } return realWrite.apply(this,arguments);',
      '};',
      'cp.spawnSync=function(command){',
      ' if(command==="taskkill.exe"){',
      '   fs.appendFileSync(forced,"force\\n");',
      simulateForceFailure
        ? '   return {status:1,error:Object.assign(new Error("synthetic taskkill failure"),{code:"EPERM"})};'
        : '   return realSpawnSync.apply(this,arguments);',
      ' } return realSpawnSync.apply(this,arguments);',
      '};',
      '}',
    ].join("\n"));

    const before = fs.existsSync(count) ? fs.readFileSync(count, "utf8") : "";
    const execution = spawnSync(process.execPath, [
      "--require", preload, script, "worker", job,
    ], { encoding: "utf8", timeout: 11000, windowsHide: true });
    assert.equal(execution.status, 2, execution.stderr + execution.stdout);
    assert.equal(fs.existsSync(ready), true, "batch must have started before publication failure");
    assert.equal(fs.readFileSync(sent, "utf8"), code, "cancel write fault must be injected");
    assert.equal(fs.existsSync(forced), true, "owned-child force must be attempted despite marker fault");
    assert.equal(fs.readFileSync(count, "utf8"), before + "request\n", "exactly one fake batch launch");

    const failure = JSON.parse(fs.readFileSync(path.join(job, "failure.json"), "utf8"));
    // writeOnce deliberately normalizes a hard-link EACCES into this stable
    // publication error code; the distinct cancellation write error remains raw.
    assert.equal(failure.original_error_code, "MMX_JOB_PUBLICATION_UNAVAILABLE");
    assert.equal(failure.cleanup_error_code, code);
    assert.equal(failure.batch_started, true);
    assert.equal(failure.termination_confirmed, null);
    assert.equal(fs.existsSync(path.join(job, "worker.lock")), true);
    assert.equal(fs.existsSync(path.join(job, "completion.json")), false);
    assert.equal(status(job).status, "unknown");
    assert.equal(verify(job).integrity, "incomplete");
    assert.equal(fs.readFileSync(count, "utf8"), before + "request\n", "inspection must not replay");

    if (simulateForceFailure) {
      // A deliberately unkillable fake batch still exits by its own short
      // failsafe, so this test cannot leave a running fixture after teardown.
      await until(() => fs.existsSync(failsafe), 7000);
      assert.equal(failure.batch_close_observed, false, "no fabricated termination proof");
    }
  });
}
