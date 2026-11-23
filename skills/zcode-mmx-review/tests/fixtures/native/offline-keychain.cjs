"use strict";

// Darwin's wrapper resolves a default Keychain even with an entirely fake CLI.
// Stub only that subprocess, inside the ZCode wrapper, for this offline test.
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const wrapper = path.resolve(__dirname, "../../../../zcode/scripts/zcode-chat.js");
require("../../../../zcode/tests/fixtures/install-budget-test.cjs");

if (process.argv[1] === wrapper) {
  const spawnSync = cp.spawnSync;
  cp.spawnSync = function (command, args, options) {
    if (command !== "/usr/bin/security") return spawnSync(command, args, options);
    if (JSON.stringify(args) !== JSON.stringify(["default-keychain", "-d", "user"])) {
      throw new Error("unexpected keychain operation in offline test");
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-keychain-"));
    const file = path.join(dir, "offline.keychain-db");
    fs.writeFileSync(file, "", { mode: 0o600 });
    return { status: 0, stdout: JSON.stringify(file) };
  };
} else {
  const spawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    if (command === process.execPath && args[0] === wrapper) {
      return spawn(command, ["--require", __filename, ...args], options);
    }
    return spawn(command, args, options);
  };
}
