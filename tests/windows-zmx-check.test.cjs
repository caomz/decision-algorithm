"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs, hostClass, targetMatch, supportStatus, hardlinkProbe, versionToken, probeVersion, testFiles, readHost, run } = require("../scripts/windows-zmx-check.cjs");

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
test("Windows 11 explicit target accepts only reviewed x64 client builds", () => {
  const win = (build, product = 1, version = "10.0." + build, architecture = "64-bit") =>
    ({ windows: { version, build_number: String(build), product_type: product, os_architecture: architecture,
      caption: "Microsoft Windows 11 Home" } });
  assert.equal(targetMatch(win(19045), "windows10", "win32", "x64"), true);
  assert.equal(targetMatch(win(19045), "windows11", "win32", "x64"), false);
  for (const build of [22000, 22621, 22631, 26100, 26200, 26300, 28000]) {
    assert.equal(targetMatch(win(build), "windows11", "win32", "x64"), true, String(build));
    assert.equal(targetMatch(win(build), "windows10", "win32", "x64"), false);
  }
  assert.equal(targetMatch(win(22631, 3), "windows11", "win32", "x64"), false);
  assert.equal(targetMatch(win(30000), "windows11", "win32", "x64"), false);
  assert.equal(targetMatch(win(26000), "windows11", "win32", "x64"), false);
  assert.equal(targetMatch(win(22631, 1, "10.0.19045"), "windows11", "win32", "x64"), false);
  assert.equal(targetMatch(win(22631, 1, "10.0.22631", "32-bit"), "windows11", "win32", "x64"), false);
  assert.equal(targetMatch(win(22631), "windows11", "win32", "ia32"), false);
  assert.equal(targetMatch(win(22631), "windows11", "linux", "x64"), false);
});
test("Windows 11 lifecycle remains separate from Windows 11 host identity", () => {
  const at = new Date("2026-11-22T00:00:00Z");
  const win = (build, caption) => ({ windows: { build_number: String(build), caption } });
  assert.equal(supportStatus(win(22631, "Windows 11 Home"), "windows11", at), "out_of_support");
  assert.equal(supportStatus(win(26100, "Windows 11 Pro"), "windows11", at), "out_of_support");
  assert.equal(supportStatus(win(26100, "Windows 11 Enterprise"), "windows11", at), "supported");
  assert.equal(supportStatus(win(26200, "Windows 11 家庭中文版"), "windows11", at), "supported");
  assert.equal(supportStatus(win(26300, "Windows 11 Home"), "windows11", at), "supported");
  assert.equal(supportStatus(win(28000, "Windows 11 Home"), "windows11", at), "supported");
  assert.equal(supportStatus(win(30000, "Windows 11 Home"), "windows11", at), "unknown_build");
  assert.equal(supportStatus(win(26200, "Windows 11"), "windows11", at), "unknown_edition");
  assert.equal(supportStatus(win(22631, "Windows 11 Home"), "windows10", at), "not_assessed");
});
test("OS target defaults Windows 10, supports explicit Win11 and rejects invalid flags", () => {
  const base = ["--jobs-root", "jobs 中文", "--report", "check.json"];
  assert.equal(parseArgs(base).targetOs, "windows10");
  assert.equal(parseArgs([...base, "--target-os", "windows11"]).targetOs, "windows11");
  assert.throws(() => parseArgs([...base, "--target-os", "windows_server"]));
  assert.throws(() => parseArgs([...base, "--target-os", "windows11", "--target-os", "windows10"]));
});
