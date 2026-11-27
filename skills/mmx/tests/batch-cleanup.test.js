"use strict";
// Phase A (shrunk): cleanup escalation after the wrapper root has exited and
// the scheduling rule for shards that follow an unconfirmed cleanup. Only a
// pinned fake wrapper is used; every long-lived process below is started by
// this test, recorded in a pid file and killed by the test when it survives.
// Tests assert actual process state and launch records, never a kill call's
// return value. POSIX process-group cases skip on Windows, where the wrappers
// do not detach the CLI; that is not evidence that Windows cleans up on its
// own.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { cleanEnv, fixtureEnv } = require("./support/env.js");

const batch = path.resolve(__dirname, "../scripts/mmx-batch.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-batch-cleanup-"));
const pidDir = path.join(root, "state");
const archiveTmp = path.join(root, "archives");
fs.mkdirSync(pidDir);
fs.mkdirSync(archiveTmp);
const wrapper = path.join(root, "cleanup-wrapper.cjs");
fs.writeFileSync(wrapper, `"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2), file = argv[argv.indexOf("--prompt-file") + 1];
const mode = fs.readFileSync(file, "utf8").trim(), tag = path.basename(file, ".txt"), dir = process.env.PID_DIR;
fs.writeFileSync(path.join(dir, tag + ".launched"), String(process.pid));
const digest = b => crypto.createHash("sha256").update(b).digest("hex");
const config = argv[argv.indexOf("--profile-file") + 1];
const bind = receipt => ({ ...receipt, batch_attempt_id: process.env.ZMX_BATCH_ATTEMPT_ID,
  batch_material_sha256: digest(fs.readFileSync(file)), batch_config_sha256: digest(fs.readFileSync(config)) });
const descendant = (detached, stdio) => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {});setInterval(() => {}, 1000)"],
    { detached, stdio, windowsHide: true });
  fs.writeFileSync(path.join(dir, tag + ".pid"), String(child.pid));
  child.unref();
};
if (mode.includes("GROUP_CHILD")) descendant(false, "ignore");
if (mode.includes("PIPE_CHILD")) descendant(false, ["ignore", "pipe", "pipe"]);
if (mode.includes("DETACHED_CHILD")) descendant(true, "ignore");
if (mode.startsWith("HANG")) { setInterval(() => {}, 1000); }
else if (mode.startsWith("CRASH")) { process.exitCode = 1; }
else {
  const receipt = { status: "ok", cli_invoked: true, exit_code: 0, model: "OFFLINE-FIXTURE", text: "synthetic", complete: true,
    truncated: false, signal: null, observed_exit_code: 0, observed_signal: null, local_process_exit_observed: true };
  if (mode === "CLEAN_FAIL") Object.assign(receipt, { status: "api_error", complete: false, exit_code: 1 });
  if (mode === "OK_CLI_UNKNOWN") receipt.local_tree_cleanup = "unknown";
  if (mode === "OK_CLI_ABSENT") receipt.local_tree_cleanup = "posix_group_absent";
  process.stdout.write(JSON.stringify(bind(receipt)) + "\\n");
  if (receipt.exit_code !== 0) process.exitCode = 1;
}
`);
const posix = { skip: process.platform === "win32" && "POSIX process-group fixture; native Windows lifecycle remains gated" };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const pidOf = tag => fs.existsSync(path.join(pidDir, tag + ".pid")) ? Number(fs.readFileSync(path.join(pidDir, tag + ".pid"), "utf8")) : null;
const launched = tag => fs.existsSync(path.join(pidDir, tag + ".launched"));

function run(name, modes, extraArgs = []) {
  const files = modes.map(mode => { const f = path.join(root, name + "-" + mode + ".txt"); fs.writeFileSync(f, mode); return f; });
  const receiptFile = path.join(root, name + ".json");
  const run = spawnSync(process.execPath, [batch, ...files.flatMap(f => ["--prompt-file", f]), "--concurrency", "1",
    "--receipt-file", receiptFile, ...extraArgs], { encoding: "utf8", timeout: 60000, shell: false,
    env: cleanEnv({ ...fixtureEnv("mmx", wrapper), TMPDIR: archiveTmp, TMP: archiveTmp, TEMP: archiveTmp, PID_DIR: pidDir }) });
  let receipt = null;
  try { receipt = JSON.parse(run.stdout); } catch {}
  // Only pids this test recorded are ever signalled, and only after the batch
  // has exited, so the assertion below reflects what the batch left behind.
  const survivors = modes.map(mode => pidOf(name + "-" + mode)).filter(pid => pid && alive(pid));
  for (const pid of survivors) { try { process.kill(pid); } catch {} }
  return { run, receipt, survivors, shards: receipt?.shards ?? [] };
}

test("phase A: a wrapper failure envelope is a normal end; later shards still run", () => {
  const r = run("normal-failure", ["CLEAN_FAIL", "OK"]);
  assert.equal(r.shards[0].status, "api_error");
  assert.equal(r.shards[0].local_cleanup, "confirmed");
  assert.equal(r.shards[0].lifecycle_validation, "PASS");
  assert.equal(r.shards[0].wrapper_exit_code, 1);
  assert.equal(r.shards[1].status, "ok");
  assert.equal(launched("normal-failure-OK"), true, "a business failure must not stop independent shards");
  assert.equal(r.receipt.batch.halted, null);
});

