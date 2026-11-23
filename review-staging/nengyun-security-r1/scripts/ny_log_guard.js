'use strict';
// Strict allowlist logger. Never accept raw page objects, SMS, cookies, or error messages.
const fs = require('node:fs');
const crypto = require('node:crypto');

class LogError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'LogError'; }
}
const TYPES = {
  event: /^[a-z][a-z0-9_]{0,63}$/,
  run_id: /^[a-zA-Z0-9_-]{7,80}$/,
  attempt_id: /^[a-zA-Z0-9_-]{7,80}$/,
  record_id: /^[a-zA-Z0-9_-]{7,80}$/,
  request_ref: /^[a-f0-9]{32}$/,
  stage: /^[a-z][a-z0-9_]{0,63}$/,
  status: /^(ok|failed|blocked|unknown|pending)$/,
  reason_code: /^[A-Z][A-Z0-9_]{1,63}$/,
  at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
};
const ALLOWED = new Set([...Object.keys(TYPES), 'duration_ms']);
function safeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new LogError('EINVALID_EVENT');
  for (const k of Object.keys(record)) {
    if (!ALLOWED.has(k)) throw new LogError('EUNSAFE_FIELD');
  }
  if (typeof record.event !== 'string') throw new LogError('EMISSING_EVENT');
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === 'duration_ms') {
      if (!Number.isSafeInteger(v) || v < 0 || v > 86400000) throw new LogError('EINVALID_VALUE');
    } else if (typeof v !== 'string' || !TYPES[k].test(v) || /^\d{6}$/.test(v)) {
      throw new LogError('EINVALID_VALUE');
    }
    out[k] = v;
  }
  if (!out.at) out.at = new Date().toISOString();
  return Object.freeze(out);
}
function appendSafeEvent(file, event, { mirrorStdout = false } = {}) {
  const output = JSON.stringify(safeRecord(event)) + '\n';
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new LogError('EUNSAFE_LOG_PATH');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.appendFileSync(file, output, { encoding: 'utf8', mode: 0o600 });
  if (mirrorStdout) process.stdout.write(output);
}
// Random correlator only. NEVER hash a low-entropy SMS code, account, token or cookie:
// deterministic hashes of short secrets are vulnerable to offline enumeration.
function newAuditRef() {
  return crypto.randomBytes(16).toString('hex');
}
module.exports = { safeRecord, appendSafeEvent, newAuditRef, LogError };
