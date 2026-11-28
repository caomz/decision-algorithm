"use strict";

// Conservative, single-host MMX provider slot. mkdir is atomic on local
// filesystems. The lock stays held until the owner explicitly releases it.
// Never reclaim an unknown/incomplete owner: a detached upstream request may
// still be running after its parent disappears. This module is deliberately
// independent of provider credentials and paid API calls.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DEFAULT_ROOT = path.join(os.homedir(), ".zmx", "locks");
const DEFAULT_WAIT_MS = 120000;
const POLL_MS = 100;

function syncDirectory(dir) {
  if (process.platform === "win32") return false;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(fd).isDirectory()) throw slotError("MMX_SLOT_UNSAFE", "MMX slot sync target is not a directory");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return true;
}
function syncCreatedPath(dir, firstCreated) {
  syncDirectory(dir);
  if (!firstCreated) return;
  const stop = path.dirname(firstCreated);
  for (let parent = path.dirname(dir); ; parent = path.dirname(parent)) {
    syncDirectory(parent);
    if (parent === stop || parent === path.dirname(parent)) break;
  }
}

function slotError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(slotError("MMX_SLOT_CANCELLED", "Waiting for the MMX slot was cancelled"));
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(slotError("MMX_SLOT_CANCELLED", "Waiting for the MMX slot was cancelled"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function assertPrivateDirectory(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw slotError("MMX_SLOT_UNSAFE", "MMX lock directory is not a real directory");
  }
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw slotError("MMX_SLOT_UNSAFE", "MMX lock directory must not be group/world-accessible");
  }
  return st;
}

function assertSameDirectory(dir, expected) {
  let current;
  try { current = assertPrivateDirectory(dir); }
  catch { throw slotError("MMX_SLOT_UNSAFE", "MMX lock directory changed or became inaccessible"); }
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw slotError("MMX_SLOT_UNSAFE", "MMX lock directory was replaced");
  }
}

// A single slot across every cooperating process on this host/user.
// No implicit bypass on errors, timeout, or unexpected lock file contents.
async function acquireMmxSlot(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const signal = options.signal;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 86400000) {
    throw slotError("MMX_SLOT_USAGE", "MMX slot wait must be between 0 and 86400000 ms");
  }
  if (signal?.aborted) throw slotError("MMX_SLOT_CANCELLED", "Waiting for the MMX slot was cancelled");
  // No symlinks in the two managed directory components; avoid following a
  // user-supplied symlink at the exact lock namespace boundary.
  const namespace = path.join(root, "mmx");
  const firstRoot = fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = assertPrivateDirectory(root);
  syncCreatedPath(root, firstRoot);
  const firstNamespace = fs.mkdirSync(namespace, { recursive: true, mode: 0o700 });
  const namespaceStat = assertPrivateDirectory(namespace);
  syncCreatedPath(namespace, firstNamespace);

  const lockDir = path.join(namespace, "slot-0");
  const started = performance.now();
  const ownerId = randomUUID();
  while (true) {
    if (signal?.aborted) throw slotError("MMX_SLOT_CANCELLED", "Waiting for the MMX slot was cancelled");
    assertSameDirectory(root, rootStat);
    assertSameDirectory(namespace, namespaceStat);
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const lockStat = assertPrivateDirectory(lockDir);
      const ownerFile = path.join(lockDir, "owner.json");
      try {
        const fd = fs.openSync(ownerFile, "wx", 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ format: 1, owner_id: ownerId, pid: process.pid, created_ms: Date.now() }) + "\n");
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        syncDirectory(lockDir);
        syncDirectory(namespace);
      } catch (error) {
        try { fs.rmdirSync(lockDir); } catch {}
        throw slotError("MMX_SLOT_IO", "MMX slot owner record could not be written");
      }
      const ownerStat = fs.lstatSync(ownerFile);
      let released = false;
      return {
        path: lockDir,
        waited_ms: performance.now() - started,
        release() {
          if (released) return;
          // Never delete another process's lock after an unexpected replacement.
          assertSameDirectory(root, rootStat);
          assertSameDirectory(namespace, namespaceStat);
          assertSameDirectory(lockDir, lockStat);
          let owner;
          try {
            const current = fs.lstatSync(ownerFile);
            if (!current.isFile() || current.dev !== ownerStat.dev || current.ino !== ownerStat.ino) throw new Error();
            owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
          }
          catch { throw slotError("MMX_SLOT_UNSAFE", "MMX lock owner record is missing or unreadable"); }
          if (owner?.owner_id !== ownerId || owner.pid !== process.pid) {
            throw slotError("MMX_SLOT_UNSAFE", "MMX lock ownership changed");
          }
          fs.unlinkSync(ownerFile);
          syncDirectory(lockDir);
          fs.rmdirSync(lockDir);
          syncDirectory(namespace);
          released = true;
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let st;
      try { st = fs.lstatSync(lockDir); }
      catch (statError) {
        // A cooperating owner can release after mkdir sees EEXIST but before
        // lstat. The vanished directory is available again, not an I/O failure.
        if (statError.code === "ENOENT") {
          if (performance.now() - started >= waitMs) {
            throw slotError("MMX_SLOT_BUSY", "MMX slot changed while waiting; acquisition deadline expired");
          }
          continue;
        }
        throw statError;
      }
      if (!st.isDirectory() || st.isSymbolicLink()) {
        throw slotError("MMX_SLOT_UNSAFE", "MMX slot is not a directory");
      }
      if (performance.now() - started >= waitMs) {
        throw slotError("MMX_SLOT_BUSY", "MMX provider slot is occupied; the previous request may still be running");
      }
      await sleep(Math.min(POLL_MS, Math.max(1, waitMs - (performance.now() - started))), signal);
    }
  }
}

module.exports = { acquireMmxSlot, DEFAULT_ROOT };
