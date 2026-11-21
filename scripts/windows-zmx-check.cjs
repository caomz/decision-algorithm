#!/usr/bin/env node
"use strict";

// Local preflight only. Never logs environment values or auth records, logs
// in, installs dependencies, changes policy, or invokes a provider request.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { offline: false, jobsRoot: null, report: null, hostFile: null };
  const names = { "--jobs-root": "jobsRoot", "--report": "report", "--host-file": "hostFile" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error("invalid_arguments");
    seen.add(arg);
    if (arg === "--offline") out.offline = true;
    else if (names[arg] && argv[i + 1] && !argv[i + 1].startsWith("--")) out[names[arg]] = path.resolve(argv[++i]);
    else throw new Error("invalid_arguments");
  }
  if (!out.jobsRoot || !out.report) throw new Error("jobs_root_and_report_required");
  return out;
}

function hostClass(metadata, platform = process.platform) {
  if (platform !== "win32") return "non_windows";
  const win = metadata?.windows;
  if (!win || !/^10\./.test(win.version || "") || !/^\d+$/.test(String(win.build_number))) return "windows_unknown";
  if (Number(win.product_type) !== 1) return "windows_server";
  return Number(win.build_number) < 22000 ? "windows_10" : "windows_11_or_newer";
}

function hardlinkProbe(root, fsApi = fs) {
  let temporary;
  try {
    if (process.platform === "win32" && /^\\\\/.test(root)) return { ok: false, code: "network_jobs_root" };
    fsApi.mkdirSync(root, { recursive: true });
    if (!fsApi.statSync(root).isDirectory() || fsApi.lstatSync(root).isSymbolicLink()) return { ok: false, code: "unsafe_jobs_root" };
    temporary = fsApi.mkdtempSync(path.join(root, ".zmx-probe-"));
    const source = path.join(temporary, "source");
    const target = path.join(temporary, "published");
    const material = "Windows \u4e2d\u6587 UTF-8\r\n";
    fsApi.writeFileSync(source, material, { encoding: "utf8", flag: "wx" });
    fsApi.linkSync(source, target);
    if (fsApi.readFileSync(target, "utf8") !== material) throw new Error("probe_mismatch");
    let refused = false;
    try { fsApi.linkSync(source, target); } catch (error) { refused = error.code === "EEXIST"; }
    if (!refused) throw new Error("exclusive_link_unverified");
    return { ok: true, code: "write_utf8_hardlink_exclusive_ok" };
  } catch (error) { return { ok: false, code: /^[A-Z][A-Z0-9_]+$/.test(error.code || "") ? error.code : "filesystem_probe_failed" }; }
  finally {
    if (temporary) {
      // Remove only files created by this probe; never recurse into a job.
      for (const name of ["published", "source"]) { try { fsApi.unlinkSync(path.join(temporary, name)); } catch {} }
      try { fsApi.rmdirSync(temporary); } catch {}
    }
  }
}

function versionToken(text, kind) {
  const raw = String(text || "").trim();
  if (kind === "zcode") {
    const runtime = raw.match(/(?:^|\r?\n)zcode-runtime\s+(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\s*(?:\r?\n|$)/);
    if (runtime) return runtime[1];
    return raw.match(/^(?:zcode\s+)?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/)?.[1] ?? null;
  }
  return raw.match(/^(?:mmx(?:-cli)?\s+)?v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/i)?.[1] ?? null;
}

function probeVersion(launch, kind, run = spawnSync) {
  if (!launch || launch.shell) return { ok: false, code: "unsupported_launcher", version: null };
  const result = run(launch.command, [...launch.prefix, "--version"], {
    encoding: "utf8", timeout: 10000, maxBuffer: 8192, shell: false, windowsHide: true,
    ...(launch.env ? { env: launch.env } : {}),
  });
  const version = !result.error && result.status === 0 ? versionToken(result.stdout, kind) : null;
  return { ok: Boolean(version), code: version ? "version_read" : "version_probe_failed", version,
    exit_code: result.status ?? null };
}

function npmVersion() {
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH || "").split(path.delimiter)];
  for (const dir of dirs) {
    try {
      const file = path.join(dir.replace(/^"|"$/g, ""), "node_modules/npm/package.json");
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (pkg.name === "npm" && /^\d+\.\d+\.\d+$/.test(pkg.version)) return { version: pkg.version, source: "installed_package" };
    } catch {}
  }
  return { version: null, source: "not_found" };
}

