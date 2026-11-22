"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { resolveLaunch, isolatedEnv, setupMacKeychain, resolveMode, terminateTree, windowsCommandLineLength, findCli, DENIED_TOOLS } = require("../scripts/zcode-chat.js");
const { validateReview, strictJson } = require("../scripts/review.js");

const wrapper = path.resolve(__dirname, "../scripts/zcode-chat.js");
const fixture = path.resolve(__dirname, "fixtures/fake-zcode.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-offline-"));
fs.chmodSync(root, 0o700);
const driver = path.join(root, "driver.cjs");
// Integration tests use the real entry function but never access a real keychain.
fs.writeFileSync(driver, `require(${JSON.stringify(wrapper)}).main(process.argv.slice(2), {setupMacKeychain:()=>null}).then(result=>{process.stdout.write(JSON.stringify(result)+'\\n');process.exitCode=['ok','usage','version'].includes(result.status)?0:1;});`);
let counter = 0;

function run(scenario = "ok", options = {}) {
  const directory = path.join(root, String(counter++));
  fs.mkdirSync(directory, { mode: 0o700 });
  const cli = path.join(directory, "fake cli.cjs");
  fs.writeFileSync(cli, `require(${JSON.stringify(fixture)}).run(${JSON.stringify(scenario)});`);
  const prompt = path.join(directory, "prompt.txt");
  fs.writeFileSync(prompt, options.bytes ?? options.prompt ?? "中文🌟 `literal` $(do-not-run) /logout\n--model remains data");
  const output = path.join(directory, "run");
  const args = [driver, "--prompt-file", prompt, "--cli-path", cli, "--output-dir", output];
  if (options.review) {
    const ids = path.join(directory, "ids.json");
    fs.writeFileSync(ids, JSON.stringify(["E1"]));
    args.push("--mode", options.review, "--evidence-ids-file", ids);
  }
  if (options.timeout) args.push("--timeout-seconds", String(options.timeout));
  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, ZCODE_MODEL: "must-not-reach-child", FAKE_UNTRUSTED: "must-not-reach-child", ...options.env },
    encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.stderr, "");
  const receipt = JSON.parse(result.stdout);
  return { result, receipt, output };
}

test("UTF-8, literal shell syntax and slash commands remain data; isolation is effective", () => {
  const { result, receipt, output } = run();
  assert.equal(result.status, 0);
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.model, "GLM-test");
  assert.equal(receipt.model_identity_source, "runtime.model_request");
  assert.equal(receipt.stop_reason, "stop");
  assert.equal(receipt.text, "中文🌟 `literal` $(do-not-run) /logout\n--model remains data");
  assert.equal(receipt.complete, true);
  assert.equal(receipt.cleanup_confirmed, process.platform === "win32" ? null : true);
  assert.deepEqual(receipt.usage, { inputTokens: 12, outputTokens: 4 });
  for (const name of ["stdout.ndjson", "stderr.log", "receipt.json", "prompt.txt", "launch.json", "progress.json"]) {
    assert.ok(fs.existsSync(path.join(output, name)));
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(output, name)).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "progress.json"))).phase, "finished");
});

for (const [scenario, status] of Object.entries({
  missing_model: "schema_mismatch", missing_stop: "schema_mismatch", missing_turn: "schema_mismatch",
  missing_result: "schema_mismatch", duplicate_turn: "schema_mismatch", duplicate_result: "schema_mismatch",
  mismatch: "schema_mismatch", trailing: "schema_mismatch", badjson: "schema_mismatch", invalid_utf8: "schema_mismatch",
  cancelled: "schema_mismatch", tool: "policy_violation", exposed_tools: "policy_violation", permission: "policy_violation",
  nonzero: "cli_error", stderr: "cli_error", auth: "auth_error", quota: "quota_error", version: "unsupported_cli",
  runtime_version_bad: "unsupported_cli", truncated: "incomplete",
})) test(`rejects ${scenario}`, () => {
  const { result, receipt } = run(scenario);
  assert.equal(result.status, 1);
  assert.equal(receipt.status, status);
  assert.equal(receipt.complete, false);
  assert.equal(receipt.review_gate, "NOT_EVALUATED");
  assert.ok(!JSON.stringify(receipt).includes("synthetic-private-value"));
});

