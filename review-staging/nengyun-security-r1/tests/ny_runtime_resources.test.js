'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resourceKeyForFile, resourceKeyForBrowser, acquireResources } = require('../scripts/ny_runtime_resources');
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-resource-synthetic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('shared file identity maps to one resource; browser identity is independent', (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, 'synthetic.json');
  fs.writeFileSync(file, '{}');
  const key = resourceKeyForFile(file);
  assert.equal(key, resourceKeyForFile(path.join(dir, '.', 'synthetic.json')));
  assert.notEqual(key, resourceKeyForBrowser('sandbox-session-01'));
  assert.equal(resourceKeyForBrowser('sandbox-session-01'), resourceKeyForBrowser('SANDBOX-SESSION-01'));
});
test('a long-held lock is never stolen by time, and releases only own marker', async (t) => {
  const dir = sandbox(t);
  const key = resourceKeyForBrowser('sandbox-session-lock');
  const lease = await acquireResources([key], { lockRoot: dir });
  const lockFile = path.join(dir, '.ny-runtime-locks', fs.readdirSync(path.join(dir, '.ny-runtime-locks'))[0]);
  fs.utimesSync(lockFile, new Date(2000, 1, 1), new Date(2000, 1, 1));
  await assert.rejects(acquireResources([key], { lockRoot: dir, waitMs: 90 }), e => e.code === 'ERESOURCE_BUSY');
  lease.release();
  const second = await acquireResources([key], { lockRoot: dir, waitMs: 90 });
  second.release();
});
test('multi-resource order is fixed, duplicates do not create a self-deadlock', async (t) => {
  const dir = sandbox(t);
  const a = resourceKeyForBrowser('sandbox-a');
  const b = resourceKeyForBrowser('sandbox-b');
  const one = await acquireResources([b, a, b], { lockRoot: dir });
  assert.deepEqual(one.keys, [a, b].sort());
  one.release();
});
test('symlinked directories resolve to same resource when supported; target links rejected', (t) => {
  const dir = sandbox(t);
  const target = path.join(dir, 'file.txt');
  fs.writeFileSync(target, 'synthetic');
  const alias = path.join(os.tmpdir(), 'ny-synthetic-alias-' + path.basename(dir));
  try { fs.symlinkSync(dir, alias, 'dir'); }
  catch { t.skip('symlink unsupported on this host'); return; }
  t.after(() => fs.rmSync(alias, { force: true }));
  if (process.platform === 'win32') {
    assert.throws(() => resourceKeyForFile(path.join(alias, 'file.txt')), e => e.code === 'EUNVERIFIED_REPARSE_ALIAS');
  } else {
    assert.equal(resourceKeyForFile(target), resourceKeyForFile(path.join(alias, 'file.txt')));
  }
  const directAlias = path.join(dir, 'target-link');
  try { fs.symlinkSync(target, directAlias); }
  catch { t.skip('target symlink creation unavailable on this host'); return; }
  assert.throws(() => resourceKeyForFile(directAlias), e => e.code === 'EUNSUPPORTED_FILE_IDENTITY');
});