test("phase A: a wrapper that dies without a receipt leaves cleanup unconfirmed and no later shard starts", () => {
  const r = run("crash", ["CRASH", "OK"]);
  assert.equal(r.shards[0].status, "child_error");
  assert.equal(r.shards[0].local_cleanup, "unconfirmed");
  assert.equal(r.shards[0].lifecycle_validation, "NOT_EVALUATED");
  assert.equal(r.shards[1].status, "not_started");
  assert.equal(r.shards[1].not_started_reason, "cleanup_unconfirmed");
  assert.equal(launched("crash-OK"), false, "the second wrapper must never be started");
  assert.equal(r.receipt.batch.halted, "cleanup_unconfirmed");
  assert.equal(r.receipt.gate, "NOT_EVALUATED");
  assert.match(r.receipt.note, /unconfirmed local cleanup/);
  assert.equal(r.receipt.shards[0].retried, false, "the failed shard is not replayed");
});

test("phase A: a supervisor timeout with a surviving child stops the batch and leaves nothing behind", () => {
  const r = run("timeout", ["HANG_GROUP_CHILD", "OK"], ["--supervisor-timeout-seconds", "2"]);
  assert.equal(r.shards[0].status, "timeout");
  assert.equal(r.shards[0].local_cleanup, "unconfirmed");
  assert.equal(r.shards[1].status, "not_started");
  assert.equal(launched("timeout-OK"), false);
  assert.deepEqual(r.survivors, [], "no descendant recorded by this test may outlive the batch");
});

test("phase A: a same-group descendant is killed after the root exited, and the batch still stops", posix, () => {
  const r = run("root-exit-group", ["CRASH_GROUP_CHILD", "OK"]);
  assert.equal(r.shards[0].status, "child_error");
  assert.deepEqual(r.survivors, [], "the owned group must be gone once the root has exited");
  assert.equal(r.shards[0].owned_process_group, "absent");
  assert.equal(r.shards[0].supervisor_force_attempted, true);
  assert.equal(r.shards[0].local_cleanup, "unconfirmed");
  assert.equal(launched("root-exit-group-OK"), false);
});

test("phase A: a surviving group member blocks a safe completion even with a success receipt", posix, () => {
  const r = run("survivor-success", ["OK_GROUP_CHILD", "OK"]);
  assert.equal(r.shards[0].transport_validation, "PASS", "transport evidence is reported on its own");
  assert.equal(r.shards[0].survivor_observed, true);
  assert.equal(r.shards[0].local_cleanup, "unconfirmed");
  assert.equal(r.shards[0].lifecycle_validation, "NOT_EVALUATED");
  assert.deepEqual(r.survivors, [], "the survivor is killed within the bounded settling window");
  assert.equal(r.receipt.transport_gate, "PASS");
  assert.equal(r.receipt.lifecycle_gate, "NOT_EVALUATED");
  assert.equal(r.receipt.gate, "NOT_EVALUATED", "a success JSON is not a safe completion");
  assert.equal(launched("survivor-success-OK"), false);
});

test("phase A: the wrapper's own CLI-group report decides when the owned group says nothing", posix, () => {
  const unknown = run("cli-unknown", ["OK_CLI_UNKNOWN", "OK"]);
  assert.equal(unknown.shards[0].wrapper_cli_group, "unknown");
  assert.equal(unknown.shards[0].local_cleanup, "unconfirmed");
  assert.equal(launched("cli-unknown-OK"), false);
  const absent = run("cli-absent", ["OK_CLI_ABSENT", "OK"]);
  assert.equal(absent.shards[0].wrapper_cli_group, "posix_group_absent");
  assert.equal(absent.shards[0].local_cleanup, "confirmed");
  assert.equal(launched("cli-absent-OK"), true);
  assert.equal(absent.receipt.gate, "PASS");
  assert.equal(absent.receipt.lifecycle_gate, "PASS");
});

test("phase A: a detached descendant is outside the supervisor's reach and the receipt states that scope", posix, () => {
  const r = run("detached", ["DETACHED_CHILD", "OK"]);
  assert.equal(r.shards[0].local_cleanup, "confirmed", "only the owned group and the wrapper's report are checked");
  assert.match(r.shards[0].lifecycle_scope, /detached groups/);
  assert.equal(r.survivors.length, 1, "a descendant that left the owned group outlives the batch");
  // The batch cannot see it; this test owns the process and has killed it above.
});

test("phase A: a descendant holding the pipes is cleaned up after the root exited", posix, () => {
  const r = run("pipe-holder", ["CRASH_PIPE_CHILD", "OK"], ["--supervisor-timeout-seconds", "2"]);
  assert.deepEqual(r.survivors, [], "escalation must not be skipped because the root already exited");
  assert.equal(r.shards[0].local_cleanup, "unconfirmed");
  assert.equal(launched("pipe-holder-OK"), false);
});
