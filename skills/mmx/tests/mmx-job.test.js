"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { start, submit, status, waitForJob, cancel, verify, ADMISSION } = require("../scripts/mmx-job.js");

const script = path.resolve(__dirname, "../scripts/mmx-job.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-durable-v21-"));
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
let seq = 0;
function setup(text = "SYNTHETIC REQUEST A\n") {
  const dir = path.join(root, String(++seq)); fs.mkdirSync(dir, { mode: 0o700 });
  const prompt = path.join(dir, "source.txt"); fs.writeFileSync(prompt, text);
  const options = ["--backend", "fixture", "--prompt-file", prompt, "--slot-root", path.join(dir, "slots")];
  return { dir, prompt, options };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, maxMs = 6000) {
  const stop = performance.now() + maxMs;
  while (performance.now() < stop) {
    const value = predicate(); if (value) return value; await pause(20);
  }
  throw new Error("fixture deadline exceeded");
}
async function finished(job) { return until(() => { const r = status(job); return r.status === "finished" && r; }); }
function cli(args, env) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10000, env });
}
function cliAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
function read(job, file) { return JSON.parse(fs.readFileSync(path.join(job, file), "utf8")); }
function fp(file) { const b = fs.readFileSync(file); return { bytes: b.length, sha256: createHash("sha256").update(b).digest("hex") }; }
function fixtureEvent(job, event) { return read(job, "receipt.json.shards/000.input/" + event + ".json"); }

test("durable admission is disabled by default and rejects real before input/output access", () => {
  assert.equal(ADMISSION.default_enabled, false);
  const dir = path.join(root, "must-not-create");
  for (const backend of [[], ["--backend", "real"]]) {
    assert.throws(() => start(dir, [...backend, "--prompt-file", "/absent"]), /disabled/);
    assert.equal(fs.existsSync(dir), false);
  }
  const r = cli(["submit", dir, "key", "--backend", "real", "--prompt-file", "/absent"]);
  assert.equal(r.status, 2); assert.equal(fs.existsSync(dir), false);
});

test("snapshots bind the material, retained 600/630/650 defaults and ignored stdin", async () => {
  const c = setup(); const job = start(path.join(c.dir, "job"), c.options).job_dir;
  fs.writeFileSync(c.prompt, "CHANGED SOURCE\n");
  const result = await finished(job);
  assert.equal(result.execution.exit_code, 0); assert.equal(result.receipt.transport_gate, "PASS");
  assert.equal(result.receipt.review_gate, "NOT_EVALUATED");
  assert.equal(result.receipt.batch.concurrency, 1); assert.equal(result.receipt.batch.retried, 0);
  assert.equal(result.receipt.batch.supervisor_timeout_ms, 650000);
  const request = read(job, "request.json"); const profile = read(job, "input/profile.json");
  assert.equal(profile.request_timeout_seconds, 600); assert.equal(profile.wrapper_timeout_seconds, 630);
  assert.equal(fs.readFileSync(request.prompts[0].file, "utf8"), "SYNTHETIC REQUEST A\n");
  assert.equal(result.receipt.shards[0].fixture_stdin_ended, true);
  assert.equal(verify(job).integrity, "match");
  if (process.platform !== "win32") await until(() => status(job).execution?.slot_released === true);
  else assert.equal(result.execution.slot_released, false);
});

test("repeated deterministic submission returns the same job without a new launch", async () => {
  const c = setup(); const jobs = path.join(c.dir, "jobs");
  const first = submit(jobs, "revision-a-review-1", c.options);
  await finished(first.job_dir);
  const launch = fs.readFileSync(path.join(first.job_dir, "launch.json"), "utf8");
  const next = submit(jobs, "revision-a-review-1", c.options);
  assert.equal(next.job_dir, first.job_dir); assert.equal(next.reused, true); assert.equal(next.automatic_replay, false);
  assert.equal(fs.readdirSync(jobs).length, 1);
  assert.equal(fs.readFileSync(path.join(first.job_dir, "launch.json"), "utf8"), launch);
  assert.equal(cli(["worker", first.job_dir]).status, 2);
  assert.equal(verify(first.job_dir).integrity, "match");
});

