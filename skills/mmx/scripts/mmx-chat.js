#!/usr/bin/env node
// Run one non-interactive text request. Keep prompt content out of argv,
// capture upstream streams privately, and emit exactly one JSON envelope.
// --version remains a plain-text compatibility exception.

"use strict";

const { createHash } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { TextDecoder } = require("util");

const VERSION = "2.8.2";
const FETCH_GUARD = path.join(__dirname, "fetch-timeout-guard.js");
const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const FETCH_LIMIT_MS = 300000;
const DEFAULT_PROFILE = path.join(__dirname, "..", "profiles", "local.json");
const LEGACY_MANAGED_ROOT = "/Volumes/WorkSSD/.claude/skills/mmx";
const RELEASE_MARKER = ".gstack-cross-validation-release.json";
const MANAGED_SIBLINGS = ["agy", "cross-validation"];
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TERMINAL_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"]);
const MAX_TIMEOUT_SEC = 3600; // ceiling for the per-call timeout flags
let requestedModel = null;
let cliInvoked = false;

// ---------------------------------------------------------------------------
// Chat result emission — exactly ONE JSON object on stdout.
// ---------------------------------------------------------------------------

let finalEmitted = false;
const telemetry = {};
function emit(result) {
  if (finalEmitted) return;
  finalEmitted = true;
  process.stdout.write(JSON.stringify({ requested_model: requestedModel, cli_invoked: cliInvoked, ...telemetry, ...result }) + "\n");
}

function fail(result) {
  emit(result);
  process.exitCode = 1;
}

function releaseProviderSlot(slot, exitCode = null) {
  try {
    slot.release();
  } catch (error) {
    telemetry.provider_slot = "release_unverified";
    throw Object.assign(error, { envelope: {
      status: "slot_unavailable",
      exit_code: exitCode,
      code: error.code || "MMX_SLOT_IO",
      error: "MMX provider slot release could not be confirmed. Check the slot and original request before retrying.",
    } });
  }
}

function usageError(message) {
  throw Object.assign(new Error(message), { envelope: { status: "usage_error", error: message } });
}

function validModel(value) {
  return typeof value === "string" && MODEL_PATTERN.test(value) && !/^sk-/i.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// A managed release installs <skills_root>/{agy,mmx,cross-validation} with the
// marker next to them. Detect that layout instead of hardcoding one host's
// path, so the same rule holds on every platform.
function isManagedLayout(skillsRoot) {
  return MANAGED_SIBLINGS.every(name => {
    try { return fs.statSync(path.join(skillsRoot, name)).isDirectory(); }
    catch { return false; }
  });
}

function validateInstall(env = process.env) {
  const skillRoot = fs.realpathSync(path.join(__dirname, ".."));
  const skillsRoot = path.dirname(skillRoot);
  const marker = path.join(skillsRoot, RELEASE_MARKER);
  let markerStat;
  try { markerStat = fs.lstatSync(marker); }
  catch (err) {
    // No marker: only a managed layout must fail closed. A plain install
    // (this repository, a symlinked skill) has no release to verify.
    const managed = skillRoot === LEGACY_MANAGED_ROOT || isManagedLayout(skillsRoot);
    if (err.code === "ENOENT" && !managed) return;
    throw err;
  }
  if (!markerStat.isFile()) throw new Error("release marker is not a regular file");
  const release = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (!isObject(release) || release.format !== 1 || release.state !== "active" ||
      typeof release.release_id !== "string" || !/^[a-f0-9]{64}$/.test(release.release_id) ||
      !isObject(release.files)) throw new Error("release marker is invalid");
  const requiredFiles = ["mmx/scripts/mmx-chat.js", "mmx/scripts/fetch-timeout-guard.js",
    "mmx/scripts/mmx-native-budget.js", "mmx/profiles/local.json"];
  if (env.MMX_GLOBAL_SLOT === "1") requiredFiles.push("mmx/scripts/mmx-provider-slot.js");
  for (const required of requiredFiles) {
    if (!Object.hasOwn(release.files, required)) throw new Error("release manifest is incomplete");
  }
  const entries = Object.keys(release.files).sort().map(name => [name, release.files[name]]);
  const inventory = JSON.stringify(Object.fromEntries(entries));
  if (createHash("sha256").update(inventory).digest("hex") !== release.release_id) {
    throw new Error("release inventory digest differs");
  }
  for (const [relative, expected] of entries) {
    const parts = relative.split("/");
    if (!["agy", "mmx", "cross-validation"].includes(parts[0]) || parts.length < 2 ||
        parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..") ||
        typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("release path or digest is invalid");
    if (parts[0] !== "mmx") continue;
    let file = skillsRoot;
    for (const [i, part] of parts.entries()) {
      file = path.join(file, part);
      const st = fs.lstatSync(file);
      if (i === parts.length - 1 ? !st.isFile() : !st.isDirectory()) throw new Error("release path changed");
    }
    if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== expected) {
      throw new Error("release file digest differs");
    }
  }
}

function readProfile(file) {
  let profile;
  try {
    if (!fs.statSync(file).isFile()) throw new Error();
    profile = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { usageError("MMX runtime profile is unreadable or is not JSON."); }
  if (!isObject(profile) || profile.format !== 1 ||
      Object.keys(profile).some(key => !["format", "model", "max_tokens", "request_timeout_seconds", "wrapper_timeout_seconds"].includes(key)) ||
      !(profile.model === null || validModel(profile.model)) ||
      !positiveInteger(profile.max_tokens) || !positiveInteger(profile.request_timeout_seconds) ||
      !positiveInteger(profile.wrapper_timeout_seconds)) usageError("MMX runtime profile is invalid.");
  return profile;
}

function timeoutOverride(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value) || !positiveInteger(Number(value))) usageError(`${name} must be a positive integer`);
  return Number(value);
}

// CLI flags win over the environment, which wins over the profile.
function timeoutArgument(value) {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value) || !positiveInteger(Number(value))) usageError("Timeout flags must be a positive integer");
  const seconds = Number(value);
  if (seconds > MAX_TIMEOUT_SEC) usageError(`Timeout flags must not exceed ${MAX_TIMEOUT_SEC} seconds`);
  return seconds;
}

// ---------------------------------------------------------------------------
// Temp workspace — remove known files one at a time, then rmdir only; NEVER
// recursive delete. Unexpected files in the dir -> rmdir fails -> the dir is
// left for the OS or a human. SIGKILL still leaks by definition; the dir is
// mkdtemp mode 0700 under the OS temp dir, bounded exposure.
// ---------------------------------------------------------------------------

let tempDir = null;
const tempFiles = new Set();

function privateFile(name) {
  const file = path.join(tempDir, name);
  const fd = fs.openSync(file, "wx", 0o600);
  tempFiles.add(file);
  return fd;
}