function testFiles(root = ROOT) {
  return ["zcode", "mmx", "zcode-mmx-review"].map(name => ({ name,
    files: fs.readdirSync(path.join(root, "skills", name, "tests")).filter(file => file.endsWith(".test.js"))
      .sort().map(file => path.join(root, "skills", name, "tests", file)) }));
}

function runOfflineTests(root, reportPath) {
  const env = { ...process.env, MMX_GLOBAL_SLOT: "0" };
  for (const key of ["MMX_CANCEL_REQUEST_FILE", "ZCODE_CANCEL_REQUEST_FILE"]) delete env[key];
  return testFiles(root).map(suite => {
    const log = `${reportPath}.${suite.name}.log`;
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...suite.files], {
      cwd: root, env, encoding: "utf8", timeout: 600000, maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true,
    });
    fs.writeFileSync(log, String(result.stdout || "") + String(result.stderr || ""), { encoding: "utf8", flag: "wx" });
    const summary = Object.fromEntries([...String(result.stdout || "").matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)]
      .map(match => [match[1], Number(match[2])]));
    const ok = !result.error && result.status === 0 && summary.tests > 0 && summary.fail === 0 && summary.cancelled === 0;
    return { name: suite.name, ok, exit_code: result.status ?? null, summary, log };
  });
}

function readHost(file) {
  if (!file) return {};
  const host = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  // Only accept the fields this script actually reports. Never forward arbitrary metadata.
  const safe = {};
  for (const [section, keys] of Object.entries({ powershell: ["version", "edition"], windows: ["caption", "version", "build_number", "product_type", "os_architecture"], jobs_volume: ["file_system", "drive_type"] })) {
    if (!host[section]) continue;
    safe[section] = {};
    for (const key of keys) {
      const value = host[section][key];
      if (typeof value === "string") safe[section][key] = value.slice(0, 160);
      else if (typeof value === "number" && Number.isFinite(value)) safe[section][key] = value;
    }
  }
  return safe;
}

