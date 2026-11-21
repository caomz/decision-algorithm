"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { safeCmdArgument, npmShimEntry, mmxPackageEntry, linkedEntry, cliLaunch, withFetchLimitHint, findMmx, terminateChildTree } = require(path.join(__dirname, "..", "scripts", "mmx-chat.js"));

const skillRoot = path.resolve(__dirname, "..");
const wrapper = path.join(skillRoot, "scripts", "mmx-chat.js");
const profile = path.join(skillRoot, "profiles", "local.json");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-contract-"));
const binDir = path.join(root, "bin");
const wrapperTmp = path.join(root, "wrapper-tmp");
const promptPath = path.join(root, "prompt.txt");
const systemPath = path.join(root, "system.txt");
const argsDumpPath = path.join(root, "args.json");
const invocationLog = path.join(root, "invocations.txt");
const overrideProfilePath = path.join(root, "profile.json");
const messagesDumpPath = path.join(root, "messages.json");
const childPidPath = path.join(root, "child.pid");
const fakeJsPath = path.join(root, "fake-mmx.cjs");
// Never created: keeps the wrapper away from the real ~/.mmx/config.json.
const absentConfigDir = path.join(root, "mmx-config-absent");
const fakeMmxPath = path.join(binDir, process.platform === "win32" ? "mmx.cmd" : "mmx");

fs.mkdirSync(binDir);
fs.mkdirSync(wrapperTmp);

fs.writeFileSync(fakeJsPath, `
"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (process.env.FAKE_INVOCATIONS) fs.appendFileSync(process.env.FAKE_INVOCATIONS, args.slice(0, 2).join(" ") + "\\n");
if (process.env.FAKE_ARGS_DUMP) fs.writeFileSync(process.env.FAKE_ARGS_DUMP, JSON.stringify(args));
if (process.env.FAKE_ENV_DUMP) fs.writeFileSync(process.env.FAKE_ENV_DUMP, JSON.stringify({
  argv: args,
  minimax_base_url: process.env.MINIMAX_BASE_URL ?? null,
  undici_path: process.env.MMX_CHAT_UNDICI_PATH || null,
  https_proxy_set: Boolean(process.env.HTTPS_PROXY),
  guard: globalThis.__fakeGuard ?? null,
}));
const messageIndex = args.indexOf("--messages-file");
if (messageIndex >= 0 && process.env.FAKE_MESSAGES_DUMP) {
  fs.writeFileSync(process.env.FAKE_MESSAGES_DUMP, fs.readFileSync(args[messageIndex + 1]));
}
const ok = {
  content: [{ type: "text", text: process.env.FAKE_TEXT || "MMX_OK" }],
  model: process.env.FAKE_MODEL || "MiniMax-M3",
  stop_reason: process.env.FAKE_STOP || "end_turn",
  usage: { input_tokens: 12, output_tokens: 3 },
  base_resp: { status_code: 0, status_msg: "" }
};
switch (process.env.FAKE_MODE || "success") {
  case "success": process.stdout.write(JSON.stringify(ok)); break;
  case "prefix": process.stdout.write("Detecting region...\\n" + JSON.stringify(ok)); break;
  case "truncated": ok.stop_reason = "max_tokens"; process.stdout.write(JSON.stringify(ok)); break;
  case "auth": process.stderr.write(JSON.stringify({ error: { code: 3, message: "No credentials" } })); process.exitCode = 3; break;
  case "api_stdout": process.stdout.write(JSON.stringify({ error: { code: 500, message: "upstream failed", hint: "retry" } })); process.exitCode = 1; break;
  // Verbatim mmx-cli 1.0.29 stderr for a real HTTP 404 (captured 2026-11-19).
  case "http_404": process.stderr.write(JSON.stringify({ error: { code: 1, message: "API error: HTTP 404 (HTTP 404)" } })); process.exitCode = 1; break;
  case "network": process.stderr.write(JSON.stringify({ error: { code: 6, message: "Network request failed." } })); process.exitCode = 6; break;
  case "api_stderr": process.stderr.write(JSON.stringify({ error: { code: 500, message: "Bearer synthetic-authorization-value and private prompt", hint: "sk-synthetic-secret" } })); process.exitCode = 1; break;
  case "quota": process.exitCode = 4; break;
  case "quota_api": process.stderr.write(JSON.stringify({ error: { code: 429 } })); process.exitCode = 1; break;
  case "base_error": process.stdout.write(JSON.stringify({ base_resp: { status_code: 1001, status_msg: "bad request" } })); process.exitCode = 1; break;
  case "schema": process.stdout.write(JSON.stringify({ content: [], model: "MiniMax-M3" })); break;
  case "missing_usage": delete ok.usage; process.stdout.write(JSON.stringify(ok)); break;
  case "missing_model": delete ok.model; process.stdout.write(JSON.stringify(ok)); break;
  case "missing_stop": delete ok.stop_reason; process.stdout.write(JSON.stringify(ok)); break;
  case "invalid": process.stdout.write("not-json"); process.exitCode = 1; break;
  case "empty": process.stderr.write("no output"); process.exitCode = 1; break;
  case "nonzero_success": process.stdout.write(JSON.stringify(ok)); process.exitCode = 2; break;
  case "large": {
    ok.content[0].text = "中".repeat(420000);
    process.stderr.write("x".repeat(1200000));
    process.stdout.write(JSON.stringify(ok));
    break;
  }
  case "string_status": ok.base_resp.status_code = "500"; process.stdout.write(JSON.stringify(ok)); break;
  case "string_error": process.stdout.write(JSON.stringify({ error: { code: "429" } })); break;
  case "array_response": process.stdout.write(JSON.stringify([ok])); break;
  case "tool_block": ok.content.push({type: "tool_use", id: "fake"}); process.stdout.write(JSON.stringify(ok)); break;
  case "thinking_only": ok.content = [{type: "thinking", thinking: "internal"}]; process.stdout.write(JSON.stringify(ok)); break;
  case "thinking_only_truncated": ok.content = [{type: "thinking", thinking: "internal"}]; ok.stop_reason = "max_tokens"; process.stdout.write(JSON.stringify(ok)); break;
  case "split_utf8": {
    const data = Buffer.from(JSON.stringify(ok));
    const at = data.indexOf(Buffer.from("中")) + 1;
    process.stdout.write(data.subarray(0, at), () => process.stdout.write(data.subarray(at)));
    break;
  }
  case "unexpected_file": {
    fs.writeFileSync(require("node:path").join(require("node:path").dirname(args[messageIndex + 1]), "unexpected-marker.txt"), "leave me");
    process.stdout.write(JSON.stringify(ok)); break;
  }
  case "hang": setInterval(() => {}, 1000); break;
  case "tree_hang": {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(process.env.FAKE_CHILD_PID, String(child.pid));
    setInterval(() => {}, 1000);
    break;
  }
  case "orphan_child": {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(process.env.FAKE_CHILD_PID, String(child.pid));
    child.unref();
    process.stdout.write(JSON.stringify(ok));
    break;
  }
  default: process.stderr.write("unknown fake mode"); process.exitCode = 2;
}
`, "utf8");

