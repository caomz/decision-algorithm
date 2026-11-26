"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { parse } = require("../scripts/mmx-timeout-experiment.js");
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
    const run = spawnSync(process.execPath, [script, "--suite", "node-fetch", "--delay-ms", "20", "--undici-path", path.join(dep, "index.js"), "--out", out], { encoding: "utf8", timeout: 15000, env: { PATH: path.dirname(process.execPath) } });
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
    const again = spawnSync(process.execPath, [script, "--suite", "node-fetch", "--delay-ms", "20", "--undici-path", path.join(dep, "index.js"), "--out", out], { encoding: "utf8", timeout: 15000, env: { PATH: path.dirname(process.execPath) } });
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
    const run = spawnSync(process.execPath, [script, "--suite", "mmx-cli", "--cli-root", root, "--out", path.join(root, "out")], { encoding: "utf8", timeout: 10000, env: { PATH: path.dirname(process.execPath) } });
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
    const run = spawnSync(process.execPath, [script, "--suite", "mmx-cli", "--case-group", "errors", "--cli-root", root, "--out", out], { encoding: "utf8", timeout: 10000, env: { PATH: path.dirname(process.execPath) } });
    if (run.status === 2 && /isolat/.test(run.stderr)) { assert.equal(fs.existsSync(out), false); return; }
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(out, "report.json")));
    assert.equal(report.real_mmx_transport, "NOT_EVALUATED");
    assert.equal(report.provider_internal_retry.status, "INCOMPLETE_NOT_EVALUATED");
    assert.equal(report.provider_internal_retry.unobserved_cases.length, 3);
    assert.ok(report.cases.every(c => c.requests === 0 && c.exit_code === 3));
    assert.match(fs.readFileSync(path.join(out, "http-500.stderr"), "utf8"), /synthetic auth failure/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
