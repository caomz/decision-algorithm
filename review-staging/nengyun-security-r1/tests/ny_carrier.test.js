'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCarrier, transactCarrier, canonicalPath } = require('../scripts/ny_carrier');
function setup(t, content = { environments: { prod: {}, test: { pass: 'SYNTHETIC_ONLY' } } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-kit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.local.json');
  fs.writeFileSync(file, JSON.stringify(content, null, 2), { mode: 0o600 });
  return { dir, file };
}
test('invalid JSON fails closed without returning an empty config', (t) => {
  const { file } = setup(t);
  fs.writeFileSync(file, '{');
  assert.throws(() => readCarrier(file), e => e.code === 'EINVALID_JSON');
  assert.throws(() => transactCarrier(file, x => x), e => e.code === 'EINVALID_JSON');
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});
test('transaction preserves other environments and clears own lock', (t) => {
  const { file } = setup(t);
  const result = transactCarrier(file, cfg => { cfg.environments.prod.sms = ''; });
  assert.equal(result.changed, true);
  assert.equal(readCarrier(file).config.environments.test.pass, 'SYNTHETIC_ONLY');
  assert.equal(readCarrier(file).config.environments.prod.sms, '');
  assert.equal(fs.existsSync(file + '.lock'), false);
  assert.equal(fs.readdirSync(path.dirname(file)).filter(x => x.includes('.tmp-')).length, 0);
});
test('a lock, however old, is never stolen automatically', (t) => {
  const { file } = setup(t);
  fs.writeFileSync(file + '.lock', '{"owner":"someone-else"}');
  assert.throws(() => transactCarrier(file, c => c), e => e.code === 'ELOCKED');
  assert.equal(fs.existsSync(file + '.lock'), true);
});
test('rename failure never deletes the original file', (t) => {
  const { file } = setup(t);
  const raw = fs.readFileSync(file);
  const originalRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('synthetic'); e.code = 'EPERM'; throw e; };
  try {
    assert.throws(() => transactCarrier(file, c => { c.environments.prod.sms = 'x'; }), e => e.code === 'EREPLACE_FAILED_OR_UNCERTAIN');
  } finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.equal(fs.existsSync(file + '.lock'), false);
});
test('symlinked directory aliases resolve to same lock/target', (t) => {
  const { dir, file } = setup(t);
  const alias = dir + '-alias';
  try { fs.symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('directory links unavailable on this host'); return; }
  t.after(() => fs.rmSync(alias, { force: true }));
  assert.equal(canonicalPath(path.join(alias, 'config.local.json')), canonicalPath(file));
});

test('target symlinks and hardlinks fail closed (when host supports them)', (t) => {
  const { dir, file } = setup(t);
  const targetAlias = path.join(dir, 'alias.json');
  try { fs.symlinkSync(file, targetAlias, 'file'); }
  catch { t.skip('file symlinks unavailable on this host'); return; }
  assert.throws(() => readCarrier(targetAlias), e => e.code === 'EUNSUPPORTED_FILE_ALIAS');
  fs.unlinkSync(targetAlias);
  try { fs.linkSync(file, targetAlias); }
  catch { t.skip('hardlinks unavailable on this host'); return; }
  assert.throws(() => transactCarrier(file, v => v), e => e.code === 'EUNSUPPORTED_FILE_ALIAS');
});
