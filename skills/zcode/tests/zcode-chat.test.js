"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { resolveLaunch, isolatedEnv, setupMacKeychain, resolveMode, DENIED_TOOLS } = require("../scripts/zcode-chat.js");
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
    env: { ...process.env, ZCODE_MODEL: "must-not-reach-child", FAKE_UNTRUSTED: "must-not-reach-child" },
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
  assert.equal(receipt.cleanup_confirmed, true);
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
test("abrupt wrapper death leaves startup state and independently captured signal", { skip: process.platform === "win32" }, async () => {
  const { result, job } = await runSupervised("kill_wrapper");
  assert.equal(result.status, "finished");
  assert.equal(result.execution.signal, "SIGKILL");
  assert.equal(result.execution.receipt_exists, false);
  assert.equal(result.receipt, undefined);
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
