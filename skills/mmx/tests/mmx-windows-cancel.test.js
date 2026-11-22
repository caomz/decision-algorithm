"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { spawnSync } = childProcess;

// Capture the ChildProcess returned by this test's module, not a stale PID
// read from an on-disk Job. The production start() API remains unchanged.
const observedSupervisors = new Map();
const realSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = realSpawn(...args);
  const [command, argv, options] = args;
  if (command === process.execPath && argv?.[1] === "worker" &&
      argv?.[0] === require.resolve("../scripts/mmx-job.js") && options?.cwd) {
    const close = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    observedSupervisors.set(path.resolve(options.cwd), { child, close });
  }
  return child;
};
let supervisor;
try { supervisor = require("../scripts/mmx-job.js"); }
finally { childProcess.spawn = realSpawn; }
const { start, status, cancel, verify } = supervisor;

const batch = path.resolve(__dirname, "../scripts/mmx-batch.js");
const profile = path.resolve(__dirname, "../profiles/local.json");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(probe, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = probe();
    if (value) return value;
    await sleep(40);
  }
  throw new Error("timed out waiting for Windows cancellation evidence");
}

// A completion file describes Job evidence, not the supervisor's lifecycle.
// Test teardown waits for the exact ChildProcess.close, then retries only the
// exclusive temporary fixture directory with a real, bounded async delay.
async function cleanFixtureAfterClose(root, observed, options = {}) {
  const started = Date.now();
  const job = path.join(root, "job");
  const closeDeadlineMs = options.closeDeadlineMs ?? 7000;
  const removeDeadlineMs = options.removeDeadlineMs ?? 3500;
  const remove = options.remove ?? (dir => fs.promises.rm(dir, {
    recursive: true, force: true, maxRetries: 0,
  }));
  const failureFile = root + ".cleanup-failure.json";
  try {
    if (!observed && fs.existsSync(path.join(job, "launch.json"))) {
      throw new Error("owned_supervisor_handle_unavailable");
    }
    if (observed) {
      let timer;
      const closed = await Promise.race([
        observed.close.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), closeDeadlineMs); }),
      ]);
      clearTimeout(timer);
      if (!closed) throw new Error("supervisor_close_not_observed");
    }
    const deadline = Date.now() + removeDeadlineMs;
    while (true) {
      try {
        await remove(root);
        return;
      } catch (error) {
        if (!["EBUSY", "ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(error?.code) ||
            Date.now() >= deadline) {
          throw Object.assign(new Error("fixture_cleanup_failed: " + (error?.code || "UNKNOWN")),
            { code: error?.code });
        }
        await sleep(Math.min(70, Math.max(1, deadline - Date.now())));
      }
    }
  } catch (error) {
    // Preserve evidence outside the fixture tree even after partial recursive
    // deletion. A cleanup hook failure must FAIL the test, never be ignored.
    try {
      fs.writeFileSync(failureFile, JSON.stringify({
        code: error.code || "UNVERIFIED", error: error.message,
        fixture: root, supervisor_pid: observed?.child?.pid ?? null,
        elapsed_ms: Date.now() - started,
      }, null, 2), { flag: "wx" });
    } catch {}
    throw error;
  }
}

test("cancel marker before the batch starts blocks all paid wrapper calls", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-windows-pre-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "cancel.request");
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(marker, "cancel\n");
  fs.writeFileSync(prompt, "SYNTHETIC ONLY");
  const res = spawnSync(process.execPath,
    [batch, "--prompt-file", prompt, "--profile-file", profile, "--concurrency", "1"],
    { encoding: "utf8", timeout: 10000, env: { ...process.env, MMX_CANCEL_REQUEST_FILE: marker } });
  assert.equal(res.status, 1, res.stderr);
  const receipt = JSON.parse(res.stdout);
  assert.equal(receipt.status, "cancelled");
  assert.equal(receipt.gate, "NOT_EVALUATED");
  assert.equal(receipt.shards.length, 1);
  assert.equal(receipt.shards[0], null, "unstarted shard must not have a fabricated receipt");
});

