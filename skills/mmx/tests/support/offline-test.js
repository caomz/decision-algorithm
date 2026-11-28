#!/usr/bin/env node
"use strict";
// The only supported way to run this skill's offline tests. It starts the test
// runner with the shared whitelisted environment, marked as a forced offline
// test, and refuses to start when a provider launcher is installed in the one
// host directory every test PATH still contains (the Node directory, which is
// also the npm global bin directory on many hosts).
//
//   node skills/<skill>/tests/support/offline-test.js "skills/<skill>/tests/**/*.test.js"
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { baseDirectories } = require("./env.js");

const PROVIDER = /^(zcode|mmx)([.\-].*)?$/i;
const SYSTEM_KEYS = ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"];

function main(argv) {
  if (process.env.ZMX_OFFLINE_TEST === "1") {
    process.stderr.write("offline-test: already inside the offline entry\n");
    return 2;
  }
  const found = fs.readdirSync(baseDirectories()[0]).filter(name => PROVIDER.test(name));
  if (found.length) {
    process.stderr.write(`offline-test refused: a provider launcher is installed beside node: ${found.join(", ")}\n`);
    return 2;
  }
  const patterns = argv.length ? argv : [path.join(__dirname, "..", "**", "*.test.js").replace(/\\/g, "/")];
  // The test runner itself gets a whitelist. A test that forgets cleanEnv can
  // then inherit only these keys, never the host's PATH or credentials.
  const env = { PATH: baseDirectories().join(path.delimiter), LANG: "C.UTF-8", CI: "true", ZMX_OFFLINE_TEST: "1" };
  for (const key of SYSTEM_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--test", ...patterns], { stdio: "inherit", shell: false, env });
    child.once("error", () => resolve(2));
    child.once("close", code => resolve(code ?? 2));
  });
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
else module.exports = { main };
