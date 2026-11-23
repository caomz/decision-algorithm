'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeRecord, appendSafeEvent, newAuditRef } = require('../scripts/ny_log_guard');
const { verifyDistribution } = require('../scripts/verify_distribution');
const { sealRun, verifyRun } = require('../scripts/ny_audit_manifest');
function dir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('structured logger refuses raw secrets and unrecognized free-form fields', (t) => {
  const root = dir(t);
  const logFile = path.join(root, 'audit.jsonl');
  assert.throws(() => safeRecord({ event: 'login', sms: '864201' }), e => e.code === 'EUNSAFE_FIELD');
  assert.throws(() => safeRecord({ event: 'login', message: 'secret in free text' }), e => e.code === 'EUNSAFE_FIELD');
  assert.throws(() => safeRecord({ event: 'login', stage: '864201' }), e => e.code === 'EINVALID_VALUE');
  appendSafeEvent(logFile, { event: 'sms_guard', stage: 'claim', status: 'blocked', reason_code: 'EEXPIRED', request_ref: newAuditRef() });
  assert.equal(fs.readFileSync(logFile, 'utf8').includes('864201'), false);
  assert.match(fs.readFileSync(logFile, 'utf8'), /"status":"blocked"/);
});
test('distribution verification is allowlist-first and bans backup, temp and secret content', (t) => {
  const root = dir(t);
  fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = true;');
  assert.equal(verifyDistribution(root, ['app.js']).status, 'PASS');
  fs.writeFileSync(path.join(root, 'config.local.json.bak'), '{}');
  assert.throws(() => verifyDistribution(root, ['app.js']), e => e.code === 'EUNLISTED_FILE');
  fs.unlinkSync(path.join(root, 'config.local.json.bak'));
  fs.writeFileSync(path.join(root, 'shadow.json'), '{"sms":"864201"}');
  assert.throws(() => verifyDistribution(root, ['app.js', 'shadow.json']), e => e.code === 'ESENSITIVE_CONTENT');
  fs.unlinkSync(path.join(root, 'shadow.json'));
  fs.writeFileSync(path.join(root, 'config.local.json.tmp-123'), '{}');
  assert.throws(() => verifyDistribution(root, ['app.js', 'config.local.json.tmp-123']), e => e.code === 'ESENSITIVE_FILENAME');
});
test('manifest detects changed artifact and invalid manifest', (t) => {
  const root = dir(t);
  const evidence = path.join(root, 'evidence');
  const manifest = path.join(root, 'sealed');
  fs.mkdirSync(evidence); fs.mkdirSync(manifest);
  fs.writeFileSync(path.join(evidence, 'event.jsonl'), '{"event":"synthetic"}\n');
  const target = path.join(manifest, 'run.json');
  assert.equal(sealRun(evidence, ['event.jsonl'], target, 'run-synthetic-01').sealed, true);
  assert.equal(verifyRun(evidence, target).verified, true);
  fs.appendFileSync(path.join(evidence, 'event.jsonl'), 'tampered\n');
  assert.throws(() => verifyRun(evidence, target), e => e.code === 'EARTIFACT_MISMATCH');
});

test('audit correlation IDs are random and not deterministic hashes of short secrets', () => {
  const one = newAuditRef();
  const two = newAuditRef();
  assert.match(one, /^[a-f0-9]{32}$/);
  assert.notEqual(one, two);
  assert.doesNotThrow(() => safeRecord({ event: 'sms_guard', request_ref: one }));
});
test('distribution rejects renamed secret backups, encoded sensitive keys and UTF-16', (t) => {
  const root = dir(t);
  fs.writeFileSync(path.join(root, 'config.bak.json'), '{}');
  assert.throws(() => verifyDistribution(root, ['config.bak.json']), e => e.code === 'ESENSITIVE_FILENAME');
  fs.unlinkSync(path.join(root, 'config.bak.json'));
  fs.writeFileSync(path.join(root, 'opaque.json'), '{"sms_base64":"SYNTHETICVALUE"}');
  assert.throws(() => verifyDistribution(root, ['opaque.json']), e => e.code === 'ESENSITIVE_CONTENT');
  fs.writeFileSync(path.join(root, 'opaque.json'), Buffer.from('plain text', 'utf16le'));
  assert.throws(() => verifyDistribution(root, ['opaque.json']), e => e.code === 'EUNSUPPORTED_ENCODING');
});