if (process.platform === "win32") {
  fs.writeFileSync(fakeMmxPath, `@echo off\r\n"${process.execPath}" "${fakeJsPath}" %*\r\n`, "utf8");
} else {
  fs.writeFileSync(fakeMmxPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeJsPath)});\n`, { mode: 0o755 });
}

function writeInputs(prompt = "hello", system = null) {
  fs.writeFileSync(promptPath, prompt, "utf8");
  if (system === null) {
    try { fs.unlinkSync(systemPath); } catch {}
  } else {
    fs.writeFileSync(systemPath, system, "utf8");
  }
}

function runWrapper(args = [], extraEnv = {}, includeFake = true) {
  fs.writeFileSync(invocationLog, "");
  const env = {
    ...process.env,
    PATH: includeFake ? `${binDir}${path.delimiter}${process.env.PATH || ""}` : "",
    TMPDIR: wrapperTmp,
    TMP: wrapperTmp,
    TEMP: wrapperTmp,
    MMX_CONFIG_DIR: absentConfigDir,
    FAKE_ARGS_DUMP: argsDumpPath,
    FAKE_INVOCATIONS: invocationLog,
    FAKE_MESSAGES_DUMP: messagesDumpPath,
    ...extraEnv,
  };
  return spawnSync(process.execPath, [wrapper, ...args], {
    env, encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024,
  });
}

function runChat(extraArgs = [], extraEnv = {}) {
  return runWrapper(["--prompt-file", promptPath, ...extraArgs], extraEnv);
}

function jsonResult(run) {
  assert.notEqual(run.stdout.trim(), "", `empty stdout; stderr=${run.stderr}`);
  return JSON.parse(run.stdout);
}

function unlinkKnown(p) {
  try { fs.unlinkSync(p); } catch {}
}

after(() => {
  unlinkKnown(promptPath);
  unlinkKnown(systemPath);
  unlinkKnown(argsDumpPath);
  unlinkKnown(invocationLog);
  unlinkKnown(overrideProfilePath);
  unlinkKnown(messagesDumpPath);
  unlinkKnown(childPidPath);
  unlinkKnown(fakeMmxPath);
  unlinkKnown(fakeJsPath);
  try { fs.rmdirSync(wrapperTmp); } catch {}
  try { fs.rmdirSync(binDir); } catch {}
  try { fs.rmdirSync(root); } catch {}
});

test("version remains a plain-text compatibility exception", () => {
  const run = runWrapper(["--version"]);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "mmx-chat 2.7.0\n");
});

test("the version constant and the SKILL.md frontmatter stay in sync", () => {
  const frontmatter = /^version:\s*(\S+)\s*$/m.exec(fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8"));
  const constant = /^const VERSION = "([^"]+)";$/m.exec(fs.readFileSync(wrapper, "utf8"));
  assert.ok(frontmatter, "SKILL.md has no version frontmatter");
  assert.ok(constant, "mmx-chat.js has no VERSION constant");
  assert.equal(frontmatter[1], constant[1]);
});

test("success preserves the public JSON schema and skips auth status", () => {
  writeInputs("hello");
  const run = runChat([], { MINIMAX_BASE_URL: undefined });
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");
  assert.deepEqual(jsonResult(run), {
    status: "ok", exit_code: 0, requested_model: null, cli_invoked: true, text: "MMX_OK", model: "MiniMax-M3",
    model_identity_source: "response.model", stop_reason: "end_turn", complete: true,
    input_tokens: 12, output_tokens: 3, truncated: false,
    fetch_timeout_guard: "custom_launcher", base_url_env: "unset",
  });
  const args = JSON.parse(fs.readFileSync(argsDumpPath, "utf8"));
  assert.deepEqual(args.slice(0, 2), ["text", "chat"]);
  assert.ok(!args.includes("--quiet"));
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "text chat\n");
  assert.equal(args[args.indexOf("--max-tokens") + 1], "524288");
  assert.equal(args[args.indexOf("--timeout") + 1], "600");
  assert.equal(JSON.parse(fs.readFileSync(profile, "utf8")).wrapper_timeout_seconds, 630);
});

test("BOM, Chinese, shell metacharacters, system, and model are preserved without argv leakage", () => {
  const prompt = "\ufeff中文 $() `tick` 'single' \"double\"";
  const system = "system 中文";
  writeInputs(prompt, system);
  const run = runChat(["--system-file", systemPath, "--model", "MiniMax-M2.7"], { FAKE_MODEL: "MiniMax-M2.7" });
  assert.equal(run.status, 0);
  const messages = JSON.parse(fs.readFileSync(messagesDumpPath, "utf8"));
  assert.deepEqual(messages, [
    { role: "system", content: system },
    { role: "user", content: prompt.slice(1) },
  ]);
  const args = JSON.parse(fs.readFileSync(argsDumpPath, "utf8"));
  assert.ok(!args.join(" ").includes("中文"));
  assert.ok(args.includes("MiniMax-M2.7"));
});

test("requested model fallback adds a warning without changing ok status", () => {
  writeInputs("model test");
  const result = jsonResult(runChat(["--model", "Unknown-Model"]));
  assert.equal(result.status, "ok");
  assert.match(result.warning, /requested model was not used/);
  assert.equal(result.requested_model, "Unknown-Model");
  assert.equal(result.model, "MiniMax-M3");
});

test("leading CLI noise is tolerated and max_tokens is marked truncated", () => {
  writeInputs("noise");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "prefix" })).status, "ok");
  const truncated = jsonResult(runChat([], { FAKE_MODE: "truncated" }));
  assert.equal(truncated.status, "ok");
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.complete, false);
});

test("missing upstream usage remains schema-compatible with null token counts", () => {
  writeInputs("missing usage");
  const result = jsonResult(runChat([], { FAKE_MODE: "missing_usage" }));
  assert.equal(result.status, "ok");
  assert.equal(result.input_tokens, null);
  assert.equal(result.output_tokens, null);
});

test("chat error code 3 maps directly to auth_error without a preflight", () => {
  writeInputs("auth");
  const run = runChat([], { FAKE_MODE: "auth" });
  assert.equal(run.status, 1);
  const result = jsonResult(run);
  assert.equal(result.status, "auth_error");
  assert.equal(result.exit_code, 3);
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "text chat\n");
});

test("API, base_resp, invalid JSON, empty stdout, and nonzero success are classified", () => {
  writeInputs("errors");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "api_stdout" })).status, "api_error");
  const stderrError = jsonResult(runChat([], { FAKE_MODE: "api_stderr" }));
  assert.equal(stderrError.status, "api_error");
  assert.doesNotMatch(JSON.stringify(stderrError), /Bearer|synthetic-secret|private prompt/);
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "base_error" })).status, "api_error");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "schema" })).status, "schema_mismatch");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "invalid" })).status, "invalid_json");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "empty" })).status, "empty_stdout");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "nonzero_success" })).status, "api_error");
});

test("complete prompt and system are forwarded beyond the old byte limits", () => {
  const prompt = "中".repeat(100000);
  const system = "s".repeat(65537);
  writeInputs(prompt, system);
  assert.equal(jsonResult(runChat(["--system-file", systemPath])).status, "ok");
  const messages = JSON.parse(fs.readFileSync(messagesDumpPath, "utf8"));
  assert.equal(messages[0].content, system);
  assert.equal(messages[1].content, prompt);
});

test("timeout flags win over the environment, which wins over the profile", () => {
  writeInputs("timeouts");
  const args = JSON.parse(fs.readFileSync(argsDumpPath, "utf8"));
  assert.equal(args[args.indexOf("--timeout") + 1], "600");
  assert.equal(jsonResult(runChat(["--timeout", "7"], { MMX_CHAT_REQ_TIMEOUT: "70" })).status, "ok");
  const flagged = JSON.parse(fs.readFileSync(argsDumpPath, "utf8"));
  assert.equal(flagged[flagged.indexOf("--timeout") + 1], "7");
  const fromEnv = jsonResult(runChat([], { MMX_CHAT_REQ_TIMEOUT: "70" }));
  assert.equal(fromEnv.status, "ok");
  const envArgs = JSON.parse(fs.readFileSync(argsDumpPath, "utf8"));
  assert.equal(envArgs[envArgs.indexOf("--timeout") + 1], "70");
  for (const invalid of ["0", "1.2", "abc", "3601"]) {
    assert.equal(jsonResult(runChat(["--timeout", invalid])).status, "usage_error");
    assert.equal(jsonResult(runChat(["--wrap-timeout", invalid])).status, "usage_error");
  }
  assert.equal(jsonResult(runChat(["--timeout", "100", "--wrap-timeout", "100"])).status, "usage_error");
});

test("thinking without text is a budget problem only when the model hit max_tokens", () => {
  writeInputs("thinking");
  const exhausted = jsonResult(runChat([], { FAKE_MODE: "thinking_only_truncated" }));
  assert.equal(exhausted.status, "thinking_budget_exhausted");
  assert.equal(exhausted.stop_reason, "max_tokens");
  assert.equal(exhausted.truncated, true);
  assert.equal(exhausted.complete, false);
  assert.deepEqual(exhausted.content_block_types, ["thinking"]);
  assert.match(exhausted.note, /--max-tokens/);
  const drifted = jsonResult(runChat([], { FAKE_MODE: "thinking_only" }));
  assert.equal(drifted.status, "schema_mismatch");
  assert.equal(drifted.stop_reason, "end_turn");
  assert.equal(drifted.complete, false);
  assert.deepEqual(drifted.content_block_types, ["thinking"]);
});

test("auth and timeout failures carry an actionable instruction", () => {
  writeInputs("auth");
  const auth = jsonResult(runChat([], { FAKE_MODE: "auth" }));
  assert.equal(auth.status, "auth_error");
  assert.match(auth.error, /mmx auth login/);
  const timedOut = jsonResult(runChat([], { FAKE_MODE: "quota" }));
  assert.equal(timedOut.status, "quota_error");
});

test("full output survives the old combined capture limit", () => {
  writeInputs("large output");
  const run = runChat([], { FAKE_MODE: "large", MMX_CHAT_MAX_CAPTURE_BYTES: "128" });
  assert.equal(run.status, 0);
  assert.equal(jsonResult(run).text, "中".repeat(420000));
  assert.equal(run.stderr, "");
});

test("profile and explicit overrides determine effective request args", () => {
  writeInputs("profile");
  fs.writeFileSync(overrideProfilePath, JSON.stringify({
    format: 1, model: "MiniMax-M3", max_tokens: 4000, request_timeout_seconds: 10, wrapper_timeout_seconds: 15,
  }));
  const result = jsonResult(runChat(["--profile-file", overrideProfilePath, "--max-tokens", "5000"]));
  assert.equal(result.requested_model, "MiniMax-M3");
  const args = JSON.parse(fs.readFileSync(argsDumpPath, "utf8"));
  assert.equal(args[args.indexOf("--max-tokens") + 1], "5000");
  assert.equal(args[args.indexOf("--timeout") + 1], "10");
  for (const invalid of ["0", "1.2", "1e3", "9007199254740992"]) {
    assert.equal(jsonResult(runChat(["--max-tokens", invalid])).status, "usage_error");
    assert.equal(fs.readFileSync(invocationLog, "utf8"), "");
  }
});

test("timeout ordering is validated and a hung process is terminated", () => {
  writeInputs("hang");
  const bad = jsonResult(runChat([], { MMX_CHAT_REQ_TIMEOUT: "2", MMX_CHAT_WRAP_TIMEOUT: "1" }));
  assert.equal(bad.status, "usage_error");

  const run = runChat([], {
    FAKE_MODE: "hang", MMX_CHAT_REQ_TIMEOUT: "1", MMX_CHAT_WRAP_TIMEOUT: "2",
  });
  assert.equal(run.status, 1);
  assert.equal(jsonResult(run).status, "timeout");
});

test("a timed-out subprocess tree does not survive the wrapper", async () => {
  writeInputs("tree hang");
  unlinkKnown(childPidPath);
  const run = runChat([], {
    FAKE_MODE: "tree_hang", FAKE_CHILD_PID: childPidPath,
    MMX_CHAT_REQ_TIMEOUT: "1", MMX_CHAT_WRAP_TIMEOUT: "2",
  });
  assert.equal(jsonResult(run).status, "timeout");
  const pid = Number(fs.readFileSync(childPidPath, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, `descendant process ${pid} survived timeout`);
});

test("missing CLI and argument failures remain structured", () => {
  writeInputs("args");
  assert.equal(jsonResult(runWrapper(["--prompt-file", promptPath], {}, false)).status, "cli_missing");
  assert.equal(jsonResult(runWrapper([])).status, "usage_error");
  assert.equal(jsonResult(runChat(["--model", "bad model"])).status, "invalid_model");
  assert.equal(jsonResult(runChat(["--tool", "{}"])).status, "usage_error");
});

test("wrapper internal temp directory is empty after a normal request", () => {
  writeInputs("cleanup");
  assert.equal(jsonResult(runChat()).status, "ok");
  assert.deepEqual(fs.readdirSync(wrapperTmp), []);
});

test("wrapper internal temp directory is empty after an API failure", () => {
  writeInputs("cleanup failure");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "api_stdout" })).status, "api_error");
  assert.deepEqual(fs.readdirSync(wrapperTmp), []);
});

test("UTF-16, invalid UTF-8, and NUL input return unsupported_encoding", () => {
  for (const bytes of [[0xff,0xfe,0x41,0], [0xc3,0x28], [0x41,0,0x42]]) {
    fs.writeFileSync(promptPath, Buffer.from(bytes));
    assert.equal(jsonResult(runChat()).status, "unsupported_encoding");
  }
});

test("multiline emoji, CRLF, and shell syntax remain literal", () => {
  const marker = path.join(root, "shell-must-not-run");
  const prompt = `中文😀\r\nsecond line\n"quotes" \`tick\` $(touch ${marker})`;
  writeInputs(prompt);
  assert.equal(jsonResult(runChat()).status, "ok");
  const messages = JSON.parse(fs.readFileSync(messagesDumpPath, "utf8"));
  assert.equal(messages[0].content, prompt);
  assert.equal(fs.existsSync(marker), false);
});

