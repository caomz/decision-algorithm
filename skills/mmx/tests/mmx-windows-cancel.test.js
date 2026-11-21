"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { start, status, cancel, verify } = require("../scripts/mmx-job.js");

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
  assert.equal(receipt.shards[0], undefined);
});

test("Windows cancel waits for a cooperative batch acknowledgement before force", {
  skip: process.platform !== "win32" ? "native Windows supervisor cancellation" : false,
  timeout: 20000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-windows-coop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