test("split UTF-8 and large replies are retained without silent truncation", () => {
  assert.equal(run("split_utf8").receipt.status, "ok");
  const receipt = run("large").receipt;
  assert.equal(receipt.text, "中文🌟".repeat(80000));
  assert.equal(receipt.truncated, false);
});
test("missing usage stays null", () => assert.equal(run("missing_usage").receipt.usage, null));
test("the two-line runtime version is accepted on the second line", () => {
  const { receipt } = run("runtime_version_ok");
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.cli_version, "0.17.1");
});
test("a runtime version other than the supported one is rejected", () => {
  const { receipt } = run("runtime_version_bad");
  assert.equal(receipt.status, "unsupported_cli");
  assert.equal(receipt.cli_invoked, false);
});
test("the permission mode is platform-specific, overridable and recorded", () => {
  assert.equal(resolveMode({}, "win32"), "guarded");
  assert.equal(resolveMode({}, "darwin"), "plan");
  assert.equal(resolveMode({}, "linux"), "plan");
  assert.equal(resolveMode({ ZCODE_CLI_MODE: "plan" }, "win32"), "plan");
  assert.equal(resolveMode({ ZCODE_CLI_MODE: "guarded" }, "darwin"), "guarded");
  assert.throws(() => resolveMode({ ZCODE_CLI_MODE: "yolo" }, "win32"), { status: "usage_error" });
  assert.throws(() => resolveMode({ ZCODE_CLI_MODE: "build" }, "darwin"), { status: "usage_error" });
});
test("native network status frames sharing model IDs are not misclassified as ModelRequest", () => {
  const { receipt } = run("network_events");
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.model, "GLM-test");
  assert.equal(receipt.tool_requests, 0);
});
test("invalid input is rejected before CLI invocation", () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from("a\0b"), Buffer.alloc(0)]) {
    const { receipt } = run("ok", { bytes });
    assert.notEqual(receipt.status, "ok");
    assert.equal(receipt.cli_invoked, false);
  }
});
test("UTF-8 BOM is decoded without changing the question", () => {
  assert.equal(run("ok", { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文")]) }).receipt.text, "中文");
});
test("existing output directories remain untouched", () => {
  const directory = path.join(root, "existing-output");
  fs.mkdirSync(directory);
  const prompt = path.join(root, "existing-prompt.txt");
  fs.writeFileSync(prompt, "question");
  const cli = path.join(root, "existing-fake.cjs");
  fs.writeFileSync(cli, `require(${JSON.stringify(fixture)}).run("ok");`);
  const result = spawnSync(process.execPath, [wrapper, "--prompt-file", prompt, "--cli-path", cli, "--output-dir", directory], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).cli_invoked, false);
  assert.deepEqual(fs.readdirSync(directory), []);
});
test("installed manifest mismatch blocks model invocation", () => {
  const directory = path.join(root, "install-fixture");
  const names = ["SKILL.md", "scripts/zcode-chat.js", "scripts/zcode-run.js", "scripts/zcode-batch.js", "scripts/review.js", "references/review-v1.schema.json"];
  const files = {};
  for (const name of names) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = fs.readFileSync(path.resolve(__dirname, "..", name));
    fs.writeFileSync(target, data);
    // The manifest hashes LF-normalized content, so the same manifest verifies
    // a CRLF checkout and an LF checkout of the same file.
    files[name] = createHash("sha256").update(data.toString("utf8").replace(/\r\n/g, "\n"), "utf8").digest("hex");
  }
  fs.writeFileSync(path.join(directory, ".zcode-release.json"), JSON.stringify({ format: 1, files }));
  const baseline = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(directory, "scripts/zcode-chat.js"))}).checkInstall();`], { encoding: "utf8" });
  assert.equal(baseline.status, 0, baseline.stderr);
  fs.appendFileSync(path.join(directory, "SKILL.md"), "\nchanged\n");
  const result = spawnSync(process.execPath, [path.join(directory, "scripts/zcode-chat.js"), "--prompt-file", "unused.txt"], { encoding: "utf8" });
  const receipt = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(receipt.status, "install_mismatch");
  assert.equal(receipt.cli_invoked, false);
});
test("one manifest verifies both a CRLF and an LF copy of the same file", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "SKILL.md"));
  const lf = source.toString("utf8").replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.notEqual(lf, crlf, "the fixture must exercise a real line-ending difference");
  const directory = path.join(root, "eol-fixture");
  fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(directory, "references"), { recursive: true });
  // Copy the real wrapper so checkInstall runs its actual verification path.
  const wrapperSource = fs.readFileSync(path.resolve(__dirname, "..", "scripts/zcode-chat.js"));
  const reviewSource = fs.readFileSync(path.resolve(__dirname, "..", "scripts/review.js"));
  const schemaSource = fs.readFileSync(path.resolve(__dirname, "..", "references/review-v1.schema.json"));
  fs.writeFileSync(path.join(directory, "scripts/zcode-chat.js"), wrapperSource);
  fs.writeFileSync(path.join(directory, "scripts/review.js"), reviewSource);
  fs.writeFileSync(path.join(directory, "scripts/zcode-run.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(directory, "scripts/zcode-batch.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(directory, "references/review-v1.schema.json"), schemaSource);
  const digest = data => createHash("sha256").update(data.toString("utf8").replace(/\r\n/g, "\n"), "utf8").digest("hex");
  fs.writeFileSync(path.join(directory, ".zcode-release.json"), JSON.stringify({
    format: 1,
    files: {
      "SKILL.md": digest(Buffer.from(lf, "utf8")),
      "scripts/zcode-chat.js": digest(wrapperSource),
      "scripts/zcode-run.js": digest(Buffer.from("module.exports = {};\n", "utf8")),
      "scripts/zcode-batch.js": digest(Buffer.from("module.exports = {};\n", "utf8")),
      "scripts/review.js": digest(reviewSource),
      "references/review-v1.schema.json": digest(schemaSource),
    },
  }));
  const check = () => spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(directory, "scripts/zcode-chat.js"))}).checkInstall();`], { encoding: "utf8" });
  fs.writeFileSync(path.join(directory, "SKILL.md"), Buffer.from(crlf, "utf8"));
  assert.equal(check().status, 0, "a CRLF checkout must pass the manifest");
  fs.writeFileSync(path.join(directory, "SKILL.md"), Buffer.from(lf, "utf8"));
  assert.equal(check().status, 0, "an LF checkout must pass the same manifest");
});
test("timeout terminates the child process group", () => {
  const { receipt } = run("hang", { timeout: 0.2 });
  assert.equal(receipt.status, "timeout");
  assert.equal(receipt.complete, false);
  assert.equal(receipt.cleanup_confirmed, true);
});
test("timeout also kills a descendant ignoring SIGTERM", { skip: process.platform === "win32" }, () => {
  const { receipt, output } = run("tree", { timeout: 0.4 });
  assert.equal(receipt.status, "timeout");
  const pid = Number(fs.readFileSync(path.join(output, "child.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
for (const mode of ["review", "challenge"]) test(`${mode} validates review-v1 with evidence IDs`, () => {
  const receipt = run("ok", { review: mode }).receipt;
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.review_gate, "PASS");
  assert.deepEqual(receipt.review.findings, []);
  const invalid = run("review_bad", { review: mode }).receipt;
  assert.equal(invalid.status, "review_schema_mismatch");
  assert.equal(invalid.review_gate, "NOT_EVALUATED");
  assert.equal(invalid.text, "not a review");
  assert.ok(typeof invalid.review_error === "string" && invalid.review_error.length > 0 && invalid.review_error.length <= 300);
});
test("default request timeout matches the MMX-paired 1200 seconds", () => {
  const { parseArgs } = require("../scripts/zcode-chat.js");
  assert.equal(parseArgs(["--prompt-file", "x"]).timeout, 1200);
  assert.equal(parseArgs(["--prompt-file", "x", "--timeout-seconds", "60"]).timeout, 60);
});

function finding(kind, severity, evidence_refs = ["E1"]) {
  return { kind, severity, evidence_refs, title: "Finding", condition: "Condition", impact: "Impact", recommendation: "Fix" };
}
function review(findings) { return JSON.stringify({ version: 1, summary: "Summary", findings }); }
test("review semantic gates match the shared protocol", () => {
  assert.equal(validateReview(review([finding("confirmed_defect", "P1")]), ["E1"]).review_gate, "FAIL");
  assert.equal(validateReview(review([finding("evidence_gap", "P1")]), ["E1"]).review_gate, "NOT_EVALUATED");
  assert.equal(validateReview(review([finding("advisory", "P2")]), ["E1"]).review_gate, "PASS");
  for (const invalid of [finding("advisory", "P1"), finding("confirmed_defect", "P1", []), finding("confirmed_defect", "P2", ["UNKNOWN"])]) {
    assert.throws(() => validateReview(review([invalid]), ["E1"]));
  }
  assert.throws(() => validateReview('{"version":1,"version":1,"summary":"x","findings":[]}', ["E1"]));
  // Regression: the 2026-11-15 cross-review rounds failed with the opaque "review field
  // type/value" because the model returned "version":"1" (string). The error must name the field.
  assert.throws(() => validateReview(review([]).replace('"version":1', '"version":"1"'), ["E1"]), /version.*expected integer/);
  assert.throws(() => strictJson('{"a":1,"\\u0061":2}'));
});
test("launcher resolution preserves isolation and refuses arbitrary shell wrappers", () => {
  const cli = path.join(root, "launcher");
  const bundle = path.join(root, "Workspace/app/zcode.cjs");
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, "");
  fs.writeFileSync(cli, '#!/bin/sh\nexec mise exec node@24.14.0 -- node "$HOME/Workspace/app/zcode.cjs" "$@"\n');
  assert.equal(resolveLaunch(cli, root).entry, fs.realpathSync(bundle));
  fs.writeFileSync(cli, "#!/bin/sh\necho dangerous\n");
  assert.throws(() => resolveLaunch(cli, root), { status: "unsupported_launcher" });
  // A batch file that is not the documented npm shim stays unsupported; the
  // batch text is never handed to a shell.
  assert.throws(() => resolveLaunch("example.cmd"), { status: "unsupported_launcher" });
});
test("npm shims resolve to their JavaScript entry instead of running a shell", () => {
  const directory = path.join(root, "npm-global");
  const script = path.join(directory, "node_modules/zcode-app-cli/bin/zcode.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  const windows = path.join(directory, "zcode.cmd");
  fs.writeFileSync(windows, '@ECHO off\r\nSETLOCAL\r\n"%_prog%" "%dp0%\\node_modules\\zcode-app-cli\\bin\\zcode.js" %*\r\n');
  const resolved = resolveLaunch(windows);
  assert.equal(resolved.command, process.execPath);
  assert.equal(resolved.entry, fs.realpathSync(script));
  assert.deepEqual(resolved.prefix, [resolved.entry]);
  const posix = path.join(directory, "zcode");
  fs.writeFileSync(posix, '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/node_modules/zcode-app-cli/bin/zcode.js" "$@"\n');
  assert.equal(resolveLaunch(posix).entry, fs.realpathSync(script));
});
test("quoted PATH directories and Chinese npm paths resolve without a shell", () => {
  const directory = path.join(root, "npm 用户 with spaces");
  const script = path.join(directory, "node_modules/zcode-app-cli/bin/zcode.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `require(${JSON.stringify(fixture)}).run("ok");`);
  const launcher = path.join(directory, process.platform === "win32" ? "zcode.cmd" : "zcode");
  fs.writeFileSync(launcher, process.platform === "win32"
    ? '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\zcode-app-cli\\bin\\zcode.js" %*\r\n'
    : '#!/bin/sh\nexec node "$basedir/node_modules/zcode-app-cli/bin/zcode.js" "$@"\n', { mode: 0o700 });
  assert.equal(findCli(null, { PATH: `"${directory}"` }), fs.realpathSync(launcher));
  const prompt = path.join(directory, "输入.txt");
  fs.writeFileSync(prompt, "Chinese 路径");
  const response = spawnSync(process.execPath, [driver, "--prompt-file", prompt, "--cli-path", launcher], { encoding: "utf8", timeout: 15000 });
  assert.equal(response.status, 0, response.stdout + response.stderr);
  assert.equal(JSON.parse(response.stdout).text, "Chinese 路径");
});
test("Windows cleanup never treats a missing root or localized taskkill failure as proof", async () => {
  let called = false;
  const exited = { pid: 123, exitCode: 0, signalCode: null };
  assert.equal(await terminateTree(exited, { platform: "win32", run: () => { called = true; } }), null);
  assert.equal(called, false);
  const live = { pid: 123, exitCode: null, signalCode: null, kill: () => {} };
  assert.equal(await terminateTree(live, { platform: "win32", kill: () => { throw Object.assign(new Error(), { code: "ESRCH" }); }, run: () => { called = true; } }), null);
  assert.equal(called, false);
  assert.equal(await terminateTree(live, { platform: "win32", kill: () => {}, run: (command, args, options) => {
    assert.equal(command, "taskkill.exe");
    assert.deepEqual(args, ["/PID", "123", "/T", "/F"]);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    return { status: 1, stderr: "错误: 没有找到进程。" };
  } }), null);
  assert.equal(await terminateTree(live, { platform: "win32", kill: () => {}, run: () => ({ status: 0 }) }), true);
});
test("Windows command-line length includes quoting expansion and UTF-16 units", () => {
  assert.equal(windowsCommandLineLength("node", ["abc"]), 9);
  assert.equal(windowsCommandLineLength("node", ['a"b']), 12);
  assert.equal(windowsCommandLineLength("node", ["a b\\"]), 13);
  assert.equal(windowsCommandLineLength("node", ["🌟"]), 8);
  assert.ok(windowsCommandLineLength("node", ['"'.repeat(17000)]) > 32767);
});
test("Windows oversized and quote-expanded prompts fail before a model request", { skip: process.platform !== "win32" }, () => {
  for (const prompt of ["a".repeat(25000), '"'.repeat(11000)]) {
    const { receipt } = run("ok", { prompt });
    assert.equal(receipt.status, "input_too_large");
    assert.equal(receipt.cli_invoked, false);
    assert.equal(receipt.review_gate, "NOT_EVALUATED");
  }
});
test("a cancellation marker prevents the CLI request", () => {
  const marker = path.join(root, "pre-cancel.request");
  fs.writeFileSync(marker, "cancel\n");
  const { receipt } = run("ok", { env: { ZCODE_CANCEL_REQUEST_FILE: marker } });
  assert.equal(receipt.status, "cancelled");
  assert.equal(receipt.cli_invoked, false);
});

test("capture descriptors close after late cancellation, second-open failure and progress failure", () => {
  for (const scenario of ["late_cancel", "stderr_open", "running_progress"]) {
    const directory = path.join(root, `capture-failure-${scenario}`);
    fs.mkdirSync(directory);
    const cli = path.join(directory, "fake.cjs"), prompt = path.join(directory, "prompt.txt");
    const marker = path.join(directory, "cancel.request"), output = path.join(directory, "run");
    const instrumented = path.join(directory, "capture-driver.cjs");
    fs.writeFileSync(cli, `require(${JSON.stringify(fixture)}).run("hang");`);
    fs.writeFileSync(prompt, "capture cleanup check");
    fs.writeFileSync(instrumented, `
      const fs=require('node:fs'), path=require('node:path');
      const wrapper=require(${JSON.stringify(wrapper)});
      const originalOpen=fs.openSync, originalClose=fs.closeSync, originalRename=fs.renameSync;
      const openCaptures=new Set();
      const scenario=${JSON.stringify(scenario)};
      let progressFailed=false;
      fs.openSync=function(file,...args){
        const name=typeof file==='string'?path.basename(file):'';
        if(scenario==='stderr_open'&&name==='stderr.log') throw Object.assign(new Error('synthetic open failure'),{code:'EACCES'});
        const fd=originalOpen.call(this,file,...args);
        if(['stdout.ndjson','stderr.log'].includes(name)) openCaptures.add(fd);
        if(scenario==='late_cancel'&&name==='stderr.log') fs.writeFileSync(${JSON.stringify(marker)},'cancel\\n');
        return fd;
      };
      fs.closeSync=function(fd){const result=originalClose.call(this,fd);openCaptures.delete(fd);return result;};
      fs.renameSync=function(from,to){
        if(scenario==='running_progress'&&!progressFailed&&path.basename(to)==='progress.json'&&JSON.parse(fs.readFileSync(from,'utf8')).phase==='running'){
          progressFailed=true;throw Object.assign(new Error('synthetic progress failure'),{code:'EACCES'});
        }
        return originalRename.call(this,from,to);
      };
      wrapper.main(process.argv.slice(2),{setupMacKeychain:()=>null}).then(receipt=>{
        fs.openSync=originalOpen;fs.closeSync=originalClose;fs.renameSync=originalRename;
        const leaked=[...openCaptures];
        for(const fd of leaked){try{originalClose(fd);}catch{}}
        process.stdout.write(JSON.stringify({receipt,leaked})+'\\n');
      });
    `);
    const response = spawnSync(process.execPath, [instrumented, "--prompt-file", prompt, "--cli-path", cli, "--output-dir", output], {
      encoding: "utf8", timeout: 15000, env: { ...process.env, ZCODE_CANCEL_REQUEST_FILE: marker },
    });
    assert.equal(response.status, 0, response.stdout + response.stderr);
    const result = JSON.parse(response.stdout);
    assert.deepEqual(result.leaked, [], scenario);
    assert.equal(result.receipt.complete, false);
    if (scenario === "late_cancel") {
      assert.equal(result.receipt.status, "cancelled");
      assert.equal(result.receipt.cli_invoked, false);
    }
  }
});

async function waitUntil(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test state");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("cooperative marker cancellation stops the real wrapper's CLI tree and retains receipt", { timeout: 20000 }, async () => {
  const directory = path.join(root, `marker-tree-${counter++}`);
  fs.mkdirSync(directory);
  const cli = path.join(directory, "fake.cjs"), prompt = path.join(directory, "prompt.txt");
  const output = path.join(directory, "run"), marker = path.join(directory, "cancel.request");
  fs.writeFileSync(cli, `require(${JSON.stringify(fixture)}).run("tree");`);
  fs.writeFileSync(prompt, "cancel this fake request");
  const child = spawn(process.execPath, [driver, "--prompt-file", prompt, "--cli-path", cli, "--output-dir", output], {
    env: { ...process.env, ZCODE_CANCEL_REQUEST_FILE: marker }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.resume();
  const ended = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  let descendant;
  try {
    await waitUntil(() => fs.existsSync(path.join(output, "child.pid")));
    descendant = Number(fs.readFileSync(path.join(output, "child.pid"), "utf8"));
    fs.writeFileSync(marker, "cancel\n");
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
    assert.equal((await ended).code, 1);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.status, "cancelled");
    assert.equal(receipt.complete, false);
    assert.equal(receipt.cleanup_confirmed, true);
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, "receipt.json"), "utf8")).status, "cancelled");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch {} }
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
  }
});
test("environment shares only auth roots and explicit supported transport settings", () => {
  const env = isolatedEnv("/scratch/home", { PATH: "/bin", NODE_OPTIONS: "bad", ZCODE_STORAGE_DIR: "/original", ZCODE_HTTP_PROXY: "http://proxy.example", ZCODE_DATA_BASE_DIR: "/auth" });
  assert.equal(env.HOME, "/scratch/home");
  assert.equal(env.ZCODE_DATA_BASE_DIR, "/auth");
  assert.equal(env.ZCODE_HTTP_PROXY, "http://proxy.example");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.notEqual(env.ZCODE_STORAGE_DIR, "/original");
  assert.ok(DENIED_TOOLS.includes("escalate"));
});
test("the auth bridge stays inert off macOS and reports a lookup failure", () => {
  const home = path.join(root, "mac-home-inert");
  assert.equal(setupMacKeychain(home, "linux", () => { throw new Error("must not run"); }), null);
  assert.equal(setupMacKeychain(home, "win32", () => { throw new Error("must not run"); }), null);
  assert.throws(() => setupMacKeychain(home, "darwin", () => ({ status: 1 })), { status: "auth_environment_error" });
});
// The macOS branch links a file, which needs POSIX symlink semantics. On
// Windows the same call needs elevated rights, so the link itself is asserted
// where it can be created.
test("macOS auth bridge links the existing default keychain without copying or changing it", { skip: process.platform === "win32" }, () => {
  const home = path.join(root, "mac-home");
  const store = path.join(root, "synthetic.keychain-db");
  fs.writeFileSync(store, "synthetic-store");
  const fakeSecurity = (command, args, options) => {
    assert.equal(command, "/usr/bin/security");
    assert.deepEqual(args, ["default-keychain", "-d", "user"]);
    assert.equal(options.shell, false);
    return { status: 0, stdout: JSON.stringify(store) + "\n" };
  };
  assert.equal(setupMacKeychain(home, "darwin", fakeSecurity), "existing-default-keychain-link");
  const link = path.join(home, "Library/Keychains/login.keychain-db");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.realpathSync(link), fs.realpathSync(store));
  assert.equal(fs.readFileSync(store, "utf8"), "synthetic-store");
});
test("empty invocation and version do not invoke a CLI", () => {
  for (const args of [[], ["--version"]]) {
    const result = spawnSync(process.execPath, [wrapper, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.ok(["usage", "version"].includes(JSON.parse(result.stdout).status));
  }
});

const supervisor = require("../scripts/zcode-run.js");
async function runSupervised(scenario, timeout = 2) {
  const directory = path.join(root, `supervised-${counter++}`);
  fs.mkdirSync(directory);
  const cli = path.join(directory, "fake.cjs");
  const prompt = path.join(directory, "prompt.txt");
  fs.writeFileSync(cli, `require(${JSON.stringify(fixture)}).run(${JSON.stringify(scenario)});`);
  fs.writeFileSync(prompt, "supervised question");
  const job = path.join(directory, "job");
  const launch = supervisor.start(job, ["--prompt-file", prompt, "--cli-path", cli, "--timeout-seconds", String(timeout)], { wrapperPath: driver });
  assert.ok(Number.isSafeInteger(launch.supervisor_pid));
  const deadline = Date.now() + 10000;
  let result;
  do {
    await new Promise(resolve => setTimeout(resolve, 30));
    result = supervisor.status(job);
  } while (["running", "unknown"].includes(result.status) && Date.now() < deadline);
  return { result, job };
}
test("durable supervisor keeps a real exit receipt and complete wrapper reply", async () => {
  const { result } = await runSupervised("network_events");
  assert.equal(result.status, "finished");
  assert.equal(result.execution.exit_code, 0);
  assert.equal(result.execution.signal, null);
  assert.equal(result.receipt.status, "ok");
  assert.equal(result.receipt.text, "supervised question");
});
test("supervisor preserves nonzero timeout and child cleanup evidence", async () => {
  const { result } = await runSupervised("hang", 0.2);
  assert.equal(result.status, "finished");
  assert.equal(result.execution.exit_code, 1);
  assert.equal(result.receipt.status, "timeout");
  assert.equal(result.receipt.cleanup_confirmed, true);
});
test("durable cancellation uses a marker and lets the wrapper save its receipt", { timeout: 20000 }, async () => {
  const directory = path.join(root, `supervised-cancel-${counter++}`);
  fs.mkdirSync(directory);
  const cli = path.join(directory, "fake.cjs"), prompt = path.join(directory, "prompt.txt"), job = path.join(directory, "job");
  fs.writeFileSync(cli, `require(${JSON.stringify(fixture)}).run("hang");`);
  fs.writeFileSync(prompt, "original prompt");
  supervisor.start(job, ["--prompt-file", prompt, "--cli-path", cli], { wrapperPath: driver });
  await waitUntil(() => {
    try { return JSON.parse(fs.readFileSync(path.join(job, "run/progress.json"), "utf8")).phase === "running"; } catch { return false; }
  });
  const cancel = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/zcode-run.js"), "cancel", job], { encoding: "utf8" });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).cancel_requested, true);
  await waitUntil(() => supervisor.status(job).status === "finished");
  const result = supervisor.status(job);
  assert.equal(result.execution.reason, "cancelled");
  assert.equal(result.execution.exit_code, 1);
  assert.equal(result.receipt.status, "cancelled");
  assert.equal(result.receipt.cleanup_confirmed, true);
  assert.equal(supervisor.cancel(job).cancel_requested, false);
});
test("cancel during version preflight preserves a no-model receipt even when the probe fails", { timeout: 20000 }, async () => {
  for (const versionExit of [0, 1]) {
    const directory = path.join(root, `preflight-cancel-${counter++}`);
    fs.mkdirSync(directory);
    const cli = path.join(directory, "fake.cjs"), prompt = path.join(directory, "prompt.txt"), job = path.join(directory, "job");
    const ready = path.join(directory, "version-ready"), release = path.join(directory, "version-release");
    const finished = path.join(directory, "version-finished"), invoked = path.join(directory, "model-invoked");
    fs.writeFileSync(cli, `
      const fs=require('node:fs');
      if(process.argv.includes('--version')){
        fs.writeFileSync(${JSON.stringify(ready)},'ready');
        const poll=setInterval(()=>{
          if(fs.existsSync(${JSON.stringify(release)})){
            clearInterval(poll);fs.writeFileSync(${JSON.stringify(finished)},'finished');
            process.stdout.write('0.17.1\\n');process.exitCode=${versionExit};
          }
        },20);
      }else{fs.writeFileSync(${JSON.stringify(invoked)},'unexpected model request');process.exitCode=9;}
    `);
    fs.writeFileSync(prompt, "cancel while preparation is blocked");
    supervisor.start(job, ["--prompt-file", prompt, "--cli-path", cli], { wrapperPath: driver });
    await waitUntil(() => fs.existsSync(ready));
    supervisor.cancel(job);
    // Keep the version probe in flight while the worker observes the marker.
    // The old immediate process-group SIGTERM killed this probe and wrapper.
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.writeFileSync(release, "finish preflight");
    await waitUntil(() => supervisor.status(job).status === "finished");
    const result = supervisor.status(job);
    assert.equal(result.execution.exit_code, 1);
    assert.equal(result.execution.reason, "cancelled");
    assert.equal(result.execution.receipt_exists, true);
    assert.equal(result.receipt.status, "cancelled");
    assert.equal(result.receipt.cli_invoked, false);
    assert.equal(result.receipt.complete, false);
    assert.equal(fs.existsSync(finished), true, "version probe gets its cooperative grace");
    assert.equal(fs.existsSync(invoked), false, "cancellation must never launch the model");
  }
});
test("failed worker launch stays unknown and preserves explicit launch evidence", async () => {
  const { EventEmitter } = require("node:events");
  for (const synchronous of [false, true]) {
    const directory = path.join(root, `launch-failure-${counter++}`);
    fs.mkdirSync(directory);
    const prompt = path.join(directory, "prompt.txt"), job = path.join(directory, "job");
    fs.writeFileSync(prompt, "must never start");
    const spawnWorker = (command, args, options) => {
      assert.equal(options.windowsHide, true);
      const error = Object.assign(new Error("synthetic launch failure"), { code: "EAGAIN" });
      if (synchronous) throw error;
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("error", error));
      return child;
    };
    const launched = supervisor.start(job, ["--prompt-file", prompt], { spawnWorker });
    assert.equal(launched.status, "unknown");
    assert.equal(launched.supervisor_pid, null);
    await new Promise(resolve => setImmediate(resolve));
    const result = supervisor.status(job);
    assert.equal(result.status, "unknown");
    assert.equal(result.launch_error.code, "EAGAIN");
    assert.equal(result.launch_error.cli_invoked, false);
    assert.equal(fs.existsSync(path.join(job, "started.json")), false);
  }
});
test("post-spawn started.json EACCES/ENOSPC/EEXIST failures cancel the owned wrapper and preserve a permanent claim", { timeout: 30000 }, async () => {
  for (const code of ["EACCES", "ENOSPC", "EEXIST"]) {
    const directory = path.join(root, "started-publish-" + code + "-" + counter++);
    fs.mkdirSync(directory);
    const prompt = path.join(directory, "prompt.txt");
    const wrapperScript = path.join(directory, "fake-wrapper.cjs");
    const preload = path.join(directory, "inject-started-failure.cjs");
    const invocationLog = path.join(directory, "wrapper-calls.log");
    const childEnded = path.join(directory, "child-ended");
    const workerEnded = path.join(directory, "worker-ended");
    const job = path.join(directory, "job");
    fs.writeFileSync(prompt, "SYNTHETIC POST SPAWN\r\n");
    fs.writeFileSync(wrapperScript, `
      const fs = require("node:fs");
      const log = ${JSON.stringify(invocationLog)};
      const ended = ${JSON.stringify(childEnded)};
      fs.appendFileSync(log, "invoked\\n");
      const timer = setInterval(() => {
        if (!fs.existsSync(process.env.ZCODE_CANCEL_REQUEST_FILE)) return;
        clearInterval(timer);
        fs.writeFileSync(ended, "cancel seen");
        process.exitCode = 1;
      }, 20);
    `);
    fs.writeFileSync(preload, `
      if (process.argv[2] === "worker" && /zcode-run\\.js$/.test(process.argv[1])) {
        const fs = require("node:fs"), path = require("node:path");
        process.on("exit", () => fs.writeFileSync(${JSON.stringify(workerEnded)}, "finished"));
        const link = fs.linkSync;
        fs.linkSync = function(from, to) {
          if (path.basename(to) === "started.json") {
            throw Object.assign(new Error("synthetic " + ${JSON.stringify(code)}), { code: ${JSON.stringify(code)} });
          }
          return link.apply(this, arguments);
        };
      }
    `);
    const saved = process.env.NODE_OPTIONS;
    let launch;
    try {
      process.env.NODE_OPTIONS = "--require " + JSON.stringify(preload);
      launch = supervisor.start(job, ["--prompt-file", prompt], { wrapperPath: wrapperScript });
    } finally {
      if (saved === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = saved;
    }
    assert.equal(launch.status, "started");
    await waitUntil(() => fs.existsSync(path.join(job, "cancel.request")));
    await waitUntil(() => fs.existsSync(path.join(job, "worker.lock")));
    await waitUntil(() => fs.existsSync(workerEnded), 8000);
    assert.equal(supervisor.status(job).status, "unknown", code);
    assert.equal(fs.existsSync(path.join(job, "execution.json")), false, code);
    const before = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog,"utf8") : "";
    const replay = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/zcode-run.js"), "worker", job], { encoding: "utf8" });
    assert.equal(replay.status, 1, code);
    const after = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog,"utf8") : "";
    assert.equal(after, before, code);
    assert.equal(fs.existsSync(path.join(job, "worker.lock")), true, code);
    if (before) assert.equal(fs.existsSync(childEnded), true, "owned child observed cooperative cancellation");
  }
});
test("missing worker lock but existing execution evidence blocks replay", () => {
  const directory = path.join(root, "missing-worker-claim-evidence-" + counter++);
  fs.mkdirSync(directory);
  const prompt = path.join(directory, "prompt.txt"), job = path.join(directory, "job");
  fs.writeFileSync(prompt, "SYNTHETIC INPUT");
  const launch = supervisor.start(job, ["--prompt-file", prompt], { spawnWorker: () => {
    const { EventEmitter } = require("node:events");
    const mock = new EventEmitter(); mock.unref = () => {}; return mock;
  }});
  assert.equal(launch.status, "unknown");
  fs.writeFileSync(path.join(job, "started.json"), '{"wrapper_pid":123}');
  const run = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/zcode-run.js"), "worker", job], { encoding:"utf8" });
  assert.equal(run.status,1);
  assert.equal(fs.existsSync(path.join(job,"worker.lock")),false);
});
test("durable jobs snapshot inputs and a second worker cannot replay the request", async () => {
  const directory = path.join(root, `supervised-inputs-${counter++}`);
  fs.mkdirSync(directory);
  const cli = path.join(directory, "fake.cjs"), prompt = path.join(directory, "prompt.txt"), job = path.join(directory, "job");
  fs.writeFileSync(cli, `require(${JSON.stringify(fixture)}).run("ok");`);
  fs.writeFileSync(prompt, "accepted content");
  supervisor.start(job, ["--prompt-file", prompt, "--cli-path", cli], { wrapperPath: driver });
  fs.writeFileSync(prompt, "edited after launch");
  await waitUntil(() => supervisor.status(job).status === "finished");
  const result = supervisor.status(job);
  assert.equal(result.receipt.text, "accepted content");
  const execution = fs.readFileSync(path.join(job, "execution.json"), "utf8");
  const replay = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/zcode-run.js"), "worker", job], { encoding: "utf8" });
  assert.equal(replay.status, 1);
  assert.equal(fs.readFileSync(path.join(job, "execution.json"), "utf8"), execution);
});
test("Windows PID reuse alone cannot establish that a durable job is running", { skip: process.platform !== "win32" }, () => {
  const job = path.join(root, `reused-pid-${counter++}`);
  fs.mkdirSync(job);
  fs.writeFileSync(path.join(job, "launch.json"), JSON.stringify({ supervisor_pid: process.pid }));
  assert.equal(supervisor.status(job).status, "unknown");
});
test("abrupt wrapper death leaves startup state and independently captured signal", { skip: process.platform === "win32" }, async () => {
  const { result, job } = await runSupervised("kill_wrapper");
  assert.equal(result.status, "unknown", "missing wrapper receipt cannot publish completion");
  assert.equal(result.receipt, undefined);
  assert.equal(supervisor.verify(job).integrity, "incomplete");
  assert.equal(JSON.parse(fs.readFileSync(path.join(job, "execution.json"))).receipt_exists, false);
  const progress = JSON.parse(fs.readFileSync(path.join(job, "run/progress.json")));
  assert.equal(progress.phase, "running");
  assert.ok(progress.wrapper_pid > 0);
  assert.ok(progress.cli_pid > 0);
});
test("supervisor refuses caller output overrides and existing job directories", () => {
  assert.throws(() => supervisor.start(path.join(root, "unused"), ["--prompt-file", "unused", "--output-dir", "other"]));
  assert.throws(() => supervisor.start(root, ["--prompt-file", "unused"]));
});
test("truncated receipt never hides the independently recorded exit status", () => {
  const job = path.join(root, "truncated-receipt-job");
  fs.mkdirSync(path.join(job, "run"), { recursive: true });
  fs.writeFileSync(path.join(job, "launch.json"), JSON.stringify({ supervisor_pid: 99999999 }));
  fs.writeFileSync(path.join(job, "execution.json"), JSON.stringify({ exit_code: null, signal: "SIGKILL", receipt_exists: true }));
  fs.writeFileSync(path.join(job, "run/receipt.json"), '{"status":');
  const result = supervisor.status(job);
  assert.equal(result.status, "finished");
  assert.equal(result.execution.signal, "SIGKILL");
  assert.equal(result.receipt_unreadable, true);
  assert.equal(result.receipt, undefined);
});
test("a supervisor that exits during the liveness probe is reported as finished", () => {
  for (const probe of [false, null]) {
    const job = path.join(root, `finishing-job-${counter++}`);
    fs.mkdirSync(job);
    fs.writeFileSync(path.join(job, "launch.json"), JSON.stringify({ supervisor_pid: 99999999 }));
    // The worker saves execution.json and only then exits, so a probe that
    // finds the supervisor gone can come right after the job finished.
    const isAlive = () => {
      fs.writeFileSync(path.join(job, "execution.json"), JSON.stringify({ exit_code: 0, signal: null, reason: "child_exit", receipt_exists: false }));
      return probe;
    };
    const result = supervisor.status(job, { isAlive });
    assert.equal(result.status, "finished", `probe=${probe}`);
    assert.equal(result.execution.exit_code, 0);
    assert.equal(result.supervisor_alive, undefined);
  }
});
test("without execution.json the liveness probe decides running, interrupted or unknown", () => {
  const job = path.join(root, "probe-only-job");
  fs.mkdirSync(job);
  fs.writeFileSync(path.join(job, "launch.json"), JSON.stringify({ supervisor_pid: 99999999 }));
  for (const [probe, state] of [[true, "running"], [false, "interrupted"], [null, "unknown"]]) {
    const result = supervisor.status(job, { isAlive: () => probe });
    assert.equal(result.status, state);
    assert.equal(result.supervisor_alive, probe);
  }
  // The default probe sees that pid 99999999 does not exist.
  assert.equal(supervisor.status(job).status, "interrupted");
});
test("launch publication failure cancels before any wrapper invocation", { timeout: 15000 }, async () => {
  const directory=path.join(root,"launch-failure-"+counter++);
  fs.mkdirSync(directory);
  const prompt=path.join(directory,"prompt.txt"),job=path.join(directory,"job");
  const injector=path.join(directory,"inject.cjs"),fake=path.join(directory,"fake-wrapper.cjs");
  const called=path.join(directory,"wrapper-started"),script=path.resolve(__dirname,"../scripts/zcode-run.js");
  fs.writeFileSync(prompt,"SYNTHETIC ONLY");
  fs.writeFileSync(fake,"require('node:fs').writeFileSync("+JSON.stringify(called)+",'SENT');process.exit(40);");
  fs.writeFileSync(injector,`
    const fs=require("node:fs"),path=require("node:path"),old=fs.linkSync;
    fs.linkSync=function(from,to){
      if(path.basename(to)==="launch.json")throw Object.assign(new Error("synthetic EACCES"),{code:"EACCES"});
      return old.apply(this,arguments);
    };
  `);
  const code=`
    const s=require(${JSON.stringify(script)});
    try{s.start(${JSON.stringify(job)},["--prompt-file",${JSON.stringify(prompt)}],
      {wrapperPath:${JSON.stringify(fake)}});process.exit(40);}
    catch{process.exit(0);}
  `;
  const result=spawnSync(process.execPath,["--require",injector,"-e",code],{encoding:"utf8",timeout:12000});
  assert.equal(result.status,0,result.stderr);
  await waitUntil(()=>fs.existsSync(path.join(job,"cancel.request")),5000);
  assert.equal(fs.existsSync(path.join(job,"launch.json")),false);
  assert.equal(fs.existsSync(called),false,"wrapper must never be invoked");
  assert.equal(supervisor.status(job).status,"unknown");
  assert.equal(supervisor.verify(job).integrity,"incomplete");
});

