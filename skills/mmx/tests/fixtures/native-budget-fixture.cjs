"use strict";

// The fake package only uses an in-memory fetch implementation. A test process
// can trust this exact entry without adding a test exception to the shipped CLI.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const Module = require("node:module");

const entryText = `#!/usr/bin/env node
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
if (!globalThis.__mmxNoNetworkTransport) throw new Error("offline transport missing");
const opts = JSON.parse(req("node:fs").readFileSync(new URL("../driver.json",import.meta.url)));
if (process.env.FAKE_GUARD_WORKER) {
  const worker = new (req("node:worker_threads").Worker)("0", {eval:true});
  if (await new Promise(resolve=>worker.once("exit",resolve))) throw new Error("worker preload failed");
}
const n = Number(process.argv[process.argv.indexOf("--max-tokens") + 1]);
await fetch("https://mmx-fixture.invalid/anthropic/v1/messages", {method:"POST",body:JSON.stringify({max_tokens:n})});
const driver = req(opts.file);
if (opts.method) await driver[opts.method](...(opts.args || []));
`;
const fixtureDigest = crypto.createHash("sha256").update(entryText).digest("hex");
const undiciText = `if (process.env.FAKE_GUARD_FAILURE === "import") throw Error("synthetic import failure");
if (process.env.FAKE_GUARD_FAILURE === "hang") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
class Agent { constructor(options){this.options=options;} }
module.exports={Agent,setGlobalDispatcher(a){
  if (process.env.FAKE_GUARD_FAILURE === "dispatcher") throw Error("synthetic dispatcher failure");
  globalThis.__fakeGuard=a.options;
  globalThis.__mmxNoNetworkTransport=true;
  globalThis.fetch=async()=>new Response("offline", {status:200});
}};`;

function install(bin, file, method = null, args = []) {
  const pkgRoot = path.join(bin, "node_modules/mmx-cli");
  const entry = path.join(pkgRoot, "dist/mmx.mjs");
  const undici = path.join(pkgRoot, "node_modules/undici");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(undici, { recursive: true });
  fs.writeFileSync(entry, entryText, { mode: 0o700, flag: "wx" });
  fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({
    name: "mmx-cli", version: "1.0.29", bin: { mmx: "dist/mmx.mjs" },
  }));
  fs.writeFileSync(path.join(pkgRoot, "driver.json"), JSON.stringify({ file, method, args }));
  fs.writeFileSync(path.join(undici, "package.json"), '{"name":"undici","main":"index.js"}');
  fs.writeFileSync(path.join(undici, "index.js"), undiciText);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "mmx.cmd"), '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\mmx-cli\\dist\\mmx.mjs" %*\r\n');
  } else fs.symlinkSync(entry, path.join(bin, "mmx"));
  return { pkgRoot, pkgBin: bin, entry };
}

// Run only in test processes that explicitly preload this test dependency.
// Verify both the fixture entry and its no-network transport before substituting
// its identity. Real payload checks, native request counting and receipts stand.
if (module.parent?.id === "internal/preload") {
  const load = Module._load;
  Module._load = function (name, parent, isMain) {
    const exported = load.call(this, name, parent, isMain);
    if (name !== "./mmx-native-budget.js") return exported;
    return { ...exported, supportedEntry(entry, root) {
      const digest = crypto.createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
      if (digest !== fixtureDigest) return false;
      return fs.readFileSync(path.join(root, "node_modules/undici/index.js"), "utf8") === undiciText;
    } };
  };
  const spawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    if (command === process.execPath && Array.isArray(args) &&
        (["mmx-chat.js", "review-run.js"].includes(path.basename(args[0] || "")) ||
         (args[0] === "--require" && path.basename(args[1] || "") === "fetch-timeout-guard.js"))) {
      return spawn(command, ["--require", __filename, ...args], options);
    }
    return spawn(command, args, options);
  };
}

module.exports = { install, undiciText };
