"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs, hostClass, hardlinkProbe, versionToken, probeVersion, testFiles, readHost, run } = require("../scripts/windows-zmx-check.cjs");

test("host classification distinguishes Windows 10, Windows 11 and Server on the same NT major", () => {
  const win = (build, product = 1) => ({ windows: { version: `10.0.${build}`, build_number: String(build), product_type: product } });
  assert.equal(hostClass(win(19045), "win32"), "windows_10");
  assert.equal(hostClass(win(22631), "win32"), "windows_11_or_newer");
  assert.equal(hostClass(win(20348, 3), "win32"), "windows_server");
  assert.equal(hostClass({}, "win32"), "windows_unknown");
  assert.equal(hostClass(win(19045), "linux"), "non_windows");
});

test("storage probe supports spaces and Chinese and preserves every existing job", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobs = path.join(root, "job data 中文");
  fs.mkdirSync(jobs);
  fs.writeFileSync(path.join(jobs, "keep.json"), "original evidence");
  assert.equal(hardlinkProbe(jobs).ok, true);
  assert.deepEqual(fs.readdirSync(jobs), ["keep.json"]);
  assert.equal(fs.readFileSync(path.join(jobs, "keep.json"), "utf8"), "original evidence");
});

test("hardlink failure blocks readiness without leaving probe debris", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-no-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const noLinks = Object.create(fs);
  noLinks.linkSync = () => { throw Object.assign(new Error("secret path must not be echoed"), { code: "ENOTSUP" }); };
  assert.deepEqual(hardlinkProbe(root, noLinks), { ok: false, code: "ENOTSUP" });
  assert.deepEqual(fs.readdirSync(root), []);
});

test("version extraction keeps only version tokens and accepts desktop runtime output", () => {
  assert.equal(versionToken("zcode-app-cli 3.2.1\r\nzcode-runtime 0.17.1\r\n", "zcode"), "0.17.1");
  assert.equal(versionToken("zcode 0.17.1", "zcode"), "0.17.1");
  assert.equal(versionToken("zcode-app-cli 3.2.1", "zcode"), null);
  assert.equal(versionToken("1.0.29", "mmx"), "1.0.29");
  assert.equal(versionToken("mmx-cli v1.0.29", "mmx"), "1.0.29");
  assert.equal(versionToken("API_KEY=not-for-the-report", "mmx"), null);
});

test("version probe never executes a shell or forwards failed CLI output", () => {
  let invoked = false;
  assert.equal(probeVersion({ command: "custom.cmd", prefix: [], shell: true }, "mmx", () => { invoked = true; }).ok, false);
  assert.equal(invoked, false);
  const result = probeVersion({ command: process.execPath, prefix: ["a path/入口.mjs"] }, "mmx", (cmd, args, options) => {
    assert.equal(cmd, process.execPath);
    assert.deepEqual(args, ["a path/入口.mjs", "--version"]);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 10000);
    return { status: 1, stdout: "secret-sentinel", stderr: "secret-sentinel" };
  });
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-sentinel/);
});

test("PowerShell metadata is allowlisted and reports are never overwritten", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "host.json");
  fs.writeFileSync(file, "\ufeff" + JSON.stringify({ powershell: { version: "5.1.19041.1", environment: "secret-sentinel" }, unexpected: "secret-sentinel" }));
  assert.deepEqual(readHost(file), { powershell: { version: "5.1.19041.1" } });
  const report = path.join(root, "report.json");
  fs.writeFileSync(report, "prior evidence");
  assert.throws(() => run({ report, jobsRoot: root, offline: true }), { code: "EEXIST" });
  assert.equal(fs.readFileSync(report, "utf8"), "prior evidence");
});

test("offline test argv contains explicit files without relying on PowerShell wildcard expansion", () => {
  const suites = testFiles();
  assert.deepEqual(suites.map(suite => suite.name), ["zcode", "mmx", "zcode-mmx-review"]);
  for (const suite of suites) {
    assert.ok(suite.files.length > 0);
    for (const file of suite.files) { assert.ok(path.isAbsolute(file)); assert.ok(fs.statSync(file).isFile()); assert.ok(!file.includes("*")); }
  }
});

test("arguments reject duplicates and absent report destination", () => {
  assert.throws(() => parseArgs(["--offline"]));
  assert.throws(() => parseArgs(["--jobs-root", "jobs", "--report", "check.json", "--offline", "--offline"]));
  assert.equal(parseArgs(["--jobs-root", "jobs 中文", "--report", "check.json", "--offline"]).offline, true);
});

test("PowerShell entry is ASCII so Windows PowerShell 5.1 does not misdecode its source", () => {
  const source = fs.readFileSync(path.join(__dirname, "../scripts/windows-zmx-check.ps1"));
  assert.ok([...source].every(byte => byte < 128));
});
