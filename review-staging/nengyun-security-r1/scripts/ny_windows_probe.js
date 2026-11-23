'use strict';
// Windows-only, isolated candidate-replace probe. This does not touch production
// configuration, browser, session, authentication, registry, or global settings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
function runProbe() {
  const summary = {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.versions.node,
    operation: 'replace_existing_file_in_isolated_temp_directory',
    status: 'NOT_EVALUATED'
  };
  if (process.platform !== 'win32') return { ...summary, reason: 'REQUIRES_WINDOWS_HOST' };
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-win-probe-'));
    const dest = path.join(dir, 'carrier.json');
    const candidate = path.join(dir, 'candidate.json');
    const old = Buffer.from(JSON.stringify({ carrier: 'SYNTHETIC_OLD' }) + '\n');
    const next = Buffer.from(JSON.stringify({ carrier: 'SYNTHETIC_NEXT' }) + '\n');
    fs.writeFileSync(dest, old, { flag: 'wx' });
    const fd = fs.openSync(candidate, 'wx');
    try { fs.writeFileSync(fd, next); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(candidate, dest); }
    catch (error) {
      const unchanged = fs.existsSync(dest) &&
        crypto.timingSafeEqual(crypto.createHash('sha256').update(fs.readFileSync(dest)).digest(),
                               crypto.createHash('sha256').update(old).digest());
      return { ...summary, status: unchanged ? 'NOT_SUPPORTED' : 'FAIL',
        reason: unchanged ? 'REPLACE_EXISTING_FAILED_WITH_OLD_BYTES_RETAINED' : 'REPLACE_FAILED_AND_OLD_BYTES_NOT_VERIFIED',
        os_error_code: typeof error.code === 'string' ? error.code : 'UNKNOWN' };
    }
    const found = fs.readFileSync(dest);
    const match = found.equals(next);
    return { ...summary, status: match ? 'PASS' : 'FAIL',
      reason: match ? 'ISOLATED_REPLACE_SUCCEEDED' : 'CANDIDATE_BYTES_MISMATCH' };
  } catch (error) {
    return { ...summary, status: 'FAIL', reason: 'PROBE_SETUP_OR_READ_FAILED',
      os_error_code: typeof error.code === 'string' ? error.code : 'UNKNOWN' };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* report excludes cleanup guarantee */ } }
  }
}
if (require.main === module) {
  const result = runProbe();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status !== 'PASS') process.exitCode = 2;
}
module.exports = { runProbe };