test("same idempotency key rejects different material and preserves the old result", async () => {
  const c = setup(); const jobs = path.join(c.dir, "jobs");
  const job = submit(jobs, "key-a", c.options).job_dir; await finished(job);
  const receipt = fs.readFileSync(path.join(job, "receipt.json"), "utf8");
  fs.writeFileSync(c.prompt, "SYNTHETIC REQUEST B\n");
  assert.throws(() => submit(jobs, "key-a", c.options), /idempotency conflict/);
  assert.equal(fs.readFileSync(path.join(job, "receipt.json"), "utf8"), receipt);
  assert.equal(verify(job).integrity, "match");
});

test("concurrent independent submitters reserve one job and one worker", async () => {
  const c = setup(); const args = ["submit", path.join(c.dir, "jobs"), "same-key", ...c.options];
  const results = await Promise.all([cliAsync(args), cliAsync(args), cliAsync(args)]);
  for (const r of results) assert.equal(r.code, 0, r.stderr + r.stdout);
  const responses = results.map(r => JSON.parse(r.stdout));
  assert.equal(new Set(responses.map(r => r.job_dir)).size, 1);
  assert.equal(responses.filter(r => r.reused === false).length, 1);
  const job = responses[0].job_dir; await finished(job);
  assert.equal(fs.existsSync(path.join(job, "worker.lock")), true);
  assert.equal(fs.readdirSync(path.join(job, "receipt.json.shards")).filter(f => f.endsWith(".started.json")).length, 1);
});

test("host wait timeout neither cancels nor resubmits a persistent job", async () => {
  const c = setup(); const opts = [...c.options, "--fixture-delay-ms", "500"];
  const jobs = path.join(c.dir, "jobs"); const job = submit(jobs, "long-review", opts).job_dir;
  const timed = await waitForJob(job, 5);
  assert.equal(timed.host_wait_timed_out, true);
  assert.equal(timed.wait_policy, "query_only_no_cancel_no_resubmit");
  assert.equal(fs.existsSync(path.join(job, "cancel.request")), false);
  const same = submit(jobs, "long-review", opts); assert.equal(same.job_dir, job); assert.equal(same.reused, true);
  assert.equal((await finished(job)).execution.reason, "child_exit");
  const query = cli(["wait", job, "--wait-ms", "0"]);
  assert.equal(JSON.parse(query.stdout).host_wait_timed_out, false);
});

test("host submitter exits while detached worker completes and a new session queries it", async () => {
  const c = setup(); const r = await cliAsync(["start", path.join(c.dir, "job"), ...c.options, "--fixture-delay-ms", "400"]);
  assert.equal(r.code, 0, r.stderr); const job = JSON.parse(r.stdout).job_dir;
  assert.equal(fs.existsSync(path.join(job, "completion.json")), false);
  await finished(job);
  const query = cli(["resume", job]); assert.equal(query.status, 0);
  assert.equal(JSON.parse(query.stdout).resume_policy, "inspect_only_no_automatic_replay");
});

test("two jobs in different directories share one cross-session slot", { skip: process.platform === "win32" }, async () => {
  const c = setup(); const opts = [...c.options, "--fixture-delay-ms", "300"];
  const a = start(path.join(c.dir, "first"), opts).job_dir;
  await until(() => fs.existsSync(path.join(a, "receipt.json.shards/000.input/fixture-start.json")));
  const b = start(path.join(c.dir, "second"), opts).job_dir;
  await Promise.all([finished(a), finished(b)]);
  assert.ok(fixtureEvent(b, "fixture-start").started_ms >= fixtureEvent(a, "fixture-end").ended_ms);
  await until(() => status(a).execution?.slot_released === true && status(b).execution?.slot_released === true);
});

