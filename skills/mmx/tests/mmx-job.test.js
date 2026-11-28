"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { start, status, cancel, verify, runtimeBinding } = require("../scripts/mmx-job.js");
const { findMmx } = require("../scripts/mmx-chat.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-durable-job-"));
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
const fixtureHome = path.join(root, "home");
fs.mkdirSync(fixtureHome, { mode: 0o700 });
for (const key of Object.keys(process.env)) {
  if (/^(?:(?:https?|all|no)_proxy$|minimax_|mmx_|node_options$)/i.test(key)) delete process.env[key];
}
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
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
  'const done = stdinEnded => {',
  '  const result = {status:"ok",gate:"PASS",batch:{shards:1},shards:[{status:"ok",complete:true,truncated:false}],stdin_ended:stdinEnded};',
  '  fs.writeFileSync(receipt,JSON.stringify(result),{flag:"wx"});',
  '  process.stdout.write(JSON.stringify(result)+"\\n");',
  '};',
  'if (process.env.MMX_JOB_TEST_HANG === "1") {',
  '  if (process.env.MMX_JOB_IGNORE_TERM === "1") process.on("SIGTERM",()=>{});',
  '  if (process.env.MMX_JOB_FAKE_READY) fs.writeFileSync(process.env.MMX_JOB_FAKE_READY,String(process.pid));',
  '  setInterval(()=>{},100);',
  '}',
  'else {',
  '  let delayElapsed = false, stdinEnded = false, emitted = false;',
  '  let grace;',
  '  const finish = () => {',
  '    if (emitted) return;',
  '    emitted = true;',
  '    clearTimeout(grace);',
  '    done(stdinEnded);',
  '  };',
  '  process.stdin.once("end", () => { stdinEnded = true; if (delayElapsed && grace) finish(); });',
  '  process.stdin.resume();',
  '  setTimeout(() => {',
  '    delayElapsed = true;',
  '    if (stdinEnded) finish();',
  '    else grace = setTimeout(finish, 2000);',
  '  }, Number(process.env.MMX_JOB_TEST_SLEEP_MS || 25));',
  '}',
].join("\n") + "\n");
const script = path.join(__dirname, "../scripts/mmx-job.js");
process.env.MMX_JOB_FAKE_COUNTER = counter;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Test harness deadline. The runtime timeouts asserted by these tests are unchanged.
async function until(predicate, timeoutMs=30000) {
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
  assert.equal(finished.receipt.stdin_ended,true);
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
  assert.equal(runtime.files.length,5);
  assert.ok(runtime.files.some(v=>v.file.endsWith("mmx-native-budget.js")));
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
// Build a synthetic mmx-cli package whose shim sits on PATH, so findMmx
// resolves the package entry — the provable chain. POSIX uses a symlink (or
// copy) named `mmx`; Windows uses an npm-style mmx.cmd shim whose package
// lives beside it, exactly like a real npm global install.
function provableCli(label, version) {
  const sandbox = fs.mkdtempSync(path.join(root, label + "-"));
  const binDir = path.join(sandbox, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const pkgDir = process.platform === "win32"
    ? path.join(binDir, "node_modules", "mmx-cli")
    : path.join(sandbox, "pkg", "node_modules", "mmx-cli");
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
    name: "mmx-cli", version: version || "9.9.9", bin: { mmx: "dist/mmx.mjs" },
  }));
  const entry = path.join(pkgDir, "dist", "mmx.mjs");
  // The entry must carry the executable bit: findMmx checks X_OK through the
  // shim, and a symlink's access check lands on its target.
  fs.writeFileSync(entry, "// synthetic CLI entry\n", { mode: 0o755 });
  fs.chmodSync(entry, 0o755);
  let shim;
  if (process.platform === "win32") {
    shim = path.join(binDir, "mmx.cmd");
    fs.writeFileSync(shim, [
      "@ECHO off",
      "SETLOCAL",
      '"%_prog%" "%dp0%\\node_modules\\mmx-cli\\dist\\mmx.mjs" %*',
      "",
    ].join("\n"));
  } else {
    shim = path.join(binDir, "mmx");
    try { fs.symlinkSync(entry, shim); }
    catch { fs.copyFileSync(entry, shim); fs.chmodSync(shim, 0o755); }
  }
  return { sandbox, binDir, pkgDir, entry, shim };
}
// A shell wrapper that execs the package shim: what it finally executes cannot
// be proven by the shared rule, so the chain is unresolved by design. POSIX
// only; on Windows a bare `mmx` wrapper is simply not found, which the
// kind-agnostic unresolved assertions accept.
function wrapperOver(label, version) {
  const cli = provableCli(label, version);
  const binDir = path.join(cli.sandbox, "wrapper-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, "mmx");
  fs.writeFileSync(wrapper, ["#!/bin/bash", `exec env "${cli.shim}" "$@"`, ""].join("\n"));
  fs.chmodSync(wrapper, 0o755);
  return { ...cli, binDir, wrapper };
}
function withPath(value, run) {
  const saved = process.env.PATH;
  process.env.PATH = value;
  try { return run(); } finally { process.env.PATH = saved; }
}
const POSIX_ONLY = { skip: process.platform === "win32" };
// One shared provable chain for every test that just needs a launchable job:
// this whole file runs with the shim first on PATH, so preparedJob records a
// resolved binding and every spawned worker agrees with it.
const PROVABLE = provableCli("shared-cli", "9.9.9");
process.env.PATH = PROVABLE.binDir + path.delimiter + process.env.PATH;
test("MAC-10 a package-owned shim on PATH binds the executed package", () => {
  const box = provableCli("provable-shim", "9.9.9");
  withPath(box.binDir, () => {
    const runtime = runtimeBinding();
    assert.equal(runtime.cli.kind, "package_entry");
    assert.equal(runtime.cli.resolution, "resolved");
    assert.equal(runtime.cli.entry.file, fs.realpathSync(box.entry));
    assert.equal(runtime.cli.package.version, "9.9.9");
    assert.equal(runtime.cli.package.file, fs.realpathSync(path.join(box.pkgDir, "package.json")));
    assert.equal(runtime.cli.launcher, null, "no launcher guess is recorded");
  });
});
test("MAC-10 a shell wrapper that shadows the npm shim is unprovable and refuses to launch", POSIX_ONLY, () => {
  // The macOS layout where ~/.local/bin/mmx is a shell wrapper: what the
  // wrapper finally executes cannot be proven without scanning shell text,
  // which is forbidden. The binding stays unresolved and a durable job refuses
  // to launch before creating any job state.
  const box = wrapperOver("wrapper-path", "9.9.9");
  withPath(box.binDir, () => {
    const runtime = runtimeBinding();
    assert.ok(runtime.cli, "the CLI record must stay bound");
    assert.equal(runtime.cli.kind, "custom_launcher");
    assert.equal(runtime.cli.resolution, "unresolved");
    assert.equal(runtime.cli.package, null, "no package identity may be invented");
    assert.equal(runtime.cli.entry, null, "no entry identity may be invented");
    assert.equal(runtime.cli.launcher.file, fs.realpathSync(box.wrapper));
    const jobDir = path.join(box.sandbox, "refused-job");
    const promptFile = path.join(box.sandbox, "prompt.txt");
    fs.writeFileSync(promptFile, "SYNTHETIC REQUEST A\n");
    const count = invocationCount();
    assert.throws(() => start(jobDir, ["--prompt-file", promptFile, "--concurrency", "1"]),
      /not provable/, "start must refuse an unprovable chain");
    assert.equal(fs.existsSync(jobDir), false, "no job state may be created");
    assert.equal(invocationCount(), count);
  });
});
test("MAC-10 a same-named package in an unrelated directory is not a binding", () => {
  // An mmx-cli package.json that exists somewhere else on disk must never be
  // accepted as the binding. Only the package that owns the resolved entry
  // counts; the decoy must lose.
  const box = provableCli("unrelated-pkg", "9.9.9");
  const decoy = path.join(box.sandbox, "elsewhere");
  fs.mkdirSync(decoy, { recursive: true });
  fs.writeFileSync(path.join(decoy, "package.json"), JSON.stringify({
    name: "mmx-cli", version: "0.0.1-decoy",
  }));
  withPath(box.binDir, () => {
    const runtime = runtimeBinding();
    assert.equal(runtime.cli.resolution, "resolved");
    assert.equal(runtime.cli.package.version, "9.9.9", "a decoy package must not win");
    assert.equal(runtime.cli.package.file, fs.realpathSync(path.join(box.pkgDir, "package.json")));
    assert.notEqual(runtime.cli.package.file, fs.realpathSync(path.join(decoy, "package.json")));
  });
});
test("MAC-10 an undeterminable execution chain is reported as unknown", POSIX_ONLY, () => {
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
    assert.equal(runtime.cli.kind, "custom_launcher");
    assert.equal(runtime.cli.resolution, "unresolved");
    assert.equal(runtime.cli.package, null, "no package identity may be invented");
    assert.equal(runtime.cli.entry, null, "no entry identity may be invented");
    assert.equal(runtime.cli.launcher.file, fs.realpathSync(wrapper));
  });
});
test("MAC-10 start refuses and creates no job state when the chain is unprovable", () => {
  const sandbox = fs.mkdtempSync(path.join(root, "refuse-start-"));
  const binDir = path.join(sandbox, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, "mmx");
  fs.writeFileSync(wrapper, ["#!/bin/bash", "exec /usr/bin/true \"$@\"", ""].join("\n"));
  fs.chmodSync(wrapper, 0o755);
  const promptFile = path.join(sandbox, "prompt.txt");
  fs.writeFileSync(promptFile, "SYNTHETIC REQUEST A\n");
  const jobDir = path.join(sandbox, "job");
  const count = invocationCount();
  withPath(binDir, () => {
    assert.throws(() => start(jobDir, ["--prompt-file", promptFile, "--concurrency", "1"]),
      /not provable/);
  });
  assert.equal(fs.existsSync(jobDir), false, "no job directory may be created");
  assert.equal(invocationCount(), count, "a refused start may not call the provider");
});
test("MAC-10 the worker refuses a recorded unprovable chain even without drift", () => {
  // A job whose recorded binding was already unresolved must never reach the
  // provider, even when the recorded bytes still match the current binding.
  const sandbox = fs.mkdtempSync(path.join(root, "worker-gate-"));
  const binDir = path.join(sandbox, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, "mmx");
  fs.writeFileSync(wrapper, ["#!/bin/bash", "exec /usr/bin/true \"$@\"", ""].join("\n"));
  fs.chmodSync(wrapper, 0o755);
  const job = withPath(binDir, () => preparedJob("worker-gate-unresolved"));
  const count = invocationCount();
  withPath(binDir, () => {
    assert.equal(runWorker(job).status, 2);
  });
  assert.equal(invocationCount(), count, "an unprovable recording may not call the provider");
});
test("MAC-10 launcher selection agrees with mmx-chat findMmx (X_OK policy)", POSIX_ONLY, () => {
  // A non-executable shim is skipped by findMmx; the job must make the same
  // choice instead of binding the first name match.
  const boxA = provableCli("xok-a", "1.1.1");
  const boxB = provableCli("xok-b", "2.2.2");
  fs.chmodSync(boxA.shim, 0o644); // present but not executable
  const pathValue = boxA.binDir + path.delimiter + boxB.binDir;
  withPath(pathValue, () => {
    const runtime = runtimeBinding();
    const wrapperChoice = findMmx();
    assert.ok(wrapperChoice && wrapperChoice.argsPrefix.length === 1,
      "findMmx must resolve the executable shim");
    assert.equal(runtime.cli.resolution, "resolved");
    assert.equal(runtime.cli.package.version, "2.2.2",
      "the non-executable shim must be skipped exactly like findMmx");
    assert.equal(runtime.cli.entry.file, fs.realpathSync(boxB.entry));
  });
});
test("MAC-10 a package entry under a CJK and space path binds normally", () => {
  // Legitimate paths containing Chinese characters and spaces must not break
  // the provable chain: the shim resolves and the package is bound.
  const sandbox = fs.mkdtempSync(path.join(root, "cjk-path-"));
  const base = path.join(sandbox, "中文 目录");
  const binDir = path.join(base, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const pkgDir = process.platform === "win32"
    ? path.join(binDir, "node_modules", "mmx-cli")
    : path.join(base, "pkg", "node_modules", "mmx-cli");
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
    name: "mmx-cli", version: "3.3.3", bin: { mmx: "dist/mmx.mjs" },
  }));
  const entry = path.join(pkgDir, "dist", "mmx.mjs");
  // The entry must carry the executable bit: findMmx checks X_OK through the
  // shim, and a symlink's access check lands on its target.
  fs.writeFileSync(entry, "// synthetic CLI entry\n", { mode: 0o755 });
  fs.chmodSync(entry, 0o755);
  let shim;
  if (process.platform === "win32") {
    shim = path.join(binDir, "mmx.cmd");
    fs.writeFileSync(shim, [
      "@ECHO off",
      "SETLOCAL",
      '"%_prog%" "%dp0%\\node_modules\\mmx-cli\\dist\\mmx.mjs" %*',
      "",
    ].join("\n"));
  } else {
    shim = path.join(binDir, "mmx");
    try { fs.symlinkSync(entry, shim); }
    catch { fs.copyFileSync(entry, shim); fs.chmodSync(shim, 0o755); }
  }
  withPath(binDir, () => {
    const runtime = runtimeBinding();
    assert.equal(runtime.cli.resolution, "resolved");
    assert.equal(runtime.cli.package.version, "3.3.3");
    assert.equal(runtime.cli.entry.file, fs.realpathSync(entry));
  });
});
test("MAC-10 a comment that names an mmx-cli entry is never a binding", () => {
  // A wrapper whose comment mentions a real package entry but whose code
  // executes something else must stay unresolved. Comments are not execution.
  const box = provableCli("comment-decoy", "9.9.9");
  const binDir = path.join(box.sandbox, "comment-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, "mmx");
  fs.writeFileSync(wrapper, [
    "#!/bin/bash",
    `# exec "${box.entry}"`,
    "exec /usr/bin/true \"$@\"",
    "",
  ].join("\n"));
  fs.chmodSync(wrapper, 0o755);
  const jobDir = path.join(box.sandbox, "comment-job");
  const promptFile = path.join(box.sandbox, "prompt.txt");
  fs.writeFileSync(promptFile, "SYNTHETIC REQUEST A\n");
  const count = invocationCount();
  withPath(binDir, () => {
    const runtime = runtimeBinding();
    assert.equal(runtime.cli.resolution, "unresolved",
      "a commented path must never claim resolution");
    assert.equal(runtime.cli.package, null);
    assert.throws(() => start(jobDir, ["--prompt-file", promptFile, "--concurrency", "1"]),
      /not provable/);
  });
  assert.equal(fs.existsSync(jobDir), false);
  assert.equal(invocationCount(), count);
});
test("MAC-10 a package upgrade is a runtime drift that refuses to launch", () => {
  const box = provableCli("pkg-upgrade", "9.9.9");
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
  const box = provableCli("entry-change", "9.9.9");
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
  const first = provableCli("path-drift-a", "9.9.9");
  const second = provableCli("path-drift-b", "9.9.10");
  const job = withPath(first.binDir, () => preparedJob("runtime-drift-path"));
  const count = invocationCount();
  // The same job is verified against a different package on PATH.
  withPath(second.binDir, () => {
    assert.equal(verify(job).integrity, "corrupt");
    assert.equal(runWorker(job).status, 2);
  });
  assert.equal(invocationCount(), count, "a PATH drift may not call the provider");
});
test("MAC-10 drift of the preloaded undici copy refuses to launch", () => {
  // The undici copy that mmx-chat's fetch guard would preload is part of the
  // execution identity: mutating it after recording is drift.
  const box = provableCli("preload-drift", "9.9.9");
  const undiciDir = path.join(box.pkgDir, "node_modules", "undici");
  fs.mkdirSync(undiciDir, { recursive: true });
  fs.writeFileSync(path.join(undiciDir, "package.json"), JSON.stringify({
    name: "undici", version: "0.0.0", main: "index.js",
  }));
  const undici = path.join(undiciDir, "index.js");
  fs.writeFileSync(undici, "module.exports = {};\n");
  const job = withPath(box.binDir, () => preparedJob("runtime-drift-preload"));
  withPath(box.binDir, () => {
    const runtime = runtimeBinding();
    assert.equal(runtime.cli.resolution, "resolved");
    assert.ok(runtime.cli.preload, "the resolvable undici copy must be bound");
    assert.equal(runtime.cli.preload.file, fs.realpathSync(undici));
  });
  fs.writeFileSync(undici, "module.exports = { changed: true };\n");
  const count = invocationCount();
  withPath(box.binDir, () => {
    assert.equal(verify(job).integrity, "corrupt");
    assert.equal(runWorker(job).status, 2);
  });
  assert.equal(invocationCount(), count, "a preload drift may not call the provider");
});
test("MAC-10 cancelling a finished job never re-invokes the provider", () => {
  const job = preparedJob("cancel-after-finish");
  assert.equal(runWorker(job).status, 0);
  const count = invocationCount();
  const result = cancel(job);
  assert.equal(result.status, "finished", "a finished job cannot be cancelled");
  assert.equal(fs.existsSync(path.join(job, "cancel.request")), false,
    "cancelling a finished job must not write a cancel marker");
  assert.equal(runWorker(job).status, 2, "a finished job may not be replayed");
  assert.equal(invocationCount(), count, "cancelling a finished job may not call the provider");
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
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--require " + JSON.stringify(require.resolve("./fixtures/batch-wrapper-preload.cjs"));
  const oldWrapper = process.env.MMX_TEST_WRAPPER;
  const oldCount = process.env.MMX_E2E_COUNT;
  process.env.MMX_TEST_WRAPPER = wrapper;
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
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    if (oldWrapper === undefined) delete process.env.MMX_TEST_WRAPPER;
    else process.env.MMX_TEST_WRAPPER = oldWrapper;
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
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--require " + JSON.stringify(require.resolve("./fixtures/batch-wrapper-preload.cjs"));
  const saved=process.env.MMX_TEST_WRAPPER;
  process.env.MMX_TEST_WRAPPER=wrapper;
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
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    if(saved===undefined) delete process.env.MMX_TEST_WRAPPER; else process.env.MMX_TEST_WRAPPER=saved;
    if(fs.existsSync(ready)) try { process.kill(-Number(fs.readFileSync(ready,"utf8")),"SIGKILL"); } catch {}
    if(job && status(job).status!=="finished") cancel(job);
  }
});
