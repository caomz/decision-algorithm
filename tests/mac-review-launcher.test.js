"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const command = path.resolve(__dirname, "../Mac交叉验证.command");
const native = path.resolve(__dirname, "../skills/zcode-mmx-review/tests/fixtures/native");
const mmxBudget = require.resolve("../skills/mmx/tests/fixtures/native-budget-fixture.cjs");

function sandbox(scenario = {}, { selectedName, revealStatus = 0 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mac-review-launcher-"));
  const home = path.join(base, "home");
  const cwd = path.join(base, "中文 目录");
  const bin = path.join(base, "bin");
  const tmp = path.join(base, "tmp");
  for (const dir of [home, cwd, bin, tmp]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(path.join(bin, "scenario.json"), JSON.stringify(scenario));
  const fixture = path.join(native, "round-cli.cjs");
  const launcher = "#!" + process.execPath + "\nrequire(" + JSON.stringify(fixture) + ").main('zcode', __dirname);\n";
  fs.writeFileSync(path.join(bin, "zcode"), launcher, { mode: 0o700 });
  require(mmxBudget).install(bin, fixture, "main", ["mmx", bin]);
  // Avoid opening Finder or using the default Keychain, including in subprocesses.
  const bootstrap = path.join(bin, "offline.cjs");
  const pickerMarker = path.join(bin, "picker-called");
  const selected = selectedName ? path.join(cwd, selectedName) + "\n" : "";
  const revealLog = path.join(bin, "finder-reveal.json");
  fs.writeFileSync(bootstrap, [
    '"use strict";',
    "const cp = require('node:child_process');",
    "const fs = require('node:fs');",
    "const spawnSync = cp.spawnSync;",
    "cp.spawnSync = function(cmd, args, opts) {",
    "  if (cmd === '/usr/bin/open') {",
    "    fs.writeFileSync(" + JSON.stringify(revealLog) + ", JSON.stringify(args), {flag: 'wx'});",
    "    return {status: " + revealStatus + ", signal: null};",
    "  }",
    "  if (cmd !== '/usr/bin/osascript') return spawnSync(cmd, args, opts);",
    "  fs.writeFileSync(" + JSON.stringify(pickerMarker) + ", 'called');",
    "  const selected = " + JSON.stringify(selected) + ";",
    "  if (selected) return {status: 0, signal: null, stdout: selected, stderr: ''};",
    "  return {status: 1, signal: null, stdout: '', stderr: 'User canceled. (-128)'};",
    "};",
    "require(" + JSON.stringify(path.join(native, "offline-keychain.cjs")) + ");",
  ].join("\n"));
  const env = {
    HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter), LANG: "en_US.UTF-8",
    NODE_OPTIONS: "--require=" + JSON.stringify(bootstrap) + " --require=" + JSON.stringify(mmxBudget),
  };
  return {
    bin, cwd, home, revealLog,
    run(...args) {
      const child = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 30000 });
      assert.ifError(child.error);
      assert.equal(child.signal, null);
      return child;
    },
    input(name, content) { fs.writeFileSync(path.join(cwd, name), content); return name; },
    count(side) {
      const log = path.join(bin, side + ".attempts");
      return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0;
    },
  };
}