function cleanup() {
  if (!tempDir) return;
  for (const file of tempFiles) {
    try { fs.unlinkSync(file); } catch {}
  }
  tempFiles.clear();
  try { fs.rmdirSync(tempDir); } catch {} // Leave unknown contents intact.
  tempDir = null;
}

let cancelCurrentRequest = null;
function terminateChildTree(child, force, grouped, platform = process.platform, killTree = spawnSync, killGroup = process.kill) {
  if (!child || !child.pid) return false;
  if (platform === "win32") {
    try {
      const killed = killTree("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, timeout: 2000, shell: false,
      });
      if (!killed.error && killed.status === 0) return true;
    } catch {}
  } else if (grouped) {
    try {
      killGroup(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch (e) { if (e.code === "ESRCH") return true; }
  }
  // A root-only fallback cannot confirm that descendants were terminated.
  try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
  return false;
}

function onSignal(code) {
  if (cancelCurrentRequest) cancelCurrentRequest(code);
  else fail({ status: "cancelled", exit_code: code });
}
if (require.main === module) {
  process.on("SIGTERM", () => onSignal(143));
  process.on("SIGINT", () => onSignal(130));
  process.on("SIGHUP", () => onSignal(129));
}

// Capture stdout and stderr separately in private files. Buffering each
// stream in memory while the request runs doubles the cost of a large reply.
function runCmd(cmd, args, timeoutSecs, useShell, childEnv, confirmGroup = false) {
  const stdoutFd = privateFile("stdout");
  let stderrFd;
  try { stderrFd = privateFile("stderr"); }
  catch (err) { fs.closeSync(stdoutFd); throw err; }
  return new Promise(resolve => {
    const grouped = process.platform !== "win32";
    let child;
    let stopReason;
    let forcedExitCode = null;
    let childCode = null;
    let closed = false;
    let escalated = false;
    let terminationFailed = false;
    let finished = false;
    let timeout;
    let grace;
    let deadline;
    let groupCheck;

    function groupGone() {
      if (!grouped || !child?.pid) return true;
      try { process.kill(-child.pid, 0); return false; }
      catch (error) { return error.code === "ESRCH"; }
    }

    function finish(kind) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(grace);
      clearTimeout(deadline);
      clearTimeout(groupCheck);
      cancelCurrentRequest = null;
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      resolve({ kind, code: forcedExitCode ?? childCode, termination_failed: terminationFailed });
    }

    function finishAfterTree(kind) {
      if (finished) return;
      if (!confirmGroup || groupGone()) { finish(kind); return; }
      // A successful signal only queues termination. Keep the lease while a
      // member still exists (including an un-reaped process or unknown probe).
      groupCheck = setTimeout(() => finishAfterTree(kind), 50);
    }

    function stop(kind, code = null) {
      if (stopReason) return;
      stopReason = kind;
      forcedExitCode = code;
      if (!terminateChildTree(child, false, grouped)) terminationFailed = true;
      grace = setTimeout(() => {
        // The main child may exit before a descendant. On POSIX the group
        // still needs escalation even after the close event.
        if ((grouped || !closed) && !terminateChildTree(child, true, grouped)) terminationFailed = true;
        escalated = true;
        if (closed) finishAfterTree(stopReason);
      }, 1500);
      deadline = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        terminationFailed = true;
        finish(stopReason);
      }, 4000);
    }

    function capture(fd, bytes) {
      if (stopReason || finished) return;
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (count <= 0) throw new Error("short write");
          offset += count;
        }
      } catch { stop("capture_error"); }
    }

    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"], shell: useShell,
        detached: grouped, windowsHide: true, env: childEnv,
      });
    } catch { finish("spawn_error"); return; }
    cancelCurrentRequest = code => stop("cancelled", code);
    child.stdout.on("data", bytes => capture(stdoutFd, bytes));
    child.stderr.on("data", bytes => capture(stderrFd, bytes));
    child.on("spawn", () => { cliInvoked = true; });
    child.on("error", () => {
      if (confirmGroup && child.pid && !groupGone()) {
        // An error after spawn is not evidence that the process group exited.
        terminationFailed = true;
        stop(stopReason || "spawn_error");
      } else finish(stopReason || "spawn_error");
    });
    child.on("close", code => {
      closed = true;
      childCode = code;
      if (!stopReason) {
        if (confirmGroup && !groupGone()) {
          // The CLI root can exit successfully after leaving a live descendant
          // with detached stdio. Never free its provider slot as an ordinary success.
          stop("cleanup_error");
        } else finish("closed");
      } else if (escalated) finishAfterTree(stopReason);
    });
    timeout = setTimeout(() => stop("timeout", 124), timeoutSecs * 1000);
  });
}

// ---------------------------------------------------------------------------
// findMmx scans PATH using the delimiter and extension policy of the running
// Node platform. Standard npm shims resolve to their package JS entry; other
// batch files use the guarded shell path.
// ---------------------------------------------------------------------------

// The real entry and package root when `candidate` is the declared `mmx` bin
// of an installed mmx-cli package; null for anything else.
function mmxPackageEntry(candidate) {
  try {
    if (!/\.(?:cjs|mjs|js)$/i.test(candidate) || !fs.statSync(candidate).isFile()) return null;
    const entry = fs.realpathSync(candidate);
    if (!/\.(?:cjs|mjs|js)$/i.test(entry)) return null;
    for (let directory = path.dirname(candidate); directory !== path.dirname(directory); directory = path.dirname(directory)) {
      const metadata = path.join(directory, "package.json");
      if (!fs.existsSync(metadata)) continue;
      const pkg = JSON.parse(fs.readFileSync(metadata, "utf8"));
      if (!isObject(pkg) || pkg.name !== "mmx-cli") return null;
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.mmx;
      if (typeof bin !== "string" || path.isAbsolute(bin) || path.win32.isAbsolute(bin)) return null;
      const root = fs.realpathSync(directory);
      const declared = fs.realpathSync(path.resolve(directory, bin));
      const relative = path.relative(root, declared);
      if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || declared !== entry) return null;
      return { entry, root };
    }
  } catch { return null; }
  return null;
}

function npmShimEntry(shim) {
  try {
    const body = fs.readFileSync(shim, "utf8");
    if (body.length > 8192 || !/^@echo off/i.test(body) ||
        !/"%_prog%"\s+"%dp0%[\\/]node_modules[\\/]mmx-cli[\\/]dist[\\/]mmx\.mjs"\s+%\*/i.test(body)) return null;
    const pkgDir = path.join(path.dirname(shim), "node_modules", "mmx-cli");
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    if (pkg.name !== "mmx-cli" || pkg.bin?.mmx !== "dist/mmx.mjs") return null;
    const entry = path.join(pkgDir, "dist", "mmx.mjs");
    if (!fs.statSync(entry).isFile()) return null;
    return entry;
  } catch { return null; }
}

