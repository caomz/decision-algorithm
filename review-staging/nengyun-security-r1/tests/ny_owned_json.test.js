'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commitOwnedJson, assertOwnedTarget, digest } = require('../scripts/ny_owned_json');
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-owned-synthetic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = path.join(root, 'one-run'); fs.mkdirSync(runDir);
  return { root, runDir };
}
test('T08 owned JSON create, versioned replace and exact hash check', async t => {
  const { root, runDir } = sandbox(t);
  const target = path.join(runDir, 'state.json');
  const first = await commitOwnedJson({ runDir, target, value: { stage: 'SYNTHETIC_1' }, lockRoot: root });
  assert.equal(first.status, 'COMMITTED');
  const old = fs.readFileSync(target);
  assert.equal(first.sha256, digest(old));
  const conflict = await commitOwnedJson({ runDir, target, value: { stage: 'SYNTHETIC_BAD' }, lockRoot: root });
  assert.equal(conflict.status, 'UNCHANGED_FAILURE');
  assert.deepEqual(fs.readFileSync(target), old);
  const second = await commitOwnedJson({ runDir, target, value: { stage: 'SYNTHETIC_2' }, lockRoot: root, expectedHash: first.sha256 });
  assert.equal(second.status, 'COMMITTED');
});
test('T08 stage failure and replace failure preserve original exact bytes', async t => {
  const { root, runDir } = sandbox(t);
  const target = path.join(runDir, 'state.json');
  const initial = await commitOwnedJson({ runDir, target, value: { safe: 'synthetic' }, lockRoot: root });
  const saved = fs.readFileSync(target);
  for (const faultAt of ['before_stage', 'after_stage', 'replace']) {
    const result = await commitOwnedJson({ runDir, target, value: { safe: 'new' }, lockRoot: root,
      expectedHash: initial.sha256, faultAt });
    assert.equal(result.status, 'UNCHANGED_FAILURE');
    assert.deepEqual(fs.readFileSync(target), saved);
  }
  const unsure = await commitOwnedJson({ runDir, target, value: { safe: 'new' }, lockRoot: root,
    expectedHash: initial.sha256, faultAt: 'after_replace' });
  assert.equal(unsure.status, 'INDETERMINATE');
  const { resourceKeyForFile, acquireResources } = require('../scripts/ny_runtime_resources');
  await assert.rejects(acquireResources([resourceKeyForFile(target)], { lockRoot: root, waitMs: 65 }), e => e.code === 'ERESOURCE_BUSY');
});
test('owned state writes reject path escape outside runDir', async t => {
  const { root, runDir } = sandbox(t);
  const outside = path.join(root, 'outside.json');
  assert.throws(() => assertOwnedTarget(runDir, outside), e => e.code === 'EOUTSIDE_RUN_DIR');
  await assert.rejects(commitOwnedJson({ runDir, target: outside, value: { v: 1 }, lockRoot: root }), e => e.code === 'EOUTSIDE_RUN_DIR');
  assert.equal(fs.existsSync(outside), false);
});
