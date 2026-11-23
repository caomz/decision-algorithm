'use strict';
// Opt-in runtime resource coordination for cooperating processes only.
// This module never opens a browser, reads credentials or reclaims stale locks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

class RuntimeResourceError extends Error {
  constructor(code) { super(code); this.name = 'RuntimeResourceError'; this.code = code; }
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function normalizePathName(p) {
  if (typeof p !== 'string' || !p.trim()) throw new RuntimeResourceError('EINVALID_PATH');
  if (process.platform === 'win32' && (/^\\\\/.test(p) || /^\/\//.test(p))) {
    throw new RuntimeResourceError('EUNSUPPORTED_NETWORK_PATH');
  }
  return path.resolve(p);
}
function resourceKeyForFile(filename) {
  const input = normalizePathName(filename);
  let parent;
  try { parent = fs.realpathSync.native(path.dirname(input)); }
  catch { throw new RuntimeResourceError('EFILE_PARENT'); }
  // Reparse-point aliases on Windows require a separate native verification.
  if (process.platform === 'win32' && parent.toLowerCase() !== path.dirname(input).toLowerCase()) {
    throw new RuntimeResourceError('EUNVERIFIED_REPARSE_ALIAS');
  }
  const target = path.join(parent, path.basename(input));
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
      throw new RuntimeResourceError('EUNSUPPORTED_FILE_IDENTITY');
    }
  } catch (e) {
    if (e instanceof RuntimeResourceError) throw e;
    if (e.code !== 'ENOENT') throw new RuntimeResourceError('EFILE_IDENTITY_UNKNOWN');
  }
  return 'file:' + digest(process.platform === 'win32' ? target.toLowerCase() : target);
}
function resourceKeyForBrowser(sessionId) {
  // The adapter must derive one stable, non-secret ID for a real shared session.
  // Do not assume distinct ports or distinct Skill IDs mean distinct browsers.
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(sessionId)) {
    throw new RuntimeResourceError('EINVALID_SESSION_ID');
  }
  return 'browser:' + digest(sessionId.toLowerCase());
}
function assertKeys(keys) {
  if (!Array.isArray(keys)) throw new RuntimeResourceError('EINVALID_RESOURCES');
  if (!keys.every(k => typeof k === 'string' && /^(?:file|browser):[a-f0-9]{64}$/.test(k))) {
    throw new RuntimeResourceError('EINVALID_RESOURCE_KEY');
  }
  return [...new Set(keys)].sort(); // Fixed order prevents multi-resource deadlocks.
}
function checkedLockDirectory(lockRoot) {
  const root = normalizePathName(lockRoot);
  let canon;
  try {
    if (!fs.lstatSync(root).isDirectory()) throw new Error('not directory');
    canon = fs.realpathSync.native(root);
  } catch { throw new RuntimeResourceError('ELOCK_ROOT_UNAVAILABLE'); }
  if (process.platform === 'win32' && canon.toLowerCase() !== root.toLowerCase()) {
    throw new RuntimeResourceError('ELOCK_ROOT_ALIAS');
  }
  const lockDir = path.join(canon, '.ny-runtime-locks');
  try { fs.mkdirSync(lockDir, { mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') throw new RuntimeResourceError('ELOCK_ROOT_UNAVAILABLE'); }
  const stat = fs.lstatSync(lockDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeResourceError('ELOCK_ROOT_UNSAFE');
  return lockDir;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RuntimeResourceError('ECANCELLED'));
    const timer = setTimeout(done, ms);
    function onAbort() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(new RuntimeResourceError('ECANCELLED')); }
    function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
async function acquireResources(keys, { lockRoot, waitMs = 10000, signal, pollMs = 35 } = {}) {
  const ordered = assertKeys(keys);
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 300000) throw new RuntimeResourceError('EINVALID_WAIT');
  if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 1000) throw new RuntimeResourceError('EINVALID_POLL');
  if (signal?.aborted) throw new RuntimeResourceError('ECANCELLED');
  if (ordered.length === 0) return { keys: [], release() {}, holdUncertain() {} };
  if (!lockRoot) throw new RuntimeResourceError('ELOCK_ROOT_REQUIRED');
  const lockDir = checkedLockDirectory(lockRoot);
  const owner = crypto.randomUUID();
  const owned = [];
  const deadline = performance.now() + waitMs;
  let uncertain = false;
  let released = false;
  function release() {
    if (released) return;
    if (uncertain) throw new RuntimeResourceError('ERESOURCE_UNCERTAIN');
    // Fail closed when any marker was changed; never delete a foreign marker.
    for (const item of owned) {
      let marker;
      try { marker = JSON.parse(fs.readFileSync(item.file, 'utf8')); }
      catch { throw new RuntimeResourceError('ELOCK_OWNERSHIP_UNVERIFIED'); }
      if (marker.owner !== owner || marker.key !== item.key) {
        throw new RuntimeResourceError('ELOCK_OWNERSHIP_UNVERIFIED');
      }
    }
    for (const item of owned.reverse()) {
      try { fs.unlinkSync(item.file); }
      catch { throw new RuntimeResourceError('ELOCK_RELEASE_FAILED'); }
    }
    released = true;
  }
  try {
    for (const key of ordered) {
      const file = path.join(lockDir, digest(key) + '.lock');
      while (true) {
        if (signal?.aborted) throw new RuntimeResourceError('ECANCELLED');
        let fd;
        try { fd = fs.openSync(file, 'wx', 0o600); }
        catch (e) {
          if (e.code !== 'EEXIST') throw new RuntimeResourceError('ELOCK_OPEN_FAILED');
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new RuntimeResourceError('ELOCK_UNSAFE');
          if (performance.now() >= deadline) throw new RuntimeResourceError('ERESOURCE_BUSY');
          await sleep(Math.min(pollMs, Math.max(1, deadline - performance.now())), signal);
          continue; // Do not steal an old marker, ever.
        }
        try {
          fs.writeFileSync(fd, JSON.stringify({ owner, key, pid: process.pid }) + '\n');
          fs.fsyncSync(fd);
        } catch {
          fs.closeSync(fd);
          throw new RuntimeResourceError('ELOCK_WRITE_UNCERTAIN');
        }
        fs.closeSync(fd);
        owned.push({ file, key });
        break;
      }
    }
    return {
      keys: ordered,
      release,
      holdUncertain() { uncertain = true; },
      get uncertain() { return uncertain; }
    };
  } catch (error) {
    // A partially acquired set must be released only when still ours.
    if (owned.length) release();
    throw error;
  }
}
module.exports = {
  RuntimeResourceError, resourceKeyForFile, resourceKeyForBrowser,
  acquireResources, assertKeys
};