test("UTF-8 is decoded after all output chunks", () => {
  writeInputs("split response");
  const split = jsonResult(runChat([], { FAKE_MODE: "split_utf8", FAKE_TEXT: "中文😀" }));
  assert.equal(split.text, "中文😀");
});

test("Windows path and command branch mock covers exe, npm shim, batch, and unsafe path", () => {
  assert.equal(safeCmdArgument("C:\\Program Files\\中文\\mmx.cmd"), true);
  for (const bad of ["&", "%", "!", "(", ")", "^", "\""]) assert.equal(safeCmdArgument("C:\\bad" + bad + "\\mmx.cmd"), false);
  const found = new Set(["C:\\Program Files\\MMX\\mmx.exe", "D:\\npm\\mmx.cmd"]);
  const fakeFs = { constants: { F_OK: 0, X_OK: 1 }, accessSync(p) { if (!found.has(p)) throw Error("missing"); } };
  const lookup = resolver => findMmx("win32", "C:\\Program Files\\MMX;D:\\npm", fakeFs, resolver, "C:\\Node\\node.exe");
  assert.deepEqual(lookup(() => null), { cmd: "C:\\Program Files\\MMX\\mmx.exe", argsPrefix: [], shell: false });
  found.delete("C:\\Program Files\\MMX\\mmx.exe");
  assert.deepEqual(lookup(() => "D:\\npm\\node_modules\\mmx-cli\\dist\\mmx.mjs"), {
    cmd: "C:\\Node\\node.exe", argsPrefix: ["D:\\npm\\node_modules\\mmx-cli\\dist\\mmx.mjs"], shell: false,
  });
  assert.deepEqual(lookup(() => null), { cmd: "D:\\npm\\mmx.cmd", argsPrefix: [], shell: true });
  found.add("E:\\unsafe&name\\mmx.bat");
  assert.deepEqual(findMmx("win32", "E:\\unsafe&name", fakeFs, () => null), { unsafe: true });
});

