"use strict";

// Whitelisted environment for offline contract tests. process.env is never
// spread into a test child: the inherited PATH (which may hold a real
// provider CLI), credentials, proxies, NODE_OPTIONS/NODE_PATH/preloads and
// GitHub tokens are not passed on. A test adds only what it needs, for
// example a directory holding a fake CLI launcher placed in front of the
// base PATH. HOME, temp and config locations point into a private sandbox.

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

function baseEnv() {
  const root = sandboxRoot();
  const windows = process.platform === "win32";
  const dirs = [path.dirname(process.execPath)];
  const systemRoot = Object.keys(process.env).find(key => key.toLowerCase() === "systemroot");
  if (windows) {
    const windowsDir = systemRoot ? process.env[systemRoot] : "C:\\Windows";
    dirs.push(path.join(windowsDir, "System32"), windowsDir);
  } else {
    dirs.push("/usr/bin", "/bin");
  }
  const dir = name => path.join(root, name);
  const env = {
    PATH: dirs.join(path.delimiter), LANG: "C.UTF-8", CI: "true",
    HOME: dir("home"), USERPROFILE: dir("home"),
    APPDATA: dir("appdata"), LOCALAPPDATA: dir("localappdata"),
    XDG_CONFIG_HOME: dir("config"), XDG_CACHE_HOME: dir("cache"), XDG_DATA_HOME: dir("data"),
    TMPDIR: dir("tmp"), TMP: dir("tmp"), TEMP: dir("tmp"),
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function cleanEnv(extra = {}) {
  return { ...baseEnv(), ...extra };
}

// Explicit offline fixture contract for a batch wrapper: absolute regular
// file inside the declared root, bound by SHA-256. The batch entry honours a
// wrapper override only together with these values.
function fixtureEnv(side, wrapper) {
  const key = `${String(side).toUpperCase()}_BATCH_WRAPPER`;
  return { ZMX_OFFLINE_FIXTURE: "1", ZMX_FIXTURE_ROOT: path.dirname(path.resolve(wrapper)),
    ZMX_FIXTURE_SHA256: createHash("sha256").update(fs.readFileSync(wrapper)).digest("hex"), [key]: path.resolve(wrapper) };
}

module.exports = { cleanEnv, fixtureEnv, PROXY_KEYS };
