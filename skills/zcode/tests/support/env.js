"use strict";

// Environment for offline contract tests. process.env is never spread into a
// test child. Every child is built here, and only inside the forced offline
// entry (tests/support/offline-test.js), which marks the test process with
// ZMX_OFFLINE_TEST=1.
//
//   PATH      the Node directory and the system directories, plus directories
//             inside the temp sandbox. Anything else is refused by name, so a
//             host PATH can never be attached.
//   forced    ZMX_OFFLINE_FIXTURE=1 is always present: a batch whose wrapper
//             fixture is omitted is refused, never defaulted to the
//             production wrapper.
//   isolated  HOME, temp and config locations point into a private sandbox;
//             credentials, proxies, NODE_OPTIONS, Node paths and tokens are
//             not inherited.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const PROXY_KEYS = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy",
  "NODE_USE_ENV_PROXY",
];
const SYSTEM_KEYS = ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"];

let sandbox = null;
function sandboxRoot() {
  if (sandbox) return sandbox;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-test-env-"));
  for (const name of ["home", "tmp", "config", "cache", "data", "appdata", "localappdata"]) {
    fs.mkdirSync(path.join(sandbox, name), { mode: 0o700 });
  }
  process.on("exit", () => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} });
  return sandbox;
}

// The base directories of every test PATH. Exported for the entry, which
// audits the Node directory before any test starts.
function baseDirectories() {
  const dirs = [path.dirname(process.execPath)];
  const systemRoot = Object.keys(process.env).find(key => key.toLowerCase() === "systemroot");
  if (process.platform === "win32") {
    const windowsDir = systemRoot ? process.env[systemRoot] : "C:\\Windows";
    dirs.push(path.join(windowsDir, "System32"), windowsDir);
  } else {
    dirs.push("/usr/bin", "/bin");
  }
  return dirs;
}

function baseEnv() {
  const dir = name => path.join(sandboxRoot(), name);
  const env = {
    PATH: baseDirectories().join(path.delimiter), LANG: "C.UTF-8", CI: "true", ZMX_OFFLINE_FIXTURE: "1",
    HOME: dir("home"), USERPROFILE: dir("home"),
    APPDATA: dir("appdata"), LOCALAPPDATA: dir("localappdata"),
    XDG_CONFIG_HOME: dir("config"), XDG_CACHE_HOME: dir("cache"), XDG_DATA_HOME: dir("data"),
    TMPDIR: dir("tmp"), TMP: dir("tmp"), TEMP: dir("tmp"),
  };
  for (const key of SYSTEM_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function refuse(message) { throw Object.assign(new Error(message), { code: "ZMX_TEST_ENV" }); }
function insideSandbox(entry) {
  let real;
  try { real = fs.realpathSync(entry); } catch { return false; }
  return real.startsWith(fs.realpathSync(os.tmpdir()) + path.sep);
}

function cleanEnv(extra = {}) {
  if (process.env.ZMX_OFFLINE_TEST !== "1") {
    refuse("offline test entry required: run node skills/<skill>/tests/support/offline-test.js");
  }
  if (extra.ZMX_OFFLINE_FIXTURE !== undefined && extra.ZMX_OFFLINE_FIXTURE !== "1") {
    refuse("ZMX_OFFLINE_FIXTURE cannot be turned off in a test");
  }
  if (extra.PATH !== undefined) {
    const additions = extra.PATH.split(path.delimiter).filter(entry => entry !== "");
    const base = baseDirectories();
    for (const entry of additions) {
      if (base.includes(path.resolve(entry)) || insideSandbox(entry)) continue;
      refuse(`offline test PATH may only add directories inside the temp sandbox: ${entry}`);
    }
    // The additions come first so a fixture launcher shadows anything with the
    // same name; the base directories stay available so the children still
    // reach taskkill, cmd.exe and the other system tools they legitimately
    // need. Neither list can contain a host PATH entry.
    const remaining = base.filter(entry => !additions.some(add => path.resolve(add) === path.resolve(entry)));
    extra.PATH = [...additions, ...remaining].join(path.delimiter);
  }
  return { ...baseEnv(), ...extra };
}

// Explicit offline fixture contract for a batch wrapper: absolute regular
// file inside the declared root, bound by SHA-256. ZMX_OFFLINE_FIXTURE=1
// comes from baseEnv.
function fixtureEnv(side, wrapper) {
  const key = `${String(side).toUpperCase()}_BATCH_WRAPPER`;
  return { ZMX_FIXTURE_ROOT: path.dirname(path.resolve(wrapper)),
    ZMX_FIXTURE_SHA256: createHash("sha256").update(fs.readFileSync(wrapper)).digest("hex"), [key]: path.resolve(wrapper) };
}

// The same contract for the CLI a chat wrapper launches. In fixture mode the
// wrapper starts only a launcher inside this root with this digest.
function fixtureCliEnv(launcher) {
  return { ZMX_FIXTURE_CLI_ROOT: path.dirname(path.resolve(launcher)),
    ZMX_FIXTURE_CLI_SHA256: createHash("sha256").update(fs.readFileSync(launcher)).digest("hex") };
}

// For sentinel tests only: the host environment plus extras, so a test can
// prove that a same-name launcher on the host PATH is never reached. Every
// other spawn in the suites must use cleanEnv.
function sentinelEnv(extra = {}) { return { ...process.env, ...extra }; }

module.exports = { cleanEnv, fixtureEnv, fixtureCliEnv, sentinelEnv, baseDirectories, PROXY_KEYS };