test("Windows cancel waits for a cooperative batch acknowledgement before force", {
  skip: process.platform !== "win32" ? "native Windows supervisor cancellation" : false,
  timeout: 20000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-windows-coop-"));
  // Wait for the *owned* supervisor's ChildProcess.close, not merely its
  // completion.json. Never delete a still-running worker's cwd/Job evidence.
  const job = path.join(root, "job");
  t.after(async () => {
    try { await cleanFixtureAfterClose(root, observedSupervisors.get(job)); }
    finally { observedSupervisors.delete(job); }
  });
  const prompt = path.join(root, "prompt.txt");
  const fake = path.join(root, "cooperative-batch.cjs");
  const ready = path.join(root, "ready.txt");
  const acknowledged = path.join(root, "acknowledged.txt");
  fs.writeFileSync(prompt, "SYNTHETIC ONLY\n");
  fs.writeFileSync(fake, [
    '"use strict";',
    'const fs=require("node:fs");',
    'const marker=process.env.MMX_CANCEL_REQUEST_FILE;',
    'if (!marker) process.exit(41);',
    'fs.writeFileSync(process.env.MMX_WINDOWS_FAKE_READY,"ready");',
    'setInterval(()=>{',
    '  if (fs.existsSync(marker)) {',
    '    fs.writeFileSync(process.env.MMX_WINDOWS_FAKE_ACK,"cancelled cleanly");',
    '    process.exit(0);',
    '  }',
    '}, 30);',
  ].join("\n") + "\n");
  const oldReady = process.env.MMX_WINDOWS_FAKE_READY;
  const oldAck = process.env.MMX_WINDOWS_FAKE_ACK;
  process.env.MMX_WINDOWS_FAKE_READY = ready;
  process.env.MMX_WINDOWS_FAKE_ACK = acknowledged;
  try {
    const created = start(path.join(root, "job"), ["--prompt-file", prompt, "--concurrency", "1"],
      { batchPath: fake });
    assert.equal(created.status, "started");
    await waitFor(() => fs.existsSync(ready));
    assert.equal(cancel(created.job_dir).status, "cancel_requested");
    const finished = await waitFor(() => {
      const s = status(created.job_dir);
      return s.status === "finished" ? s : null;
    });
    assert.equal(finished.execution.reason, "cancelled");
    assert.equal(finished.execution.exit_code, 0, "clean exit, not forced taskkill");
    assert.equal(finished.execution.batch_exit_observed, true);
    assert.equal(fs.readFileSync(acknowledged, "utf8"), "cancelled cleanly");
    assert.equal(verify(created.job_dir).integrity, "match");
  } finally {
    if (oldReady === undefined) delete process.env.MMX_WINDOWS_FAKE_READY;
    else process.env.MMX_WINDOWS_FAKE_READY = oldReady;
    if (oldAck === undefined) delete process.env.MMX_WINDOWS_FAKE_ACK;
    else process.env.MMX_WINDOWS_FAKE_ACK = oldAck;
  }
});

test("fixture teardown defers removal until its observed supervisor closes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-clean-close-"));
  let release;
  const tracked = { close: new Promise(resolve => { release = resolve; }) };
  const pending = cleanFixtureAfterClose(root, tracked, { closeDeadlineMs: 900 });
  assert.ok(fs.existsSync(root), "completion evidence cannot authorize early deletion");
  release({ code: 0, signal: null });
  await pending;
  assert.equal(fs.existsSync(root), false);
});

test("fixture teardown fails closed if the owned supervisor never closes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-clean-open-"));
  try {
    await assert.rejects(
      cleanFixtureAfterClose(root, { close: new Promise(() => {}) }, { closeDeadlineMs: 35 }),
      /supervisor_close_not_observed/
    );
    assert.equal(fs.existsSync(root), true, "do not delete a running supervisor cwd");
    assert.equal(fs.existsSync(root + ".cleanup-failure.json"), true, "failed teardown must leave evidence");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(root + ".cleanup-failure.json", { force: true });
  }
});

test("fixture teardown retries transient EBUSY but fails on a permanent lock", async () => {
  const root1 = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-clean-transient-"));
  let attempts = 0;
  await cleanFixtureAfterClose(root1, { close: Promise.resolve({ code: 0 }) }, {
    removeDeadlineMs: 1000,
    remove: async dir => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await fs.promises.rm(dir, { recursive: true, force: true });
    },
  });
  assert.equal(attempts, 3);
  assert.equal(fs.existsSync(root1), false);

  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-clean-permanent-"));
  let refused = 0;
  try {
    await assert.rejects(
      cleanFixtureAfterClose(root2, { close: Promise.resolve({ code: 0 }) }, {
        removeDeadlineMs: 120,
        remove: async () => { refused++; throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
      }),
      /fixture_cleanup_failed: EBUSY/
    );
    assert.ok(refused >= 2, "retry must occur after a real asynchronous delay");
    assert.equal(fs.existsSync(root2), true, "locked fixture is retained");
    assert.equal(fs.existsSync(root2 + ".cleanup-failure.json"), true);
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
    fs.rmSync(root2 + ".cleanup-failure.json", { force: true });
  }
});
