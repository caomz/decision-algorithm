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
      native_machine: 0x8664, process_machine: 0, processor_architecture_code: 9,
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
  assert.equal(targetMatch(win(22631, 1, "10.0.22631", "ARM64"), "windows11", "win32", "x64"), false);
  assert.equal(targetMatch(win(22631), "windows11", "win32", "ia32"), false);
  assert.equal(targetMatch(win(22631), "windows11", "linux", "x64"), false);
});
test("Windows 11 lifecycle remains separate from Windows 11 host identity", () => {
  const at = new Date("2026-11-22T00:00:00Z");
  const win = (build, caption, sku) => ({ windows: { build_number: String(build), caption, operating_system_sku: sku } });
  assert.equal(supportStatus(win(22631, "Windows 11 Home", 101), "windows11", at), "out_of_support");
  assert.equal(supportStatus(win(26100, "Windows 11 Pro", 48), "windows11", at), "out_of_support");
  assert.equal(supportStatus(win(26100, "Windows 11 Enterprise", 4), "windows11", at), "supported");
  assert.equal(supportStatus(win(26200, "Windows 11 家庭中文版", 101), "windows11", at), "supported");
  assert.equal(supportStatus(win(26300, "Windows 11 Home", 101), "windows11", at), "supported");
  assert.equal(supportStatus(win(28000, "Windows 11 Home", 101), "windows11", at), "supported");
  assert.equal(supportStatus(win(30000, "Windows 11 Home", 101), "windows11", at), "unknown_build");
  assert.equal(supportStatus(win(26200, "Windows 11", 101), "windows11", at), "unknown_edition");
  assert.equal(supportStatus(win(22631, "Windows 11 Home", 101), "windows10", at), "not_assessed");
});
test("OS target defaults Windows 10, supports explicit Win11 and rejects invalid flags", () => {
  const base = ["--jobs-root", "jobs 中文", "--report", "check.json"];
  assert.equal(parseArgs(base).targetOs, "windows10");
  assert.equal(parseArgs([...base, "--target-os", "windows11"]).targetOs, "windows11");
  assert.throws(() => parseArgs([...base, "--target-os", "windows_server"]));
  assert.throws(() => parseArgs([...base, "--target-os", "windows11", "--target-os", "windows10"]));
});
test("native x64 proof rejects ARM64 emulation, missing API or WMI, and conflicts", () => {
  const good = { windows: { version: "10.0.22631", build_number: "22631",
    product_type: 1, os_architecture: "64-bit", native_machine: 0x8664,
    process_machine: 0, processor_architecture_code: 9 } };
  const accept = o => targetMatch(o, "windows11", "win32", "x64");
  assert.equal(accept(good), true, "verified native AMD64 remains accepted");
  const variants = [
    ["ARM64 plus x64 emulated Node", { native_machine: 0xAA64, processor_architecture_code: 12 }],
    ["ARM64 pretending 64-bit", { native_machine: 0xAA64, os_architecture: "64-bit" }],
    ["API native evidence missing", { native_machine: undefined }],
    ["API returned unknown", { native_machine: 0 }],
    ["WMI evidence missing", { processor_architecture_code: undefined }],
    ["WMI returned unknown", { processor_architecture_code: null }],
    ["WMI disagrees with native API", { processor_architecture_code: 12 }],
    ["native machine disagrees with WMI", { native_machine: 0xAA64 }],
    ["PowerShell x86 emulated", { process_machine: 0x014c }],
    ["PowerShell process probe missing", { process_machine: undefined }],
    ["ARM64 label despite x64 claims", { os_architecture: "ARM64" }],
  ];
  for (const [name, patch] of variants) {
    assert.equal(accept({ windows: { ...good.windows, ...patch } }), false, name);
    assert.equal(targetMatch({ windows: { ...good.windows, ...patch } }, "windows10", "win32", "x64"), false, name + " win10");
  }
  assert.equal(targetMatch({ windows: { ...good.windows, native_machine: "34404" } }, "windows11", "win32", "x64"), false);
  assert.equal(targetMatch(good, "windows11", "win32", "arm64"), false, "x64 Node required");
});

