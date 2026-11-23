'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCarrier, sha256 } = require('../scripts/ny_carrier');
const { publishSms, claimSms, markSubmitting, finishAttempt, publicState } = require('../scripts/ny_sms_state');
const NOW = 1795400000000;
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-sms-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));  const file = path.join(dir, 'config.local.json');
  fs.writeFileSync(file, JSON.stringify({ environments: { prod: { sms: '' }, test: { pass: 'FAKE' } } }));
  return file;
}
function payload(messageId = 'message-01') {
  return { code: '864201', sourceMessageId: messageId, requestId: 'request-xyz-123',
    messageCreatedAt: NOW - 30000, expiresAt: NOW + 50000 };
}
const policy = { now: NOW, maxLifetimeMs: 120000 };
test('one-time claim clears stored raw code and rejects second claim', (t) => {
  const file = setup(t);
  const { recordId } = publishSms(file, payload(), policy);
  assert.equal(readCarrier(file).config.environments.prod.sms, '');
  const claim = claimSms(file, { requestId: 'request-xyz-123', attemptId: 'attempt-alpha', now: NOW });
  assert.equal(claim.code, '864201');
  assert.equal(claim.recordId, recordId);
  assert.equal(readCarrier(file).config.environments.prod.sms_record.code, undefined);
  assert.throws(() => claimSms(file, { requestId: 'request-xyz-123', attemptId: 'attempt-beta', now: NOW }), e => e.code === 'ENOT_FRESH');
  assert.throws(() => markSubmitting(file, { recordId, attemptId: 'attempt-beta', now: NOW }), e => e.code === 'ECLAIM_MISMATCH');
  markSubmitting(file, { recordId, attemptId: 'attempt-alpha', now: NOW });
  assert.throws(() => finishAttempt(file, { recordId, attemptId: 'attempt-beta', outcome: 'confirmed_success', now: NOW }), e => e.code === 'ERESULT_MISMATCH');
  finishAttempt(file, { recordId, attemptId: 'attempt-alpha', outcome: 'confirmed_success', now: NOW });
  assert.equal(publicState(file).state, 'spent');
});
test('old Feishu message cannot be republished with a refreshed local time', (t) => {
  const file = setup(t);
  publishSms(file, payload(), policy);
  const c = claimSms(file, { requestId: 'request-xyz-123', attemptId: 'attempt-01', now: NOW });
  markSubmitting(file, { recordId: c.recordId, attemptId: 'attempt-01', now: NOW });
  finishAttempt(file, { recordId: c.recordId, attemptId: 'attempt-01', outcome: 'unknown', now: NOW });
  assert.throws(() => publishSms(file, payload(), policy), e => e.code === 'EDUPLICATE_MESSAGE');
  assert.equal(publicState(file).state, 'unknown');
});
test('missing policy, expired, future and wrong request all fail closed', (t) => {
  const file = setup(t);
  assert.throws(() => publishSms(file, payload(), {}), e => e.code === 'EPOLICY_MISSING');
  assert.throws(() => publishSms(file, { ...payload(), messageCreatedAt: NOW + 100 }, policy), e => e.code === 'EINVALID_EXPIRY');
  assert.throws(() => publishSms(file, { ...payload(), expiresAt: NOW - 1 }, policy), e => e.code === 'EINVALID_EXPIRY');
  publishSms(file, payload(), policy);
  assert.throws(() => claimSms(file, { requestId: 'wrong-id', attemptId: 'attempt-1', now: NOW }), e => e.code === 'EREQUEST_MISMATCH');
  assert.throws(() => claimSms(file, { requestId: 'request-xyz-123', attemptId: 'attempt-1', now: NOW + 50001 }), e => e.code === 'EEXPIRED');
});
test('prod fixedSms cannot bypass new production protocol', (t) => {
  const file = setup(t);
  fs.writeFileSync(file, JSON.stringify({ environments: { prod: { fixedSms: true } } }));
  assert.throws(() => publishSms(file, payload(), policy), e => e.code === 'EPROD_FIXED_SMS_FORBIDDEN');
});
test('old completion callback cannot consume a newly published message', (t) => {
  const file = setup(t);
  const first = publishSms(file, payload(), policy);
  const a = claimSms(file, { requestId: 'request-xyz-123', attemptId: 'attempt-01', now: NOW });
  markSubmitting(file, { recordId: a.recordId, attemptId: 'attempt-01', now: NOW });
  finishAttempt(file, { recordId: a.recordId, attemptId: 'attempt-01', outcome: 'unknown', now: NOW });
  const second = publishSms(file, { ...payload('message-02'), requestId: 'request-new-123' }, policy);
  assert.notEqual(first.recordId, second.recordId);
  assert.throws(() => finishAttempt(file, { recordId: first.recordId, attemptId: 'attempt-01', outcome: 'confirmed_success', now: NOW }), e => e.code === 'ERESULT_MISMATCH');
  assert.equal(publicState(file).state, 'fresh');
});

test('deduplication never evicts old source messages and capacity is fail-closed', (t) => {
  const file = setup(t);
  const oldSource = sha256(Buffer.from('source-message:message-01'));
  const prod = { sms: '', sms_seen_hashes: [oldSource] };
  for (let i = 0; i < 600; i++) prod.sms_seen_hashes.push(sha256(Buffer.from('filler-' + i)));
  fs.writeFileSync(file, JSON.stringify({ environments: { prod } }));
  assert.throws(() => publishSms(file, payload('message-01'), policy), e => e.code === 'EDUPLICATE_MESSAGE');
  publishSms(file, payload('message-new'), policy);
  assert.equal(readCarrier(file).config.environments.prod.sms_seen_hashes.length, 602);
  prod.sms_seen_hashes = Array.from({ length: 4096 }, (_, i) => sha256(Buffer.from('distinct-' + i)));
  fs.writeFileSync(file, JSON.stringify({ environments: { prod } }));
  assert.throws(() => publishSms(file, payload('message-new'), policy), e => e.code === 'EHISTORY_CAPACITY');
});
