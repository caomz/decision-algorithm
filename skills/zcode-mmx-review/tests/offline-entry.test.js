"use strict";
// V2.2.1 S0: the forced offline entry and the test environment policy. No real
// CLI is reachable here; a same-name sentinel launcher stands in for it and
// must never start.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { cleanEnv, fixtureCliEnv, sentinelEnv } = require("./support/env.js");

const repo = path.resolve(__dirname, "../../..");
const skill = name => path.join(repo, "skills", name);
const win = process.platform === "win32";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-s0-entry-"));
const sentinelLog = path.join(root, "sentinel.log");
const sentinelDir = path.join(root, "sentinel-bin");
fs.mkdirSync(sentinelDir);
for (const name of ["zcode", "mmx"]) {
  const body = win ? "@ECHO off\r\necho " + name + ">>\"" + sentinelLog + "\"\r\n" : "#!/bin/sh\necho " + name + ">>\"" + sentinelLog + "\"\n";
  fs.writeFileSync(path.join(sentinelDir, name + (win ? ".cmd" : "")), body, { mode: 0o755 });
}
const sentinels = () => { try { return fs.readFileSync(sentinelLog, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
const lastJson = out => JSON.parse(out.stdout.trim().split("\n").pop());

test("V2.2.1 S0: the shared environment requires the forced offline entry", () => {
  const probe = path.join(root, "probe.cjs");
  fs.writeFileSync(probe, "const { cleanEnv } = require(" + JSON.stringify(path.join(__dirname, "support/env.js")) + ");\n" +
    "try { cleanEnv(); process.stdout.write(\"built\"); } catch (error) { process.stdout.write(\"refused: \" + error.message); }\n");
  // Host environment minus the entry marker: cleanEnv must refuse.
  const { ZMX_OFFLINE_TEST: _dropped, ...raw } = sentinelEnv();
  assert.match(spawnSync(process.execPath, [probe], { encoding: "utf8", env: raw }).stdout,
    /^refused: offline test entry required/);
  assert.equal(spawnSync(process.execPath, [probe], { encoding: "utf8", env: sentinelEnv({ ZMX_OFFLINE_TEST: "1" }) }).stdout, "built");
});

test("V2.2.1 S0: the environment never inherits a foreign PATH nor drops the forced fixture mode", () => {
  assert.equal(cleanEnv().ZMX_OFFLINE_FIXTURE, "1");
  // Under the forced entry the runner's own PATH is already the whitelist, so
  // a host PATH cannot even be reached here. A directory that is neither a
  // base directory nor inside the temp sandbox stands in for one.
  assert.throws(() => cleanEnv({ PATH: sentinelDir + path.delimiter + repo }),
    /offline test PATH may only add directories inside the temp sandbox/);
  assert.throws(() => cleanEnv({ PATH: "C:\\no-such-foreign-dir" }),
    /offline test PATH may only add directories inside the temp sandbox/);
  assert.throws(() => cleanEnv({ ZMX_OFFLINE_FIXTURE: "0" }), /ZMX_OFFLINE_FIXTURE/);
});

test("V2.2.1 S0: a batch whose wrapper fixture is omitted refuses before reserving an archive", () => {
  const prompt = path.join(root, "a.txt"); fs.writeFileSync(prompt, "hi");
  for (const [side, entry] of [["zcode", path.join(skill("zcode"), "scripts/zcode-batch.js")], ["mmx", path.join(skill("mmx"), "scripts/mmx-batch.js")]]) {
    const receipt = path.join(root, side + ".json");
    const out = spawnSync(process.execPath, [entry, "--prompt-file", prompt, "--receipt-file", receipt], { encoding: "utf8", shell: false, timeout: 20000, env: cleanEnv() });
    assert.equal(lastJson(out).status, "usage_error", side + ": " + out.stdout + out.stderr);
    assert.equal(fs.existsSync(receipt + ".shards"), false, side + " must not reserve an archive");
  }
  assert.deepEqual(sentinels(), []);
});

test("V2.2.1 S0: a missing, unbound or unusable fake CLI never falls through to a same-name launcher", { skip: win && "POSIX executable bit; Windows resolves launchers without X_OK" }, () => {
  const prompt = path.join(root, "b.txt"); fs.writeFileSync(prompt, "hi");
  const dir = path.join(root, "bin"); fs.mkdirSync(dir);
  fs.copyFileSync(path.join(skill("zcode"), "tests/fixtures/fake-zcode.cjs"), path.join(dir, "zcode"));
  fs.chmodSync(path.join(dir, "zcode"), 0o644);
  const wrapper = path.join(skill("zcode"), "scripts/zcode-chat.js");
  const cases = [
    ["missing", ["--prompt-file", prompt, "--cli-path", path.join(root, "no-such-cli")], { ZMX_FIXTURE_CLI_ROOT: root, ZMX_FIXTURE_CLI_SHA256: "0".repeat(64) }],
    ["not executable", ["--prompt-file", prompt], fixtureCliEnv(path.join(dir, "zcode"))],
    ["not bound", ["--prompt-file", prompt], {}],
  ];
  for (const [label, args, cli] of cases) {
    fs.writeFileSync(sentinelLog, "");
    // The unusable fake comes first, the same-name sentinel second: a search
    // that continues past the first hit would reach the sentinel.
    const out = spawnSync(process.execPath, [wrapper, ...args], { encoding: "utf8", shell: false, timeout: 20000, env: cleanEnv({ PATH: dir + path.delimiter + sentinelDir, ...cli }) });
    const receipt = lastJson(out);
    assert.notEqual(receipt.status, "ok", label);
    assert.ok(receipt.cli_invoked === false || receipt.cli_invoked === undefined, label + ": " + out.stdout + out.stderr);
    assert.deepEqual(sentinels(), [], label + ": the same-name launcher started");
  }
});

test("V2.2.1 S0: a bound fixture CLI is the only launcher a fixture-mode wrapper starts", { skip: win && "covered by the zcode suite through --cli-path" }, () => {
  const prompt = path.join(root, "c.txt"); fs.writeFileSync(prompt, "Return FIXED_REPLY");
  const dir = path.join(root, "ok-bin"); fs.mkdirSync(dir);
  // A node shebang so resolveLaunch runs the launcher with this Node.
  fs.writeFileSync(path.join(dir, "zcode"), "#!/usr/bin/env node\n" + fs.readFileSync(path.join(skill("zcode"), "tests/fixtures/fake-zcode.cjs"), "utf8"), { mode: 0o755 });
  const out = spawnSync(process.execPath, [path.join(skill("zcode"), "scripts/zcode-chat.js"), "--prompt-file", prompt],
    { encoding: "utf8", shell: false, timeout: 20000, env: cleanEnv({ PATH: dir, ...fixtureCliEnv(path.join(dir, "zcode")) }) });
  assert.equal(lastJson(out).cli_invoked, true, out.stdout + out.stderr);
  assert.deepEqual(sentinels(), []);
});

test("V2.2.1 S0: no test starts a process without the shared environment", () => {
  const list = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? (entry.name === "fixtures" ? [] : list(path.join(dir, entry.name)))
      : /\.test\.js$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
  const call = /\b(spawn|spawnSync|execFile|execFileSync|fork)\(/g;
  for (const file of ["zcode", "mmx", "zcode-mmx-review"].flatMap(name => list(path.join(skill(name), "tests")))) {
    // Fixture sources written as template strings are children built elsewhere.
    const code = fs.readFileSync(file, "utf8").replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
    for (const match of code.matchAll(call)) {
      // The environment may be built a few lines before the call.
      const around = code.slice(Math.max(0, match.index - 400), match.index + 600);
      assert.match(around, /\b(cleanEnv|sentinelEnv)\(/,
        path.relative(repo, file) + " must start every process with cleanEnv (or sentinelEnv for sentinel tests)");
    }
  }
});

test("V2.2.1 S0: the shared support files are byte-identical in every skill", () => {
  for (const name of ["env.js", "offline-test.js"]) {
    const copies = ["zcode", "mmx", "zcode-mmx-review"].map(side => fs.readFileSync(path.join(skill(side), "tests/support", name)));
    assert.ok(copies.every(bytes => bytes.equals(copies[0])), name);
  }
});
