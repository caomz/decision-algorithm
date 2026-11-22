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
  const out = { offline: false, jobsRoot: null, report: null, hostFile: null, targetOs: "windows10" };
  const names = { "--jobs-root": "jobsRoot", "--report": "report", "--host-file": "hostFile" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error("invalid_arguments");
    seen.add(arg);
    if (arg === "--offline") out.offline = true;
    else if (arg === "--target-os" && ["windows10", "windows11"].includes(argv[i + 1])) out.targetOs = argv[++i];
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


// A static, manually reviewed snapshot. This is NOT a remote refresh or a
// grant of compatibility to unseen builds/channels. Official source checked:
// https://learn.microsoft.com/en-us/windows/release-health/supported-versions-windows-client
// https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information
const WINDOWS11_SUPPORT_TABLE = Object.freeze({
  data_version: "ms-windows11-ga-2026-11-22-v1",
  verified_date: "2026-11-22",
  channel: "General Availability Channel",
  source: "https://learn.microsoft.com/en-us/windows/release-health/supported-versions-windows-client",
  release_source: "https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information",
  rows: Object.freeze([
    [22000, "21H2", "2021-10-04", "2023-10-10", "2024-10-08"],
    [22621, "22H2", "2022-09-20", "2024-10-08", "2025-10-14"],
    [22631, "23H2", "2023-10-31", "2025-11-11", "2026-11-10"],
    [26100, "24H2", "2024-10-01", "2026-10-13", "2027-10-12"],
    [26200, "25H2", "2025-09-30", "2027-10-12", "2028-10-10"],
    [26300, "26H2", "2026-09-29", "2028-10-10", "2029-10-09"],
    [28000, "26H1", "2026-02-10", "2028-03-14", "2029-03-13"],
  ].map(([build, version, available_date, consumer_end, enterprise_end]) =>
    Object.freeze({ build, version, available_date, consumer_end, enterprise_end }))),
});
function utcDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}
function validateSupportTable(table = WINDOWS11_SUPPORT_TABLE) {
  if (!table || table.data_version !== "ms-windows11-ga-2026-11-22-v1" ||
      table.verified_date !== "2026-11-22" ||
      table.channel !== "General Availability Channel" ||
      table.source !== "https://learn.microsoft.com/en-us/windows/release-health/supported-versions-windows-client" ||
      table.release_source !== "https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information" ||
      utcDay(table.verified_date) === null || !Array.isArray(table.rows) || !table.rows.length) return false;
  const seen = new Set();
  for (const r of table.rows) {
    const available = utcDay(r?.available_date), shortEnd = utcDay(r?.consumer_end), longEnd = utcDay(r?.enterprise_end);
    if (!Number.isSafeInteger(r?.build) || r.build < 22000 || seen.has(r.build) ||
        !/^\d{2}H[12]$/.test(String(r.version || "")) ||
        available === null || shortEnd === null || longEnd === null ||
        available > shortEnd || shortEnd > longEnd || available > utcDay(table.verified_date)) return false;
    seen.add(r.build);
  }
  return true;
}
function supportRow(build) {
  if (!validateSupportTable()) return null;
  return WINDOWS11_SUPPORT_TABLE.rows.find(row => row.build === build) ?? null;
}
function targetMatch(metadata, targetOs, platform = process.platform, nodeArch = process.arch) {
  const win = metadata?.windows;
  // Three separate measurements are required: Node runtime architecture,
  // the native host machine from IsWow64Process2, and WMI processor type.
  // PowerShell itself must not be executing under WOW emulation. A string
  // containing "64" (notably "ARM64") is never adequate evidence.
  const osArch = String(win?.os_architecture || "");
  if (platform !== "win32" || nodeArch !== "x64" || !win || Number(win.product_type) !== 1 ||
      win.native_machine !== 0x8664 || win.process_machine !== 0 ||
      win.processor_architecture_code !== 9 ||
      !/64/.test(osArch) || /arm|32/i.test(osArch)) return false;
  const version = /^10\.0\.(\d+)$/.exec(String(win.version || ""));
  const build = Number(win.build_number);
  if (!version || !Number.isSafeInteger(build) || Number(version[1]) !== build) return false;
  if (targetOs === "windows10") return build >= 10240 && build < 22000;
  return targetOs === "windows11" && supportRow(build) !== null;
}
// Windows client identity and security support are independent. Unknown OS
// edition is never silently treated as supported.
// Win32_OperatingSystem.OperatingSystemSKU is independent of the caption.
// These are explicit GetProductInfo values, not a fuzzy word search. LTSC and
// unknown SKUs are intentionally outside this annual-servicing contract.
const SKU_EDITION = new Map([
  ...[98, 99, 100, 101].map(id => [id, "home"]),
  ...[48, 49].map(id => [id, "pro"]),
  [164, "pro_education"],
  ...[161, 162].map(id => [id, "pro_workstations"]),
  ...[121, 122].map(id => [id, "education"]),
  ...[4, 27].map(id => [id, "enterprise"]),
  [188, "iot_enterprise"],
  ...[125, 126, 191].map(id => [id, "ltsc"]),
]);
function captionEdition(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let caption = value.toLowerCase();
  if (/l t s c|ltsc|ltsb|long.term.servicing/i.test(caption)) return "ltsc";
  const matches = new Set();
  const consume = (edition, re) => {
    if (re.test(caption)) { matches.add(edition); caption = caption.replace(re, " "); }
  };
  consume("pro_education", /\bpro\s+education\b|专业教育/g);
  consume("pro_workstations", /\bpro\s+for\s+workstations\b|工作站专业/g);
  consume("iot_enterprise", /\biot\s+enterprise\b|物联网企业/g);
  consume("enterprise", /\benterprise\b|企业/g);
  consume("education", /\beducation\b|教育/g);
  consume("home", /\bhome\b|家庭/g);
  consume("pro", /\bpro(?:fessional)?\b|专业/g);
  return matches.size === 1 ? [...matches][0] : matches.size > 1 ? "conflicting" : null;
}
function supportStatus(metadata, targetOs, at = new Date()) {
  if (targetOs !== "windows11") return "not_assessed";
  const win = metadata?.windows, row = supportRow(Number(win?.build_number));
  if (!row) return "unknown_build";
  const atMs = at instanceof Date ? at.getTime() : NaN;
  if (!Number.isFinite(atMs)) return "invalid_evaluation_time";
  if (atMs < utcDay(row.available_date)) return "not_yet_available";
  const sku = win?.operating_system_sku;
  const skuEdition = Number.isInteger(sku) ? SKU_EDITION.get(sku) : null;
  const declaredEdition = captionEdition(win?.caption);
  if (skuEdition === "ltsc" || declaredEdition === "ltsc") return "unsupported_channel";
  if (!skuEdition || !declaredEdition) return "unknown_edition";
  if (skuEdition !== declaredEdition) return "conflicting_edition";
  const longServicing = ["enterprise", "education", "iot_enterprise"].includes(skuEdition);
  const end = longServicing ? row.enterprise_end : row.consumer_end;
  // Exclusive midnight boundary includes every millisecond of the end date.
  return atMs < utcDay(end) + 86400000 ? "supported" : "out_of_support";
}


