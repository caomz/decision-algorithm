"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { start, status, cancel, verify } = require("../scripts/mmx-job.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-durable-job-"));
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
  'if (process.env.MMX_JOB_TEST_HANG === "1") setInterval(()=>{},100);',
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