describe("Mac command from a separate working directory", { skip: process.platform !== "darwin" }, () => {
  for (const [ext, scenario, code, gate] of [
    ["md", {}, 0, "PASS"],
    ["json", { mmx: "fail" }, 1, "FAIL"],
    ["txt", { mmx: "truncate" }, 2, "NOT_EVALUATED"],
  ]) {
    test(ext + " input keeps its contents, verdict and offline replay", () => {
      const box = sandbox(scenario);
      const content = "离线标记，带空格的内容。\n第二行。";
      const packet = { facts: [{ id: "F1", text: content }] };
      const name = box.input("审核 稿件." + ext, ext === "json" ? JSON.stringify(packet) : content);
      const results = path.join(box.cwd, "本轮 记录");
      const run = box.run("--results-dir", results, name);
      assert.equal(run.status, code, run.stdout + run.stderr);
      assert.ok(run.stdout.includes(gate), run.stdout);
      const jobs = fs.readdirSync(results);
      assert.equal(jobs.length, 1);
      const job = path.join(results, jobs[0]);
      const archive = path.join(job, "run");
      const archivedPacket = JSON.parse(fs.readFileSync(path.join(archive, "packet.json"), "utf8"));
      if (ext === "json") assert.deepEqual(archivedPacket, packet);
      else assert.ok(archivedPacket.facts.some(fact => fact.text.includes(content)));
      const result = JSON.parse(fs.readFileSync(path.join(archive, "result.json"), "utf8"));
      assert.equal(result.review_gate, gate);
      assert.equal(result.backend, "real");
      const verify = box.run("--verify", ext === "json" ? job : archive);
      assert.equal(verify.status, 0, verify.stdout + verify.stderr);
      if (ext === "md") {
        fs.appendFileSync(path.join(archive, "material.txt"), "altered");
        assert.equal(box.run("--verify", archive).status, 2);
      }
      for (const side of ["zcode", "mmx"]) assert.equal(box.count(side), 1);
      assert.equal(fs.existsSync(box.revealLog), false);
    });
  }

  test("dry run and invalid inputs leave results and providers untouched", () => {
    const box = sandbox();
    const results = path.join(box.cwd, "零调用 结果");
    const small = box.input("小 文本.md", "本次审核材料");
    const large = box.input("大 文本.txt", "汉".repeat(8192));
    const bad = box.input("无效 包.json", '{"facts":[]}');
    for (const [expected, args] of [
      [0, ["--dry-run", small]], [2, [large]], [2, ["--dry-run", large]],
      [2, [bad]], [2, ["没有此文件.txt"]],
    ]) {
      const run = box.run("--results-dir", results, ...args);
      assert.equal(run.status, expected, run.stdout + run.stderr);
      assert.equal(fs.existsSync(results), false);
    }
    for (const side of ["zcode", "mmx"]) assert.equal(box.count(side), 0);
  });

  test("cancelling the file picker dispatches no review", () => {
    const box = sandbox();
    const run = box.run();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(fs.existsSync(path.join(box.bin, "picker-called")), true);
    assert.equal(fs.existsSync(box.revealLog), false);
    for (const side of ["zcode", "mmx"]) assert.equal(box.count(side), 0);
  });

  test("preflight reports the full multi-shard budget without writing a job or dispatching", () => {
    const box = sandbox();
    const name = box.input("长 材料.md", "ALPHA ".repeat(4400));
    const dir = path.join(box.cwd, "只读预检");
    const check = box.run("--dry-run", "--max-shards", "2", "--max-tokens", "4096", "--timeout-seconds", "25", "--results-dir", dir, name);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /2 片，两侧合计最多 4 次/);
    assert.match(check.stdout, /4096 tokens，时限 25 秒/);
    assert.equal(box.run("--max-shards", "1", "--results-dir", dir, name).status, 2);
    assert.equal(box.run("--max-shards", "33", "--results-dir", dir, name).status, 2);
    assert.equal(box.run("--max-tokens", "524289", "--results-dir", dir, name).status, 2);
    assert.equal(fs.existsSync(dir), false);
    for (const side of ["zcode", "mmx"]) assert.equal(box.count(side), 0);
  });

  test("an explicit unsupported MMX launcher stops both providers before spending", () => {
    const box = sandbox();
    const name = box.input("授权检查.md", "Check the two labels.");
    const bin = path.join(box.cwd, "unverified"), dir = path.join(box.cwd, "未派发");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "mmx"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const child = box.run("--mmx-bin-dir", bin, "--results-dir", dir, name);
    assert.equal(child.status, 2, child.stdout);
    assert.equal(fs.existsSync(dir), false);
    for (const side of ["zcode", "mmx"]) assert.equal(box.count(side), 0);
  });

  for (const revealStatus of [0, 1]) {
    test("Finder selects a document and reveals the private summary (open exit " + revealStatus + ")", () => {
      const selectedName = "选中的 审核稿.md";
      const box = sandbox({}, { selectedName, revealStatus });
      box.input(selectedName, "由文件选择器传入的材料。");
      const run = box.run();
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const results = path.join(box.home, "Library", "Application Support", "Decision Algorithm", "Reviews");
      const jobs = fs.readdirSync(results);
      assert.equal(jobs.length, 1);
      const summary = path.join(results, jobs[0], "审核摘要.txt");
      assert.deepEqual(JSON.parse(fs.readFileSync(box.revealLog, "utf8")), ["-R", summary]);
      assert.equal(fs.statSync(summary).mode & 0o777, 0o600);
      assert.match(fs.readFileSync(summary, "utf8"), /PASS/);
      for (const side of ["zcode", "mmx"]) assert.equal(box.count(side), 1);
    });
  }
});