test("UNKNOWN partial archive never starts again and resume is inspection only", async () => {
  const c = setup(); const job = start(path.join(c.dir, "job"), c.options).job_dir; await finished(job);
  fs.unlinkSync(path.join(job, "completion.json"));
  const old = fs.readFileSync(path.join(job, "execution.json"), "utf8");
  assert.equal(status(job).status, "unknown"); assert.equal(verify(job).integrity, "incomplete");
  assert.equal(start(job, c.options).reused, true);
  assert.equal(cli(["worker", job]).status, 2);
  assert.equal(JSON.parse(cli(["resume", job]).stdout).status, "unknown");
  assert.equal(fs.readFileSync(path.join(job, "execution.json"), "utf8"), old);
});

test("missing or corrupt records never authorize an automatic replay", () => {
  const c = setup(); const job = path.join(c.dir, "partial"); fs.mkdirSync(job);
  fs.writeFileSync(path.join(job, "request.json"), "incomplete");
  const r = start(job, c.options); assert.equal(r.status, "unknown"); assert.equal(r.reused, true);
  assert.equal(fs.existsSync(path.join(job, "launch.json")), false);
  assert.equal(verify(job).integrity, "corrupt");
});

test("material, receipt and execution tampering return UNKNOWN without repair", async () => {
  for (const name of ["input/shard-0.txt", "receipt.json", "execution.json"]) {
    const c = setup(); const job = start(path.join(c.dir, "job"), c.options).job_dir; await finished(job);
    fs.appendFileSync(path.join(job, name), "changed");
    assert.equal(verify(job).integrity, "corrupt", name); assert.equal(status(job).status, "unknown", name);
    assert.equal(start(job, c.options).reused, true); assert.equal(cli(["worker", job]).status, 2);
  }
});

test("rehashing a swapped result cannot mix material versions", async () => {
  const c = setup(); const job = start(path.join(c.dir, "job"), c.options).job_dir; await finished(job);
  // Windows has no proven group-disappearance check, so a finished job there
  // keeps its slot and never writes a release record.
  if (process.platform !== "win32") {
    await until(() => fs.existsSync(path.join(job, "slot-release.json")));
    fs.unlinkSync(path.join(job, "slot-release.json"));
  }
  const receipt = read(job, "receipt.json"); receipt.shards[0].material_sha256 = "f".repeat(64);
  fs.writeFileSync(path.join(job, "receipt.json"), JSON.stringify(receipt));
  const execution = read(job, "execution.json"); execution.outputs["receipt.json"] = fp(path.join(job, "receipt.json"));
  fs.writeFileSync(path.join(job, "execution.json"), JSON.stringify(execution));
  const completion = read(job, "completion.json"); completion.execution = fp(path.join(job, "execution.json"));
  fs.writeFileSync(path.join(job, "completion.json"), JSON.stringify(completion));
  const confirmed = read(job, "completion-confirmed.json"); confirmed.completion = fp(path.join(job, "completion.json"));
  fs.writeFileSync(path.join(job, "completion-confirmed.json"), JSON.stringify(confirmed));
  assert.equal(verify(job).integrity, "corrupt"); assert.equal(status(job).status, "unknown");
});

test("input directory symlinks are refused during inspection", { skip: process.platform === "win32" }, async () => {
  const c = setup(); const job = start(path.join(c.dir, "job"), c.options).job_dir; await finished(job);
  const outside = path.join(c.dir, "moved"); fs.renameSync(path.join(job, "input"), outside);
  fs.symlinkSync(outside, path.join(job, "input"), "dir");
  assert.equal(verify(job).integrity, "corrupt"); assert.equal(status(job).status, "unknown");
});

