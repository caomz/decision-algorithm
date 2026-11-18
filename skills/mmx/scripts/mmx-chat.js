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

const VERSION = "2.4.0";
const DEFAULT_PROFILE = path.join(__dirname, "..", "profiles", "local.json");
const LEGACY_MANAGED_ROOT = "/Volumes/WorkSSD/.claude/skills/mmx";
const RELEASE_MARKER = ".gstack-cross-validation-release.json";
const MANAGED_SIBLINGS = ["agy", "cross-validation"];
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TERMINAL_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"]);
const MAX_TIMEOUT_SEC = 3600; // ceiling for the per-call timeout flags
const MAX_TIMER_SEC = 2147483; // Node timer range for profile and environment values
let requestedModel = null;
let cliInvoked = false;

// ---------------------------------------------------------------------------
// Chat result emission — exactly ONE JSON object on stdout.
// ---------------------------------------------------------------------------

let finalEmitted = false;
function emit(result) {
  if (finalEmitted) return;
  finalEmitted = true;
  process.stdout.write(JSON.stringify({ requested_model: requestedModel, cli_invoked: cliInvoked, ...result }) + "\n");
}

function fail(result) {
  emit(result);
  process.exitCode = 1;
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

function validateInstall() {
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
  for (const required of ["mmx/scripts/mmx-chat.js", "mmx/profiles/local.json",
                          "cross-validation/scripts/cross_validate.py"]) {
    if (!Object.hasOwn(release.files, required)) throw new Error("release manifest is incomplete");
  }
  for (const [relative, expected] of Object.entries(release.files)) {
    const parts = relative.split("/");
    if (!["agy", "mmx", "cross-validation"].includes(parts[0]) || parts.length < 2 ||
        parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..") ||
        typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("release path or digest is invalid");
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
function runCmd(cmd, args, timeoutSecs, useShell) {
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

    function finish(kind) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(grace);
      clearTimeout(deadline);
      cancelCurrentRequest = null;
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      resolve({ kind, code: forcedExitCode ?? childCode, termination_failed: terminationFailed });
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
        if (closed) finish(stopReason);
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
        detached: grouped, windowsHide: true,
      });
    } catch { finish("spawn_error"); return; }
    cancelCurrentRequest = code => stop("cancelled", code);
    child.stdout.on("data", bytes => capture(stdoutFd, bytes));
    child.stderr.on("data", bytes => capture(stderrFd, bytes));
    child.on("spawn", () => { cliInvoked = true; });
    child.on("error", () => finish(stopReason || "spawn_error"));
    child.on("close", code => {
      closed = true;
      childCode = code;
      if (!stopReason || escalated) finish(stopReason || "closed");
    });
    timeout = setTimeout(() => stop("timeout", 124), timeoutSecs * 1000);
  });
}

// ---------------------------------------------------------------------------
// findMmx scans PATH using the delimiter and extension policy of the running
// Node platform. Standard npm shims resolve to their package JS entry; other
// batch files use the guarded shell path.
// ---------------------------------------------------------------------------

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

// cmd.exe expands % and ! inside quotes; other metacharacters affect parsing.
function safeCmdArgument(s) {
  return typeof s === "string" && s.length > 0 &&
    !/["%!?^&|<>()\r\n\x00]/.test(s);
}

function findMmx(platform = process.platform, envPath = process.env.PATH || "", fsApi = fs,
                 shimResolver = npmShimEntry, nodePath = process.execPath) {
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
        const entry = batch ? shimResolver(p) : null;
        if (entry) return { cmd: nodePath, argsPrefix: [entry], shell: false };
        if (batch && !safeCmdArgument(p)) return { unsafe: true };
        return { cmd: p, argsPrefix: [], shell: batch };
      } catch {}
    }
  }
  return null;
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
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch {
    throw Object.assign(new Error(), { envelope: { status: "unsupported_encoding", error: `${label} must be valid UTF-8.` } });
  }
}