test("npm shim resolution requires package metadata and exact entry", () => {
  const npmDir = path.join(root, "npm-shim");
  const pkg = path.join(npmDir, "node_modules", "mmx-cli");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  const shim = path.join(npmDir, "mmx.cmd");
  const entry = path.join(pkg, "dist", "mmx.mjs");
  fs.writeFileSync(shim, '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\mmx-cli\\dist\\mmx.mjs" %*\r\n');
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "mmx-cli", bin: { mmx: "dist/mmx.mjs" } }));
  fs.writeFileSync(entry, "// fake");
  assert.equal(npmShimEntry(shim), entry);
  fs.writeFileSync(shim, "@echo off\r\necho custom wrapper\r\n");
  assert.equal(npmShimEntry(shim), null);
  fs.unlinkSync(entry); fs.unlinkSync(path.join(pkg, "package.json")); fs.unlinkSync(shim);
  for (const dir of [path.join(pkg, "dist"), pkg, path.join(npmDir, "node_modules"), npmDir]) fs.rmdirSync(dir);
});

test("Windows taskkill failure checks result and falls back", () => {
  let fallback = 0;
  const child = { pid: 123, kill() { fallback++; return true; } };
  const calls = [];
  assert.equal(terminateChildTree(child, true, false, "win32", (...args) => { calls.push(args); return { status: 1 }; }), false);
  assert.equal(fallback, 1);
  assert.deepEqual(calls[0][1], ["/PID", "123", "/T", "/F"]);
  assert.equal(calls[0][2].shell, false);
});

test("POSIX CLI path with spaces, Chinese, and metacharacters is direct", () => {
  if (process.platform === "win32") return;
  const specialBin = path.join(root, "bin 中文 & space");
  fs.mkdirSync(specialBin);
  const cli = path.join(specialBin, "mmx");
  fs.writeFileSync(cli, `#!${process.execPath}\nrequire(${JSON.stringify(fakeJsPath)});\n`, { mode: 0o755 });
  writeInputs("special path");
  assert.equal(jsonResult(runChat([], { PATH: `${specialBin}${path.delimiter}${process.env.PATH || ""}` })).status, "ok");
  fs.unlinkSync(cli); fs.rmdirSync(specialBin);
});

test("launch error yields one JSON object", () => {
  if (process.platform === "win32") return;
  const bin = path.join(root, "broken-bin"); fs.mkdirSync(bin);
  const cli = path.join(bin, "mmx");
  fs.writeFileSync(cli, "#!/definitely/missing/interpreter\n", { mode: 0o755 });
  writeInputs("launch failure");
  const run = runChat([], { PATH: bin });
  assert.equal(jsonResult(run).status, "api_error");
  assert.equal(run.stdout.trim().split(/\r?\n/).length, 1);
  fs.unlinkSync(cli); fs.rmdirSync(bin);
});

test("unexpected temp file is preserved", () => {
  writeInputs("preserve");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "unexpected_file" })).status, "ok");
  const dirs = fs.readdirSync(wrapperTmp);
  assert.equal(dirs.length, 1);
  const file = path.join(wrapperTmp, dirs[0], "unexpected-marker.txt");
  assert.equal(fs.readFileSync(file, "utf8"), "leave me");
  fs.unlinkSync(file); fs.rmdirSync(path.dirname(file));
});


test("SIGTERM cancellation yields one final JSON object", async () => {
  if (process.platform === "win32") return;
  writeInputs("cancel");
  unlinkKnown(argsDumpPath);
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    TMPDIR: wrapperTmp, TMP: wrapperTmp, TEMP: wrapperTmp, FAKE_MODE: "hang",
    FAKE_ARGS_DUMP: argsDumpPath, FAKE_MESSAGES_DUMP: messagesDumpPath };
  const child = spawn(process.execPath, [wrapper, "--prompt-file", promptPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stdout.on("data", chunk => chunks.push(chunk));
  for (let i = 0; i < 40 && !fs.existsSync(argsDumpPath); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(argsDumpPath), true);
  child.kill("SIGTERM");
  const exitCode = await new Promise(resolve => child.once("close", resolve));
  assert.equal(exitCode, 1);
  const output = Buffer.concat(chunks).toString("utf8").trim();
  assert.equal(output.split(/\r?\n/).length, 1);
  assert.equal(JSON.parse(output).status, "cancelled");
});


test("missing model or stop_reason cannot be treated as ok", () => {
  writeInputs("required fields");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "missing_model" })).status, "schema_mismatch");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "missing_stop" })).status, "schema_mismatch");
});


