'use strict';
// Synthetic/owned run-state writes only. Never use to migrate production config.
// Windows replace/ACL/OS-crash properties require on-host evidence.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireResources, resourceKeyForFile } = require('./ny_runtime_resources');
class OwnedWriteError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'OwnedWriteError'; }
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function assertOwnedTarget(runDir, filename) {
  let root;
  let parent;
  try {
    root = fs.realpathSync.native(runDir);
    parent = fs.realpathSync.native(path.dirname(path.resolve(filename)));
  } catch { throw new OwnedWriteError('EOWNED_PATH_UNAVAILABLE'); }
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new OwnedWriteError('EOUTSIDE_RUN_DIR');
  const target = path.join(parent, path.basename(filename));
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new OwnedWriteError('EUNSAFE_TARGET');
  } catch (e) {
    if (e instanceof OwnedWriteError) throw e;
    if (e.code !== 'ENOENT') throw new OwnedWriteError('ETARGET_INSPECT_FAILED');
  }
  return target;
}
async function commitOwnedJson({ runDir, target, value, lockRoot, expectedHash = null, faultAt = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OwnedWriteError('EINVALID_STATE');
  const filename = assertOwnedTarget(runDir, target);
  let bytes;
  try { bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'); }
  catch { throw new OwnedWriteError('EINVALID_STATE'); }
  if (bytes.length > 1024 * 1024) throw new OwnedWriteError('ESTATE_TOO_LARGE');
  if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash)) throw new OwnedWriteError('EINVALID_VERSION');
  const lease = await acquireResources([resourceKeyForFile(filename)], { lockRoot });
  let temp = null;
  let before = null;
  let existsBefore = false;
  let renamed = false;
  try {
    try { before = fs.readFileSync(filename); existsBefore = true; }
    catch (e) { if (e.code !== 'ENOENT') throw new OwnedWriteError('EINITIAL_READ_FAILED'); }
    const baseline = existsBefore ? digest(before) : null;
    if (baseline !== expectedHash) throw new OwnedWriteError('EVERSION_CONFLICT');
    if (faultAt === 'before_stage') throw new OwnedWriteError('EINJECTED_STAGE');
    temp = path.join(path.dirname(filename), '.' + path.basename(filename) + '.tmp-' + crypto.randomBytes(8).toString('hex'));
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (faultAt === 'after_stage') throw new OwnedWriteError('EINJECTED_STAGE');
    if (!fs.readFileSync(temp).equals(bytes)) throw new OwnedWriteError('ESTAGE_MISMATCH');
    // A cooperating writer holds this resource lock, but compare before commit
    // to detect an uncooperative changed file. This is not a CAS substitute.
    let beforeCommit;
    try { beforeCommit = fs.readFileSync(filename); }
    catch (e) { if (e.code !== 'ENOENT') throw new OwnedWriteError('EVERIFY_FAILED'); }
    if ((beforeCommit ? digest(beforeCommit) : null) !== baseline) throw new OwnedWriteError('EVERSION_CONFLICT');
    if (faultAt === 'replace') throw new OwnedWriteError('EINJECTED_REPLACE');
    try { fs.renameSync(temp, filename); renamed = true; temp = null; }
    catch { /* classified below; NEVER unlink destination */ }
    let current;
    try { current = fs.readFileSync(filename); }
    catch { current = null; }
    if (renamed && current?.equals(bytes) && faultAt !== 'after_replace') {
      return { status: 'COMMITTED', sha256: digest(bytes) };
    }
    if (!renamed && ((current === null && !existsBefore) || (current && before && current.equals(before)))) {
      return { status: 'UNCHANGED_FAILURE' };
    }
    lease.holdUncertain(); // Stop other writers until an owner confirms the file state.
    return { status: 'INDETERMINATE' };
  } catch (e) {
    // Pre-replace failures are safe only when the old bytes can be verified.
    let current;
    try { current = fs.readFileSync(filename); }
    catch { current = null; }
    if ((current === null && !existsBefore) || (current && before && current.equals(before))) {
      return { status: 'UNCHANGED_FAILURE', errorCode: e.code || 'EWRITE_FAILED' };
    }
    lease.holdUncertain();
    return { status: 'INDETERMINATE', errorCode: e.code || 'EWRITE_FAILED' };
  } finally {
    if (temp) { try { fs.unlinkSync(temp); } catch { /* leave owned temp for inspection */ } }
    if (!lease.uncertain) lease.release();
  }
}
module.exports = { OwnedWriteError, commitOwnedJson, assertOwnedTarget, digest };
