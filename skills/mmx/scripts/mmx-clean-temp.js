#!/usr/bin/env node
// mmx-clean-temp.js — reclaim stale outer temp dirs left by the /mmx calling blocks.
//
// Background: SKILL.md's POSIX / PowerShell blocks create one `mmx.XXXXXX`
// directory per call and deliberately leave it for the OS. Windows never
// reclaims those, so prompt text accumulates in %TEMP% indefinitely.
//
// Safety model (never a blind prefix delete):
//   - only DIRECT children of os.tmpdir() whose name matches ^mmx\.[0-9A-Za-z]{6,12}$
//     (mktemp 6 chars / PowerShell guid6). This never matches wrapper-internal
//     `mmx-chat-*` dirs or mcode's `mcv.*` dirs.
//   - only dirs whose age (max(birthtime>0, mtime)) exceeds 24h, so a running
//     call is never touched.
//   - reparse points / symlinks are rejected before reading and again before
//     deleting (realpath must stay a direct child of the temp root).
//   - POSIX: dirs writable by group/other are skipped (potential lure).
//   - default is DRY-RUN; --apply performs the deletion.
//   - per-dir failures are reported on stderr and do not abort the sweep.
//
// stdout is always a single JSON object. Exit 0 for a completed scan (even with
// per-dir failures), 1 for usage / root errors.
//
// Usage:
//   node mmx-clean-temp.js            # dry-run: list what would be deleted
//   node mmx-clean-temp.js --apply    # actually delete
//   node mmx-clean-temp.js --help

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.0.0';
const IS_WIN = process.platform === 'win32';
const STALE_MS = 24 * 3600 * 1000;
const NAME_RE = /^mmx\.[0-9A-Za-z]{6,12}$/;

function emit(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exitCode = code;
}

function usage(msg) {
  emit({ status: 'usage_error', error: msg, usage: 'node mmx-clean-temp.js [--apply]' }, 1);
}

const argv = process.argv.slice(2);
let apply = false;
for (const a of argv) {
  if (a === '--apply') apply = true;
  else if (a === '--help' || a === '-h') {
    process.stdout.write(
      `mmx-clean-temp ${VERSION}\n` +
      'Usage: node mmx-clean-temp.js [--apply]\n' +
      '  default: dry-run (list only); --apply deletes stale mmx.* dirs older than 24h\n'
    );
    process.exit(0);
  } else {
    usage(`unknown argument: ${a}`);
  }
}

const root = os.tmpdir();

// Windows junctions are not reported by lstat().isSymbolicLink(); resolve the
// real path and require it to remain a DIRECT child of the temp root.
function isReparsePoint(dir, lst) {
  try {
    if (lst.isSymbolicLink()) return true;
  } catch (_) {
    return true;
  }
  let real;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
  } catch (_) {
    return true;
  }
  if (!IS_WIN) return false;
  let realRoot;
  try {
    realRoot = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
  } catch (_) {
    return true;
  }
  const expect = path.join(realRoot, path.basename(dir));
  return real.toLowerCase() !== expect.toLowerCase();
}

function realOf(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch (_) {
    return null;
  }
}

// Recursive delete must not traverse into nested symlinks/junctions: a link
// planted inside an mmx.* dir could otherwise redirect rmSync to another tree.
// Any nested reparse point (or unreadable/too-deep subtree) makes the whole
// candidate untouchable.
function containsLink(dir, depth) {
  if (depth > 6) return true;
  const parentReal = realOf(dir);
  if (!parentReal) return true;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return true;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) return true;
    if (e.isDirectory()) {
      const real = realOf(p);
      if (!real) return true;
      const expect = path.join(parentReal, e.name);
      if (IS_WIN ? real.toLowerCase() !== expect.toLowerCase() : real !== expect) return true;
      if (containsLink(p, depth + 1)) return true;
    }
  }
  return false;
}

function sizeOf(dir, depth) {
  if (depth > 6) return 0;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += sizeOf(p, depth + 1);
      else if (e.isFile()) total += fs.lstatSync(p).size;
    } catch (_) {}
  }
  return total;
}

let entries;
try {
  entries = fs.readdirSync(root, { withFileTypes: true });
} catch (e) {
  emit({ status: 'scan_error', root, error: `cannot read temp root: ${e.code || e.message}` }, 1);
  process.exit(1);
}

let scanned = 0;
let matched = 0;
let aged = 0;
let deleted = 0;
let failed = 0;
let bytes = 0;
const candidates = [];

for (const e of entries) {
  scanned++;
  if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
  matched++;
  const dir = path.join(root, e.name);

  let lst;
  try {
    lst = fs.lstatSync(dir);
  } catch (_) {
    continue;
  }
  if (isReparsePoint(dir, lst)) continue;

  // Age = last activity (mtime), falling back to creation time. mtime is the
  // practical signal: a call writes prompt.txt at start, so a dir untouched for
  // 24h cannot belong to a running call. birthtime is used only when mtime is
  // unavailable (some volumes report 0).
  const mtime = Number.isFinite(lst.mtimeMs) && lst.mtimeMs > 0 ? lst.mtimeMs : 0;
  const birth = Number.isFinite(lst.birthtimeMs) && lst.birthtimeMs > 0 ? lst.birthtimeMs : 0;
  const born = mtime || birth;
  if (!Number.isFinite(born) || born <= 0) continue;
  if (Date.now() - born <= STALE_MS) continue;

  if (!IS_WIN && (lst.mode & 0o022) !== 0) continue; // group/other writable -> untrusted

  if (containsLink(dir, 0)) {
    process.stderr.write(`warning: skip ${e.name}: contains a symlink/junction or unreadable subtree\n`);
    continue;
  }

  aged++;
  const size = sizeOf(dir, 0);
  bytes += size;
  const ageHours = Math.round((Date.now() - born) / 3600000);

  if (!apply) {
    candidates.push({ name: e.name, bytes: size, age_hours: ageHours });
    continue;
  }

  try {
    // Re-check right before the recursive delete to shrink the swap window.
    if (isReparsePoint(dir, fs.lstatSync(dir))) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    deleted++;
  } catch (err) {
    failed++;
    process.stderr.write(`warning: could not remove ${e.name}: ${err.code || err.message}\n`);
  }
}

emit({
  status: 'ok',
  version: VERSION,
  mode: apply ? 'apply' : 'dry-run',
  root,
  scanned,
  matched,
  aged,
  deleted,
  failed,
  bytes,
  candidates: candidates.slice(0, 50),
  truncated: candidates.length > 50,
}, 0);