test("caller environment cannot substitute a provider wrapper or inject Node preload", async () => {
  const c = setup(); const canary = path.join(c.dir, "must-not-run.cjs"); const marker = path.join(c.dir, "bad");
  fs.writeFileSync(canary, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'BAD');`);
  // Set overrides after loading this module, so the host process itself does not
  // run a preload. Only a child inheriting it would create the canary.
  const keys = ["MMX_BATCH_WRAPPER", "NODE_OPTIONS", "MINIMAX_API_KEY", "MINIMAX_BASE_URL", "HTTPS_PROXY"];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let job;
  try {
    process.env.MMX_BATCH_WRAPPER = canary; process.env.NODE_OPTIONS = "--require " + canary;
    process.env.MINIMAX_API_KEY = "synthetic-credential"; process.env.MINIMAX_BASE_URL = "http://invalid.example";
    process.env.HTTPS_PROXY = "http://invalid.example";
    job = start(path.join(c.dir, "job"), c.options).job_dir;
  } finally { for (const k of keys) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  assert.equal((await finished(job)).receipt.gate, "PASS"); assert.equal(fs.existsSync(marker), false);
});

test("cancel while queued preserves the other owner and never starts the batch", async () => {
  const c = setup(); const slotRoot = path.join(c.dir, "slots");
  const owner = await require("../scripts/mmx-provider-slot.js").acquireMmxSlot({ root: slotRoot });
  const job = start(path.join(c.dir, "job"), c.options).job_dir;
  await until(() => fs.existsSync(path.join(job, "worker.lock")));
  assert.equal(cancel(job).status, "cancel_requested");
  const r = await finished(job); assert.equal(r.execution.batch_started, false); assert.equal(r.execution.reason, "cancelled");
  assert.equal(fs.existsSync(owner.path), true); owner.release();
  assert.equal(fs.existsSync(path.join(job, "receipt.json")), false);
});

test("slot deadline leaves a terminal no-launch record without stealing a stale owner", async () => {
  const c = setup(); const owner = await require("../scripts/mmx-provider-slot.js").acquireMmxSlot({ root: path.join(c.dir, "slots") });
  const job = start(path.join(c.dir, "job"), [...c.options, "--slot-wait-ms", "10"]).job_dir;
  const r = await finished(job); assert.equal(r.execution.batch_started, false); assert.equal(r.execution.slot_error, "MMX_SLOT_BUSY");
  assert.equal(fs.existsSync(owner.path), true); owner.release();
});

test("failed transport retains its slot and cannot replay using its existing key", async () => {
  const c = setup("FIXTURE_TRANSPORT_FAIL\n"); const job = start(path.join(c.dir, "job"), c.options).job_dir;
  const r = await finished(job); assert.equal(r.receipt.transport_gate, "NOT_EVALUATED");
  assert.equal(r.execution.slot_released, false); assert.equal(fs.existsSync(path.join(c.dir, "slots/mmx/slot-0")), true);
  assert.equal(start(job, c.options).reused, true); assert.equal(cli(["worker", job]).status, 2);
});

test("permanent worker claim survives a supervisor crash with uncertain completion", { skip: process.platform === "win32" }, async () => {
  const c = setup(); const options = [...c.options, "--fixture-delay-ms", "400"];
  const job = start(path.join(c.dir, "job"), options).job_dir;
  await until(() => fs.existsSync(path.join(job, "receipt.json.shards/000.input/fixture-start.json")));
  const started = read(job, "started.json"); process.kill(started.supervisor_pid, "SIGKILL");
  await until(() => fs.existsSync(path.join(job, "receipt.json.shards/000.input/fixture-end.json")));
  assert.equal(status(job).status, "unknown"); assert.equal(fs.existsSync(path.join(job, "worker.lock")), true);
  assert.equal(fs.existsSync(path.join(c.dir, "slots/mmx/slot-0")), true);
  assert.equal(start(job, options).reused, true); assert.equal(cli(["worker", job]).status, 2);
});

test("importing parsers installs no signal handlers and durable concurrency stays one", () => {
  const c = setup(); assert.throws(() => start(path.join(c.dir, "bad"), [...c.options, "--concurrency", "2"]), /concurrency/);
  const code = `const b=['SIGTERM','SIGINT','SIGHUP'].map(s=>process.listenerCount(s));require(${JSON.stringify(script)});console.log(JSON.stringify(['SIGTERM','SIGINT','SIGHUP'].map((s,i)=>process.listenerCount(s)-b[i])));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  assert.equal(r.status, 0); assert.deepEqual(JSON.parse(r.stdout), [0, 0, 0]);
});


