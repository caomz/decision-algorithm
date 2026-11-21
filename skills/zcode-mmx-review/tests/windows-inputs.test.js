"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const runner = require("../scripts/review-run.js");
const coverage = require("../scripts/shard-coverage.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-windows-inputs-"));
const script = path.resolve(__dirname, "../scripts/review-run.js");
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("UTF-8 BOM and CRLF input survives fixture run and archive verification byte for byte", () => {
  const packet = { facts: [{ id: "F1", text: "Windows 中文完整输入" }] };
  const bytes = Buffer.from("\ufeff" + JSON.stringify(packet, null, 2).replace(/\n/g, "\r\n") + "\r\n");
  const input = path.join(root, "packet 中文.json");
  const out = path.join(root, "run 中文");
  fs.writeFileSync(input, bytes);
  const result = spawnSync(process.execPath, [script, "run", "--backend", "fixture", "--scenario", "both-pass", "--packet", input, "--out", out], {
    encoding: "utf8", timeout: 20000, shell: false,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(out, "packet.json")), bytes);
  assert.equal(runner.verifyRun(out).integrity, "ok");
});

test("pack reads PowerShell UTF-8 BOM JSON without relaxing duplicate-key rejection", () => {
  const facts = path.join(root, "facts.json");
  const output = path.join(root, "packed.json");
  fs.writeFileSync(facts, '\ufeff[{"id":"F1","text":"PowerShell 中文"}]\r\n');
  const run = args => spawnSync(process.execPath, [script, "pack", "--facts", facts, "--out", ...args], {
    encoding: "utf8", timeout: 5000, shell: false,
  });
  const good = run([output]);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).facts[0].text, "PowerShell 中文");
  fs.writeFileSync(facts, '\ufeff[{"id":"F1","id":"F2","text":"duplicate"}]');
  const bad = path.join(root, "duplicate.json");
  assert.equal(run([bad]).status, 2);
  assert.equal(fs.existsSync(bad), false);
});

test("invalid UTF-8 bytes are refused rather than silently replaced in review material", () => {
  const bad = Buffer.concat([Buffer.from('{"facts":[{"id":"F1","text":"'), Buffer.from([0xff]), Buffer.from('"}]}')]);
  assert.throws(() => runner.buildRunPacket(bad), /UTF-8/);
});

test("BOM packet retains original hash and bytes through coverage planning", () => {
  const raw = Buffer.from('\ufeff{"goal":{"request":"中文检查","acceptance":["全部输入"]}}\r\n');
  const out = path.join(root, "coverage 中文");
  coverage.writePlan(raw, out);
  assert.deepEqual(fs.readFileSync(path.join(out, "packet.json")), raw);
  assert.equal(coverage.verifyPlan(out).integrity, "match");
});