function clockStatus(at) {
  const ms = at instanceof Date ? at.getTime() : NaN;
  if (!Number.isFinite(ms)) return "invalid";
  const reviewMs = utcDay(WINDOWS11_SUPPORT_TABLE.verified_date);
  if (reviewMs === null || !validateSupportTable()) return "table_unverified";
  if (ms < reviewMs) return "before_table_verification";
  // This static data has no release after 2029. A clock more than one year
  // beyond the last known GA support end is anomalous for this frozen snapshot.
  const latestEnd = Math.max(...WINDOWS11_SUPPORT_TABLE.rows.map(r => utcDay(r.enterprise_end)));
  if (ms >= latestEnd + 366 * 86400000) return "implausible_future";
  return "plausible_unverified";
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
  for (const [section, keys] of Object.entries({ powershell: ["version", "edition"], windows: ["caption", "version", "build_number", "product_type", "os_architecture",
      "native_machine", "process_machine", "processor_architecture_code", "operating_system_sku"], jobs_volume: ["file_system", "drive_type"] })) {
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
  // Sample the local clock exactly once for this run. It is NOT attested by a
  // time authority; tests freeze the Date constructor inside a private VM.
  const evaluatedAt = new Date();
  const timeMs = evaluatedAt.getTime();
  const checkedAt = Number.isFinite(timeMs) ? evaluatedAt.toISOString() : null;
  const report = { format: 1, checked_at: checkedAt, mode: options.offline ? "offline" : "preflight",
    readiness: "blocked", provider_auth: "not_run", real_provider_requests: 0, real_provider_acceptance: "not_run",
    checks: [], tests: [], cli: { zcode: { status: "not_probed" }, mmx: { status: "not_probed" } } };
  try {
    const metadata = readHost(options.hostFile);
    report.environment = { ...metadata, host_class: hostClass(metadata), platform: process.platform,
      os_release: os.release(), machine: os.machine(), node_version: process.versions.node, node_exec_path: process.execPath,
      node_arch: process.arch, npm: npmVersion() };
    report.requested_target = options.targetOs ?? "windows10";
    report.observed_host = report.environment.host_class;
    const native = metadata.windows?.native_machine;
    const powershellMachine = metadata.windows?.process_machine;
    report.environment.architecture = {
      native_machine: native ?? null,
      powershell_machine: powershellMachine ?? null,
      processor_architecture_code: metadata.windows?.processor_architecture_code ?? null,
      node_arch: process.arch,
      emulation: native === 0xAA64 && process.arch === "x64" ? "x64_on_arm64"
        : native === 0x8664 && powershellMachine === 0 && process.arch === "x64" ? "none"
        : "unknown_or_emulated",
    };
    report.target_match = targetMatch(metadata, report.requested_target);
    report.support_status = supportStatus(metadata, report.requested_target, evaluatedAt);
    const clockVerdict = clockStatus(evaluatedAt);
    report.clock = { source: "local_system_clock", authenticated: false,
      evaluated_at: checkedAt, status: clockVerdict,
      note: "The operating-system clock is not an authenticated time authority." };
    const evaluatedRow = supportRow(Number(metadata.windows?.build_number));
    report.support_table = {
      data_version: WINDOWS11_SUPPORT_TABLE.data_version,
      verified_date: WINDOWS11_SUPPORT_TABLE.verified_date,
      channel: WINDOWS11_SUPPORT_TABLE.channel,
      source: WINDOWS11_SUPPORT_TABLE.source,
      release_source: WINDOWS11_SUPPORT_TABLE.release_source,
      valid: validateSupportTable(),
      selected_build: evaluatedRow?.build ?? null,
      available_date: evaluatedRow?.available_date ?? null,
      consumer_end: evaluatedRow?.consumer_end ?? null,
      enterprise_end: evaluatedRow?.enterprise_end ?? null,
    };
    report.acceptance_scope = options.offline ? "offline_diagnostics_only" : "native_client_preflight";
    report.target = { os: report.requested_target === "windows11" ? "Windows 11" : "Windows 10", arch: "x64", node_major: 22, powershell_minimum: "5.1" };
    report.source = { root, head: null, branch: null, working_tree_dirty: null };
    const git = args => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 16384, shell: false, windowsHide: true });
    const head = git(["rev-parse", "HEAD"]);
    if (head.status === 0 && /^[0-9a-f]{40}\s*$/.test(head.stdout || "")) report.source.head = head.stdout.trim();
    const branch = git(["branch", "--show-current"]);
    if (branch.status === 0 && /^[A-Za-z0-9._/-]*\s*$/.test(branch.stdout || "")) report.source.branch = branch.stdout.trim() || "detached";
    const dirty = git(["status", "--porcelain", "--untracked-files=all"]);
    if (dirty.status === 0) report.source.working_tree_dirty = Boolean(dirty.stdout.trim());
    const add = (name, ok, detail, applicable = true) => report.checks.push({ name, ok, detail, applicable });
    add("evaluation_clock", options.offline || clockVerdict === "plausible_unverified",
      "Only a plausible local clock is usable for non-offline preflight; time is never authenticated.", !options.offline);
    add("node_22_x64", process.versions.node.split(".")[0] === "22" && process.arch === "x64", "Supported Windows acceptance target is Node.js 22 x64.");
    add("native_windows", options.offline || process.platform === "win32", "Offline mode is not Windows platform acceptance.", !options.offline);
    add(report.requested_target === "windows11" ? "windows11_target" : "windows10_target", options.offline || report.target_match,
      "Only an explicitly recognized matching Windows client passes preflight.", !options.offline);
    if (report.requested_target === "windows11") add("windows11_support", options.offline || report.support_status === "supported",
      "Unsupported/unknown Windows 11 builds and editions block production preflight.", !options.offline);
    add("powershell_host", options.offline || /^(?:5\.1\.|[6-9]\.)/.test(metadata.powershell?.version || ""), "PowerShell host version is inspected for preflight.", !options.offline);
    const storage = hardlinkProbe(options.jobsRoot);
    report.jobs_root = options.jobsRoot;
    add("job_storage", storage.ok, storage.code);
    if (process.platform === "win32") add("local_ntfs", metadata.jobs_volume?.file_system === "NTFS" && metadata.jobs_volume?.drive_type === 3, "Durable jobs require a verified local NTFS volume; do not use a network or synchronized job folder.");
    // An already-blocked preflight must not run the offline doctor wrapper
    // (which may check a repository-owned wrapper via --version). Offline
    // diagnostics still run the full doctor for protocol evidence.
    if (options.offline || report.checks.every(check => check.ok)) {
      const doctor = require(path.join(root, "skills/zcode-mmx-review/scripts/review-run.js")).doctorOffline(path.join(root, "skills"));
      add("release_and_protocol", doctor.status === "ok", doctor.checks.filter(check => !check.ok).map(check => check.name));
    } else {
      add("release_and_protocol", false, "not_run_due_to_failed_prerequisite");
    }
    if (!options.offline) {
      add("windows_global_slot_disabled", process.env.MMX_GLOBAL_SLOT !== "1", "Windows global slot is intentionally unavailable.");
      add("no_inherited_cancellation", !process.env.MMX_CANCEL_REQUEST_FILE && !process.env.ZCODE_CANCEL_REQUEST_FILE, "Run the preflight from a normal terminal, outside a managed job.");
      // These checks (host, OS support, storage, release/protocol, inherited
      // cancellation and global-slot policy) MUST gate CLI lookup and launch,
      // not just the final readiness string. Both CLIs remain not_probed on
      // every precondition failure. No user/env flag can bypass this gate.
      if (report.checks.every(check => check.ok)) {
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
    }
    report.tests = options.offline ? runOfflineTests(root, options.report) : [];
    for (const suite of report.tests) add(`tests:${suite.name}`, suite.ok, suite.summary);
    if (report.checks.every(check => check.ok)) report.readiness = options.offline ? "offline_pass" : "preflight_ready";
    report.failed = report.checks.filter(check => !check.ok).map(check => check.name);
    report.note = "offline_pass is diagnostics only and NOT Windows client compatibility approval. preflight_ready does not prove provider authentication, billed requests, descendant cleanup, or the unified real backend.";
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
  } catch { process.stderr.write("Local check refused. Use --jobs-root DIRECTORY --report NEW_FILE [--offline] [--target-os windows10|windows11]; existing reports are never replaced.\n"); process.exitCode = 2; }
}

module.exports = { parseArgs, hostClass, targetMatch, supportStatus, WINDOWS11_SUPPORT_TABLE,
  validateSupportTable, clockStatus, hardlinkProbe, versionToken, probeVersion, testFiles, readHost, run };