// A POSIX `mmx` that is, or links to, the mmx-cli package entry.
function linkedEntry(file) {
  try { return mmxPackageEntry(fs.realpathSync(file))?.entry ?? null; }
  catch { return null; }
}

// Directories that may hold a global npm install of the audited package.
// MMX_NPM_GLOBAL_ROOT points at the root that owns node_modules/mmx-cli; the
// standard locations cover the usual layouts.
function auditedPackageRoots(env = process.env, platform = process.platform) {
  const home = env[envKey(env, platform === "win32" ? "USERPROFILE" : "HOME", platform)] || os.homedir();
  const roots = [];
  const push = value => {
    if (typeof value !== "string" || value === "") return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  push(env.MMX_NPM_GLOBAL_ROOT);
  push(path.join(home, ".npm-global", "lib", "node_modules"));
  push(path.join(home, ".node_modules"));
  if (platform === "win32") {
    push(path.join(env[envKey(env, "APPDATA", platform)] || path.join(home, "AppData", "Roaming"), "npm", "node_modules"));
  } else {
    push("/usr/local/lib/node_modules");
    push("/opt/homebrew/lib/node_modules");
  }
  return roots;
}

// The mmx-cli package directory inside a global npm root, when the package
// name and version match the audited release. The root may be the npm global
// root (which holds node_modules/) or the node_modules directory itself.
function auditedPackageCandidate(root) {
  for (const pkgDir of [path.join(root, "mmx-cli"), path.join(root, "node_modules", "mmx-cli")]) {
    try {
      const metadata = path.join(pkgDir, "package.json");
      if (!fs.statSync(metadata).isFile()) continue;
      const pkg = JSON.parse(fs.readFileSync(metadata, "utf8"));
      if (!isObject(pkg) || pkg.name !== "mmx-cli" || pkg.version !== "1.0.29") continue;
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.mmx;
      if (typeof bin !== "string" || path.isAbsolute(bin)) continue;
      const entry = path.resolve(pkgDir, bin);
      const realEntry = fs.realpathSync(entry);
      if (!/\.(?:cjs|mjs|js)$/i.test(realEntry)) continue;
      return { entry: realEntry, declared_entry: entry, root: fs.realpathSync(pkgDir) };
    } catch { /* try the next layout */ }
  }
  return null;
}

// An explicitly requested entry (--cli-entry / MMX_CLI_ENTRY). Only the
// audited package layout verifies; anything else stays unverified.
function explicitAuditedEntry(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    const resolved = fs.realpathSync(path.resolve(value));
    return mmxPackageEntry(resolved) ?? { entry: resolved, root: null };
  } catch { return null; }
}

// The audited entry must match the reviewed SHA-256 before it may run.
function verifyAuditedEntry(pkg) {
  try {
    if (!pkg) return { ok: false, entry: null, digest: null };
    const digest = createHash("sha256").update(fs.readFileSync(pkg.entry)).digest("hex");
    if (!require("./mmx-native-budget.js").supportedEntry(pkg.entry, pkg.root, digest)) {
      return { ok: false, entry: pkg.entry, digest };
    }
    return { ok: true, entry: pkg.entry, root: pkg.root, digest, declared_entry: pkg.declared_entry ?? null };
  } catch { return { ok: false, entry: pkg?.entry ?? null, digest: null }; }
}

// npm bin paths that resolve to the audited entry, for the usual global
// layouts (<prefix>/lib/node_modules/mmx-cli and <prefix>/node_modules/mmx-cli).
function npmBinCandidates(pkgRoot) {
  const candidates = [];
  const add = value => { if (value && !candidates.includes(value)) candidates.push(value); };
  const up = (directory, levels) => {
    let current = directory;
    for (let i = 0; i < levels; i++) current = path.dirname(current);
    return current;
  };
  const threeUp = up(pkgRoot, 3);
  const twoUp = up(pkgRoot, 2);
  add(path.join(threeUp, "bin", "mmx"));
  add(path.join(twoUp, "bin", "mmx"));
  add(path.join(twoUp, "mmx.cmd"));
  return candidates;
}

// Every literal path that points at the audited entry: the entry itself, the
// path the package declares, and the npm bin shims that resolve to it.
function auditedTargets(pkg, platform = process.platform) {
  const targets = [];
  const add = value => { if (value && !targets.includes(value)) targets.push(value); };
  add(pkg.entry);
  add(pkg.declared_entry);
  for (const candidate of npmBinCandidates(pkg.root)) {
    try { if (fs.realpathSync(candidate) === pkg.entry) add(candidate); }
    catch { /* a shim that does not exist cannot be the target */ }
    try { if (npmShimEntry(candidate) === pkg.entry) add(candidate); }
    catch { /* not a Windows npm shim */ }
  }
  return targets;
}

// Windows paths are case-insensitive; POSIX paths are not.
function isTarget(candidate, targets, platform = process.platform) {
  if (targets.includes(candidate)) return true;
  if (platform !== "win32") return false;
  const lower = candidate.toLowerCase();
  return targets.some(target => target.toLowerCase() === lower);
}

// `env` options that consume the following word.
const ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-i", "--ignore", "-C", "--chdir", "-S", "--split-string"]);
// Interpreters that may stand in front of the audited entry.
const LAUNCHER_INTERPRETERS = new Set(["node", "nodejs", "bun", "deno"]);

