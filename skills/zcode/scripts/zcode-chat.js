#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { buildPrompt, validateReview, validateIds, strictJson } = require("./review.js");

const VERSION = "1.2.0";
const SUPPORTED_CLI = "0.17.1";
// The CLI accepts build/edit/plan/yolo/guarded. This wrapper only ever uses the
// two read-only modes: macOS keeps the plan mode it was accepted with, Windows
// keeps the guarded mode it was adapted to. ZCODE_CLI_MODE overrides both.
const CLI_MODES = Object.freeze(["plan", "guarded"]);
const DEFAULT_MODE = Object.freeze({ win32: "guarded" });
const MAX_BYTES = 64 * 1024 * 1024;
const DENIED_TOOLS = Object.freeze([
  "Read", "Write", "Edit", "ApplyPatch", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "js",
  "Agent", "Task", "Skill", "TodoRead", "TodoWrite", "ToolSearch", "LocalToolSearch", "DeferredToolCall",
  "EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "TaskOutput", "TaskStop", "ReadTopicResource",
  "SearchPlugins", "SuggestPluginInstall", "SendMessage", "RespondToCoordinator", "submit_result", "escalate",
  "CronCreate", "CronList", "CronUpdate", "CronDelete", "CronPauseSelf", "OffPeakCreate", "OffPeakList",
  "ListSessions", "ReadSession", "CreateSession", "ForkSession", "SendToSession", "WaitSessions",
  "InterruptSession", "RenameSession", "ListProjects", "OpenSession", "SetSessionArchived", "SetSessionPinned",
  "CreateWorkflow", "AmendWorkflow", "SaveWorkflow", "EvalWorkflowSnippet", "ListWorkflowRuns",
  "GetWorkflowRun", "ResumeWorkflowRun", "ResolveWorkflowQuestion", "FillWorkflowHole", "ListSavedWorkflows", "ListModels", "GoalRead", "Workflow", "ReplyToChannel",
]);
const RUNTIME_CONFIG = Object.freeze({
  features: { mcp: false, subagent: false, memory: false, skill: false, compact: false, rewind: false },
  memory: { use: false }, plugins: { enabled: false }, skills: { enabled: false, includeInstructions: false },
  hooks: { enabled: false }, modelStream: { idleTimeoutMs: 600000 },
});

function fail(status) { throw Object.assign(new Error(status), { status }); }
function privateWrite(file, contents) { fs.writeFileSync(file, contents, { mode: 0o600, flag: "wx" }); }
function atomicJson(file, value) {
  const temporary = file + ".writing";
  privateWrite(temporary, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temporary, file);
}
function readUtf8(file) {
  const bytes = fs.readFileSync(file);
  if (!bytes.length || bytes.includes(0)) fail("input_error");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
// Hash the file with CRLF normalized to LF. Repositories checked out on Windows
// carry CRLF line endings while the same file checked out on macOS carries LF;
// hashing raw bytes would make one platform's release manifest fail the other
// platform's install check. Normalizing keeps a single manifest valid on both.
function hashFile(file) {
  const content = fs.readFileSync(file).toString("utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function checkInstall() {
  const root = fs.realpathSync(path.join(__dirname, ".."));
  const marker = path.join(root, ".zcode-release.json");
  if (!fs.existsSync(marker)) return;
  if (fs.lstatSync(marker).isSymbolicLink()) fail("install_mismatch");
  const manifest = strictJson(fs.readFileSync(marker, "utf8"));
  const required = ["SKILL.md", "scripts/zcode-chat.js", "scripts/zcode-run.js", "scripts/review.js", "references/review-v1.schema.json"];
  if (manifest.format !== 1 || !manifest.files || !required.every(name => Object.hasOwn(manifest.files, name))) fail("install_mismatch");
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const parts = relative.split("/");
    if (parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) fail("install_mismatch");
    let file = root;
    for (const part of parts) { file = path.join(file, part); if (fs.lstatSync(file).isSymbolicLink()) fail("install_mismatch"); }
    if (hashFile(file) !== digest) fail("install_mismatch");
  }
}

function findCli(explicit, env = process.env) {
  if (explicit) return fs.realpathSync(explicit);
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of process.platform === "win32" ? ["zcode.exe", "zcode.cmd", "zcode"] : ["zcode"]) {
      const file = path.resolve(directory, name);
      try {
        // A directory on PATH is not a launcher. On Windows an application
        // install directory can share the CLI's name, and accessSync would
        // accept it because a directory is also "executable".
        if (!fs.statSync(file).isFile()) continue;
        fs.accessSync(file, fs.constants.X_OK);
        return fs.realpathSync(file);
      } catch {}
    }
  }
  fail("cli_missing");
}