test("new job records exact raw bytes, pinned role paths, and immutable request digest", () => {
  const directory=path.join(root,"raw-job-"+counter++);
  fs.mkdirSync(directory);
  const prompt=path.join(directory,"raw-prompt.txt"), job=path.join(directory,"job");
  const bytes=Buffer.from("\ufeff中文\r\nBOM+CRLF\r\n","utf8");
  fs.writeFileSync(prompt,bytes);
  const { EventEmitter } = require("node:events");
  supervisor.start(job,["--prompt-file",prompt],{spawnWorker:()=>{
    const child=new EventEmitter();child.unref=()=>{};return child;
  }});
  const request=JSON.parse(fs.readFileSync(path.join(job,"request.json"),"utf8"));
  const hash=b=>require("node:crypto").createHash("sha256").update(b).digest("hex");
  assert.equal(request.format,2);
  assert.equal(request.inputs[0].sha256,hash(bytes));
  assert.equal(request.inputs[0].bytes,bytes.length);
  assert.deepEqual(fs.readFileSync(request.inputs[0].file),bytes);
  assert.equal(request.args[request.inputs[0].index],request.inputs[0].file);
  assert.equal(JSON.parse(fs.readFileSync(path.join(job,"request-digest.json"))).sha256,
    hash(fs.readFileSync(path.join(job,"request.json"))));
  assert.notEqual(hash(bytes),hash(Buffer.from(bytes.toString("utf8").replace(/\r\n/g,"\n"))),
    "job digests must not use the CRLF-normalized release hash");
  assert.equal(supervisor.verify(job).integrity,"incomplete");
});

