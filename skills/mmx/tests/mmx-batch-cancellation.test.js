"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const batch = path.resolve(__dirname, "../scripts/mmx-batch.js");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(probe, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (probe()) return;
    await pause(25);
  }
  throw new Error("timed out waiting for controlled batch evidence");
}

function launch(t, root, preload, wrapper, extraEnv = {}) {
  const prompt = path.join(root, "中文 request.txt");
  const receipt = path.join(root, "receipt.json");
  fs.writeFileSync(prompt, "SYNTHETIC ONLY\r\n");
  const child = spawn(process.execPath, ["--require", preload, batch, "--prompt-file", prompt,
    "--concurrency", "1", "--receipt-file", receipt], {
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MMX_BATCH_WRAPPER: wrapper, MMX_CANCEL_REQUEST_FILE: "", ...extraEnv },
  });
  let stdout = "", stderr = "", finished = false;
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  t.after(async () => {
    if (!finished) {
      try { process.kill(Number(fs.readFileSync(path.join(root, "wrapper.pid"), "utf8")), "SIGKILL"); } catch {}
      child.kill("SIGKILL");
    }
    await closed;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { child, receipt, closed, output: () => ({ stdout, stderr }), done: () => finished };
}

test("cancelling during quota backoff writes a receipt promptly without another request", { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-backoff-cancel-"));
  const marker = path.join(root, "cancel.request");
  const ready = path.join(root, "backoff-ready");
  const count = path.join(root, "invocations");
  const wrapper = path.join(root, "quota-wrapper.cjs");
  const preload = path.join(root, "observe-close.cjs");
  fs.writeFileSync(wrapper, `
const fs=require("node:fs");
fs.writeFileSync(${JSON.stringify(path.join(root, "wrapper.pid"))},String(process.pid));
fs.appendFileSync(${JSON.stringify(count)},"call\\n");
process.stdout.write(JSON.stringify({status:"quota_error",complete:false,exit_code:1})+"\\n");
process.exitCode=1;
`);
  // Observe the real wrapper close before publishing readiness. This avoids a
  // guessed sleep that could cancel before the quota receipt reaches the batch.
  fs.writeFileSync(preload, `
const cp=require("node:child_process");
const fs=require("node:fs");
const original=cp.spawn;
cp.spawn=function(...args) {
  const child=original(...args);
  child.once("close",()=>setTimeout(()=>fs.writeFileSync(${JSON.stringify(ready)},"ready"),100));
  return child;
};
`);
  const running = launch(t, root, preload, wrapper, {
    MMX_CANCEL_REQUEST_FILE: marker, MMX_BATCH_QUOTA_RETRY_MS: "30000",
  });
  await waitFor(() => fs.existsSync(ready));
  fs.writeFileSync(marker, "cancel\n");
  await waitFor(running.done, 3000);
  const exit = await running.closed;
  const { stdout, stderr } = running.output();
  assert.equal(exit.code, 1, stderr);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.status, "cancelled");
  assert.equal(receipt.gate, "NOT_EVALUATED");
  assert.equal(receipt.shards[0].retried, false);
  assert.equal(receipt.shards[0].first_attempt.status, "quota_error");
  assert.ok(receipt.shards[0].retry_backoff_seconds < 5);
  assert.equal(fs.readFileSync(count, "utf8"), "call\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(running.receipt, "utf8")), receipt);
  assert.ok(fs.existsSync(marker), "supervisor-owned cancellation evidence must remain");
});

test("foreground SIGINT gives wrappers a cooperative marker and saves a cancellation receipt", { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-foreground-cancel-"));
  const ready = path.join(root, "ready");
  const ack = path.join(root, "ack");
  const markerRecord = path.join(root, "marker-path");
  const wrapper = path.join(root, "cooperative-wrapper.cjs");
  const preload = path.join(root, "interrupt.cjs");
  fs.writeFileSync(wrapper, `
const fs=require("node:fs");
fs.writeFileSync(${JSON.stringify(path.join(root, "wrapper.pid"))},String(process.pid));
const marker=process.env.MMX_CANCEL_REQUEST_FILE;
if (!marker) process.exit(41);
fs.writeFileSync(${JSON.stringify(markerRecord)},marker);
process.on("SIGTERM",()=>{});
fs.writeFileSync(${JSON.stringify(ready)},"ready");
const poll=setInterval(()=>{
  if (!fs.existsSync(marker)) return;
  clearInterval(poll);
  fs.writeFileSync(${JSON.stringify(ack)},"cleaned");
  process.stdout.write(JSON.stringify({status:"cancelled",complete:false})+"\\n");
  process.exitCode=1;
},25);
`);
  // Node receives SIGINT from Ctrl+C on Windows, but process.kill(SIGINT)
  // would force termination there. Emit the Node event to exercise its actual
  // handler on every platform; physical console delivery remains native QA.
  fs.writeFileSync(preload, `
const fs=require("node:fs");
const poll=setInterval(()=>{
  if (!fs.existsSync(${JSON.stringify(ready)})) return;
  clearInterval(poll);
  process.emit("SIGINT");
},25);
poll.unref();
`);
  const running = launch(t, root, preload, wrapper);
  await waitFor(running.done);
  const exit = await running.closed;
  const { stdout, stderr } = running.output();
  assert.equal(exit.code, 1, stderr);
  assert.equal(fs.readFileSync(ack, "utf8"), "cleaned");
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.status, "cancelled");
  assert.equal(receipt.gate, "NOT_EVALUATED");
  assert.equal(receipt.shards[0].status, "cancelled");
  assert.deepEqual(JSON.parse(fs.readFileSync(running.receipt, "utf8")), receipt);
  const marker = fs.readFileSync(markerRecord, "utf8");
  assert.equal(fs.existsSync(path.dirname(marker)), false, "batch-owned temporary marker is removed after cleanup");
});

test("a receipt persistence failure keeps shard results but cannot report PASS", { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-receipt-write-error-"));
  const wrapper = path.join(root, "ok-wrapper.cjs");
  const preload = path.join(root, "disk-full.cjs");
  fs.writeFileSync(wrapper, 'process.stdout.write(JSON.stringify({status:"ok",complete:true,truncated:false})+"\\n");\n');
  fs.writeFileSync(preload, `
const fs=require("node:fs");
const original=fs.writeFileSync;
fs.writeFileSync=function(file,...rest) {
  if (typeof file === "number") throw Object.assign(new Error("disk full"),{code:"ENOSPC"});
  return original.call(this,file,...rest);
};
`);
  const running = launch(t, root, preload, wrapper);
  await waitFor(running.done);
  const exit = await running.closed;
  const { stdout, stderr } = running.output();
  assert.equal(exit.code, 1, stderr);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.status, "receipt_error");
  assert.equal(receipt.gate, "NOT_EVALUATED");
  assert.equal(receipt.shards[0].status, "ok");
  assert.equal(receipt.shards[0].complete, true);
  assert.match(receipt.receipt_file_write_error, /ENOSPC/);
});
