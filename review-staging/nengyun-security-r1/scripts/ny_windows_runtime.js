'use strict';
// Opt-in Windows-oriented runner. Does not alter existing Skill entrypoints.
// No shell interpolation, no authentication relocation, no automatic retries.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { acquireResources, assertKeys, RuntimeResourceError } = require('./ny_runtime_resources');

class SkillRuntimeError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'SkillRuntimeError'; }
}
const PROTECTED = /^(?:path|home|userprofile|homedrive|homepath|appdata|localappdata|comspec|node_options|http_proxy|https_proxy|no_proxy|node_extra_ca_certs|ssl_cert_file)$/i;
const SENSITIVE = /(token|password|secret|credential|cookie|authorization|api_key)/i;
function assertDirectory(p, code) {
  if (typeof p !== 'string' || !p.trim()) throw new SkillRuntimeError(code);
  const abs = path.resolve(p);
  let stat;
  try { stat = fs.statSync(abs); }
  catch { throw new SkillRuntimeError(code); }
  if (!stat.isDirectory()) throw new SkillRuntimeError(code);
  return abs;
}
function inspectReadOnly({ entry, cwd, args = [], platform = process.platform } = {}) {
  const workingDir = assertDirectory(cwd, 'EINVALID_CWD');
  if (typeof entry !== 'string' || !entry.trim()) throw new SkillRuntimeError('EINVALID_ENTRY');
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || /[\u0000\r\n]/.test(a))) {
    throw new SkillRuntimeError('EINVALID_ARGS');
  }
  const full = path.resolve(workingDir, entry);
  let stat;
  try { stat = fs.statSync(full); }
  catch { throw new SkillRuntimeError('EENTRY_NOT_FOUND'); }
  if (!stat.isFile()) throw new SkillRuntimeError('EENTRY_NOT_FILE');
  const ext = path.extname(full).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(ext)) {
    return { kind: 'node', command: process.execPath, argv: [full, ...args], cwd: workingDir };
  }
  if (ext === '.exe') {
    if (platform !== 'win32') throw new SkillRuntimeError('EREQUIRES_WINDOWS');
    return { kind: 'exe', command: full, argv: args.slice(), cwd: workingDir };
  }
  if (ext === '.ps1') {
    if (platform !== 'win32') throw new SkillRuntimeError('EREQUIRES_WINDOWS');
    // No policy bypass, no PowerShell profile, and no implicit shell string.
    return { kind: 'ps1', command: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-File', full, ...args], cwd: workingDir };
  }
  if (ext === '.cmd' || ext === '.bat') {
    // cmd.exe expands %, !, ^, &, |, <, > and quotes. Without an actual
    // Windows adapter + argv tests, do not silently use shell:true.
    throw new SkillRuntimeError('EUNVERIFIED_CMD_BRIDGE');
  }
  throw new SkillRuntimeError('EUNSUPPORTED_ENTRY');
}
function childEnvironment(overrides, runId, runDir) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new SkillRuntimeError('EINVALID_ENV_OVERRIDES');
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        PROTECTED.test(key) || SENSITIVE.test(key) || /^ny_skill_run_/i.test(key) ||
        typeof value !== 'string' || /[\u0000]/.test(value)) {
      throw new SkillRuntimeError('EPROTECTED_ENV_OVERRIDE');
    }
  }
  return { ...process.env, ...overrides, NY_SKILL_RUN_ID: runId, NY_SKILL_RUN_DIR: runDir };
}
function newRunContext({ skillId, cwd, runRoot = os.tmpdir(), resourceKeys = [] } = {}) {
  if (typeof skillId !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(skillId)) {
    throw new SkillRuntimeError('EINVALID_SKILL_ID');
  }
  const workingDir = assertDirectory(cwd, 'EINVALID_CWD');
  const parent = assertDirectory(runRoot, 'EINVALID_RUN_ROOT');
  const keys = assertKeys(resourceKeys);
  const runId = crypto.randomUUID().replace(/-/g, '');
  const runDir = fs.mkdtempSync(path.join(parent, 'ny-run-' + skillId + '-'));
  return Object.freeze({ skillId, runId, workingDir, runDir, resourceKeys: Object.freeze(keys) });
}
function stoppedStatus(kind) { return kind === 'timeout' ? 'TIMEOUT' : 'CANCELLED'; }
async function runSkill({ skillId, entry, cwd, args = [], env = {}, resourceKeys = [], lockRoot,
  runRoot, timeoutMs = 60000, lockWaitMs = 10000, stopGraceMs = 350,
  signal, assumeNoDescendants = false, cleanupOwned = false } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000 ||
      !Number.isSafeInteger(stopGraceMs) || stopGraceMs < 1 || stopGraceMs > 60000) {
    throw new SkillRuntimeError('EINVALID_TIMEOUT');
  }
  // An existing business --check must be reviewed and dispatched separately,
  // before this side-effect-capable runner initializes any run state.
  if (args.includes('--check')) throw new SkillRuntimeError('ECHECK_REQUIRES_READONLY_PATH');
  // Preflight is read-only: no run directories or locks until arguments are valid.
  const command = inspectReadOnly({ entry, cwd, args });
  if (signal?.aborted) throw new SkillRuntimeError('ECANCELLED');
  childEnvironment(env, "12345678", "safe-preflight"); // Reject override errors before creating any run directory.
  const ctx = newRunContext({ skillId, cwd, runRoot, resourceKeys });
  const childEnv = childEnvironment(env, ctx.runId, ctx.runDir);
  let lease = null;
  let child = null;
  let terminal = 'FINISHED';
  let closeObserved = false;
  let cancelled = null;
  let spawnError = null;
  let outputExceeded = false;
  let result = null;
  const chunksOut = [];
  const chunksErr = [];
  let outBytes = 0;
  let errBytes = 0;
  const OUTPUT_LIMIT = 16 * 1024 * 1024;
  const started = performance.now();
  const triggerStop = (reason) => {
    if (cancelled || closeObserved) return;
    cancelled = reason;
    // Never target a process by name, PID lookup, or a guessed process tree.
    if (child && child.pid) {
      try { child.kill(); } catch { /* unknown; retained lock on failure */ }
    }
  };
  let abortHandler;
  let timeout;
  try {
    lease = await acquireResources(ctx.resourceKeys, { lockRoot, waitMs: lockWaitMs, signal });
    if (signal?.aborted) throw new SkillRuntimeError('ECANCELLED');
    child = spawn(command.command, command.argv, {
      cwd: command.cwd, env: childEnv, shell: false,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const onData = (chunks, which) => (buf) => {
      if (which === 'stdout') outBytes += buf.length;
      else errBytes += buf.length;
      if (outBytes + errBytes <= OUTPUT_LIMIT) chunks.push(buf);
      else { outputExceeded = true; triggerStop('output_limit'); }
    };
    child.stdout.on('data', onData(chunksOut, 'stdout'));
    child.stderr.on('data', onData(chunksErr, 'stderr'));
    let closeCode = null;
    let closeSignal = null;
    const closed = new Promise(resolve => {
      child.once('error', () => { spawnError = 'ESPAWN_FAILED'; });
      child.once('close', (code, sig) => {
        closeObserved = true;
        closeCode = code;
        closeSignal = sig;
        resolve();
      });
    });
    abortHandler = () => triggerStop('cancel');
    signal?.addEventListener('abort', abortHandler, { once: true });
    timeout = setTimeout(() => triggerStop('timeout'), timeoutMs);
    if (signal?.aborted) triggerStop('cancel');
    await Promise.race([
      closed,
      new Promise(resolve => {
        const check = () => {
          if (cancelled && !closeObserved) return resolve();
          if (closeObserved) return resolve();
          setTimeout(check, 15);
        };
        check();
      })
    ]);
    if (cancelled && !closeObserved) {
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, stopGraceMs))]);
    }
    if (cancelled) terminal = cancelled === 'output_limit' ? 'OUTPUT_LIMIT' : stoppedStatus(cancelled);
    if (spawnError && !cancelled) terminal = 'SPAWN_FAILED';
    // Child close is not proof that descendants have stopped. Retain locks when
    // termination happened without an externally validated tree ownership contract.
    if (ctx.resourceKeys.length && (!closeObserved || !assumeNoDescendants)) {
      lease.holdUncertain();
      terminal = 'RESOURCE_UNCERTAIN';
    }
    result = {
      status: terminal, exitCode: terminal === 'FINISHED' ? closeCode : null,
      signal: closeSignal, childPid: child.pid || null,
      skillId: ctx.skillId, runId: ctx.runId, runDir: ctx.runDir,
      stdout: Buffer.concat(chunksOut), stderr: Buffer.concat(chunksErr),
      durationMs: Math.round(performance.now() - started),
      evidence: closeObserved ? 'CHILD_CLOSE_OBSERVED' : 'CHILD_STILL_UNCONFIRMED',
      processTreeVerified: false, outputExceeded
    };
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
    let releaseKnown = true;
    try { if (lease && !lease.uncertain) lease.release(); }
    catch { releaseKnown = false; }
    if (!releaseKnown && result) {
      result.status = 'RESOURCE_UNCERTAIN';
      result.exitCode = null;
      result.evidence = 'LOCK_RELEASE_UNVERIFIED';
    }
    // A failed ownership release leaves the marker, not a foreign deletion.
    if (cleanupOwned && releaseKnown && (!lease || !lease.uncertain) && (!child || closeObserved)) {
      try { fs.rmSync(ctx.runDir, { recursive: true }); }
      catch { /* preserve artifacts on cleanup failure */ }
    }
  }
}
module.exports = { SkillRuntimeError, inspectReadOnly, childEnvironment, newRunContext, runSkill };