test("pinned input, request digest and role edits prevent worker execution", () => {
  const { EventEmitter }=require("node:events");
  const script=path.resolve(__dirname,"../scripts/zcode-run.js");
  for(const kind of ["snapshot","request","role"]) {
    const directory=path.join(root,"pinned-tamper-"+kind+"-"+counter++);
    fs.mkdirSync(directory);
    const prompt=path.join(directory,"raw.txt"),job=path.join(directory,"job");
    fs.writeFileSync(prompt,"SAFE\r\n");
    supervisor.start(job,["--prompt-file",prompt],{spawnWorker:()=>{
      const mock=new EventEmitter();mock.unref=()=>{};return mock;
    }});
    const requestFile=path.join(job,"request.json");
    const request=JSON.parse(fs.readFileSync(requestFile,"utf8"));
    if(kind==="snapshot")fs.writeFileSync(request.inputs[0].file,"SAFE\n");
    else if(kind==="request")fs.appendFileSync(requestFile," ");
    else {
      request.args[request.inputs[0].index]=prompt;
      fs.writeFileSync(requestFile,JSON.stringify(request));
      const bytes=fs.readFileSync(requestFile);
      fs.writeFileSync(path.join(job,"request-digest.json"),JSON.stringify({
        bytes:bytes.length,sha256:require("node:crypto").createHash("sha256").update(bytes).digest("hex")
      }));
    }
    const worker=spawnSync(process.execPath,[script,"worker",job],{encoding:"utf8"});
    assert.equal(worker.status,1,kind);
    assert.equal(fs.existsSync(path.join(job,"started.json")),false,kind);
    assert.equal(supervisor.verify(job).integrity,"corrupt",kind);
    assert.equal(supervisor.status(job).status,"unknown",kind);
    assert.equal(fs.existsSync(path.join(job,"worker.lock")),true,kind);
  }
});