test("unexpected stop reasons, tool blocks and malformed code types fail closed", () => {
  writeInputs("invalid upstream contract");
  for (const FAKE_STOP of ["tool_use", "unknown"]) {
    assert.equal(jsonResult(runChat([], { FAKE_STOP })).status, "schema_mismatch");
  }
  for (const FAKE_MODE of ["tool_block", "string_status", "string_error", "array_response"]) {
    assert.equal(jsonResult(runChat([], { FAKE_MODE })).status, "schema_mismatch");
  }
});

test("CLI and API quota failures have a fixed error classification", () => {
  writeInputs("quota");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "quota" })).status, "quota_error");
  assert.equal(jsonResult(runChat([], { FAKE_MODE: "quota_api" })).status, "quota_error");
});


test("managed release rejects mixed or interrupted installation before launching MMX", () => {
  const managed = path.join(root, "managed-skills");
  const marker = path.join(managed, ".gstack-cross-validation-release.json");
  const files = {
    "agy/scripts/agy_runner.py": Buffer.from("# fixture runner"),
    "mmx/scripts/mmx-chat.js": fs.readFileSync(wrapper),
    "mmx/scripts/fetch-timeout-guard.js": fs.readFileSync(path.join(skillRoot, "scripts", "fetch-timeout-guard.js")),
    "mmx/scripts/mmx-provider-slot.js": fs.readFileSync(path.join(skillRoot, "scripts", "mmx-provider-slot.js")),
    "mmx/profiles/local.json": fs.readFileSync(profile),
    "cross-validation/scripts/cross_validate.py": Buffer.from("# fixture coordinator"),
  };
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const digests = {};
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(managed, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    digests[name] = hash(bytes);
  }
  const manifest = { format: 1, state: "active", release_id: hash(JSON.stringify(digests)), files: digests };
  const installedWrapper = path.join(managed, "mmx", "scripts", "mmx-chat.js");
  function run(extraEnv = {}) {
    fs.writeFileSync(invocationLog, "");
    return jsonResult(spawnSync(process.execPath, [installedWrapper, "--prompt-file", promptPath], {
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`, TMPDIR: wrapperTmp,
        TMP: wrapperTmp, TEMP: wrapperTmp, FAKE_INVOCATIONS: invocationLog, ...extraEnv },
      encoding: "utf8", timeout: 15000,
    }));
  }
  writeInputs("release fixture");
  fs.writeFileSync(marker, JSON.stringify(manifest));
  assert.equal(run().status, "ok");
  const slotHome = path.join(root, "managed-slot-home");
  fs.mkdirSync(slotHome, { recursive: true });
  const slotEnv = { MMX_GLOBAL_SLOT: "1", HOME: slotHome, USERPROFILE: slotHome };
  assert.equal(run(slotEnv).status, "ok", "pinned slot helper remains usable");
  fs.writeFileSync(marker, JSON.stringify({ ...manifest,
    files: { ...digests, "mmx/scripts/mmx-provider-slot.js": undefined } }));
  const unpinnedSlot = run(slotEnv);
  assert.equal(unpinnedSlot.status, "install_mismatch", "enabled slot helper must be covered by the managed manifest");
  assert.equal(unpinnedSlot.cli_invoked, false);
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "");
  fs.writeFileSync(marker, JSON.stringify(manifest));
  fs.writeFileSync(path.join(managed, "mmx", "profiles", "local.json"), "{}");
  const mixed = run();
  assert.equal(mixed.status, "install_mismatch");
  assert.equal(mixed.cli_invoked, false);
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "");
  fs.writeFileSync(path.join(managed, "mmx", "profiles", "local.json"), files["mmx/profiles/local.json"]);
  fs.writeFileSync(marker, JSON.stringify({ ...manifest, state: "installing" }));
  assert.equal(run().status, "install_mismatch");
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "");
  fs.writeFileSync(marker, JSON.stringify({ ...manifest, files: { ...digests, "mmx/scripts/fetch-timeout-guard.js": undefined } }));
  assert.equal(run().status, "install_mismatch", "the fetch guard is a required release file");
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "");
  for (const name of Object.keys(files)) unlinkKnown(path.join(managed, name));
  unlinkKnown(marker);
  for (const name of ["agy/scripts", "agy", "mmx/scripts", "mmx/profiles", "mmx",
                      "cross-validation/scripts", "cross-validation"]) fs.rmdirSync(path.join(managed, name));
  fs.rmdirSync(managed);
});

// The managed root is detected from its layout, so the same rule holds on
// every platform instead of one host's absolute path.
test("a managed layout without a release marker fails closed before the CLI runs", () => {
  const managed = path.join(root, "managed-layout");
  const files = {
    "agy/scripts/agy_runner.py": Buffer.from("# fixture runner"),
    "mmx/scripts/mmx-chat.js": fs.readFileSync(wrapper),
    "mmx/profiles/local.json": fs.readFileSync(profile),
    "cross-validation/scripts/cross_validate.py": Buffer.from("# fixture coordinator"),
  };
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(managed, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  fs.writeFileSync(invocationLog, "");
  const run = spawnSync(process.execPath, [path.join(managed, "mmx", "scripts", "mmx-chat.js"),
    "--prompt-file", promptPath], {
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`, TMPDIR: wrapperTmp,
      TMP: wrapperTmp, TEMP: wrapperTmp, FAKE_INVOCATIONS: invocationLog },
    encoding: "utf8", timeout: 15000,
  });
  const result = jsonResult(run);
  assert.equal(result.status, "install_mismatch");
  assert.equal(result.cli_invoked, false);
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "");
  for (const name of Object.keys(files)) unlinkKnown(path.join(managed, name));
  for (const name of ["agy/scripts", "agy", "mmx/scripts", "mmx/profiles", "mmx",
                      "cross-validation/scripts", "cross-validation"]) fs.rmdirSync(path.join(managed, name));
  fs.rmdirSync(managed);
});