test("SIGHUP after submitter disconnect does not cancel the worker", { skip: process.platform === "win32" }, async () => {
  const c = setup(); const job = start(path.join(c.dir, "job"), [...c.options, "--fixture-delay-ms", "400"]).job_dir;
  await until(() => fs.existsSync(path.join(job, "started.json")));
  process.kill(read(job, "started.json").supervisor_pid, "SIGHUP");
  const result = await finished(job); assert.equal(result.execution.reason, "child_exit");
  assert.equal(result.receipt.transport_gate, "PASS"); assert.equal(fs.existsSync(path.join(job, "cancel.request")), false);
});

test("completion publication failure retains the slot and cannot restart the worker", async () => {
  const c = setup(); const job = start(path.join(c.dir, "job"), [...c.options, "--fixture-delay-ms", "400"]).job_dir;
  await until(() => fs.existsSync(path.join(job, "receipt.json.shards/000.input/fixture-start.json")));
  fs.mkdirSync(path.join(job, "completion.json"));
  await until(() => fs.existsSync(path.join(job, "execution.json")));
  assert.equal(status(job).status, "unknown");
  assert.equal(fs.existsSync(path.join(c.dir, "slots/mmx/slot-0")), true);
  assert.equal(fs.existsSync(path.join(job, "slot-release.json")), false);
  assert.equal(cli(["worker", job]).status, 2);
});


test("logical-shard limits and exact CLI version options are preserved in identity", async () => {
  const c = setup("S".repeat(9000)); const jobs = path.join(c.dir, "jobs");
  assert.throws(() => submit(jobs, "too-large", [...c.options, "--shard-max-bytes", "8192"]), /exceeds/);
  assert.equal(fs.existsSync(jobs), false);
  const options = [...c.options, "--shard-max-bytes", "12288", "--expected-cli-version", "1.0.29"];
  const job = submit(jobs, "bound-options", options).job_dir; await finished(job);
  const req = read(job, "request.json");
  assert.equal(req.batch_args[req.batch_args.indexOf("--shard-max-bytes") + 1], "12288");
  assert.equal(req.batch_args[req.batch_args.indexOf("--expected-cli-version") + 1], "1.0.29");
  assert.equal(status(job).receipt.batch.logical_sharding.max_prompt_bytes, 12288);
  assert.throws(() => submit(jobs, "bound-options", [...c.options, "--shard-max-bytes", "16384", "--expected-cli-version", "1.0.29"]), /idempotency conflict/);
  assert.throws(() => submit(jobs, "bound-options", [...c.options, "--shard-max-bytes", "12288", "--expected-cli-version", "1.0.30"]), /idempotency conflict/);
});