// The tokens of one shell line after the usual prefixes, with assignments and
// expansions dropped. The first token is the program the line runs.
function launcherTokens(line) {
  let tokens = line.trim().split(/\s+/);
  if (tokens[0] === "exec" || tokens[0] === "command") tokens = tokens.slice(1);
  if (tokens[0] === "env") {
    tokens = tokens.slice(1);
    while (tokens.length) {
      const token = tokens[0];
      if (token.startsWith("-")) {
        const option = tokens.shift();
        if (ENV_VALUE_OPTIONS.has(option) && tokens.length) tokens.shift();
        continue;
      }
      if (/^"?\$\{/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { tokens.shift(); continue; }
      break;
    }
  }
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  return tokens.map(token => token.replace(/^["']|["']$/g, ""));
}

// A launcher on PATH may only be bypassed when it demonstrably runs the
// audited entry. The check is on the command lines, not on a substring: the
// last command has to be the audited entry (directly or behind an
// interpreter), and no other command in the script may run a different
// absolute program. A mention in a comment, in an argument or in an unrelated
// branch proves nothing, and a script that runs something else is not a thin
// wrapper for the audited entry.
function launcherTargetsAudited(launcherPath, pkg, platform = process.platform) {
  try {
    const stat = fs.statSync(launcherPath);
    if (!stat.isFile() || stat.size > 65536) return false;
    const body = fs.readFileSync(launcherPath, "utf8");
    const targets = auditedTargets(pkg, platform);
    if (!targets.length) return false;
    const lines = body.split("\n").filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#");
    });
    if (!lines.length) return false;
    for (const line of lines.slice(0, -1)) {
      const program = launcherTokens(line)[0];
      if (program && program.startsWith("/") && !isTarget(program, targets, platform)) return false;
    }
    const tokens = launcherTokens(lines[lines.length - 1]);
    if (!tokens.length) return false;
    if (isTarget(tokens[0], targets, platform)) return true;
    return LAUNCHER_INTERPRETERS.has(path.basename(tokens[0]).toLowerCase()) &&
      isTarget(tokens[1] || "", targets, platform);
  } catch { return false; }
}

// cmd.exe expands % and ! inside quotes; other metacharacters affect parsing.
function safeCmdArgument(s) {
  return typeof s === "string" && s.length > 0 &&
    !/["%!?^&|<>()\r\n\x00]/.test(s);
}

function findMmx(platform = process.platform, envPath = process.env.PATH || "", fsApi = fs,
                 shimResolver = npmShimEntry, nodePath = process.execPath, linkResolver = linkedEntry) {
  const isWin = platform === "win32";
  const pathApi = isWin ? path.win32 : path.posix;
  const dirs = envPath.split(pathApi.delimiter).filter(Boolean);
  const exts = isWin ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = pathApi.join(dir, "mmx" + ext);
      try {
        fsApi.accessSync(p, isWin ? fsApi.constants.F_OK : fsApi.constants.X_OK);
        const batch = isWin && (ext === ".cmd" || ext === ".bat");
        // The mmx-cli package entry runs under this Node so the wrapper can
        // preload its fetch guard. Any other executable, such as a user's own
        // launcher script, runs unchanged.
        const entry = batch ? shimResolver(p) : isWin ? null : linkResolver(p);
        if (entry) return { cmd: nodePath, argsPrefix: [entry], shell: false };
        if (batch && !safeCmdArgument(p)) return { unsafe: true };
        return { cmd: p, argsPrefix: [], shell: batch };
      } catch {}
    }
  }
  return null;
}

// Child launch for the CLI. mmx-cli appends /anthropic/v1/messages to its base
// URL, so an OpenAI-style MINIMAX_BASE_URL ending in /v1 (often exported for
// other tools) always yields HTTP 404; only the child's copy is normalised.
// Node's built-in fetch also gives up after 300 s without response headers,
// and a non-streaming reply sends its headers only when it is complete. When
// the CLI is the mmx-cli package entry, preload a guard that lifts that limit
// with the undici copy the CLI itself imports. The CLI's --timeout and the
// wrapper deadline still bound the request. With a proxy set (environment or
// the mmx config `proxy` key), the CLI installs its own proxy dispatcher,
// which keeps the 300 s limit; both are checked the way the CLI reads them.
function cliLaunch(mmx, env = process.env, platform = process.platform, guardFile = FETCH_GUARD) {
  const childEnv = { ...env };
  const baseKey = envKey(childEnv, "MINIMAX_BASE_URL", platform);
  let baseUrl = typeof childEnv[baseKey] === "string" && childEnv[baseKey] !== "" ? childEnv[baseKey] : null;
  let baseUrlEnv = "unset";
  if (baseUrl !== null) {
    const trimmed = baseUrl.replace(/\/v1\/?$/, "");
    baseUrlEnv = trimmed === baseUrl ? "unchanged" : "stripped_v1";
    childEnv[baseKey] = baseUrl = trimmed;
  }
  let argsPrefix = mmx.argsPrefix;
  let guard = "custom_launcher";
  const pkg = mmx.argsPrefix.length === 1 ? mmxPackageEntry(mmx.argsPrefix[0]) : null;
  if (pkg) {
    let undici = null;
    try { undici = require.resolve("undici", { paths: [pkg.root] }); } catch {}
    let guardPresent = false;
    try { guardPresent = fs.statSync(guardFile).isFile(); } catch {}
    if (!guardPresent) guard = "guard_missing";
    else if (!undici) guard = "undici_not_found";
    else {
      childEnv.MMX_CHAT_UNDICI_PATH = undici;
      argsPrefix = ["--require", guardFile, ...mmx.argsPrefix];
      const proxied = PROXY_VARIABLES.some(name => childEnv[envKey(childEnv, name, platform)]) || configProxy(childEnv, platform);
      guard = proxied ? "proxy_limited" : "preloaded";
    }
  }
  return { argsPrefix, env: childEnv, base_url: baseUrl, fetch_timeout_guard: guard, base_url_env: baseUrlEnv };
}

// Inspection only. The parent can check both providers before launching either.
// Recheck the same policy inside the wrapper before allocating its private claim.
//
// Which native entry runs. A user-owned launcher script on PATH cannot carry
// the fetch guard, because the guard is preloaded into a Node child. When the
// PATH entry is not the audited package entry, the audited install is looked
// up in the known global npm roots instead of failing outright. Every
// candidate is still verified against the reviewed SHA-256 before it runs, so
// the request budget keeps its guarantee; only the lookup gets smarter.
// Egress-relevant variables that a launcher may neutralise. When the parent
// environment carries any of them, the bypass would run the audited entry
// with a different environment than the launcher would have produced, so it
// needs an explicit acknowledgement.
function egressEnvironmentPresent(env, platform) {
  if (PROXY_VARIABLES.some(name => env[envKey(env, name, platform)])) return true;
  const base = env[envKey(env, "MINIMAX_BASE_URL", platform)];
  if (typeof base !== "string" || base === "") return false;
  // A base URL that only differs by the /v1 suffix normalises to the same
  // origin the wrapper already uses, so it changes nothing.
  return !/\/v1\/?$/.test(base);
}

// An owner-selected macOS entry is independent of terminal startup files.
// Only the entry path is configurable here; the launch inherits proxy settings.
function configuredMacEntry(env, platform) {
  if (platform !== "darwin" || env.MMX_REQUIRE_PATH_LAUNCHER === "1" || !path.isAbsolute(env.HOME || "")) return null;
  const file = path.join(env.HOME, "Library", "Application Support", "Decision Algorithm", "mmx-launch.json");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 4096) {
      throw new Error("unsafe MMX launch configuration");
    }
    const data = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!isObject(data) || Object.keys(data).length !== 2 || data.format !== 1 ||
        typeof data.cli_entry !== "string" || !path.isAbsolute(data.cli_entry)) {
      throw new Error("invalid MMX launch configuration");
    }
    return data.cli_entry;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function resolveLaunch(env = process.env, platform = process.platform, options = {}) {
  const pathEnv = env[envKey(env, "PATH", platform)] || "";
  const pathMmx = findMmx(platform, pathEnv);
  const resolution = { source: null, path_launcher: null, audited_entry: null, bypassed: false, roots: [] };

  const selectedLaunch = (value, source) => {
    resolution.source = source;
    const explicit = explicitAuditedEntry(value);
    if (!explicit) {
      resolution.audited_entry = value;
      return { ok: false, reason: "unverified_native_entry", resolution,
        detail: "The selected MMX entry does not exist or is not readable." };
    }
    resolution.audited_entry = explicit.entry;
    const verdict = verifyAuditedEntry(explicit);
    if (!verdict.ok) {
      return { ok: false, reason: "unverified_native_entry", resolution,
        detail: "The selected MMX entry is not the audited mmx-cli 1.0.29 package entry." };
    }
    return finishLaunch({ cmd: process.execPath, argsPrefix: [verdict.entry], shell: false }, env, verdict, resolution);
  };
  const explicitValue = options.explicitEntry ?? env.MMX_CLI_ENTRY;
  if (typeof explicitValue === "string" && explicitValue !== "") return selectedLaunch(explicitValue, "explicit");

  if (pathMmx && !pathMmx.unsafe && pathMmx.argsPrefix.length === 1) {
    const pkg = mmxPackageEntry(pathMmx.argsPrefix[0]);
    if (pkg) {
      const verdict = verifyAuditedEntry(pkg);
      if (verdict.ok) {
        resolution.source = "path";
        resolution.audited_entry = verdict.entry;
        return finishLaunch(pathMmx, env, verdict, resolution);
      }
      // The PATH entry is the audited package but its content does not match
      // the reviewed digest. That is an entry problem, not a launcher problem.
      resolution.audited_entry = verdict.entry ?? pkg.entry;
      return { ok: false, reason: "unverified_native_entry", resolution,
        detail: "The mmx-cli package entry on PATH does not match the reviewed SHA-256." };
    }
  }

  let configuredValue;
  try { configuredValue = configuredMacEntry(env, platform); }
  catch {
    return { ok: false, reason: "invalid_launch_config", resolution,
      detail: "Check the owner-only Decision Algorithm/mmx-launch.json for a valid audited cli_entry." };
  }
  if (configuredValue) return selectedLaunch(configuredValue, "mac_config");

  resolution.path_launcher = pathMmx ? pathMmx.cmd : null;
  if (env.MMX_REQUIRE_PATH_LAUNCHER === "1") {
    return { ok: false, reason: "unverified_launcher", resolution,
      detail: "MMX_REQUIRE_PATH_LAUNCHER=1 forbids the audited-package fallback; only the entry found on PATH may run." };
  }

  for (const root of auditedPackageRoots(env, platform)) {
    resolution.roots.push(root);
    const candidate = auditedPackageCandidate(root);
    if (!candidate) continue;
    const verdict = verifyAuditedEntry(candidate);
    if (!verdict.ok) continue;
    // Only a launcher that demonstrably runs this audited entry may be
    // bypassed. Anything else on PATH stays untouched.
    if (!launcherTargetsAudited(resolution.path_launcher, verdict, platform)) continue;
    if (egressEnvironmentPresent(env, platform) && env.MMX_ALLOW_LAUNCHER_BYPASS !== "1") {
      return { ok: false, reason: "launcher_environment_differs", resolution,
        detail: "The launcher may neutralise proxy or base-URL variables that the audited entry would inherit. Set MMX_ALLOW_LAUNCHER_BYPASS=1 to accept the difference, or run the launcher by putting its npm bin first on PATH." };
    }
    resolution.source = "audited_package_fallback";
    resolution.audited_entry = verdict.entry;
    resolution.bypassed = true;
    return finishLaunch({ cmd: process.execPath, argsPrefix: [verdict.entry], shell: false }, env, verdict, resolution);
  }

  return {
    ok: false,
    reason: pathMmx ? "unverified_launcher" : "cli_missing",
    resolution,
    detail: pathMmx
      ? "The first mmx on PATH is not the audited mmx-cli 1.0.29 package entry, and no audited install that this launcher runs was found."
      : "No mmx executable was found on PATH.",
  };
}