test("a plain install without siblings and without a marker is not treated as managed", () => {
  const plain = path.join(root, "plain-layout");
  const files = {
    "mmx/scripts/mmx-chat.js": fs.readFileSync(wrapper),
    "mmx/profiles/local.json": fs.readFileSync(profile),
  };
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(plain, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  writeInputs("plain install");
  fs.writeFileSync(invocationLog, "");
  const run = spawnSync(process.execPath, [path.join(plain, "mmx", "scripts", "mmx-chat.js"),
    "--prompt-file", promptPath], {
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`, TMPDIR: wrapperTmp,
      TMP: wrapperTmp, TEMP: wrapperTmp, FAKE_INVOCATIONS: invocationLog },
    encoding: "utf8", timeout: 15000,
  });
  assert.equal(jsonResult(run).status, "ok");
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "text chat\n");
  for (const name of Object.keys(files)) unlinkKnown(path.join(plain, name));
  for (const name of ["mmx/scripts", "mmx/profiles", "mmx"]) fs.rmdirSync(path.join(plain, name));
  fs.rmdirSync(plain);
});

// A real npm-style package entry on every platform: POSIX uses its executable
// link and Windows uses the .cmd shim resolved by the production launcher.
function buildFakePackage() {
  const pkgBin = path.join(root, "pkg-bin");
  const pkgRoot = path.join(pkgBin, "node_modules", "mmx-cli");
  fs.mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, "node_modules", "undici"), { recursive: true });
  const entry = path.join(pkgRoot, "dist", "mmx.mjs");
  fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "mmx-cli", bin: { mmx: "dist/mmx.mjs" } }));
  fs.writeFileSync(entry, `#!${process.execPath}\nimport { createRequire } from 'node:module';\ncreateRequire(import.meta.url)(${JSON.stringify(fakeJsPath)});\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(pkgRoot, "node_modules", "undici", "package.json"), JSON.stringify({ name: "undici", main: "index.js" }));
  fs.writeFileSync(path.join(pkgRoot, "node_modules", "undici", "index.js"),
    "class Agent { constructor(options) { this.options = options; } }\n" +
    "module.exports = { Agent, setGlobalDispatcher(dispatcher) { globalThis.__fakeGuard = dispatcher.options; } };\n");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(pkgBin, "mmx.cmd"), '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\mmx-cli\\dist\\mmx.mjs" %*\r\n');
  } else fs.symlinkSync(entry, path.join(pkgBin, "mmx"));
  return { pkgRoot, pkgBin, entry };
}

function removeFakePackage(pkgRoot, pkgBin, entry) {
  unlinkKnown(path.join(pkgBin, "mmx"));
  unlinkKnown(path.join(pkgBin, "mmx.cmd"));
  unlinkKnown(entry);
  unlinkKnown(path.join(pkgRoot, "package.json"));
  unlinkKnown(path.join(pkgRoot, "node_modules", "undici", "package.json"));
  unlinkKnown(path.join(pkgRoot, "node_modules", "undici", "index.js"));
  for (const dir of [path.join(pkgRoot, "dist"), path.join(pkgRoot, "node_modules", "undici"),
                     path.join(pkgRoot, "node_modules"), pkgRoot, path.join(pkgBin, "node_modules"), pkgBin]) fs.rmdirSync(dir);
}

test("package entry resolution accepts linked mmx-cli entries and rejects other packages", () => {
  const { pkgRoot, pkgBin, entry } = buildFakePackage();
  try {
    if (process.platform !== "win32") assert.equal(linkedEntry(path.join(pkgBin, "mmx")), fs.realpathSync(entry));
    assert.equal(fs.realpathSync(findMmx(process.platform, pkgBin).argsPrefix[0]), fs.realpathSync(entry));
    assert.equal(mmxPackageEntry(entry)?.root, fs.realpathSync(pkgRoot));
    // The default fake is a custom launcher, not an mmx-cli package.
    assert.equal(linkedEntry(fakeMmxPath), null);
    fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "other-cli", bin: { mmx: "dist/mmx.cjs" } }));
    assert.equal(mmxPackageEntry(entry), null);
    fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "mmx-cli", bin: { mmx: "dist/elsewhere.cjs" } }));
    assert.equal(mmxPackageEntry(entry), null);
  } finally {
    removeFakePackage(pkgRoot, pkgBin, entry);
  }
});

test("the mmx-cli package entry launches with the fetch guard preloaded and a normalized base URL", () => {
  const { pkgRoot, pkgBin, entry } = buildFakePackage();
  const envDumpPath = path.join(root, "env-dump.json");
  const noProxy = Object.fromEntries(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                                      "ALL_PROXY", "all_proxy"].map(name => [name, undefined]));
  try {
    writeInputs("guard");
    const result = jsonResult(runChat([], {
      PATH: `${pkgBin}${path.delimiter}${process.env.PATH || ""}`,
      MINIMAX_BASE_URL: "https://api.example.com/v1/",
      FAKE_ENV_DUMP: envDumpPath,
      ...noProxy,
    }));
    assert.equal(result.status, "ok");
    assert.equal(result.fetch_timeout_guard, "preloaded");
    assert.equal(result.base_url_env, "stripped_v1");
    const dumped = JSON.parse(fs.readFileSync(envDumpPath, "utf8"));
    assert.deepEqual(dumped.argv.slice(0, 2), ["text", "chat"]);
    assert.equal(dumped.minimax_base_url, "https://api.example.com");
    assert.equal(dumped.undici_path, fs.realpathSync(path.join(pkgRoot, "node_modules", "undici", "index.js")));
    assert.equal(dumped.https_proxy_set, false);
    // The preload really ran in the CLI process, before the CLI's own code.
    assert.deepEqual(dumped.guard, { headersTimeout: 0, bodyTimeout: 0 });

    const found = findMmx(process.platform, pkgBin);
    assert.equal(cliLaunch(found, { Https_Proxy: "http://127.0.0.1:9" }, "win32").fetch_timeout_guard, "proxy_limited");
    assert.equal(cliLaunch(found, { Https_Proxy: "http://127.0.0.1:9", MMX_CONFIG_DIR: absentConfigDir }, "linux").fetch_timeout_guard, "preloaded");
    const noGuard = cliLaunch(found, {}, process.platform, path.join(root, "missing-fetch-timeout-guard.js"));
    assert.equal(noGuard.fetch_timeout_guard, "guard_missing");
    assert.deepEqual(noGuard.argsPrefix, [fs.realpathSync(entry)]);
    assert.equal(Object.hasOwn(noGuard.env, "MMX_CHAT_UNDICI_PATH"), false);
    // A fresh wrapper process: this one has cached the undici resolution.
    unlinkKnown(path.join(pkgRoot, "node_modules", "undici", "index.js"));
    unlinkKnown(path.join(pkgRoot, "node_modules", "undici", "package.json"));
    unlinkKnown(envDumpPath);
    const withoutUndici = jsonResult(runChat([], {
      PATH: `${pkgBin}${path.delimiter}${process.env.PATH || ""}`, FAKE_ENV_DUMP: envDumpPath, ...noProxy,
    }));
    assert.equal(withoutUndici.status, "ok");
    assert.equal(withoutUndici.fetch_timeout_guard, "undici_not_found");
    const unguarded = JSON.parse(fs.readFileSync(envDumpPath, "utf8"));
    assert.equal(unguarded.undici_path, null);
    assert.equal(unguarded.guard, null);
  } finally {
    removeFakePackage(pkgRoot, pkgBin, entry);
    unlinkKnown(envDumpPath);
  }
});