function resolveLaunch(cli, originalHome = os.homedir()) {
  if (/\.(cjs|mjs|js)$/i.test(cli)) return { command: process.execPath, prefix: [cli], entry: cli };
  // Windows npm shim (.cmd/.bat): read the batch text and resolve the JS
  // entry it launches. The batch file itself is never handed to a shell.
  if (/\.(cmd|bat)$/i.test(cli)) {
    const entry = resolveWindowsShim(cli);
    return { command: process.execPath, prefix: [entry], entry };
  }
  const fd = fs.openSync(cli, "r");
  const header = Buffer.alloc(4096);
  const length = fs.readSync(fd, header, 0, header.length, 0);
  fs.closeSync(fd);
  const text = header.subarray(0, length).toString("utf8");
  if (!text.startsWith("#!")) return { command: cli, prefix: [], entry: cli };
  if (/^#![^\n]*\bnode(?:\s|$)/.test(text)) return { command: process.execPath, prefix: [cli], entry: cli };
  // 本机 mise launcher 依赖 HOME；在隔离 HOME 前解析实际 bundle，不执行任意 shell。
  const match = text.match(/^#!\/bin\/sh\r?\nexec mise exec node@[0-9.]+ -- node "\$HOME\/([^"\r\n]+\/zcode\.cjs)" "\$@"\s*$/);
  if (match && length !== header.length) {
    const entry = fs.realpathSync(path.resolve(originalHome, match[1]));
    return { command: process.execPath, prefix: [entry], entry };
  }
  // POSIX-style npm shim: a shell script that ends up running a JS file.
  const shim = text.match(/node_modules[\\/]([^"\r\n]+?)[\\/]bin[\\/]([^"\r\n]+?\.js)/);
  if (shim) {
    const entry = resolveShimEntry(path.dirname(cli), shim[1], shim[2]);
    return { command: process.execPath, prefix: [entry], entry };
  }
  fail("unsupported_launcher");
}

// Resolve the JS entry a Windows npm shim launches. Only the documented npm
// shim shape is accepted; anything else stays unsupported rather than being
// handed to a shell.
function resolveWindowsShim(cli) {
  let text;
  try { text = fs.readFileSync(cli, "utf8"); }
  catch { fail("unsupported_launcher"); }
  const match = text.match(/node_modules[\\/]([^"\r\n]+?)[\\/]bin[\\/]([^"\r\n]+?\.js)/);
  if (!match) fail("unsupported_launcher");
  return resolveShimEntry(path.dirname(cli), match[1], match[2]);
}

// An npm global install keeps the shim and node_modules side by side, so the
// package root is the shim's own directory.
function resolveShimEntry(directory, packageName, scriptName) {
  let entry;
  try { entry = fs.realpathSync(path.resolve(directory, "node_modules", packageName, "bin", scriptName)); }
  catch { fail("unsupported_launcher"); }
  if (!fs.statSync(entry).isFile()) fail("unsupported_launcher");
  return entry;
}

function isolatedEnv(home, env = process.env) {
  const childEnv = {};
  const allowed = /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE|TERM|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  for (const [key, value] of Object.entries(env)) if (allowed.test(key)) childEnv[key] = value;
  // Only the provider/credential data root is shared; no credential contents are copied or logged.
  const dataBase = env.ZCODE_DATA_BASE_DIR || os.homedir();
  return {
    ...childEnv, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    ZCODE_DATA_BASE_DIR: dataBase,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || path.join(dataBase, ".zcode/v2/provider_config.json"),
    ZCODE_STORAGE_DIR: path.join(home, ".zcode/cli"), ZCODE_LOG_DIR: path.join(home, "logs"),
    ZCODE_SESSION_DB_PATH: path.join(home, "sessions.db"),
    ...Object.fromEntries(["ZCODE_HTTP_PROXY", "ZCODE_NO_PROXY", "ZCODE_AGENT_CA_CERT"].filter(key => env[key]).map(key => [key, env[key]])),
  };
}

function setupMacKeychain(home, platform = process.platform, run = spawnSync) {
  if (platform !== "darwin") return null;
  // Security.framework follows the child's HOME to find its default login keychain.
  // Link the already authorized default store; never copy it or change OS defaults.
  const result = run("/usr/bin/security", ["default-keychain", "-d", "user"], {
    encoding: "utf8", timeout: 10000, maxBuffer: 8192, shell: false,
  });
  if (result.status !== 0) fail("auth_environment_error");
  let keychain;
  try {
    keychain = JSON.parse(result.stdout.trim());
    if (typeof keychain !== "string" || !path.isAbsolute(keychain)) fail("auth_environment_error");
    keychain = fs.realpathSync(keychain);
    if (!fs.statSync(keychain).isFile()) fail("auth_environment_error");
    fs.accessSync(keychain, fs.constants.R_OK);
    const directory = path.join(home, "Library", "Keychains");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.symlinkSync(keychain, path.join(directory, "login.keychain-db"));
  } catch { fail("auth_environment_error"); }
  return "existing-default-keychain-link";
}

class EventParser {
  constructor() { this.events = []; this.result = null; this.completeTurn = null; this.models = []; this.reasons = []; this.requests = 0; }
  accept(line) {
    if (!line.trim()) return;
    const event = strictJson(line);
    if (!event || typeof event.type !== "string" || this.result) fail("schema_mismatch");
    const payload = event.payload || {};
    if (event.type === "tool.updated" || event.type.startsWith("permission.") || event.type.startsWith("workflow.")) fail("policy_violation");
    if (event.type === "turn.failed") {
      const code = payload.error?.code ?? payload.code;
      fail([401, 403].includes(code) ? "auth_error" : code === 429 ? "quota_error" : "cli_error");
    }
    // ModelRequest and ModelNetworkStatus share session.updated and model IDs.
    // Only ModelRequest carries messageCount/iteration; network events have no toolCount.
    if (event.type === "session.updated" && Object.hasOwn(payload, "messageCount") && Object.hasOwn(payload, "iteration")) {
      if (typeof payload.modelId !== "string" || typeof payload.providerId !== "string" || !payload.modelId.trim() || !payload.providerId.trim()) fail("schema_mismatch");
      if (payload.toolCount !== 0) fail("policy_violation");
      this.requests++;
      this.models.push({ provider: payload.providerId, model: payload.modelId });
    }
    if (event.type === "session.updated" && payload.querySource === "main_turn" && typeof payload.stopReason === "string") {
      if (payload.toolCallCount !== 0) fail("policy_violation");
      this.reasons.push(payload.stopReason);
    }
    if (event.type === "turn.completed") {
      if (this.completeTurn) fail("schema_mismatch");
      if (payload.toolCallCount !== 0) fail("policy_violation");
      if (payload.resultType !== "success") fail("schema_mismatch");
      this.completeTurn = event;
    }
    if (event.type === "result") this.result = event;
    else this.events.push({ sessionId: event.sessionId, turnId: event.turnId });
  }
  finish() {
    const result = this.result;
    if (!result || !this.completeTurn || !this.requests || !result.sessionId || !result.turnId || !result.traceId ||
        typeof result.response !== "string" || !result.response.trim() || result.projection?.status !== "idle" ||
        (result.usage != null && (typeof result.usage !== "object" || Array.isArray(result.usage))) ||
        this.completeTurn.turnId !== result.turnId || this.completeTurn.payload.response !== result.response ||
        this.events.some(event => event.sessionId !== result.sessionId || (event.turnId && event.turnId !== result.turnId))) fail("schema_mismatch");
    const models = [...new Set(this.models.map(model => JSON.stringify(model)))].map(model => JSON.parse(model));
    if (models.length !== 1 || !this.reasons.length) fail("schema_mismatch");
    const stop = this.reasons.at(-1);
    const truncated = this.reasons.some(reason => ["length", "max_tokens"].includes(reason));
    if (!["stop", "end_turn", "stop_sequence", "length", "max_tokens"].includes(stop)) fail("schema_mismatch");
    return {
      text: result.response, provider: models[0].provider, model: models[0].model,
      model_identity_source: "runtime.model_request", stop_reason: stop, truncated, complete: !truncated,
      session_id: result.sessionId, trace_id: result.traceId, turn_id: result.turnId, usage: result.usage ?? null,
      tool_requests: 0, tool_calls: 0,
    };
  }
}

async function terminateTree(child) {
  if (!child.pid) return true;
  if (process.platform === "win32") {
    // A process that already exited cannot be killed and taskkill reports it as
    // not found. Probe first so a normally finished request is recorded as
    // confirmed cleanup rather than an unresolved cleanup gap.
    try { process.kill(child.pid, 0); } catch (error) { if (error.code === "ESRCH") return true; }
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status === 0) return true;
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (/could not be found|not found/i.test(output)) return true;
    return null;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { return error.code === "ESRCH"; }
  await new Promise(resolve => setTimeout(resolve, 200));
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") return false; }
  await new Promise(resolve => setTimeout(resolve, 50));
  try { process.kill(-child.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
}

// Resolve the CLI permission mode. ZCODE_CLI_MODE wins when set and must name
// a mode the CLI supports; otherwise the platform default applies, so the same
// wrapper keeps the mode each platform was accepted with.
function resolveMode(env = process.env, platform = process.platform) {
  const override = env.ZCODE_CLI_MODE;
  if (override !== undefined && override !== "") {
    if (!CLI_MODES.includes(override)) fail("usage_error");
    return override;
  }
  return DEFAULT_MODE[platform] || "plan";
}

function parseArgs(argv) {
  const args = { mode: "chat", timeout: 600 };
  const names = { "--prompt-file": "prompt", "--mode": "mode", "--evidence-ids-file": "ids", "--cli-path": "cli", "--output-dir": "output", "--timeout-seconds": "timeout" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (!key || seen.has(key) || !argv[i + 1]) fail("usage_error");
    seen.add(key); args[key] = argv[++i];
  }
  args.timeout = Number(args.timeout);
  if (!args.prompt || !["chat", "review", "challenge"].includes(args.mode) || !(args.timeout > 0 && args.timeout <= 21600) ||
      (args.mode !== "chat" && !args.ids) || (args.mode === "chat" && args.ids)) fail("usage_error");
  return args;
}

async function main(argv, deps = {}) {
  if (argv.length === 1 && argv[0] === "--version") return { status: "version", version: VERSION };
  if (!argv.length || (argv.length === 1 && argv[0] === "--help")) return { status: "usage", usage: "node zcode-chat.js --prompt-file FILE [--mode chat|review|challenge --evidence-ids-file FILE] [--output-dir NEW_DIR] [--timeout-seconds 600] [--cli-path EXECUTABLE]" };
  const receipt = { status: "input_error", cli_invoked: false, exit_code: null, signal: null, complete: false, model: null, stop_reason: null, truncated: null, usage: null, review_gate: "NOT_EVALUATED" };
  let child;
  let directory;
  try {
    try { checkInstall(); } catch { fail("install_mismatch"); }
    const args = parseArgs(argv);
    const material = readUtf8(args.prompt);
    const ids = args.ids ? validateIds(strictJson(readUtf8(args.ids))) : null;
    const prompt = buildPrompt(material, args.mode, ids);
    const cli = findCli(args.cli);
    const launch = resolveLaunch(cli);
    const mode = (deps.resolveMode || resolveMode)();
    const version = spawnSync(launch.command, [...launch.prefix, "--version"], { encoding: "utf8", timeout: 10000, maxBuffer: 4096, shell: false });
    receipt.cli_version = version.stdout?.trim().replace(/^zcode\s+/, "") || null;
    // zcode-app-cli 3.x prints two lines ("zcode-app-cli <n>\nzcode-runtime <n>");
    // the supported contract is the runtime version, which may be on the second line.
    const runtimeVersion = typeof receipt.cli_version === "string" ? receipt.cli_version.match(/(?:^|\n)zcode-runtime\s+(\S+)/)?.[1] : null;
    if (runtimeVersion) receipt.cli_version = runtimeVersion;
    if (version.status !== 0 || receipt.cli_version !== SUPPORTED_CLI) fail("unsupported_cli");
    if (args.output) {
      const candidate = path.resolve(args.output);
      fs.mkdirSync(candidate, { mode: 0o700 });
      directory = candidate;
    } else directory = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-text-"));
    fs.chmodSync(directory, 0o700);
    receipt.artifacts_dir = directory;
    const progress = phase => atomicJson(path.join(directory, "progress.json"), {
      phase, wrapper_pid: process.pid, cli_pid: child?.pid ?? null,
      updated_at: new Date().toISOString(), model: receipt.model,
      status: "running", complete: false,
    });
    progress("preparing");
    const home = path.join(directory, "home");
    const work = path.join(directory, "work");
    fs.mkdirSync(path.join(home, ".zcode/cli"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(work, { mode: 0o700 });
    privateWrite(path.join(home, ".zcode/cli/config.json"), JSON.stringify(RUNTIME_CONFIG));
    receipt.auth_environment = (deps.setupMacKeychain || setupMacKeychain)(home);
    privateWrite(path.join(directory, "prompt.txt"), prompt);
    privateWrite(path.join(directory, "launch.json"), JSON.stringify({ wrapper_version: VERSION, cli_version: receipt.cli_version, launcher: cli, entry: launch.entry, entry_sha256: hashFile(launch.entry), runtime: launch.command, mode, denied_tools: DENIED_TOOLS, timeout_seconds: args.timeout, shared_auth_data: true }, null, 2));
    const stdoutFd = fs.openSync(path.join(directory, "stdout.ndjson"), "wx", 0o600);
    const stderrFd = fs.openSync(path.join(directory, "stderr.log"), "wx", 0o600);
    const parser = new EventParser();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "", bytes = 0, problem = null, termination;
    const cliArgs = [...launch.prefix, "--prompt", prompt, "--cwd", work, "--mode", mode, "--output-format", "stream-json", "--workflow-mode", "disabled", "--toolsearch-mode", "off", "--disallowed-tools", DENIED_TOOLS.join(","), "--no-color"];
    child = spawn(launch.command, cliArgs, { cwd: work, env: isolatedEnv(home), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    receipt.cli_invoked = Boolean(child.pid);
    progress("running");
    const stop = status => { if (!problem) { problem = status; termination = terminateTree(child); } };
    const timeout = setTimeout(() => stop("timeout"), args.timeout * 1000);
    const onSignal = () => stop("cancelled");
    process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    child.stdout.on("data", data => {
      try {
        fs.writeSync(stdoutFd, data); bytes += data.length;
        if (bytes > MAX_BYTES) { stop("output_limit"); return; }
        if (problem) return;
        pending += decoder.decode(data, { stream: true });
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) { parser.accept(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
        if (!receipt.model && parser.models.length) {
          Object.assign(receipt, parser.models[0], { model_identity_source: "runtime.model_request" });
          progress("streaming");
        }
      } catch (error) { stop(error.status || (/^E[A-Z]+$/.test(error.code || "") ? "io_error" : "schema_mismatch")); }
    });
    child.stderr.on("data", data => {
      try { fs.writeSync(stderrFd, data); bytes += data.length; if (bytes > MAX_BYTES) stop("output_limit"); }
      catch { stop("io_error"); }
    });
    const result = await new Promise(resolve => {
      child.once("error", () => { stop("cli_error"); });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timeout);
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
    fs.closeSync(stdoutFd); fs.closeSync(stderrFd);
    receipt.exit_code = result.code; receipt.signal = result.signal;
    receipt.cleanup_confirmed = await (termination || terminateTree(child));
    const identities = [...new Set(parser.models.map(model => JSON.stringify(model)))];
    if (identities.length === 1) Object.assign(receipt, JSON.parse(identities[0]), { model_identity_source: "runtime.model_request" });
    else { receipt.model = null; receipt.model_identity_source = null; }
    if (typeof parser.result?.response === "string") receipt.text = parser.result.response;
    if (parser.reasons.length) {
      receipt.stop_reason = parser.reasons.at(-1);
      receipt.truncated = parser.reasons.some(reason => ["length", "max_tokens"].includes(reason));
    }
    if (problem) fail(problem);
    if (result.code !== 0 || result.signal) fail("cli_error");
    pending += decoder.decode();
    if (pending.trim()) parser.accept(pending);
    Object.assign(receipt, parser.finish());
    if (receipt.cleanup_confirmed === false) fail("cleanup_error");
    if (!receipt.complete) fail("incomplete");
    if (args.mode !== "chat") {
      try { Object.assign(receipt, validateReview(receipt.text, ids)); }
      catch { fail("review_schema_mismatch"); }
    }
    receipt.status = "ok";
  } catch (error) {
    receipt.status = error.status || (error.code === "ENOENT" ? "file_missing" : "input_error");
    receipt.complete = false;
    receipt.review_gate = "NOT_EVALUATED";
    if (child?.pid && child.exitCode === null && child.signalCode === null) receipt.cleanup_confirmed = await terminateTree(child);
  }
  if (directory) {
    try {
      atomicJson(path.join(directory, "progress.json"), { phase: "finished", wrapper_pid: process.pid, cli_pid: child?.pid ?? null, updated_at: new Date().toISOString(), status: receipt.status, complete: receipt.complete });
      atomicJson(path.join(directory, "receipt.json"), receipt);
    }
    catch { receipt.status = "io_error"; receipt.complete = false; receipt.review_gate = "NOT_EVALUATED"; }
  }
  return receipt;
}

if (require.main === module) main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = ["ok", "usage", "version"].includes(result.status) ? 0 : 1;
}).catch(() => { process.stdout.write('{"status":"internal_error","complete":false}\n'); process.exitCode = 1; });

module.exports = { EventParser, resolveLaunch, isolatedEnv, setupMacKeychain, DENIED_TOOLS, RUNTIME_CONFIG, CLI_MODES, checkInstall, parseArgs, resolveMode, main };