function apiFailure(exitCode, code) {
  const result = { status: "api_error", exit_code: exitCode, code };
  if (exitCode === 3 || [3, 401, 403].includes(code)) {
    return { ...result, status: "auth_error",
      error: "MMX authentication failed. Run `mmx auth login` locally, then retry." };
  }
  if (exitCode === 4 || [429, 1028, 1030].includes(code)) {
    return { ...result, status: "quota_error", error: "MMX quota or rate limit blocked the request." };
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
  if ([3, 4, 5, 130].includes(exitCode)) return apiFailure(exitCode, null);
  const body = parseUpstream(out || err);
  if (body === undefined) {
    return { status: out ? "invalid_json" : "empty_stdout", exit_code: exitCode };
  }
  if (!isObject(body)) return schemaFailure(exitCode, "Expected a JSON response object.");
  if (Object.hasOwn(body, "error")) {
    if (!isObject(body.error) ||
        (Object.hasOwn(body.error, "code") && !Number.isSafeInteger(body.error.code))) {
      return schemaFailure(exitCode, "Invalid error object or error code.");
    }
    return apiFailure(exitCode, body.error.code ?? null);
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
  if (!text.trim()) {
    // The server thinks by default and the thinking blocks are not text. A
    // reply made only of thinking means the output budget was consumed
    // before any answer was written, not that the contract drifted.
    const thinking = body.content.some(block => block.type === "thinking" || block.type === "redacted_thinking");
    if (thinking) {
      return { status: "thinking_budget_exhausted", exit_code: exitCode,
        note: "the model produced only thinking blocks and no text: the output budget was fully consumed by server-side thinking. Re-run with a larger --max-tokens." };
    }
    return schemaFailure(exitCode, "No response text.");
  }
  const truncated = body.stop_reason === "max_tokens";
  const result = {
    status: "ok", exit_code: exitCode, text, model: body.model, model_identity_source: "response.model",
    stop_reason: body.stop_reason, complete: !truncated, truncated,
    input_tokens: tokenCount(body.usage?.input_tokens), output_tokens: tokenCount(body.usage?.output_tokens),
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
  const options = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] === "-m" ? "--model" : argv[i];
    if (!["--prompt-file", "--system-file", "--model", "--max-tokens", "--profile-file",
          "--timeout", "--wrap-timeout"].includes(flag)) {
      usageError("Unknown MMX wrapper option.");
    }
    if (i + 1 >= argv.length || !argv[i + 1] || argv[i + 1].startsWith("--") || options.has(flag)) {
      usageError(`${flag} requires exactly one value.`);
    }
    options.set(flag, argv[i + 1]);
  }
  const promptFile = options.get("--prompt-file");
  if (!promptFile) usageError("--prompt-file is required");

  try { validateInstall(); }
  catch {
    fail({ status: "install_mismatch", error: "MMX managed release is missing, inactive, or inconsistent. Run cross-validation doctor." });
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
  const requestTimeout = timeoutArgument(options.get("--timeout"))
    ?? timeoutOverride("MMX_CHAT_REQ_TIMEOUT", profile.request_timeout_seconds);
  const wrapperTimeout = timeoutArgument(options.get("--wrap-timeout"))
    ?? timeoutOverride("MMX_CHAT_WRAP_TIMEOUT", profile.wrapper_timeout_seconds);
  if (wrapperTimeout <= requestTimeout) {
    usageError("The wrapper timeout must exceed the request timeout.");
  }
  if (requestTimeout > MAX_TIMER_SEC || wrapperTimeout > MAX_TIMER_SEC) {
    usageError("Timeouts must fit the Node timer range.");
  }

  const prompt = readInput(promptFile, "prompt");
  if (!prompt.length) usageError("prompt file is empty");
  const systemFile = options.get("--system-file");
  const system = systemFile ? readInput(systemFile, "system") : "";
  const mmx = findMmx();
  if (!mmx) {
    fail({ status: "cli_missing", error: "mmx CLI not found on PATH." });
    return;
  }
  if (mmx.unsafe) usageError("Unsafe cmd.exe batch path. Use a resolvable npm shim.");

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-chat-"));
  const messages = [];
  if (system.trim()) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const messagesFd = privateFile("messages.json");
  try { fs.writeFileSync(messagesFd, JSON.stringify(messages)); }
  finally { fs.closeSync(messagesFd); }

  const chatArgs = ["text", "chat", "--messages-file", path.join(tempDir, "messages.json")];
  if (model !== null) chatArgs.push("--model", model);
  chatArgs.push("--max-tokens", String(maxTokens), "--output", "json", "--non-interactive", "--no-color",
    "--timeout", String(requestTimeout));
  if (mmx.shell && ![mmx.cmd, ...chatArgs].every(safeCmdArgument)) {
    usageError("cmd.exe cannot safely represent the CLI path or arguments.");
  }
  const chat = await runCmd(mmx.cmd, [...mmx.argsPrefix, ...chatArgs], wrapperTimeout, mmx.shell);
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
  const result = classifyReply(out, err, chat.code);
  if (result.status === "ok") emit(result);
  else fail(result);
}

if (require.main === module) {
  main().catch(error => {
    fail(error.envelope ?? { status: "api_error", exit_code: 1, code: null, error: "MMX wrapper failed locally." });
  }).finally(cleanup);
} else {
  module.exports = { safeCmdArgument, npmShimEntry, findMmx, terminateChildTree };
}
