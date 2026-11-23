'use strict';
// Standalone fail-closed carrier primitives. Does NOT alter an existing installation.
// All cooperating writers must use the same canonical path and this transaction API.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 1024 * 1024;
class CarrierError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'CarrierError';
    this.code = code;
    // Deliberately never include OS error messages or file content in public errors.
    if (cause) this.cause = cause;
  }
}
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function canonicalPath(filename) {
  if (typeof filename !== 'string' || !filename.trim()) throw new CarrierError('EINVALID_PATH');
  const abs = path.resolve(filename);
  let parent;
  try { parent = fs.realpathSync.native(path.dirname(abs)); }
  catch (e) { throw new CarrierError('EPARENT_NOT_ACCESSIBLE', e); }
  const target = path.join(parent, path.basename(abs));
  try {
    const s = fs.lstatSync(target);
    // Reject target symlinks and hardlinks; sharing a lock through a replaced
    // file identity is not a supported production contract. Parent directory
    // aliases resolve to the same canonical directory before this point.
    if (s.isSymbolicLink() || (s.isFile() && s.nlink > 1)) {
      throw new CarrierError('EUNSUPPORTED_FILE_ALIAS');
    }
    if (!s.isFile()) throw new CarrierError('ENOT_FILE');
    return target;
  } catch (e) {
    if (e.code === 'ENOENT') return target;
    if (e instanceof CarrierError) throw e;
    throw new CarrierError('EPATH_NOT_ACCESSIBLE', e);
  }
}

function parseJsonBuffer(buffer) {
  if (buffer.length > MAX_BYTES) throw new CarrierError('ECONFIG_TOO_LARGE');
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    throw new CarrierError('EBOM_NOT_SUPPORTED');
  }
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); }
  catch { throw new CarrierError('EINVALID_JSON'); }
  if (!isObject(parsed)) throw new CarrierError('EINVALID_STRUCTURE');
  return parsed;
}

function readSnapshot(target, { allowMissing = false } = {}) {
  try {
    const buf = fs.readFileSync(target);
    return { config: parseJsonBuffer(buf), raw: buf, hash: sha256(buf), exists: true };
  } catch (e) {
    if (e.code === 'ENOENT' && allowMissing) {
      return { config: {}, raw: null, hash: null, exists: false };
    }
    if (e instanceof CarrierError) throw e;
    if (e.code === 'ENOENT') throw new CarrierError('ECARRIER_MISSING', e);
    throw new CarrierError('EREAD_FAILED', e);
  }
}

function readCarrier(filename, opts = {}) {
  const target = canonicalPath(filename);
  const snap = readSnapshot(target, opts);
  return { config: snap.config, sha256: snap.hash, exists: snap.exists };
}

function verifySnapshot(target, before) {
  const current = readSnapshot(target, { allowMissing: !before.exists });
  if (before.exists !== current.exists || before.hash !== current.hash) {
    throw new CarrierError('ECONFLICT');
  }
}

// Lock is held for the whole read/mutate/validate/replace/verify transaction.
// NEVER automatically remove a lock because it is "old". Operator intervention is required.
function transactCarrier(filename, mutator, { allowMissing = false } = {}) {
  if (typeof mutator !== 'function') throw new CarrierError('EINVALID_MUTATOR');
  const target = canonicalPath(filename);
  const lock = target + '.lock';
  const ownership = crypto.randomUUID();
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new CarrierError('ELOCKED', e);
    throw new CarrierError('ELOCK_FAILED', e);
  }
  let temp = null;
  let committed = false;
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ owner: ownership, pid: process.pid, at: Date.now() }));
    fs.fsyncSync(lockFd);
    const before = readSnapshot(target, { allowMissing });
    const cloned = JSON.parse(JSON.stringify(before.config));
    const ret = mutator(cloned);
    const updated = ret === undefined ? cloned : ret;
    if (!isObject(updated)) throw new CarrierError('EINVALID_STRUCTURE');
    // Retain existing EOL preference. Never serialize a BOM.
    const eol = before.raw && before.raw.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
    const newText = JSON.stringify(updated, null, 2).replace(/\n/g, eol) + eol;
    const buf = Buffer.from(newText, 'utf8');
    parseJsonBuffer(buf); // validates before write and before any replacement
    if (buf.length > MAX_BYTES) throw new CarrierError('ECONFIG_TOO_LARGE');
    if (before.exists && sha256(buf) === before.hash) {
      return { changed: false, sha256: before.hash };
    }
    temp = path.join(path.dirname(target), '.' + path.basename(target) + '.tmp-' + crypto.randomBytes(10).toString('hex'));
    let dataFd;
    try {
      dataFd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(dataFd, buf);
      fs.fsyncSync(dataFd);
    } finally { if (dataFd !== undefined) fs.closeSync(dataFd); }
    const staged = fs.readFileSync(temp);
    parseJsonBuffer(staged);
    if (sha256(staged) !== sha256(buf)) throw new CarrierError('ESTAGING_MISMATCH');
    verifySnapshot(target, before);
    try {
      // On Windows this may fail due to file sharing/AV. Never unlink the old file.
      fs.renameSync(temp, target);
      committed = true;
      temp = null;
    } catch (e) {
      throw new CarrierError('EREPLACE_FAILED_OR_UNCERTAIN', e);
    }
    // Post-commit failure is UNKNOWN, never silently restore a backup or retry.
    let result;
    try { result = readSnapshot(target); }
    catch (e) { throw new CarrierError('ECOMMIT_UNCERTAIN', e); }
    if (result.hash !== sha256(buf)) throw new CarrierError('ECOMMIT_UNCERTAIN');
    return { changed: true, sha256: result.hash };
  } finally {
    // Best effort remove only OUR uncommitted temporary file (it contains secrets).
    if (temp) { try { fs.unlinkSync(temp); } catch { /* must investigate if present */ } }
    try { fs.closeSync(lockFd); } catch { /* locked state must be reviewed */ }
    try {
      const currentLock = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (currentLock.owner === ownership) fs.unlinkSync(lock);
    } catch { /* fail closed if lock cannot be removed */ }
    void committed;
  }
}

module.exports = { CarrierError, canonicalPath, readCarrier, transactCarrier, sha256 };
