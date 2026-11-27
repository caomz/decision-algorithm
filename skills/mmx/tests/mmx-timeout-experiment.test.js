"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { cleanEnv } = require("./support/env.js");
const { parse, experiment, checkBinding } = require("../scripts/mmx-timeout-experiment.js");
const script = path.resolve(__dirname, "../scripts/mmx-timeout-experiment.js");

test("experiment parser bounds the test and rejects provider/custom backend selection", () => {
  assert.equal(parse(["--out", "new"]).delayMs, 305000);
  for (const args of [["--out", "new", "--suite", "real"], ["--out", "new", "--delay-ms", "Infinity"], ["--out", "new", "--delay-ms", "330001"], ["--out", "new", "--base-url", "https://example.invalid"], ["--out", "x", "--out", "y"]]) assert.throws(() => parse(args));
});

test("controlled runner fails closed outside isolation or records bounded fetch-only controls", { timeout: 20000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-experiment-"));
  try {
    // A deliberately named test dependency exercises acknowledgement and reporting,
    // never stands in for a 300s real-undici validation. Actual fetch is Node's.
    const dep = path.join(root, "undici-fixture"); fs.mkdirSync(dep);
    fs.writeFileSync(path.join(dep, "package.json"), JSON.stringify({ name: "undici", version: "0.0.0-test-fixture" }));
    fs.writeFileSync(path.join(dep, "index.js"), "module.exports={Agent:class Agent{},setGlobalDispatcher(){}};\n");
    const out = path.join(root, "result");
    const run = spawnSync(process.execPath, [script, "--suite", "node-fetch", "--delay-ms", "20", "--undici-path", path.join(dep, "index.js"), "--out", out], { encoding: "utf8", timeout: 15000, env: cleanEnv() });
    let devices = []; try { devices = fs.readFileSync("/proc/net/dev", "utf8").trim().split("\n").slice(2).map(l => l.split(":")[0].trim()); } catch {}
    if (process.platform !== "linux" || devices.length !== 1 || devices[0] !== "lo") {
      assert.equal(run.status, 2);
      assert.match(run.stderr, /isolat/);
      assert.equal(fs.existsSync(out), false);
      return;
    }
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(out, "report.json")));
    assert.equal(report.threshold_300s_exercised, false);
    assert.equal(report.real_mmx_transport, "NOT_EVALUATED");
    assert.equal(report.provider_internal_retry, "NOT_EVALUATED");
    assert.equal(report.cli, null);
    assert.equal(report.undici.version, "0.0.0-test-fixture");
    assert.equal(report.cases.length, 2);
    assert.deepEqual(report.cases.map(c => c.requests), [1, 1]);
    assert.deepEqual(report.cases.map(c => c.guard_initialized), [false, true]);
    assert.ok(report.cases.every(c => c.exit_code === 0));
    const again = spawnSync(process.execPath, [script, "--suite", "node-fetch", "--delay-ms", "20", "--undici-path", path.join(dep, "index.js"), "--out", out], { encoding: "utf8", timeout: 15000, env: cleanEnv() });
    assert.equal(again.status, 2);
    assert.equal(fs.readFileSync(path.join(out, "report.json"), "utf8"), JSON.stringify(report, null, 2) + "\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("real CLI experiment requires exact installed version without invoking unknown code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-pin-experiment-"));
  try {
    const marker = path.join(root, "invoked");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "mmx-cli", version: "1.0.28", bin: "cli.js" }));
    fs.writeFileSync(path.join(root, "cli.js"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
    const run = spawnSync(process.execPath, [script, "--suite", "mmx-cli", "--cli-root", root, "--out", path.join(root, "out")], { encoding: "utf8", timeout: 10000, env: cleanEnv() });
    assert.equal(run.status, 2);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(path.join(root, "out")), false);
    assert.match(run.stderr, /isolat|1\.0\.29/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("zero-request pinned synthetic CLI cannot claim real transport or retry verification", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-zero-request-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "mmx-cli", version: "1.0.29", bin: "cli.js" }));
    fs.writeFileSync(path.join(root, "cli.js"), "process.stderr.write('synthetic auth failure');process.exitCode=3;\n");
    const dep = path.join(root, "node_modules", "undici"); fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, "package.json"), JSON.stringify({ name: "undici", version: "0.0.0-fixture", main: "index.js" }));
    fs.writeFileSync(path.join(dep, "index.js"), "module.exports={Agent:class Agent{},setGlobalDispatcher(){}};\n");
    const out = path.join(root, "out");
    const binding = { "node.version": process.version, "cli.package": "mmx-cli", "cli.version": "1.0.29",
      "cli.entry_sha256": require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(root, "cli.js"))).digest("hex"),
      "undici.version": "0.0.0-fixture" };
    const run = spawnSync(process.execPath, [script, "--suite", "mmx-cli", "--case-group", "errors", "--cli-root", root, "--out", out],
      { encoding: "utf8", timeout: 10000, env: cleanEnv({ ZMX_ACCEPTANCE_BINDING: JSON.stringify(binding) }) });
    if (run.status === 2 && /isolat/.test(run.stderr)) { assert.equal(fs.existsSync(out), false); return; }
    if (run.status === 2 && /acceptance binding refused/.test(run.stderr)) { assert.fail("the binding names this exact CLI: " + run.stderr); }
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(out, "report.json")));
    assert.equal(report.real_mmx_transport, "NOT_EVALUATED");
    assert.equal(report.provider_internal_retry.status, "INCOMPLETE_NOT_EVALUATED");
    assert.equal(report.provider_internal_retry.unobserved_cases.length, 3);
    assert.ok(report.cases.every(c => c.requests === 0 && c.exit_code === 3));
    assert.match(fs.readFileSync(path.join(out, "http-500.stderr"), "utf8"), /synthetic auth failure/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// V2.2.1 D4: the admission approval is compared with what the runner actually
// launches, before the network namespace is checked, before the output
// directory exists and before any process starts.
// ---------------------------------------------------------------------------

function syntheticPackage(root, undici, tag) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "mmx-cli", version: "1.0.29", bin: "cli.js" }));
  fs.writeFileSync(path.join(root, "cli.js"), "require('node:fs').writeFileSync(" + JSON.stringify(path.join(root, "launched")) + ", 'yes');\n// " + tag + "\n");
  const dep = path.join(root, "node_modules", "undici"); fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(path.join(dep, "package.json"), JSON.stringify({ name: "undici", version: undici, main: "index.js" }));
  fs.writeFileSync(path.join(dep, "index.js"), "module.exports={Agent:class Agent{},setGlobalDispatcher(){}};\n");
  return { "cli.package": "mmx-cli", "cli.version": "1.0.29", entry: path.join(root, "cli.js"), "undici.version": undici };
}
const bindingFor = pkg => JSON.stringify({ "node.version": process.version, "cli.package": pkg["cli.package"], "cli.version": pkg["cli.version"],
  "cli.entry_sha256": require("node:crypto").createHash("sha256").update(fs.readFileSync(pkg.entry)).digest("hex"), "undici.version": pkg["undici.version"] });