test("changing a job snapshot after worker verification cannot change bytes consumed by wrapper", { timeout: 20000 }, async () => {
  const directory = path.join(root, "sealed-toctou-" + counter++);
  fs.mkdirSync(directory);
  const prompt = path.join(directory, "prompt.txt"), cli = path.join(directory, "fake.cjs");
  const mutatingWrapper = path.join(directory, "mutating-driver.cjs"), job = path.join(directory, "job");
  fs.writeFileSync(prompt, "ORIGINAL VERIFIED BYTES\r\n", "utf8");
  fs.writeFileSync(cli, `require(${JSON.stringify(fixture)}).run("network_events");`);
  fs.writeFileSync(mutatingWrapper, `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    const input = args[args.indexOf("--prompt-file") + 1];
    fs.writeFileSync(input, "TAMPERED AFTER WORKER HASH");
    require(${JSON.stringify(wrapper)}).main(args,{setupMacKeychain:()=>null}).then(result=>{
      process.stdout.write(JSON.stringify(result)+"\\n");
      process.exitCode=['ok','usage','version'].includes(result.status)?0:1;
    });
  `);
  supervisor.start(job,["--prompt-file",prompt,"--cli-path",cli],{wrapperPath:mutatingWrapper});
  await waitUntil(() => fs.existsSync(path.join(job,"execution.json")), 15000);
  const receipt=JSON.parse(fs.readFileSync(path.join(job,"run/receipt.json"),"utf8"));
  assert.equal(receipt.status,"ok");
  assert.equal(receipt.text,"ORIGINAL VERIFIED BYTES\r\n");
  assert.equal(receipt.job_request_sha256,JSON.parse(fs.readFileSync(path.join(job,"request-digest.json"))).sha256);
  assert.equal(fs.readFileSync(path.join(job,"inputs/prompt.txt"),"utf8"),"TAMPERED AFTER WORKER HASH");
  assert.equal(supervisor.verify(job).integrity,"corrupt");
  assert.equal(supervisor.status(job).status,"unknown");
});