function run(options, root = ROOT) {
  // Reserve a NEW destination before running anything; an old report is evidence.
  fs.mkdirSync(path.dirname(options.report), { recursive: true });
  const reportFd = fs.openSync(options.report, "wx", 0o600);
  const report = { format: 1, checked_at: new Date().toISOString(), mode: options.offline ? "offline" : "preflight",
    readiness: "blocked", provider_auth: "not_run", real_provider_requests: 0, real_provider_acceptance: "not_run", checks: [] };
  try {
    const metadata = readHost(options.hostFile);
    report.environment = { ...metadata, host_class: hostClass(metadata), platform: process.platform,
      os_release: os.release(), machine: os.machine(), node_version: process.versions.node, node_arch: process.arch, npm: npmVersion() };
    report.target = { os: "Windows 10", arch: "x64", node_major: 22, powershell_minimum: "5.1" };
    report.source = { root, head: null, branch: null, working_tree_dirty: null };
    const git = args => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 16384, shell: false, windowsHide: true });
    const head = git(["rev-parse", "HEAD"]);
    if (head.status === 0 && /^[0-9a-f]{40}\s*$/.test(head.stdout || "")) report.source.head = head.stdout.trim();
    const branch = git(["branch", "--show-current"]);
    if (branch.status === 0 && /^[A-Za-z0-9._/-]*\s*$/.test(branch.stdout || "")) report.source.branch = branch.stdout.trim() || "detached";
    const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.status === 0) report.source.working_tree_dirty = Boolean(dirty.stdout.trim());
    const add = (name, ok, detail) => report.checks.push({ name, ok, detail });
    add("node_22_x64", process.versions.node.split(".")[0] === "22" && process.arch === "x64", "Supported Windows acceptance target is Node.js 22 x64.");
    add("native_windows", options.offline || process.platform === "win32", "Offline runs on other operating systems do not establish Windows readiness.");
    add("windows10_target", options.offline || report.environment.host_class === "windows_10", "Preflight targets a Windows 10 client; Server CI and Windows 11 are reported separately.");
    add("powershell_host", options.offline || /^(?:5\.1\.|[6-9]\.)/.test(metadata.powershell?.version || ""), "Run the PowerShell entry point to record the actual shell version.");
    const storage = hardlinkProbe(options.jobsRoot);
    report.jobs_root = options.jobsRoot;
    add("job_storage", storage.ok, storage.code);
    if (process.platform === "win32") add("local_ntfs", metadata.jobs_volume?.file_system === "NTFS" && metadata.jobs_volume?.drive_type === 3, "Durable jobs require a verified local NTFS volume; do not use a network or synchronized job folder.");
    const doctor = require(path.join(root, "skills/zcode-mmx-review/scripts/review-run.js")).doctorOffline(path.join(root, "skills"));
    add("release_and_protocol", doctor.status === "ok", doctor.checks.filter(check => !check.ok).map(check => check.name));
    report.cli = { zcode: { status: "not_probed" }, mmx: { status: "not_probed" } };
    if (!options.offline) {
      add("windows_global_slot_disabled", process.env.MMX_GLOBAL_SLOT !== "1", "Windows global slot is intentionally unavailable.");
      add("no_inherited_cancellation", !process.env.MMX_CANCEL_REQUEST_FILE && !process.env.ZCODE_CANCEL_REQUEST_FILE, "Run the preflight from a normal terminal, outside a managed job.");
      try {
        const zcode = require(path.join(root, "skills/zcode/scripts/zcode-chat.js"));
        const launcher = zcode.findCli();
        const launch = zcode.resolveLaunch(launcher);
        const result = probeVersion(launch, "zcode");
        report.cli.zcode = { ...result, launcher, entry: launch.entry, supported_runtime: "0.17.1" };
        add("zcode_runtime", result.ok && result.version === "0.17.1", "ZCode runtime must be exactly 0.17.1; a desktop app version alone is insufficient.");
      } catch { report.cli.zcode = { status: "unavailable_or_unsupported" }; add("zcode_runtime", false, "CLI missing or launcher unsupported."); }
      try {
        const mmx = require(path.join(root, "skills/mmx/scripts/mmx-chat.js"));
        const found = mmx.findMmx();
        if (!found || found.unsafe || found.shell) throw new Error("unsupported_launcher");
        const launch = mmx.cliLaunch(found);
        const result = probeVersion({ command: found.cmd, prefix: launch.argsPrefix, env: launch.env }, "mmx");
        report.cli.mmx = { ...result, command: found.cmd, entry: found.argsPrefix[0] || found.cmd, fetch_timeout_guard: launch.fetch_timeout_guard };
        add("mmx_cli", result.ok, "Version is observed locally; auth, model and remote endpoint are not verified.");
      } catch { report.cli.mmx = { status: "unavailable_or_unsupported" }; add("mmx_cli", false, "CLI missing or custom shell launcher unsupported by this preflight."); }
    }
    report.tests = options.offline ? runOfflineTests(root, options.report) : [];
    for (const suite of report.tests) add(`tests:${suite.name}`, suite.ok, suite.summary);
    if (report.checks.every(check => check.ok)) report.readiness = options.offline ? "offline_pass" : "preflight_ready";
    report.failed = report.checks.filter(check => !check.ok).map(check => check.name);
    report.note = "Neither offline_pass nor preflight_ready proves a real provider request, authentication, Windows descendant cleanup, or the unified real backend.";
    fs.writeFileSync(reportFd, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { exitCode: report.readiness === "blocked" ? 2 : 0, report };
  } catch {
    report.checks.push({ name: "check_execution", ok: false, detail: "Local check failed; no provider request was attempted." });
    report.failed = report.checks.filter(check => !check.ok).map(check => check.name);
    fs.writeFileSync(reportFd, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { exitCode: 2, report };
  } finally { fs.closeSync(reportFd); }
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = run(options);
    process.stdout.write(JSON.stringify({ readiness: result.report.readiness, host_class: result.report.environment?.host_class ?? "unknown", report: options.report, failed: result.report.checks.filter(check => !check.ok).map(check => check.name), real_provider_acceptance: "not_run" }) + "\n");
    process.exitCode = result.exitCode;
  } catch { process.stderr.write("Local check refused. Use --jobs-root DIRECTORY --report NEW_FILE [--offline]; existing reports are never replaced.\n"); process.exitCode = 2; }
}

module.exports = { parseArgs, hostClass, hardlinkProbe, versionToken, probeVersion, testFiles, readHost, run };