test("PowerShell captures separate native host and WMI architecture with failure-closed metadata", () => {
  const ps = fs.readFileSync(path.join(__dirname, "../scripts/windows-zmx-check.ps1"), "utf8");
  assert.match(ps, /IsWow64Process2/);
  assert.match(ps, /Win32_Processor/);
  assert.match(ps, /native_machine\s*=\s*\$nativeMachine/);
  assert.match(ps, /processor_architecture_code\s*=\s*\$processorArchitectureCode/);
  assert.doesNotMatch(ps, /PROCESSOR_ARCHITECTURE=\S+/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-native-host-"));
  try {
    const file = path.join(root, "host.json");
    fs.writeFileSync(file, JSON.stringify({ windows: { native_machine: 0xAA64, process_machine: 0x8664,
      processor_architecture_code: 12, os_architecture: "ARM64", extra_secret: "do_not_forward" } }));
    const safe = readHost(file).windows;
    assert.equal(safe.native_machine, 0xAA64);
    assert.equal(safe.process_machine, 0x8664);
    assert.equal(safe.processor_architecture_code, 12);
    assert.equal(safe.extra_secret, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("Windows 11 Pro Education follows consumer EOL, not Education or Enterprise", () => {
  const asOf = new Date("2026-11-22T00:00:00Z");
  const status = (caption, sku, build = 26100, at = asOf) =>
    supportStatus({ windows: { caption, operating_system_sku: sku, build_number: String(build) } }, "windows11", at);
  assert.equal(status("Windows 11 Pro Education", 164), "out_of_support");
  assert.equal(status("Windows 11 专业教育版", 164), "out_of_support");
  assert.equal(status("Windows 11 Pro for Workstations", 161), "out_of_support");
  assert.equal(status("Windows 11 Education", 121), "supported");
  assert.equal(status("Windows 11 Enterprise", 4), "supported");
  assert.equal(status("Windows 11 Pro", 48), "out_of_support");
  assert.equal(status("Windows 11 Home", 101), "out_of_support");
  assert.equal(status("Windows 11 Home", 101, 26300), "supported", "GA 26H2 must be retained");
  assert.equal(status("Windows 11 Home", 101, 28000), "supported", "GA 26H1 must be retained");
});

test("Windows lifecycle SKU and caption conflicts, unknowns and LTSC fail closed", () => {
  const asOf = new Date("2026-11-22T00:00:00Z");
  const status = (caption, sku, build = 26100) =>
    supportStatus({ windows: { caption, operating_system_sku: sku, build_number: String(build) } }, "windows11", asOf);
  assert.equal(status("Windows 11 Pro Education", 121), "conflicting_edition");
  assert.equal(status("Windows 11 Education", 164), "conflicting_edition");
  assert.equal(status("Windows 11 Enterprise", 101), "conflicting_edition");
  assert.equal(status("Windows 11 Home", 48), "conflicting_edition");
  assert.equal(status("Windows 11 Pro Education Enterprise", 164), "conflicting_edition");
  assert.equal(status("Windows 11 Pro Education", null), "unknown_edition");
  assert.equal(status("Windows 11 Pro Education", "164"), "unknown_edition");
  assert.equal(status("Windows 11 Pro Education", 777777), "unknown_edition");
  assert.equal(status("Windows 11", 164), "unknown_edition");
  assert.equal(status("Windows 11 Enterprise LTSC", 125), "unsupported_channel");
  assert.equal(status("Windows 11 Enterprise LTSC", 4), "unsupported_channel");
  assert.equal(status("Windows 11 Enterprise", 125), "unsupported_channel");
  assert.equal(status("Windows 11 Pro Education", 164, 99999), "unknown_build");
});

test("Windows 11 lifecycle boundary dates distinguish exact expiration and SKU class", () => {
  const metadata = (caption, sku) => ({ windows: { build_number: "26100", caption, operating_system_sku: sku } });
  assert.equal(supportStatus(metadata("Windows 11 Pro Education", 164), "windows11", new Date("2026-10-13T23:59:59Z")), "supported");
  assert.equal(supportStatus(metadata("Windows 11 Pro Education", 164), "windows11", new Date("2026-10-14T00:00:00Z")), "out_of_support");
  assert.equal(supportStatus(metadata("Windows 11 Education", 121), "windows11", new Date("2027-10-12T23:59:59Z")), "supported");
  assert.equal(supportStatus(metadata("Windows 11 Education", 121), "windows11", new Date("2027-10-13T00:00:00Z")), "out_of_support");
});

test("OperatingSystemSKU is captured and allowlisted without leaking unrelated host keys", () => {
  const ps = fs.readFileSync(path.join(__dirname, "../scripts/windows-zmx-check.ps1"), "utf8");
  assert.match(ps, /OperatingSystemSKU/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-sku-"));
  try {
    const host = path.join(root, "host.json");
    fs.writeFileSync(host, JSON.stringify({ windows: { caption: "Windows 11 Pro Education",
      operating_system_sku: 164, unrelated: "secret" } }));
    const safe = readHost(host).windows;
    assert.equal(safe.operating_system_sku, 164);
    assert.equal(safe.unrelated, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
