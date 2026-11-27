"use strict";
// F-lite: transport-and-recovery handoff from the unified entry to the
// durable fixture entry. Only the existing explicit fixture admission and the
// pinned fixture script are used, with a synthetic prompt inside the shard
// limit. There is no content vote anywhere in this file: the durable fixture
// protocol is not review-v1, so the secondary gate stays NOT_EVALUATED by
// construction and a transport PASS never becomes a review PASS.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { durableHandoffKey, composeDurableSecondary } = require("../scripts/review-run.js");
const jobmod = require("../../mmx/scripts/mmx-job.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-handoff-"));
const keyParts = { run: "review-run-20261127", material: "01".repeat(32), stage: "secondary", config: "fixture" };
const key = durableHandoffKey([keyParts.run, keyParts.material, keyParts.stage, keyParts.config]);
const jobsRoot = path.join(root, "jobs");
// The durable entry derives the directory from the key: job-<SHA-256(KEY)>,
// as documented in docs/zmx-stability-v2/04-durable-tasks.md.
const expectedDir = path.join(jobsRoot, "job-" + createHash("sha256").update(key).digest("hex"));
const prompt = path.join(root, "shard.txt");
fs.writeFileSync(prompt, "SYNTHETIC SECONDARY HANDOFF\n");
const options = ["--backend", "fixture", "--prompt-file", prompt, "--slot-root", path.join(root, "slots-handoff")];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finished(job, maxMs = 15000) {
  const stop = Date.now() + maxMs;
  while (Date.now() < stop) {
    const value = jobmod.status(job);
    if (value.status === "finished") return value;
    await pause(25);
  }
  throw new Error("fixture deadline exceeded");
}

test("F-lite: the handoff key is stable, derived and fits the admission contract", () => {
  assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  assert.equal(key, durableHandoffKey([keyParts.run, keyParts.material, keyParts.stage, keyParts.config]));
  assert.notEqual(key, durableHandoffKey([keyParts.run, keyParts.material, "secondary", "other-config"]));
  assert.throws(() => durableHandoffKey([keyParts.run, ""]), /nonempty/);
});

test("F-lite: submit is idempotent and the job reference is recoverable from the key alone", async () => {
  const first = jobmod.submit(jobsRoot, key, options);
  assert.equal(first.job_dir, expectedDir, "the deterministic key decides the directory");
  const value = await finished(first.job_dir);
  assert.equal(value.receipt.transport_gate, "PASS");
  // Simulate a crash after submit but before the reference was persisted:
  // the job is found again by recomputing the key, without a new launch.
  const recovered = path.join(jobsRoot, "job-" + createHash("sha256").update(key).digest("hex"));
  assert.equal(fs.existsSync(recovered), true);
  const again = jobmod.submit(jobsRoot, key, options);
  assert.equal(again.job_dir, expectedDir);
  assert.equal(again.reused, true);
  assert.equal(again.automatic_replay, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(expectedDir, "receipt.json"), "utf8")).shards[0].material_sha256,
    createHash("sha256").update(fs.readFileSync(prompt)).digest("hex"), "the receipt is bound to the sealed material");
});

test("F-lite: the same key with different material is refused, nothing is replayed", async () => {
  fs.writeFileSync(prompt, "SYNTHETIC SECONDARY HANDOFF, CHANGED\n");
  assert.throws(() => jobmod.submit(jobsRoot, key, options), /idempotency conflict/);
});

test("F-lite: host wait expiry neither cancels nor resubmits; resume is inspection only", async () => {
  const slowPrompt = path.join(root, "slow.txt");
  fs.writeFileSync(slowPrompt, "SYNTHETIC SLOW HANDOFF\n");
  const slowOptions = ["--backend", "fixture", "--prompt-file", slowPrompt,
    "--slot-root", path.join(root, "slots-slow"), "--fixture-delay-ms", "400"];
  const slow = jobmod.submit(path.join(root, "slow-jobs"), "slow-key", slowOptions).job_dir;
  const timed = await jobmod.waitForJob(slow, 5);
  assert.equal(timed.host_wait_timed_out, true);
  assert.equal(timed.wait_policy, "query_only_no_cancel_no_resubmit");
  assert.equal(fs.existsSync(path.join(slow, "cancel.request")), false, "wait expiry must not create a cancel marker");
  const resumed = jobmod.submit(path.join(root, "slow-jobs"), "slow-key", slowOptions);
  assert.equal(resumed.job_dir, slow);
  assert.equal(resumed.reused, true);
  assert.equal(resumed.automatic_replay, false);
  const value = await finished(slow);
  assert.equal(value.execution.reason, "child_exit");
});

test("F-lite: composition keeps a valid primary veto and never grants a review PASS", () => {
  const pass = composeDurableSecondary({ PRIMARY_REVIEW_GATE: "PASS" }, { status: "finished" });
  assert.equal(pass.SECONDARY_REVIEW_GATE, "NOT_EVALUATED");
  assert.equal(pass.SECONDARY_NOT_EVALUATED_REASON, "durable_content_vote_not_wired");
  assert.equal(pass.REVIEW_GATE, "NOT_EVALUATED");
  const fail = composeDurableSecondary({ PRIMARY_REVIEW_GATE: "FAIL" }, { status: "finished" });
  assert.equal(fail.REVIEW_GATE, "FAIL", "a valid primary P1 survives the unwired secondary");
  assert.equal(composeDurableSecondary(null, null).REVIEW_GATE, "NOT_EVALUATED");
});
