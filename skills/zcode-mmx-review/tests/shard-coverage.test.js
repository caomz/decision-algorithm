"use strict";

const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildCoveragePlan, writePlan, verifyPlan, evaluateCoverage } = require("../scripts/shard-coverage.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-shard-coverage-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const packet = {
  goal: { request: "Verify every configured deployment gate", acceptance: [
    "Every service restart preserves the config", "Every recovery run keeps the audit trail",
  ] },
  facts: [{ id: "F1", text: "中文🌟".repeat(9000) }],
};
const raw = Buffer.from(JSON.stringify(packet) + "\n", "utf8");
const validSide = (family, gate = "PASS") => ({
  eligible: true, material_bound: true, model_family: family, gate,
});
const receipt = (shard, z = "PASS", m = "PASS") => ({
  shard_id: shard.id, shard_sha256: shard.sha256,
  providers: { zcode: validSide("glm", z), mmx: validSide("minimax", m) },
});
const plan = buildCoveragePlan(raw, { chunkBytes: 8192 }).plan;

test("UTF-8 boundaries are lossless and the AC matrix requires all shards", () => {
  assert.ok(plan.shards.length > 1);
  assert.equal(plan.acceptance_ids.length, 2);
  assert.equal(plan.requirements.length, 2);
  for (const requirement of plan.requirements) {
    assert.deepEqual(requirement.required_shards, plan.shards.map(s => s.id));
  }
  for (const shard of plan.shards) {
    assert.ok(shard.bytes > 0 && shard.bytes <= 8192);
    assert.equal(shard.end_byte - shard.start_byte, shard.bytes);
  }
});

test("new archive plans exact bytes and rejects edits to even one shard", () => {
  const dir = path.join(root, "archive");
  const result = writePlan(raw, dir, { chunkBytes: 8192 });
  assert.equal(result.status, "planned");
  assert.equal(verifyPlan(dir).integrity, "match");
  const first = path.join(dir, "shards", plan.shards[0].file);
  fs.appendFileSync(first, "extra");
  assert.equal(verifyPlan(dir).integrity, "corrupt");
  assert.throws(() => writePlan(raw, dir, { chunkBytes: 8192 }), /EEXIST/);
});

test("two independent bound PASS reviews of every shard allow PASS", () => {
  const records = plan.shards.map(shard => receipt(shard));
  const result = evaluateCoverage(plan, records);
  assert.equal(result.review_gate, "PASS");
  assert.equal(result.coverage_complete, true);
  assert.equal(result.covered_shards, plan.shards.length);
  assert.equal(result.acceptance.every(a => a.missing_shards.length === 0), true);
});

test("one unreviewed shard blocks PASS even when model summaries claim all checked", () => {
  const records = plan.shards.slice(0, -1).map(shard => receipt(shard));
  const result = evaluateCoverage(plan, records);
  assert.equal(result.review_gate, "NOT_EVALUATED");
  assert.deepEqual(result.missing_shards, [plan.shards.at(-1).id]);
  assert.equal(result.acceptance.every(a => a.missing_shards.length === 1), true);
});

test("the second model must be independent and bound to the exact shard", () => {
  const records = plan.shards.map(shard => receipt(shard));
  records[0].providers.mmx.model_family = "glm";
  assert.equal(evaluateCoverage(plan, records).review_gate, "NOT_EVALUATED");
  records[0] = receipt(plan.shards[0]);
  records[0].providers.mmx.material_bound = false;
  assert.equal(evaluateCoverage(plan, records).review_gate, "NOT_EVALUATED");
  records[0] = receipt(plan.shards[0]);
  records[0].shard_sha256 = "0".repeat(64);
  const result = evaluateCoverage(plan, records);
  assert.equal(result.review_gate, "NOT_EVALUATED");
  assert.equal(result.unexpected_or_duplicate_shards.includes(plan.shards[0].id), true);
});

test("duplicate and extra shard receipts are not accepted as a full pass", () => {
  const records = plan.shards.map(shard => receipt(shard));
  const copy = { ...records[0] };
  assert.equal(evaluateCoverage(plan, [...records, copy]).review_gate, "NOT_EVALUATED");
  assert.equal(evaluateCoverage(plan, [...records, { shard_id: "S-XXXX", shard_sha256: "0".repeat(64) }]).review_gate, "NOT_EVALUATED");
});

test("a bound P1 FAIL is preserved even when other evidence is missing", () => {
  const records = [receipt(plan.shards[0], "FAIL"), ...plan.shards.slice(1, -1).map(shard => receipt(shard))];
  const result = evaluateCoverage(plan, records);
  assert.equal(result.review_gate, "FAIL");
  assert.equal(result.coverage_complete, false);
});

test("cancelled rounds never become a terminal PASS or FAIL verdict", () => {
  const records = plan.shards.map(shard => receipt(shard));
  let result = evaluateCoverage(plan, records, { cancelled: true });
  assert.equal(result.review_gate, "NOT_EVALUATED");
  assert.equal(result.exit_code, 2);
  assert.equal(result.coverage_complete, false);
  assert.equal(result.cancelled, true);
  // The input's verified defect remains intact for diagnostics, just as in
  // review-run, even though cancellation takes priority over the final gate.
  records[0].providers.zcode.gate = "FAIL";
  result = evaluateCoverage(plan, records, { cancelled: true });
  assert.equal(result.review_gate, "NOT_EVALUATED");
  assert.equal(records[0].providers.zcode.gate, "FAIL");
  assert.throws(() => evaluateCoverage(plan, records, { cancelled: "false" }), /cancellation/);
});

