"use strict";
// Bounded teardown for processes a test owns. Nothing is looked up by name,
// by port or through the host's process list. A process is signalled only
// when this test run spawned it (a ChildProcess) or when a fixture recorded
// its pid together with a marker that this test run put into its command
// line. A live pid whose command line does not carry the marker is never
// touched: for a recorded pid that proves the original process exited and
// the pid was reused.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const TERM_GRACE_MS = 1500;
const KILL_GRACE_MS = 5000;
const owned = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function track(target) { owned.add(target); return target; }
function untrack(target) { owned.delete(target); return target; }
function alive(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code === "EPERM"; }
  // kill(0) also succeeds for a zombie: it exists as a reaped-pending entry
  // and can never run again. On Linux that state is readable directly.
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return !stat.slice(stat.lastIndexOf(")") + 2).trimStart().startsWith("Z");
    } catch { return false; }
  }
  return true;
}
function signal(pid, name) {
  // Returns the empty string on success, otherwise the errno code: stop()
  // surfaces it so a real survivor is diagnosable instead of silent.
  try { process.kill(pid, name); return ""; } catch (error) { return error.code || "ERR"; }
}

function commandLine(pid) {
  // One retry: a query that comes back empty during process death must not
  // be mistaken for ownership evidence. powershell.exe lives outside the
  // directories CreateProcess searches by default, so it is resolved
  // absolutely and never through PATH.
  const powershell = path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = process.platform === "win32"
      ? spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: "utf8", timeout: 15000, shell: false })
      : spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 15000, shell: false });
    if (run.status === 0 && run.stdout) return run.stdout;
  }
  return "";
}

// target: a ChildProcess this test spawned, or { pid, marker } for a
// descendant a fixture recorded. Returns exited, "pid reused; the recorded
// process exited" or survived.
async function stop(target) {
  const pid = Number(target.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return "exited";
  const recorded = typeof target.marker === "string" && target.marker.length > 0;
  if (!recorded && (target.exitCode !== null || target.signalCode !== null)) return "exited";
  if (!alive(pid)) return "exited";
  if (recorded) {
    const line = commandLine(pid);
    if (!line.includes(target.marker)) return `pid reused; the recorded process exited (cmdline=${JSON.stringify(line.slice(0, 120))})`;
  }
  const closed = typeof target.once === "function" ? new Promise(resolve => target.once("close", resolve)) : null;
  const termErr = signal(pid, "SIGTERM");
  if (closed ? await Promise.race([closed, sleep(TERM_GRACE_MS)]) : !alive(pid)) return "exited";
  const killErr = signal(pid, "SIGKILL");
  if (closed ? await Promise.race([closed, sleep(KILL_GRACE_MS)]) : !alive(pid)) return "exited";
  // A pid that still looks alive after SIGKILL is either a zombie waiting to
  // be reaped (dead, reported by the check above on Linux) or a reused pid
  // that no longer carries the marker; the original exited either way. Only
  // a marker-carrying survivor fails the run, with the delivery errors shown.
  if (recorded && !commandLine(pid).includes(target.marker)) return "pid reused; the recorded process exited";
  return `survived (alive after SIGKILL; termErr=${termErr || "none"} killErr=${killErr || "none"})`;
}

// Stops everything still tracked. A process that outlived both signals fails
// the run by name instead of being left behind; a recorded pid that can no
// longer be proven to belong to this run is left alone on purpose.
async function teardown() {
  const problems = [];
  for (const target of owned) {
    const outcome = await stop(target);
    if (outcome === "exited" || outcome.startsWith("pid reused")) owned.delete(target);
    else problems.push(`pid ${target.pid}: ${outcome}`);
  }
  if (problems.length) throw new Error(`test-owned processes not confirmed exited: ${problems.join("; ")}`);
}

module.exports = { track, untrack, stop, teardown };