test("a selected fetch guard fails before invoking the CLI if initialization throws", () => {
  const { pkgRoot, pkgBin, entry } = buildFakePackage();
  const undiciFile = path.join(pkgRoot, "node_modules", "undici", "index.js");
  const secret = "synthetic-private-dependency-detail";
  try {
    writeInputs("guard initialization must precede request");
    for (const broken of [
      `throw new Error(${JSON.stringify(secret)});`,
      "module.exports = { Agent: class {}, setGlobalDispatcher() { throw new Error('dispatcher rejected'); } };",
    ]) {
      fs.writeFileSync(undiciFile, broken);
      const run = runChat([], { PATH: `${pkgBin}${path.delimiter}${process.env.PATH || ""}` });
      const receipt = jsonResult(run);
      assert.equal(run.status, 1);
      assert.equal(receipt.status, "guard_error");
      assert.equal(receipt.fetch_timeout_guard, "preload_failed");
      assert.equal(receipt.exit_code, 78);
      assert.equal(fs.readFileSync(invocationLog, "utf8"), "", "the CLI entry never runs");
      assert.doesNotMatch(run.stdout + run.stderr, new RegExp(secret));
      assert.deepEqual(fs.readdirSync(wrapperTmp), []);
    }
  } finally { removeFakePackage(pkgRoot, pkgBin, entry); }
});

test("fetch guard acknowledgement does not break inherited Worker preloads", () => {
  const { pkgRoot, pkgBin, entry } = buildFakePackage();
  try {
    fs.writeFileSync(entry, "import { Worker } from 'node:worker_threads';\n" +
      "import { createRequire } from 'node:module';\n" +
      "const worker = new Worker('0', { eval: true });\n" +
      "worker.on('exit', code => { if (code) process.exit(code); else createRequire(import.meta.url)(" +
      JSON.stringify(fakeJsPath) + "); });\n");
    writeInputs("worker preload");
    const result = jsonResult(runChat([], { PATH: `${pkgBin}${path.delimiter}${process.env.PATH || ""}` }));
    assert.equal(result.status, "ok");
    assert.notEqual(result.fetch_timeout_guard, "preload_failed");
    assert.deepEqual(fs.readdirSync(wrapperTmp), []);
  } finally { removeFakePackage(pkgRoot, pkgBin, entry); }
});

test("a blocked guard import preserves timeout without claiming initialization", () => {
  const { pkgRoot, pkgBin, entry } = buildFakePackage();
  try {
    fs.writeFileSync(path.join(pkgRoot, "node_modules", "undici", "index.js"),
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);\n");
    writeInputs("blocked preload");
    const run = runChat(["--timeout", "1", "--wrap-timeout", "2"],
      { PATH: `${pkgBin}${path.delimiter}${process.env.PATH || ""}` });
    const result = jsonResult(run);
    assert.equal(run.status, 1);
    assert.equal(result.status, "timeout");
    assert.equal(result.fetch_timeout_guard, "preload_failed");
    assert.equal(fs.readFileSync(invocationLog, "utf8"), "");
    assert.deepEqual(fs.readdirSync(wrapperTmp), []);
  } finally { removeFakePackage(pkgRoot, pkgBin, entry); }
});

test("the mmx config proxy key downgrades the guard the way mmx-cli reads it", () => {
  const { pkgRoot, pkgBin, entry } = buildFakePackage();
  const envDumpPath = path.join(root, "env-dump.json");
  const noProxy = Object.fromEntries(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                                      "ALL_PROXY", "all_proxy"].map(name => [name, undefined]));
  const configDir = path.join(root, "mmx config");
  const configFile = path.join(configDir, "config.json");
  const home = path.join(root, "home");
  const homeConfigDir = path.join(home, ".mmx");
  const homeConfigFile = path.join(homeConfigDir, "config.json");
  const run = extra => jsonResult(runChat([], {
    PATH: `${pkgBin}${path.delimiter}${process.env.PATH || ""}`, FAKE_ENV_DUMP: envDumpPath, ...noProxy, ...extra,
  }));
  try {
    writeInputs("config proxy guard");
    fs.mkdirSync(configDir);
    fs.writeFileSync(configFile, JSON.stringify({ api_key: "sk-synthetic-config-secret", proxy: "http://127.0.0.1:9" }));
    const configured = run({ MMX_CONFIG_DIR: configDir });
    assert.equal(configured.status, "ok");
    assert.equal(configured.fetch_timeout_guard, "proxy_limited");
    assert.deepEqual(JSON.parse(fs.readFileSync(envDumpPath, "utf8")).guard, { headersTimeout: 0, bodyTimeout: 0 });
    assert.doesNotMatch(JSON.stringify(configured), /sk-synthetic-config-secret|127\.0\.0\.1:9/);
    fs.writeFileSync(configFile, JSON.stringify({ proxy: "socks5://127.0.0.1:9" }));
    assert.equal(run({ MMX_CONFIG_DIR: configDir }).fetch_timeout_guard, "preloaded", "mmx-cli ignores a proxy that does not start with http");
    fs.writeFileSync(configFile, "{ not json");
    assert.equal(run({ MMX_CONFIG_DIR: configDir }).fetch_timeout_guard, "preloaded", "an unreadable config has no proxy");
    const found = findMmx(process.platform, pkgBin);
    fs.mkdirSync(homeConfigDir, { recursive: true });
    fs.writeFileSync(homeConfigFile, JSON.stringify({ proxy: "https://127.0.0.1:9" }));
    assert.equal(cliLaunch(found, { HOME: home }, "linux").fetch_timeout_guard, "proxy_limited", "<home>/.mmx when MMX_CONFIG_DIR is unset");
    assert.equal(cliLaunch(found, { HOME: home, MMX_CONFIG_DIR: absentConfigDir }, "linux").fetch_timeout_guard, "preloaded", "MMX_CONFIG_DIR wins over HOME");
    assert.equal(cliLaunch(found, { UserProfile: home }, "win32").fetch_timeout_guard, "proxy_limited");
    fs.writeFileSync(configFile, JSON.stringify({ proxy: "http://127.0.0.1:9" }));
    assert.equal(cliLaunch(found, { Mmx_Config_Dir: configDir, UserProfile: absentConfigDir }, "win32").fetch_timeout_guard, "proxy_limited");
  } finally {
    removeFakePackage(pkgRoot, pkgBin, entry);
    for (const file of [envDumpPath, configFile, homeConfigFile]) unlinkKnown(file);
    for (const dir of [configDir, homeConfigDir, home]) { try { fs.rmdirSync(dir); } catch {} }
  }
});

test("proxy variables downgrade the preloaded guard to proxy_limited", () => {
  const { pkgRoot, pkgBin, entry } = buildFakePackage();
  const envDumpPath = path.join(root, "env-dump.json");
  try {
    writeInputs("proxy guard");
    const result = jsonResult(runChat([], {
      PATH: `${pkgBin}${path.delimiter}${process.env.PATH || ""}`,
      HTTPS_PROXY: "http://127.0.0.1:7890",
      FAKE_ENV_DUMP: envDumpPath,
    }));
    assert.equal(result.status, "ok");
    assert.equal(result.fetch_timeout_guard, "proxy_limited");
    const dumped = JSON.parse(fs.readFileSync(envDumpPath, "utf8"));
    assert.equal(dumped.https_proxy_set, true);
    assert.equal(dumped.undici_path, fs.realpathSync(path.join(pkgRoot, "node_modules", "undici", "index.js")));
    assert.deepEqual(dumped.guard, { headersTimeout: 0, bodyTimeout: 0 }, "the guard still loads; the CLI proxy dispatcher replaces it later");
  } finally {
    removeFakePackage(pkgRoot, pkgBin, entry);
    unlinkKnown(envDumpPath);
  }
});