test("malformed plans cannot turn matching side receipts into PASS", async t => {
  const cases = {
    "missing AC matrix": p => { p.requirements = []; },
    "missing acceptance requirement": p => { p.requirements.pop(); },
    "acceptance and matrix omit declared evidence": p => { p.acceptance_ids.pop(); p.requirements.pop(); },
    "duplicate acceptance ID": p => { p.acceptance_ids[1] = p.acceptance_ids[0]; },
    "unknown acceptance ID": p => { p.acceptance_ids[0] = "AC-999"; },
    "acceptance omitted from evidence": p => { p.required_evidence_ids = p.required_evidence_ids.filter(id => id !== "AC-1"); },
    "duplicate evidence ID": p => { p.required_evidence_ids.push(p.required_evidence_ids[0]); },
    "empty requirement": p => { p.requirements[0].required_shards = []; },
    "requirement drops one shard": p => { p.requirements[0].required_shards.pop(); },
    "requirement repeats one shard": p => { p.requirements[0].required_shards[1] = p.shards[0].id; },
    "sparse requirement": p => { delete p.requirements[0].required_shards[0]; },
    "duplicate shard ID": p => { p.shards[1].id = p.shards[0].id; },
    "shard path escapes": p => { p.shards[0].file = "../material.txt"; },
    "overlapping byte ranges": p => { p.shards[1].start_byte--; },
    "inconsistent shard length": p => { p.shards[0].bytes--; },
    "material extends past shards": p => { p.material_bytes++; },
    "invalid digest": p => { p.shards[0].sha256 = "not-a-digest"; },
  };
  for (const [name, corrupt] of Object.entries(cases)) {
    await t.test(name, () => {
      const broken = structuredClone(plan);
      corrupt(broken);
      assert.throws(() => evaluateCoverage(broken, broken.shards.map(shard => receipt(shard))), /invalid coverage plan/);
    });
  }
});

test("no declared acceptance conditions never silently passes", () => {
  const v1 = Buffer.from(JSON.stringify({ facts: [{ id: "AC-1", text: "Legacy fact ID, not acceptance" }] }));
  const planLegacy = buildCoveragePlan(v1).plan;
  const result = evaluateCoverage(planLegacy, planLegacy.shards.map(shard => receipt(shard)));
  assert.equal(result.coverage_complete, true);
  assert.equal(result.review_gate, "NOT_EVALUATED");
});

test("a corrupted manifest, unknown files and invalid shard sizes fail closed", () => {
  const dir = path.join(root, "corrupt");
  writePlan(raw, dir, { chunkBytes: 8192 });
  fs.writeFileSync(path.join(dir, "shards", "extra.txt"), "not planned");
  assert.equal(verifyPlan(dir).integrity, "corrupt");
  assert.throws(() => buildCoveragePlan(raw, { chunkBytes: 100 }), /shard bytes/);
  assert.throws(() => buildCoveragePlan(raw, { chunkBytes: 50000 }), /shard bytes/);
});

test("archive verification rejects redirected directories and symlinked shards", () => {
  const dir = path.join(root, "redirected");
  writePlan(raw, dir, { chunkBytes: 8192 });
  const moved = path.join(root, "external-shards");
  fs.renameSync(path.join(dir, "shards"), moved);
  fs.symlinkSync(moved, path.join(dir, "shards"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(verifyPlan(dir).integrity, "corrupt");
  fs.rmSync(path.join(dir, "shards"));
  fs.renameSync(moved, path.join(dir, "shards"));
  assert.equal(verifyPlan(dir).integrity, "match");

  const alias = path.join(root, "archive-alias");
  fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(verifyPlan(alias).integrity, "corrupt");
  if (process.platform !== "win32") {
    // Windows junction tests above need no elevation; file symlinks may.
    const shard = path.join(dir, "shards", plan.shards[0].file);
    const outside = path.join(root, "external-shard.txt");
    fs.renameSync(shard, outside);
    fs.symlinkSync(outside, shard);
    assert.equal(verifyPlan(dir).integrity, "corrupt");
  }
});

test("CLI plan and verify produce machine-readable receipts", () => {
  const input = path.join(root, "cli-input.json");
  const out = path.join(root, "cli-output");
  fs.writeFileSync(input, raw);
  const entry = path.join(__dirname, "../scripts/shard-coverage.js");
  const run = spawnSync(process.execPath, [entry, "plan", "--packet", input, "--out", out, "--shard-bytes", "8192"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).shards, plan.shards.length);
  const verification = spawnSync(process.execPath, [entry, "verify", "--run", out], { encoding: "utf8" });
  assert.equal(verification.status, 0, verification.stderr);
  assert.equal(JSON.parse(verification.stdout).integrity, "match");
});