test("invalid or forged sealed stdin cannot invoke the CLI", () => {
  const directory=path.join(root,"sealed-invalid-"+counter++);
  fs.mkdirSync(directory);
  const prompt=path.join(directory,"prompt.txt"),cli=path.join(directory,"fake.cjs");
  fs.writeFileSync(prompt,"ORIGINAL");
  fs.writeFileSync(cli,`require(${JSON.stringify(fixture)}).run("network_events");`);
  const run=spawnSync(process.execPath,[driver,"--prompt-file",prompt,"--cli-path",cli],{
    input:JSON.stringify({format:1,request_sha256:"0".repeat(64),inputs:[]}),
    env:{...process.env,ZCODE_JOB_SEALED_INPUT_V1:"1",ZCODE_JOB_REQUEST_SHA256:"1".repeat(64)},
    encoding:"utf8",timeout:12000
  });
  assert.equal(run.status,1);
  const receipt=JSON.parse(run.stdout);
  assert.equal(receipt.status,"input_error");
  assert.equal(receipt.cli_invoked,false);
});

test("completed job remains locally verifiable but detects receipt replacement", async () => {
  const {result,job}=await runSupervised("network_events");
  assert.equal(result.status,"finished");
  assert.equal(result.integrity,"match");
  assert.equal(supervisor.verify(job).integrity,"match");
  fs.writeFileSync(path.join(job,"run/receipt.json"),'{"status":"ok","text":"forged"}');
  assert.equal(supervisor.verify(job).integrity,"corrupt");
  assert.equal(supervisor.status(job).status,"unknown");
  const before=fs.readFileSync(path.join(job,"execution.json"),"utf8");
  assert.equal(spawnSync(process.execPath,[path.resolve(__dirname,"../scripts/zcode-run.js"),"worker",job],{encoding:"utf8"}).status,1);
  assert.equal(fs.readFileSync(path.join(job,"execution.json"),"utf8"),before);
});