// The audited entry still has to run under the fetch guard; a guard that
// cannot be prepared keeps the call closed.
function finishLaunch(mmx, env, verdict, resolution) {
  const launch = cliLaunch(mmx, env);
  if (!["preloaded", "proxy_limited"].includes(launch.fetch_timeout_guard)) {
    return { ok: false, reason: launch.fetch_timeout_guard, resolution,
      detail: `The audited entry was found, but the fetch guard could not be prepared (${launch.fetch_timeout_guard}).` };
  }
  return { ok: true, reason: null, mmx, launch, resolution, entry_sha256: verdict.digest, cli_version: "1.0.29" };
}

function resolveBudgetLaunch(env, options = {}) {
  try {
    return resolveLaunch(env, process.platform, options);
  } catch { return { ok: false, reason: "native_budget_unavailable", resolution: null }; }
}

function preflightRequestBudget(env = process.env, options = {}) {
  try { validateInstall(env); }
  catch { return { ok: false, reason: "install_mismatch", detail: "MMX managed files failed verification.", launch_resolution: null }; }
  const result = resolveBudgetLaunch(env, options);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail ?? null, launch_resolution: result.resolution ?? null };
  return { ok: true, reason: null, entry_sha256: result.entry_sha256, cli_version: result.cli_version,
    launch_resolution: result.resolution, fetch_timeout_guard: result.launch.fetch_timeout_guard,
    base_url_env: result.launch.base_url_env };
}

// Windows environment names are case-insensitive, but a copied environment
// keeps the spelling each variable was set with.
function envKey(env, name, platform) {
  if (platform !== "win32") return name;
  return Object.keys(env).find(key => key.toUpperCase() === name) ?? name;
}

// mmx-cli falls back to the `proxy` key of $MMX_CONFIG_DIR/config.json (else
// <home>/.mmx/config.json) and accepts only values starting with "http". Same
// rule here; only that key is read and nothing from the file is echoed.
function configProxy(env, platform) {
  const home = env[envKey(env, platform === "win32" ? "USERPROFILE" : "HOME", platform)] || os.homedir();
  const dir = env[envKey(env, "MMX_CONFIG_DIR", platform)] || path.join(home, ".mmx");
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    return isObject(config) && typeof config.proxy === "string" && config.proxy.startsWith("http");
  } catch { return false; }
}

// mmx-cli exits with code 6 ("Network request failed.") when fetch itself
// fails, which is also how Node's 300 s header and body limits surface.
function withFetchLimitHint(result, elapsedMs) {
  if (result.status !== "api_error" || result.exit_code !== 6 || !(elapsedMs >= FETCH_LIMIT_MS - 5000) || result.hint) return result;
  return { ...result,
    hint: "The CLI reported a network failure after about 300 s or more. Node's fetch drops a reply whose headers or body stall for 300 s; fetch_timeout_guard shows whether this wrapper lifted that limit, and a proxy from the environment or the mmx config keeps it." };
}

// Scheme and host only: never echo credentials, query strings, or path
// segments — gateways can embed tokens in the base URL path.
function displayUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch { return null; }
}

