"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { safeCmdArgument, npmShimEntry, findMmx, terminateChildTree } = require(path.join(__dirname, "..", "scripts", "mmx-chat.js"));

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
  assert.equal(run.stdout, "mmx-chat 2.3.0\n");
});

test("success preserves the public JSON schema and skips auth status", () => {
  writeInputs("hello");
  const run = runChat();
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");
  assert.deepEqual(jsonResult(run), {
    status: "ok", exit_code: 0, requested_model: null, cli_invoked: true, text: "MMX_OK", model: "MiniMax-M3",
    model_identity_source: "response.model", stop_reason: "end_turn", complete: true,
    input_tokens: 12, output_tokens: 3, truncated: false,
  });
  const args = JSON.parse(fs.readFileSync(argsDumpPath, "utf8"));
  assert.deepEqual(args.slice(0, 2), ["text", "chat"]);
  assert.ok(!args.includes("--quiet"));
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "text chat\n");
  assert.equal(args[args.indexOf("--max-tokens") + 1], "524288");
  assert.equal(args[args.indexOf("--timeout") + 1], "21600");
  assert.equal(JSON.parse(fs.readFileSync(profile, "utf8")).wrapper_timeout_seconds, 21630);
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
  function run() {
    fs.writeFileSync(invocationLog, "");
    return jsonResult(spawnSync(process.execPath, [installedWrapper, "--prompt-file", promptPath], {
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`, TMPDIR: wrapperTmp,
        TMP: wrapperTmp, TEMP: wrapperTmp, FAKE_INVOCATIONS: invocationLog },
      encoding: "utf8", timeout: 15000,
    }));
  }
  writeInputs("release fixture");
  fs.writeFileSync(marker, JSON.stringify(manifest));
  assert.equal(run().status, "ok");
  fs.writeFileSync(path.join(managed, "mmx", "profiles", "local.json"), "{}");
  const mixed = run();
  assert.equal(mixed.status, "install_mismatch");
  assert.equal(mixed.cli_invoked, false);
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "");
  fs.writeFileSync(path.join(managed, "mmx", "profiles", "local.json"), files["mmx/profiles/local.json"]);
  fs.writeFileSync(marker, JSON.stringify({ ...manifest, state: "installing" }));
  assert.equal(run().status, "install_mismatch");
  assert.equal(fs.readFileSync(invocationLog, "utf8"), "");
  for (const name of Object.keys(files)) unlinkKnown(path.join(managed, name));
  unlinkKnown(marker);
  for (const name of ["agy/scripts", "agy", "mmx/scripts", "mmx/profiles", "mmx",
                      "cross-validation/scripts", "cross-validation"]) fs.rmdirSync(path.join(managed, name));
  fs.rmdirSync(managed);
});