test("V2.2.1 D4: an approval for A refuses a run that names B before anything starts", { timeout: 20000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-binding-"));
  try {
    const a = syntheticPackage(path.join(base, "a"), "7.0.0", "approved A");
    const b = syntheticPackage(path.join(base, "b"), "7.0.1", "actual B");
    const out = path.join(base, "out");
    process.env.ZMX_ACCEPTANCE_BINDING = bindingFor(a);
    await assert.rejects(experiment({ suite: "mmx-cli", cliRoot: path.join(base, "b"), out, caseGroup: "errors", delayMs: 20 }),
      error => error.code === "ZMX_ACCEPTANCE_REFUSED" &&
        /cli\.entry_sha256 differs/.test(error.message) && /undici\.version differs/.test(error.message));
    assert.equal(fs.existsSync(path.join(base, "b", "launched")), false, "B must not start");
    assert.equal(fs.existsSync(out), false, "no output directory before admission");
  } finally { delete process.env.ZMX_ACCEPTANCE_BINDING; fs.rmSync(base, { recursive: true, force: true }); }
});

test("V2.2.1 D4: the real-CLI suite refuses to run without a binding and compares every field", () => {
  const actual = { "node.version": process.version, "cli.package": "mmx-cli", "cli.version": "1.0.29", "cli.entry_sha256": "a".repeat(64), "undici.version": "6.28.0" };
  assert.deepEqual(checkBinding(undefined, actual), ["acceptance binding is missing or malformed"]);
  assert.deepEqual(checkBinding(JSON.parse(JSON.stringify(actual)), actual), []);
  assert.deepEqual(checkBinding({ ...actual, "cli.version": "1.0.28" }, actual), ["cli.version differs: approved 1.0.28, launch would use 1.0.29"]);
  assert.deepEqual(checkBinding({ ...actual, "undici.version": undefined }, actual), ["undici.version is missing from the binding"]);
});
