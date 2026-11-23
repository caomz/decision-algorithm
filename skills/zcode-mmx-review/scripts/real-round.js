"use strict";

const fs = require("node:fs");
const path = require("node:path");

const skills = fs.realpathSync(path.resolve(__dirname, "../.."));

// Load the checkout wrappers, never a fixture, installed skill or caller-supplied script.
function wrapper(side) {
  const file = path.join(skills, side, "scripts", side + "-chat.js");
  if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) {
    throw new Error("real " + side + " wrapper must be a regular checkout file");
  }
  return file;
}

// Keep provider-specific authentication and network settings with their own CLI.
// Only names of inherited variables are archived, never credentials or their values.
function selectEnvironment(pattern) {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => pattern.test(key)));
}

function createRealBackend({ timeoutSeconds, envBase, mmxBinDir }) {
  const host = {
    ...envBase,
    ...selectEnvironment(/^(HOME|USERPROFILE|USER|LOGNAME|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LC_CTYPE|TERM|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i),
  };
  const zcode = {
    ...host,
    ...selectEnvironment(/^ZCODE_(DATA_BASE_DIR|PERSONAL_PROVIDER_CONFIG_FILE|HTTP_PROXY|NO_PROXY|AGENT_CA_CERT)$/),
    ZCODE_CLI_MODE: process.platform === "win32" ? "guarded" : "plan",
  };
  const mmx = {
    ...host,
    ...selectEnvironment(/^(MINIMAX_(BASE_URL|API_KEY|GROUP_ID)|MMX_(CONFIG_DIR|API_KEY|GLOBAL_SLOT|KEEP_PROXY)|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|XDG_CONFIG_HOME)$/i),
  };
  if (mmxBinDir !== undefined) {
    if (!path.isAbsolute(mmxBinDir)) throw new Error("--mmx-bin-dir requires an absolute directory");
    const executable = process.platform === "win32" ? "mmx.cmd" : "mmx";
    fs.accessSync(path.join(mmxBinDir, executable), fs.constants.X_OK);
    mmx.PATH = [fs.realpathSync(mmxBinDir), host.PATH].filter(Boolean).join(path.delimiter);
  }
  // ZCode may spend 10s each discovering its runtime and keychain. MMX has a
  // 30s wrapper margin and, if enabled, a separate 120s global-slot wait.
  const margin = mmx.MMX_GLOBAL_SLOT === "1" ? 180 : 60;
  const wrappers = { zcode: wrapper("zcode"), mmx: wrapper("mmx") };
  const env = { zcode, mmx };
  const nativeEntries = {};
  // Verify both launch chains before either side can spend the first request.
  for (const side of Object.keys(wrappers)) {
    const proof = require(wrappers[side]).preflightRequestBudget(env[side]);
    if (!proof.ok || !/^[a-f0-9]{64}$/.test(proof.entry_sha256)) {
      throw Object.assign(new Error(`${side}: cannot enforce a single native request (${proof.reason || "missing entry fingerprint"}). No model request dispatched.`), { side });
    }
    nativeEntries[side] = proof.entry_sha256;
  }
  return {
    wrappers, env, nativeEntries, deadlineMs: (timeoutSeconds + margin) * 1000,
  };
}

module.exports = { createRealBackend };
