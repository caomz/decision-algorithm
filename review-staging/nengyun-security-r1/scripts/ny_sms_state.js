'use strict';
// New production SMS protocol. INTEGRATION REQUIRES removing legacy SMS fallbacks.
// Do not call this from --check, which must remain strictly read-only.
const crypto = require('node:crypto');
const { transactCarrier, readCarrier, sha256 } = require('./ny_carrier');

class SmsError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'SmsError'; }
}
const object = (x) => x && typeof x === 'object' && !Array.isArray(x);
const nonEmpty = (x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 256;
const validTime = (x) => Number.isSafeInteger(x) && x > 0;
// Never silently evict deduplication history: old message replay must stay blocked.
const MAX_SEEN_MESSAGES = 4096;
function checkTime(now) { if (!validTime(now)) throw new SmsError('EINVALID_CLOCK'); }
function prodOf(config) {
  const env = config?.environments;
  if (!object(env) || !object(env.prod)) throw new SmsError('EPROD_MISSING');
  return env.prod;
}
function publicState(path) {
  const prod = prodOf(readCarrier(path).config);
  const r = prod.sms_record;
  if (!object(r)) return { state: 'missing' };
  return { state: r.state, recordId: r.record_id };
}
function publishSms(path, payload, policy) {
  const { code, sourceMessageId, messageCreatedAt, expiresAt, requestId } = payload || {};
  const now = policy?.now ?? Date.now();
  const maxLifetimeMs = policy?.maxLifetimeMs;
  checkTime(now);
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1000) throw new SmsError('EPOLICY_MISSING');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new SmsError('EINVALID_SMS');
  if (!nonEmpty(sourceMessageId) || !nonEmpty(requestId)) throw new SmsError('EINVALID_BINDING');
  if (!validTime(messageCreatedAt) || !validTime(expiresAt) || messageCreatedAt > now ||
      expiresAt <= now || expiresAt <= messageCreatedAt ||
      expiresAt - messageCreatedAt > maxLifetimeMs) {
    throw new SmsError('EINVALID_EXPIRY');
  }
  // A message's immutable origin creation time is required. Re-fetch time is NOT evidence.
  const sourceHash = sha256(Buffer.from('source-message:' + sourceMessageId));
  const recordId = crypto.randomUUID();
  transactCarrier(path, (config) => {
    const prod = prodOf(config);
    if (Object.hasOwn(prod, 'fixedSms') && prod.fixedSms !== false) throw new SmsError('EPROD_FIXED_SMS_FORBIDDEN');
    if (prod.sms_seen_hashes !== undefined && !Array.isArray(prod.sms_seen_hashes)) throw new SmsError('EINVALID_HISTORY');
    const seen = Array.isArray(prod.sms_seen_hashes) ? prod.sms_seen_hashes : [];
    if (!seen.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)) ||
        new Set(seen).size !== seen.length) throw new SmsError('EINVALID_HISTORY');
    if (seen.includes(sourceHash)) throw new SmsError('EDUPLICATE_MESSAGE');
    if (seen.length >= MAX_SEEN_MESSAGES) throw new SmsError('EHISTORY_CAPACITY');
    const prev = prod.sms_record;
    if (object(prev) && ['claimed', 'submitted'].includes(prev.state)) throw new SmsError('EACTIVE_ATTEMPT');
    prod.sms_seen_hashes = [...seen, sourceHash];
    prod.sms_record = {
      record_id: recordId,
      code,
      source_message_hash: sourceHash,
      message_created_at: messageCreatedAt,
      expires_at: expiresAt,
      request_id: requestId,
      state: 'fresh'
    };
    // Legacy property must not hold a real production code.
    prod.sms = '';
  });
  return { recordId };
}
function checkFresh(rec, now, requestId) {
  checkTime(now);
  if (!object(rec) || rec.state !== 'fresh') throw new SmsError('ENOT_FRESH');
  if (typeof rec.code !== 'string' || !/^\d{6}$/.test(rec.code)) throw new SmsError('EINVALID_SMS');
  if (!nonEmpty(requestId) || rec.request_id !== requestId) throw new SmsError('EREQUEST_MISMATCH');
  if (!validTime(rec.message_created_at) || !validTime(rec.expires_at) ||
      rec.message_created_at > now || rec.expires_at <= now) throw new SmsError('EEXPIRED');
}
function claimSms(path, { requestId, attemptId, now = Date.now() } = {}) {
  if (!nonEmpty(attemptId)) throw new SmsError('EATTEMPT_MISSING');
  let claimed;
  transactCarrier(path, (config) => {
    const prod = prodOf(config);
    if (Object.hasOwn(prod, 'fixedSms') && prod.fixedSms !== false) throw new SmsError('EPROD_FIXED_SMS_FORBIDDEN');
    const rec = prod.sms_record;
    checkFresh(rec, now, requestId);
    claimed = { code: rec.code, recordId: rec.record_id, requestId: rec.request_id, attemptId };
    delete rec.code; // Remove stored raw code before any side-effecting browser submission.
    rec.state = 'claimed';
    rec.claimed_by = attemptId;
    rec.claimed_at = now;
    prod.sms = '';
  });
  return claimed; // Keep only in memory. Never pass via argv or log this object.
}
function markSubmitting(path, { recordId, attemptId, now = Date.now() } = {}) {
  if (!nonEmpty(recordId) || !nonEmpty(attemptId)) throw new SmsError('EINVALID_BINDING');
  checkTime(now);
  transactCarrier(path, (config) => {
    const r = prodOf(config).sms_record;
    if (!object(r) || r.record_id !== recordId || r.state !== 'claimed' ||
        r.claimed_by !== attemptId) throw new SmsError('ECLAIM_MISMATCH');
    if (!validTime(r.expires_at) || r.expires_at <= now) throw new SmsError('EEXPIRED');
    r.state = 'submitted';
    r.submitted_at = now;
  });
  return { state: 'submitted' };
}
function finishAttempt(path, { recordId, attemptId, outcome, now = Date.now() } = {}) {
  if (!nonEmpty(recordId) || !nonEmpty(attemptId) ||
      !['confirmed_success', 'confirmed_rejected', 'unknown'].includes(outcome)) {
    throw new SmsError('EINVALID_RESULT');
  }
  checkTime(now);
  transactCarrier(path, (config) => {
    const r = prodOf(config).sms_record;
    if (!object(r) || r.record_id !== recordId || r.state !== 'submitted' ||
        r.claimed_by !== attemptId) throw new SmsError('ERESULT_MISMATCH');
    delete r.code;
    r.state = outcome === 'unknown' ? 'unknown' : 'spent';
    r.result = outcome;
    r.finalized_at = now;
  });
  return { state: outcome === 'unknown' ? 'unknown' : 'spent' };
}
module.exports = { SmsError, publicState, publishSms, claimSms, markSubmitting, finishAttempt, checkFresh };