test("directory fsync failure after completion link remains UNKNOWN and retains the slot", { skip: process.platform !== "linux" }, async () => {
  const c = setup(); const seed = start(path.join(c.dir, "seed"), c.options).job_dir;
  await finished(seed); await until(() => fs.existsSync(path.join(seed, "slot-release.json")));
  // Prepare another fixture request with the same content/options and relocated
  // absolute snapshot paths; no output evidence or permanent worker claim is copied.
  const job = path.join(c.dir, "sync-failure"); fs.mkdirSync(job, { mode: 0o700 });
  fs.cpSync(path.join(seed, "input"), path.join(job, "input"), { recursive: true });
  const request = fs.readFileSync(path.join(seed, "request.json"), "utf8").split(seed).join(job);
  fs.writeFileSync(path.join(job, "request.json"), request);
  fs.writeFileSync(path.join(job, "request-digest.json"), JSON.stringify(fp(path.join(job, "request.json"))));
  const fault = path.join(c.dir, "fsync-fault.cjs");
  fs.writeFileSync(fault, `const fs=require('node:fs');const path=require('node:path');
const job=${JSON.stringify(job)};const dir=fs.statSync(job);const original=fs.fsyncSync;
fs.fsyncSync=function(fd){const st=fs.fstatSync(fd);
 if(st.isDirectory()&&st.dev===dir.dev&&st.ino===dir.ino&&fs.existsSync(path.join(job,'completion.json')))
   throw Object.assign(new Error('synthetic directory fsync failure'),{code:'EIO'});
 return original.call(fs,fd);};`);
  const run = spawnSync(process.execPath, ["--require", fault, script, "worker", job], { encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.equal(fs.existsSync(path.join(job, "completion.json")), true, "fault is after the visible link");
  assert.equal(fs.existsSync(path.join(job, "completion-confirmed.json")), false);
  assert.equal(status(job).status, "unknown"); assert.equal(verify(job).integrity, "incomplete");
  assert.equal(fs.existsSync(path.join(c.dir, "slots/mmx/slot-0")), true);
  assert.equal(fs.existsSync(path.join(job, "slot-release.json")), false);
  assert.equal(cli(["worker", job]).status, 2);
});

// ---------------------------------------------------------------------------
// F02: the completion record is bound to the shard archive plan. The expected
// archive set is derived from that plan and the per-shard execution state,
// never from whatever survived on disk. status/verify are read-only.
// ---------------------------------------------------------------------------
function archiveEntries(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) archiveEntries(file, base, out); else out.push(path.relative(base, file).split(path.sep).join("/"));
  }
  return out.sort();
}
const shardsOf = job => path.join(job, "receipt.json.shards");
const BINDING = "completion_bound_plan_and_per_shard_records";

test("F02: completion is bound to the shard plan and the archive verifies as a whole", async () => {
  const c = setup(); const job = start(path.join(c.dir, "job"), c.options).job_dir;
  const result = await finished(job);
  assert.equal(result.execution.shard_archive_binding, BINDING);
  const report = verify(job);
  assert.equal(report.integrity, "match");
  assert.equal(report.record_format, 4);
  assert.equal(report.shard_archive_binding, BINDING);
  assert.equal(read(job, "completion.json").shard_plan.sha256, fp(path.join(shardsOf(job), "plan.json")).sha256);
  assert.deepEqual(archiveEntries(shardsOf(job)), ["000.input/fixture-end.json", "000.input/fixture-start.json", "000.input/shard-0.txt",
    "000.json", "000.raw.json", "000.started.json", "plan.json", "profile.json"]);
});