// mmx-cli reports HTTP failures as "API error: HTTP <status>" in its error envelope.
function upstreamHttpStatus(...bodies) {
  for (const body of bodies) {
    const message = isObject(body) && isObject(body.error) && typeof body.error.message === "string" ? body.error.message : "";
    const match = /\bHTTP (\d{3})\b/.exec(message);
    if (match) return Number(match[1]);
  }
  return null;
}

function withHttpHint(result, ...bodies) {
  if (result.status !== "api_error" || upstreamHttpStatus(...bodies) !== 404) return result;
  return { ...result, http_status: 404,
    hint: "HTTP 404 from the MiniMax endpoint. mmx-cli appends /anthropic/v1/messages to its base URL; if this repeats, check that --base-url, MINIMAX_BASE_URL or the mmx config base_url does not already end in /v1." };
}

// The CLI can emit diagnostic lines before its sole JSON envelope. Avoid
// interpreting a JSON string, array, or an embedded object as a response.
function parseUpstream(raw) {
  try { return JSON.parse(raw); } catch {}
  const start = raw.search(/^\s*\{/m);
  if (start > 0 && !/^[{[\"]/.test(raw)) {
    try { return JSON.parse(raw.slice(start)); } catch {}
  }
  return undefined;
}

function readInput(file, label) {
  if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(file)) {
    usageError(`${label} path is MSYS-style; convert it with cygpath -w before invoking Windows Node.js`);
  }
  let raw;
  try {
    if (!fs.statSync(file).isFile()) throw new Error();
    raw = fs.readFileSync(file);
  } catch { usageError(`${label} file is not a readable regular file`); }
  if ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff) || raw.includes(0)) {
    throw Object.assign(new Error(), { envelope: { status: "unsupported_encoding", error: `${label} must be UTF-8.` } });
  }
  try { return { raw, text: new TextDecoder("utf-8", { fatal: true }).decode(raw) }; }
  catch {
    throw Object.assign(new Error(), { envelope: { status: "unsupported_encoding", error: `${label} must be valid UTF-8.` } });
  }
}

// Only copy fixed categories into receipts. The native CLI's message/hint may
// include upstream text or identifiers; its exit code 4 combines several causes.
function quotaCause(code, nativeMessage) {
  if ([1008, 2053].includes(code)) return "insufficient_balance_or_credit";
  if (code === 402) return "billing_or_quota_unspecified";
  if (code === 2056) return "plan_window_exhausted";
  if ([1002, 1045].includes(code)) return "rate_limit";
  if ([1028, 1030].includes(code)) return "quota_exhausted";
  if ([2061, 2068].includes(code)) return "model_not_in_plan";
  if (typeof nativeMessage !== "string") return "unspecified";
  if (nativeMessage.startsWith("Quota or balance exhausted.")) return "billing_or_quota_unspecified";
  if (nativeMessage.startsWith("Quota exhausted.")) return "quota_exhausted";
  if (nativeMessage.startsWith("This model is not available on your current ")) return "model_not_in_plan";
  return "unspecified";
}

function apiFailure(exitCode, code, nativeMessage) {
  const result = { status: "api_error", exit_code: exitCode, code };
  if (exitCode === 3 || (exitCode !== 4 && [3, 401, 403].includes(code))) {
    return { ...result, status: "auth_error",
      error: "MMX authentication failed. Run `mmx auth login` locally, then retry." };
  }
  const quota = quotaCause(code, nativeMessage);
  if (exitCode === 4 || code === 429 || quota !== "unspecified") {
    return { ...result, status: "quota_error", quota_cause: quota,
      error: "MMX quota or rate limit blocked the request." };
  }
  if (exitCode === 5 || [408, 504].includes(code)) {
    return { ...result, status: "timeout", error: "The MMX CLI reported a request timeout.",
      note: "Retry with a larger --timeout/--wrap-timeout pair if the prompt is large." };
  }
  if (exitCode === 130) {
    return { ...result, status: "cancelled", error: "The MMX CLI was interrupted." };
  }
  return { ...result, error: "MMX API or CLI failed." };
}

function schemaFailure(exitCode, note) {
  return { status: "schema_mismatch", exit_code: exitCode, note };
}

function classifyReply(out, err, exitCode) {
  if ([3, 5, 130].includes(exitCode)) return apiFailure(exitCode, null);
  const body = parseUpstream(out || err);
  if (exitCode === 4) {
    // CLIError.toJSON() uses its own process exit code as error.code.
    // Preserve the prior public code=null in that case, even with a subtype.
    const number = body?.base_resp?.status_code ?? body?.error?.code;
    const code = Number.isSafeInteger(number) && number !== 4 ? number : null;
    return apiFailure(exitCode, code, body?.error?.message);
  }
  if (body === undefined) {
    return { status: out ? "invalid_json" : "empty_stdout", exit_code: exitCode };
  }
  if (!isObject(body)) return schemaFailure(exitCode, "Expected a JSON response object.");
  if (Object.hasOwn(body, "error")) {
    if (!isObject(body.error) ||
        (Object.hasOwn(body.error, "code") && !Number.isSafeInteger(body.error.code))) {
      return schemaFailure(exitCode, "Invalid error object or error code.");
    }
    return withHttpHint(apiFailure(exitCode, body.error.code ?? null), body);
  }
  if (!out) return { status: "empty_stdout", exit_code: exitCode };
  if (Object.hasOwn(body, "base_resp")) {
    if (!isObject(body.base_resp) || !Number.isSafeInteger(body.base_resp.status_code)) {
      return schemaFailure(exitCode, "Invalid base response status code.");
    }
    if (body.base_resp.status_code !== 0) return apiFailure(exitCode, body.base_resp.status_code);
  }
  if (exitCode !== 0) return apiFailure(exitCode, null);
  if (!validModel(body.model) ||
      !TERMINAL_REASONS.has(body.stop_reason)) {
    return schemaFailure(exitCode, "Missing model or unsupported stop_reason.");
  }
  if (!Array.isArray(body.content) || body.content.some(block => !isObject(block) ||
      !["text", "thinking", "redacted_thinking"].includes(block.type) ||
      (block.type === "text" && typeof block.text !== "string"))) {
    return schemaFailure(exitCode, "Invalid or unsupported response content blocks.");
  }
  const text = body.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  const truncated = body.stop_reason === "max_tokens";
  const responseMetadata = {
    model: body.model, model_identity_source: "response.model",
    stop_reason: body.stop_reason, complete: !truncated, truncated,
    input_tokens: tokenCount(body.usage?.input_tokens), output_tokens: tokenCount(body.usage?.output_tokens),
  };
  const contentBlockTypes = body.content.map(block => block.type);
  if (!text.trim()) {
    // Server-side thinking counts against the output budget. A max_tokens stop
    // with thinking blocks and no answer text is a budget problem, not drift;
    // with any other stop reason the reply is simply malformed.
    if (truncated && contentBlockTypes.some(type => type === "thinking" || type === "redacted_thinking")) {
      return {
        status: "thinking_budget_exhausted", exit_code: exitCode, ...responseMetadata, complete: false,
        content_block_types: contentBlockTypes,
        note: "Server-side thinking consumed the output budget before any answer text. Omit --max-tokens to retry with the profile budget.",
      };
    }
    return {
      ...schemaFailure(exitCode, "No response text."), ...responseMetadata, complete: false,
      content_block_types: contentBlockTypes,
    };
  }
  const result = {
    status: "ok", exit_code: exitCode, text, ...responseMetadata,
  };
  if (requestedModel && result.model !== requestedModel) {
    result.warning = "requested model was not used; compare requested_model and model";
  }
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`mmx-chat ${VERSION}\n`);
    return;
  }
  // --preflight resolves the native entry and reports it without touching the
  // network or spending a request, so a host can check the runtime first. It
  // is only recognised in a flag position; a value that looks like it stays a
  // usage error.
  const options = new Map();
  let preflightOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--preflight") { preflightOnly = true; continue; }
    const flag = token === "-m" ? "--model" : token;
    if (!["--prompt-file", "--system-file", "--model", "--max-tokens", "--profile-file",
          "--timeout", "--wrap-timeout", "--observed-input-file", "--native-request-limit",
          "--cli-entry"].includes(flag)) {
      usageError("Unknown MMX wrapper option.");
    }
    if (i + 1 >= argv.length) usageError(`${flag} requires exactly one value.`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) usageError(`${flag} requires exactly one value.`);
    if (options.has(flag)) usageError(`${flag} requires exactly one value.`);
    options.set(flag, value);
  }
  const promptFile = options.get("--prompt-file");
  if (!preflightOnly && !promptFile) usageError("--prompt-file is required");
  if (options.has("--native-request-limit") && options.get("--native-request-limit") !== "1") {
    usageError("--native-request-limit accepts only 1.");
  }

  const explicitEntry = options.get("--cli-entry") ?? null;
  if (preflightOnly) {
    const report = preflightRequestBudget(process.env, { explicitEntry });
    telemetry.launch_resolution = report.launch_resolution ?? null;
    emit({ status: report.ok ? "preflight_ok" : "preflight_failed", ...report });
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  try { validateInstall(); }
  catch {
    fail({ status: "install_mismatch", error: "MMX managed files failed verification. Run mmx-chat.js --preflight." });
    return;
  }

  const profile = readProfile(options.get("--profile-file") ?? DEFAULT_PROFILE);
  const model = options.get("--model") ?? profile.model;
  if (model !== null && !validModel(model)) {
    fail({ status: "invalid_model", error: "Model id is not a valid identifier." });
    return;
  }
  requestedModel = model;
  const maxTokensArg = options.get("--max-tokens");
  const maxTokens = maxTokensArg === undefined ? profile.max_tokens : Number(maxTokensArg);
  if ((maxTokensArg !== undefined && !/^\d+$/.test(maxTokensArg)) || !positiveInteger(maxTokens)) {
    usageError("--max-tokens must be a positive integer.");
  }
  if (maxTokens > profile.max_tokens || maxTokens > 524288) {
    usageError("Output tokens must fit both the configured profile and the 524288-token native limit.");
  }
  const requestTimeout = timeoutArgument(options.get("--timeout"))
    ?? timeoutOverride("MMX_CHAT_REQ_TIMEOUT", profile.request_timeout_seconds);
  const wrapperTimeout = timeoutArgument(options.get("--wrap-timeout"))
    ?? timeoutOverride("MMX_CHAT_WRAP_TIMEOUT", profile.wrapper_timeout_seconds);
  if (wrapperTimeout <= requestTimeout) {
    usageError("The wrapper timeout must exceed the request timeout.");
  }
  if (requestTimeout > MAX_TIMEOUT_SEC || wrapperTimeout > MAX_TIMEOUT_SEC) {
    usageError(`Effective request and wrapper timeouts must not exceed ${MAX_TIMEOUT_SEC} seconds.`);
  }
  telemetry.request_timeout_seconds = requestTimeout;
  telemetry.wrapper_timeout_seconds = wrapperTimeout;

  const { raw: promptBytes, text: prompt } = readInput(promptFile, "prompt");
  if (!prompt.length) usageError("prompt file is empty");
  const systemFile = options.get("--system-file");
  const system = systemFile ? readInput(systemFile, "system").text : "";
  const policy = resolveBudgetLaunch(process.env, { explicitEntry });
  telemetry.launch_resolution = policy.resolution ?? null;
  if (policy.reason === "cli_missing") {
    fail({ status: "cli_missing", error: "mmx CLI not found on PATH." });
    return;
  }
  telemetry.native_request_budget = { scope: "native_fetch", limit: 1, attempts: 0, blocked: false, verified: false,
    max_output_tokens: maxTokens, output_limit_verified: false };
  if (!policy.ok) {
    fail({ status: "native_budget_unavailable", reason: policy.reason,
      detail: policy.detail ?? null,
      error: "Choose the audited mmx-cli 1.0.29 npm entry: put its npm bin first on PATH, pass --cli-entry <path to dist/mmx.mjs>, or set MMX_CLI_ENTRY." });
    return;
  }
  const { mmx, launch } = policy;
  telemetry.native_request_budget.entry_sha256 = policy.entry_sha256;
  telemetry.native_request_budget.cli_version = policy.cli_version;
  telemetry.fetch_timeout_guard = launch.fetch_timeout_guard;
  telemetry.base_url_env = launch.base_url_env;

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-chat-"));
  const claim = path.join(tempDir, "model-fetch.claim");
  tempFiles.add(claim);
  tempFiles.add(claim + ".blocked");
  launch.env.MMX_CHAT_NATIVE_CLAIM = claim;
  launch.env.MMX_CHAT_NATIVE_MAX_TOKENS = String(maxTokens);
  let guardStatusFile = null;
  if (["preloaded", "proxy_limited"].includes(launch.fetch_timeout_guard)) {
    guardStatusFile = path.join(tempDir, "fetch-guard-status");
    tempFiles.add(guardStatusFile);
    // Remove differently-cased inherited keys on Windows before assigning the
    // private acknowledgement path owned by this invocation.
    delete launch.env[envKey(launch.env, "MMX_CHAT_FETCH_GUARD_STATUS", process.platform)];
    launch.env.MMX_CHAT_FETCH_GUARD_STATUS = guardStatusFile;
  }
  const messages = [];
  if (system.trim()) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const messagesFd = privateFile("messages.json");
  try { fs.writeFileSync(messagesFd, JSON.stringify(messages)); }
  finally { fs.closeSync(messagesFd); }

  const messagesPath = path.join(tempDir, "messages.json");
  const observation = options.get("--observed-input-file");
  if (observation) {
    const delivered = JSON.parse(fs.readFileSync(messagesPath, "utf8"));
    if (system || delivered.length !== 1 || delivered[0].role !== "user" || delivered[0].content !== prompt) {
      usageError("A review observation requires one complete user message.");
    }
    fs.writeFileSync(observation, JSON.stringify({
      side: "mmx", argv, env_keys: Object.keys(process.env).sort(),
      prompt_file_b64: promptBytes.toString("base64"),
      delivery: { method: "messages-file", prompt_sha256: createHash("sha256").update(delivered[0].content).digest("hex") },
    }) + "\n", { mode: 0o600, flag: "wx" });
  }
  const chatArgs = ["text", "chat", "--messages-file", messagesPath];
  if (model !== null) chatArgs.push("--model", model);
  chatArgs.push("--max-tokens", String(maxTokens), "--output", "json", "--non-interactive", "--no-color",
    "--timeout", String(requestTimeout));
  if (mmx.shell && ![mmx.cmd, ...chatArgs].every(safeCmdArgument)) {
    usageError("cmd.exe cannot safely represent the CLI path or arguments.");
  }
  // Opt-in rollout: the global provider slot serializes independent sessions
  // on this host. Until Windows and macOS native deployments are validated,
  // existing installations retain their current parallel behavior.
  const slotEnabled = process.env.MMX_GLOBAL_SLOT === "1";
  const slotAbort = new AbortController();
  let providerSlot = null;
  if (slotEnabled) {
    // The optional extension is not required for legacy managed-install
    // validation fixtures or for hosts that have not enabled provider slots.
    let acquireMmxSlot;
    try { ({ acquireMmxSlot } = require("./mmx-provider-slot.js")); }
    catch {
      fail({ status: "slot_unavailable", code: "MMX_SLOT_MODULE_MISSING",
        error: "MMX global slot module is missing; no upstream request was made." });
      return;
    }
    cancelCurrentRequest = () => slotAbort.abort();
    try {
      providerSlot = await acquireMmxSlot({ signal: slotAbort.signal });
    } catch (error) {
      cancelCurrentRequest = null;
      const status = error.code === "MMX_SLOT_CANCELLED" ? "cancelled" : "slot_unavailable";
      fail({ status, code: error.code || "MMX_SLOT_IO", error: "MMX provider slot unavailable; no upstream request was made." });
      return;
    }
    cancelCurrentRequest = null;
    telemetry.provider_slot = "acquired";
    telemetry.provider_slot_wait_ms = providerSlot.waited_ms;
    if (slotAbort.signal.aborted) {
      releaseProviderSlot(providerSlot);
      fail({ status: "cancelled", code: "MMX_SLOT_CANCELLED" });
      return;
    }
  }
  const requestStarted = Date.now();
  let chat;
  try {
    chat = await runCmd(mmx.cmd, [...launch.argsPrefix, ...chatArgs], wrapperTimeout, mmx.shell, launch.env, Boolean(providerSlot));
  } finally {
    if (providerSlot) {
      // Do not open the slot for a new paid request when descendant cleanup
      // was not confirmed. The unreleased lock is an explicit recovery gate.
      if (!chat || chat.termination_failed) telemetry.provider_slot = "held_for_recovery";
      else releaseProviderSlot(providerSlot, chat.code);
    }
  }
  const elapsedMs = Date.now() - requestStarted;
  const budget = telemetry.native_request_budget;
  try {
    const value = fs.readFileSync(claim, "utf8");
    const allowed = Number(value.trim());
    if (!Number.isSafeInteger(allowed) || allowed < 1 || allowed > maxTokens || value !== String(allowed) + "\n") {
      throw new Error("bad native budget record");
    }
    budget.attempts = 1;
    budget.output_limit_verified = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      budget.attempts = null;
      fail({ status: "native_budget_unverified", exit_code: chat.code, error: "Unreadable native request budget record." });
      return;
    }
  }
  try {
    const blocked = fs.readFileSync(claim + ".blocked", "utf8");
    if (blocked !== "blocked\n") throw new Error("bad native budget record");
    budget.blocked = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      fail({ status: "native_budget_unverified", exit_code: chat.code, error: "Unreadable native budget refusal record." });
      return;
    }
  }
  if (guardStatusFile) {
    let initialized = false;
    try {
      initialized = fs.lstatSync(guardStatusFile).isFile() && fs.readFileSync(guardStatusFile, "utf8") === "applied\n";
    } catch {}
    if (!initialized) {
      telemetry.fetch_timeout_guard = "preload_failed";
      if (chat.kind === "closed") {
        fail({ status: "guard_error", exit_code: chat.code,
          error: "MMX fetch timeout guard initialization could not be confirmed." });
        return;
      }
    } else budget.verified = !chat.termination_failed;
  }
  if (budget.blocked) {
    fail({ status: "native_budget_exceeded", exit_code: chat.code,
      error: "The native model fetch exceeded the authorized request count or output token limit." });
    return;
  }
  if (chat.kind !== "closed") {
    const status = chat.kind === "spawn_error" ? "api_error" : chat.kind;
    fail({
      status, exit_code: chat.code,
      ...(chat.termination_failed ? { termination_warning: "Process-tree termination could not be confirmed." } : {}),
    });
    return;
  }

  let out;
  let err;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    out = decoder.decode(fs.readFileSync(path.join(tempDir, "stdout"))).trim();
    // Upstream writes its structured errors to stderr when stdout is empty.
    err = out ? "" : decoder.decode(fs.readFileSync(path.join(tempDir, "stderr"))).trim();
  } catch (error) {
    fail({ status: error instanceof TypeError ? "invalid_json" : "capture_error", exit_code: chat.code });
    return;
  }
  const result = withFetchLimitHint(classifyReply(out, err, chat.code), elapsedMs);
  if (result.status === "ok" && (!budget.verified || budget.attempts !== 1)) {
    fail({ status: "native_budget_unverified", exit_code: chat.code,
      error: "A successful native model fetch could not be bound to this request budget." });
    return;
  }
  if (result.http_status === 404 && launch.base_url !== null) {
    result.base_url_env_value = displayUrl(launch.base_url);
  }
  if (result.status === "ok") emit(result);
  else fail(result);
}

if (require.main === module) {
  main().catch(error => {
    fail(error.envelope ?? { status: "api_error", exit_code: 1, code: null, error: "MMX wrapper failed locally." });
  }).finally(cleanup);
} else {
  module.exports = { safeCmdArgument, npmShimEntry, mmxPackageEntry, linkedEntry, cliLaunch, preflightRequestBudget, withFetchLimitHint, displayUrl, findMmx, terminateChildTree, resolveLaunch, resolveBudgetLaunch, auditedPackageRoots, auditedPackageCandidate, explicitAuditedEntry, verifyAuditedEntry, launcherTargetsAudited, npmBinCandidates };
}
