'use strict';
// Fail-closed verification of a STAGED distribution, not of the live runtime carrier.
const fs = require('node:fs');
const path = require('node:path');
class DistributionError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'DistributionError'; }
}
function walk(dir, prefix = '') {
  const found = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);
    if (item.isSymbolicLink()) throw new DistributionError('ESYMLINK_IN_DISTRIBUTION');
    if (item.isDirectory()) found.push(...walk(path.join(dir, item.name), relative));
    else if (item.isFile()) found.push(relative);
    else throw new DistributionError('ESPECIAL_FILE');
  }
  return found;
}
function sensitiveName(name) {
  const base = path.posix.basename(name).toLowerCase();
  return base.includes('config.local') || /(^\.env(?:\.|$)|\.secret\.|(?:\.bak|\.backup|\.old|\.orig)(?:\.|$)|\.tmp(?:[.\-_]|$)|\.lock$)/.test(base) ||
         /(cookie|credential|private[-_]?key|auth[-_]?token)/.test(base);
}
function sensitiveContent(text) {
  // Contextual detection only, not a proof of absence of all encoded secrets.
  // Scan key-context values including explicit encoded carrier fields. A named
  // secret value is not made safe merely because it is base64/hex.
  return /["']?(?:sms|password|pass|cookie|authorization|access_token|refresh_token|secret)(?:_(?:base64|hex|base32))?["']?\s*[:=]\s*["']?[^"'\s,;}]{1,256}/i.test(text);
}
function verifyDistribution(root, allowlist) {
  if (!Array.isArray(allowlist) || !allowlist.length) throw new DistributionError('EEMPTY_ALLOWLIST');
  const allowed = new Set(allowlist);
  for (const rel of allowed) {
    if (typeof rel !== 'string' || rel.startsWith('/') || rel.includes('\\') || rel.split('/').includes('..')) {
      throw new DistributionError('EINVALID_ALLOWLIST');
    }
  }
  const files = walk(root);
  for (const rel of files) {
    if (!allowed.has(rel)) throw new DistributionError('EUNLISTED_FILE');
    if (sensitiveName(rel)) throw new DistributionError('ESENSITIVE_FILENAME');
    const buf = fs.readFileSync(path.join(root, ...rel.split('/')));
    if (buf.length > 10 * 1024 * 1024) throw new DistributionError('EFILE_TOO_LARGE');
    // This staged source distribution is text-only. Fail closed rather than
    // treating an UTF-16/binary file as an incomplete UTF-8 secret scan.
    if (buf.includes(0)) throw new DistributionError('EUNSUPPORTED_ENCODING');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { throw new DistributionError('EUNSUPPORTED_ENCODING'); }
    if (sensitiveContent(text)) throw new DistributionError('ESENSITIVE_CONTENT');
  }
  for (const rel of allowed) if (!files.includes(rel)) throw new DistributionError('EMISSING_ALLOWED_FILE');
  return { scanned: files.length, status: 'PASS' };
}
module.exports = { verifyDistribution, DistributionError, sensitiveName, sensitiveContent };
if (require.main === module) {
  // Never accept an allowlist from an untrusted distribution artifact.
  const root = process.argv[2];
  const allowlistJson = process.argv[3];
  if (!root || !allowlistJson) {
    process.stderr.write('Usage: node verify_distribution.js <stage_dir> <allowlist_json>\n');
    process.exitCode = 2;
  } else {
    try {
      const list = JSON.parse(fs.readFileSync(allowlistJson, 'utf8'));
      const report = verifyDistribution(root, list);
      process.stdout.write(JSON.stringify(report) + '\n');
    } catch (e) { process.stderr.write((e.code || 'EVERIFICATION_FAILED') + '\n'); process.exitCode = 2; }
  }
}