test("HTTP 404 explains the base URL suffix and reports the normalized origin without secrets", () => {
  writeInputs("404");
  const run = runChat([], {
    FAKE_MODE: "http_404",
    MINIMAX_BASE_URL: "https://user:secret@api.example.com/v1",
  });
  assert.equal(run.status, 1);
  const result = jsonResult(run);
  assert.equal(result.status, "api_error");
  assert.equal(result.http_status, 404);
  assert.match(result.hint, /\/v1/);
  assert.equal(result.base_url_env, "stripped_v1");
  assert.equal(result.base_url_env_value, "https://api.example.com");
  assert.doesNotMatch(JSON.stringify(result), /secret|token=/);
  const pathToken = jsonResult(runChat([], {
    FAKE_MODE: "http_404",
    MINIMAX_BASE_URL: "https://gw.example.test/synthetic-path-token/v1",
  }));
  assert.equal(pathToken.base_url_env, "stripped_v1");
  assert.equal(pathToken.base_url_env_value, "https://gw.example.test");
  assert.doesNotMatch(JSON.stringify(pathToken), /synthetic-path-token/);
});

test("the CLI child gets MINIMAX_BASE_URL without a trailing /v1 and the receipt records it", () => {
  writeInputs("base url");
  const envDumpPath = path.join(root, "env-dump.json");
  const cases = [
    ["https://api.example.test/v1", "https://api.example.test", "stripped_v1"],
    ["https://api.example.test/v1/", "https://api.example.test", "stripped_v1"],
    ["https://api.example.test/anthropic", "https://api.example.test/anthropic", "unchanged"],
    ["https://api.example.test/v10", "https://api.example.test/v10", "unchanged"],
    [undefined, null, "unset"],
  ];
  try {
    for (const [value, base, state] of cases) {
      unlinkKnown(envDumpPath);
      const result = jsonResult(runChat([], { FAKE_ENV_DUMP: envDumpPath, MINIMAX_BASE_URL: value }));
      assert.equal(result.status, "ok");
      assert.equal(result.base_url_env, state, String(value));
      assert.equal(result.fetch_timeout_guard, "custom_launcher");
      assert.equal(JSON.parse(fs.readFileSync(envDumpPath, "utf8")).minimax_base_url, base, String(value));
    }
  } finally {
    unlinkKnown(envDumpPath);
  }
});

test("Windows matches environment names case-insensitively and POSIX does not", () => {
  const launcher = { cmd: "mmx", argsPrefix: [], shell: false };
  const windows = cliLaunch(launcher, { minimax_base_url: "https://api.example.test/v1" }, "win32");
  assert.equal(windows.base_url_env, "stripped_v1");
  assert.deepEqual(windows.env, { minimax_base_url: "https://api.example.test" }, "the original spelling is updated in place");
  assert.equal(windows.base_url, "https://api.example.test");
  const posix = cliLaunch(launcher, { minimax_base_url: "https://api.example.test/v1" }, "linux");
  assert.equal(posix.base_url_env, "unset");
  assert.deepEqual(posix.env, { minimax_base_url: "https://api.example.test/v1" });
  assert.equal(posix.base_url, null);
});

test("a CLI network failure after 300 s points at the fetch limit", () => {
  const failure = { status: "api_error", exit_code: 6, code: 6, error: "MMX API or CLI failed." };
  assert.match(withFetchLimitHint(failure, 301400).hint, /300 s/);
  assert.match(withFetchLimitHint(failure, 905000).hint, /fetch_timeout_guard/);
  for (const [result, elapsed] of [
    [failure, 120000], [{ ...failure, exit_code: 1, code: 500 }, 301400],
    [{ status: "ok", exit_code: 0 }, 301400], [failure, undefined],
  ]) assert.equal(withFetchLimitHint(result, elapsed).hint, undefined);
  assert.equal(withFetchLimitHint({ ...failure, hint: "kept" }, 301400).hint, "kept");
  writeInputs("network");
  const quick = jsonResult(runChat([], { FAKE_MODE: "network" }));
  assert.equal(quick.status, "api_error");
  assert.equal(quick.exit_code, 6);
  assert.equal(Object.hasOwn(quick, "hint"), false, "a fast network failure gets no fetch-limit hint");
});

// Both sides of the cross-validation pair must return the same structure,
// otherwise their findings cannot be compared.
const siblingSchema = path.join(skillRoot, "..", "zcode", "references", "review-v1.schema.json");
test("the review schema matches the ZCode copy byte for byte", {
  skip: fs.existsSync(siblingSchema) ? false : "ZCode skill is not installed next to this skill",
}, () => {
  const local = fs.readFileSync(path.join(skillRoot, "references", "review-v1.schema.json"));
  assert.deepEqual(local, fs.readFileSync(siblingSchema));
});

test("opt-in provider slot is acquired and released after the CLI closes", () => {
  writeInputs("provider slot successful request");
  const home = path.join(root, "provider-slot-home");
  fs.mkdirSync(home, { recursive: true });
  const run = runChat([], { MMX_GLOBAL_SLOT: "1", HOME: home, USERPROFILE: home });
  const result = jsonResult(run);
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.provider_slot, "acquired");
  assert.equal(typeof result.provider_slot_wait_ms, "number");
  assert.equal(fs.existsSync(path.join(home, ".zmx", "locks", "mmx", "slot-0")), false);
});

test("opt-in slot cannot report success when the CLI leaves a same-group descendant running", {
  skip: process.platform === "win32" ? "POSIX process-group contract" : false,
}, () => {
  writeInputs("provider slot descendant cleanup");
  const home = path.join(root, "provider-slot-orphan-home");
  fs.mkdirSync(home, { recursive: true });
  unlinkKnown(childPidPath);
  try {
    const run = runChat([], { MMX_GLOBAL_SLOT: "1", HOME: home, USERPROFILE: home,
      FAKE_MODE: "orphan_child", FAKE_CHILD_PID: childPidPath });
    const result = jsonResult(run);
    assert.equal(result.status, "cleanup_error", JSON.stringify(result));
    assert.equal(run.status, 1);
    const lock = path.join(home, ".zmx", "locks", "mmx", "slot-0");
    if (result.provider_slot === "held_for_recovery") {
      assert.equal(fs.existsSync(lock), true, "an unconfirmed process group must retain the slot");
      assert.match(result.termination_warning, /could not be confirmed/);
    } else {
      const pid = Number(fs.readFileSync(childPidPath, "utf8"));
      assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH",
        "release requires the descendant to have disappeared");
      assert.equal(fs.existsSync(lock), false);
    }
  } finally {
    if (fs.existsSync(childPidPath)) {
      try { process.kill(Number(fs.readFileSync(childPidPath, "utf8")), "SIGKILL"); } catch {}
      unlinkKnown(childPidPath);
    }
  }
});