test("legacy jobs stay read-only without retrospective hash or execution migration", () => {
  const job=path.join(root,"legacy-job-"+counter++);
  fs.mkdirSync(job);
  fs.writeFileSync(path.join(job,"request.json"),JSON.stringify({wrapper:process.execPath,args:[]}));
  fs.writeFileSync(path.join(job,"launch.json"),JSON.stringify({supervisor_pid:123}));
  assert.equal(supervisor.status(job).legacy_unverified,true);
  assert.equal(supervisor.verify(job).integrity,"legacy_unverified");
  assert.equal(supervisor.cancel(job).status,"legacy_read_only");
  assert.equal(fs.existsSync(path.join(job,"cancel.request")),false);
  const worker=spawnSync(process.execPath,[path.resolve(__dirname,"../scripts/zcode-run.js"),"worker",job],{encoding:"utf8"});
  assert.equal(worker.status,1);
  assert.equal(fs.existsSync(path.join(job,"request-digest.json")),false);
});

test("SKILL.md, the release manifest and the wrapper agree on one version", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../.zcode-release.json"), "utf8"));
  const frontmatter = fs.readFileSync(path.resolve(__dirname, "../SKILL.md"), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, "SKILL.md needs a frontmatter block");
  const declared = frontmatter[1].match(/^version:\s*(\S+)\s*$/m);
  assert.ok(declared, "SKILL.md frontmatter needs a version");
  const reported = JSON.parse(spawnSync(process.execPath, [wrapper, "--version"], { encoding: "utf8" }).stdout);
  assert.equal(declared[1], manifest.version);
  assert.equal(reported.version, manifest.version);
});
