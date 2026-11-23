'use strict';
// Integrity checks against an explicitly retained checksum; not tamper-resistant signing.
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./ny_carrier');
class AuditError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'AuditError'; }
}
function safeName(rel) {
  return typeof rel === 'string' && rel.length > 0 && !path.isAbsolute(rel) &&
    !rel.includes('\\') && !rel.split('/').some(p => p === '..' || p === '' || p === '.');
}
function digestFile(root, rel) {
  if (!safeName(rel)) throw new AuditError('EBAD_RELATIVE_PATH');
  const target = path.join(root, ...rel.split('/'));
  if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new AuditError('ENOT_REGULAR_FILE');
  return sha256(fs.readFileSync(target));
}
function sealRun(root, files, outManifest, runId) {
  if (!Array.isArray(files) || files.length === 0 || new Set(files).size !== files.length) throw new AuditError('EINVALID_LIST');
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{7,80}$/.test(runId)) throw new AuditError('EINVALID_RUN_ID');
  // Manifest and .sha256 should live OUTSIDE of the sealed source root.
  const rootCanonical = fs.realpathSync(root);
  const outCanonical = fs.realpathSync(path.dirname(outManifest));
  if (outCanonical === rootCanonical || outCanonical.startsWith(rootCanonical + path.sep)) throw new AuditError('EOUTPUT_INSIDE_SOURCE');
  const manifest = { schema: 1, run_id: runId, files: files.slice().sort().map(file => ({ file, sha256: digestFile(root, file) })) };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  const outHash = outManifest + '.sha256';
  let manifestMade = false;
  try {
    fs.writeFileSync(outManifest, manifestText, { flag: 'wx', mode: 0o600 });
    manifestMade = true;
    fs.writeFileSync(outHash, sha256(Buffer.from(manifestText)) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    // If the manifest was written but hash creation failed, do not claim sealed.
    throw new AuditError(manifestMade ? 'ESEAL_INCOMPLETE' : 'ESEAL_FAILED');
  }
  return { runId, artifacts: files.length, sealed: true };
}
function verifyRun(root, manifestFile) {
  const data = fs.readFileSync(manifestFile);
  const expected = fs.readFileSync(manifestFile + '.sha256', 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(data) !== expected) throw new AuditError('EMANIFEST_MISMATCH');
  let parsed;
  try { parsed = JSON.parse(data.toString('utf8')); }
  catch { throw new AuditError('EINVALID_MANIFEST'); }
  if (parsed.schema !== 1 || !Array.isArray(parsed.files) || !parsed.files.length) throw new AuditError('EINVALID_MANIFEST');
  if (new Set(parsed.files.map(e => e.file)).size !== parsed.files.length) throw new AuditError('EDUPLICATE_FILE');
  for (const item of parsed.files) {
    if (!item || typeof item.sha256 !== 'string' || digestFile(root, item.file) !== item.sha256) throw new AuditError('EARTIFACT_MISMATCH');
  }
  return { runId: parsed.run_id, artifacts: parsed.files.length, verified: true };
}
module.exports = { sealRun, verifyRun, AuditError };