const tampers = [
  ["raw shard receipt deleted", job => fs.unlinkSync(path.join(shardsOf(job), "000.raw.json"))],
  ["raw shard receipt truncated", job => fs.truncateSync(path.join(shardsOf(job), "000.raw.json"), 8)],
  ["per-shard record corrupted", job => fs.appendFileSync(path.join(shardsOf(job), "000.json"), "corrupt")],
  ["per-shard record content rewritten", job => { const file = path.join(shardsOf(job), "000.json"); const record = JSON.parse(fs.readFileSync(file, "utf8")); record.text = "FORGED REPLACEMENT"; fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n"); }],
  ["plan metadata rewritten", job => { const file = path.join(shardsOf(job), "plan.json"); const plan = JSON.parse(fs.readFileSync(file, "utf8")); plan.shards[0].material_sha256 = "f".repeat(64); fs.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n"); }],
  ["whole archive deleted", job => { for (const rel of archiveEntries(shardsOf(job)).slice().reverse()) fs.unlinkSync(path.join(shardsOf(job), rel)); fs.rmdirSync(path.join(shardsOf(job), "000.input")); fs.rmdirSync(shardsOf(job)); }],
  ["launch intent deleted", job => fs.unlinkSync(path.join(shardsOf(job), "000.started.json"))],
  ["unexpected archive entry", job => fs.writeFileSync(path.join(shardsOf(job), "999.json"), "{}\n")],
  ["sealed input snapshot rewritten", job => fs.writeFileSync(path.join(shardsOf(job), "000.input", "shard-0.txt"), "REWRITTEN\n")],
  ["sealed profile replaced", job => fs.writeFileSync(path.join(shardsOf(job), "profile.json"), "{}\n")],
];
for (const [name, mutate] of tampers) {
  test(`F02: ${name} is reported corrupt and never repaired`, async () => {
    const c = setup(); const job = start(path.join(c.dir, "job"), c.options).job_dir; await finished(job);
    assert.equal(verify(job).integrity, "match");
    // Let the worker finish its own release bookkeeping first: a tamper must
    // not race with it. On Windows no release happens at all.
    if (process.platform !== "win32") await until(() => status(job).execution?.slot_released === true, 8000);
    mutate(job);
    const slotRoot = path.join(c.dir, "slots"), slotsBefore = archiveEntries(slotRoot), archiveBefore = archiveEntries(shardsOf(job));
    assert.equal(verify(job).integrity, "corrupt", name);
    assert.equal(verify(job).integrity, "corrupt", "repeated read-only queries agree");
    assert.equal(status(job).status, "unknown", name);
    assert.deepEqual(archiveEntries(shardsOf(job)), archiveBefore, "inspection never rewrites the archive");
    assert.deepEqual(archiveEntries(slotRoot), slotsBefore, "inspection never touches the provider slot");
    assert.equal(start(job, c.options).reused, true, "the same key resolves to the same job");
    assert.equal(cli(["worker", job]).status, 2, "corruption never starts another worker");
  });
}

test("F02: a raw receipt swapped in from another material is rejected", async () => {
  const c = setup(); const job = start(path.join(c.dir, "job"), c.options).job_dir; await finished(job);
  const prompt = path.join(c.dir, "other.txt"); fs.writeFileSync(prompt, "SYNTHETIC REQUEST B\n");
  const other = start(path.join(c.dir, "other"), ["--backend", "fixture", "--prompt-file", prompt, "--slot-root", path.join(c.dir, "slots-other")]).job_dir;
  await finished(other);
  if (process.platform !== "win32") await until(() => status(job).execution?.slot_released === true, 8000);
  fs.copyFileSync(path.join(shardsOf(other), "000.raw.json"), path.join(shardsOf(job), "000.raw.json"));
  assert.equal(verify(job).integrity, "corrupt");
  assert.equal(status(job).status, "unknown");
});

test("F02: an archive directory redirected elsewhere is rejected", { skip: process.platform === "win32" }, async () => {
  const c = setup(); const job = start(path.join(c.dir, "job"), c.options).job_dir; await finished(job);
  const outside = path.join(c.dir, "moved-archive"); fs.renameSync(shardsOf(job), outside);
  fs.symlinkSync(outside, shardsOf(job), "dir");
  assert.equal(verify(job).integrity, "corrupt");
});

test("F02: a failed shard carries its intent and record but promises no raw receipt", async () => {
  const c = setup("FIXTURE_TRANSPORT_FAIL\n"); const job = start(path.join(c.dir, "job"), c.options).job_dir; await finished(job);
  assert.equal(read(job, "receipt.json").shards[0].raw_receipt_file, null);
  assert.equal(verify(job).integrity, "match");
  fs.writeFileSync(path.join(shardsOf(job), "000.raw.json"), "{}\n");
  assert.equal(verify(job).integrity, "corrupt", "a raw receipt the execution never promised is rejected");
});

test("F02: a job written by an earlier record format is not silently upgraded", async () => {
  const c = setup(); const job = start(path.join(c.dir, "job"), c.options).job_dir; await finished(job);
  const requestFile = path.join(job, "request.json"); const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  request.format = 3; fs.writeFileSync(requestFile, JSON.stringify(request, null, 2) + "\n");
  fs.writeFileSync(path.join(job, "request-digest.json"), JSON.stringify(fp(requestFile)));
  assert.equal(status(job).status, "unknown");
  assert.equal(verify(job).integrity, "corrupt");
});
