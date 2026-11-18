"use strict";

// Offline tests for mmx-clean-temp.js. Every case runs the real script with
// TEMP/TMP/TMPDIR pointed at a synthetic fixture root; the real %TEMP% is
// never touched and --apply is only ever executed against fixtures.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "..", "scripts", "mmx-clean-temp.js");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-clean-contract-"));
const OLD = new Date(Date.now() - 30 * 3600 * 1000);

after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

function makeFixture(name) {
  const root = path.join(base, name);
  fs.mkdirSync(root);
  const dir = rel => {
    const p = path.join(root, rel);
    fs.mkdirSync(p, { recursive: true });
    return p; // Fresh mtime: must never be treated as stale.
  };
  const stale = rel => {
    const p = dir(rel);
    fs.utimesSync(p, OLD, OLD);
    return p;
  };
  const file = (rel, content) => {
    const p = path.join(root, rel);
    fs.writeFileSync(p, content);
    fs.utimesSync(p, OLD, OLD);
    return p;
  };
  return { root, dir, stale, file };
}

function run(args, root) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8", windowsHide: true, shell: false,
    env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root },
  });
}

function receipt(runResult) {
  assert.equal(runResult.stderr.includes("Error"), false, runResult.stderr);
  return JSON.parse(runResult.stdout.trim().split("\n").pop());
}

test("dry-run lists every stale shape-matched dir and deletes nothing", () => {
  const fx = makeFixture("dry");
  const expected = ["mmx.abcdef", "mmxP1.219edd", "mmxA2.d4d8bd", "mmxrun.fOQFkc", "mmxdbg3.556406"];
  for (const name of expected) fx.stale(name);
  const fresh = fx.dir("mmx.fresh1");
  const exemptChat = fx.stale("mmx-chat-AbCdEf");
  const exemptMcv = fx.stale("mcv.x1y2z3");
  const badShort = fx.stale("mmxP2.abc");
  const badNoDot = fx.stale("mmxfoo");
  const badUpper = fx.stale("MMX.ABCDEF");
  const plainFile = fx.file("mmx.file12", "not a dir");
  fx.stale("mmxlnk.abcdef");
  try { fs.symlinkSync(fx.root, path.join(fx.root, "mmxlnk.abcdef", "inner"), "junction"); }
  catch { /* links unavailable: degrade to the non-link assertions below */ }

  const result = run([], fx.root);
  assert.equal(result.status, 0);
  const out = receipt(result);
  assert.equal(out.mode, "dry-run");
  assert.equal(out.matched, 7, "five stale shapes + fresh + linked shape match the shape rule");
  assert.equal(out.aged, 5, "the linked candidate is skipped by containsLink");
  assert.equal(out.deleted, 0);
  assert.equal(out.candidates.length, 5);
  assert.deepEqual(out.candidates.map(c => c.name).sort(), expected.slice().sort());
  for (const keep of [fresh, exemptChat, exemptMcv, badShort, badNoDot, badUpper, plainFile]) {
    assert.ok(fs.existsSync(keep), `${path.basename(keep)} must survive dry-run`);
  }
});

test("--apply deletes exactly the stale shape-matched dirs", () => {
  const fx = makeFixture("apply");
  const doomed = ["mmx.abcdef", "mmxP1.219edd", "mmxA2.d4d8bd", "mmxrun.fOQFkc", "mmxdbg3.556406"];
  for (const name of doomed) fx.stale(name);
  const fresh = fx.dir("mmx.fresh1");
  const exemptChat = fx.stale("mmx-chat-AbCdEf");
  const exemptMcv = fx.stale("mcv.x1y2z3");
  const badShort = fx.stale("mmxP2.abc");

  const result = run(["--apply"], fx.root);
  assert.equal(result.status, 0);
  const out = receipt(result);
  assert.equal(out.mode, "apply");
  assert.equal(out.deleted, 5);
  assert.equal(out.failed, 0);
  for (const name of doomed) assert.ok(!fs.existsSync(path.join(fx.root, name)), `${name} must be deleted`);
  for (const keep of [fresh, exemptChat, exemptMcv, badShort]) {
    assert.ok(fs.existsSync(keep), `${path.basename(keep)} must survive --apply`);
  }
});

test("age gate: a shape-matched dir younger than 24h is never touched", () => {
  const fx = makeFixture("age");
  const young = fx.dir("mmx.young1");
  const result = run(["--apply"], fx.root);
  const out = receipt(result);
  assert.equal(out.matched, 1);
  assert.equal(out.aged, 0);
  assert.equal(out.deleted, 0);
  assert.ok(fs.existsSync(young));
});

test("stats add up: scanned counts every entry, matched only shape dirs", () => {
  const fx = makeFixture("stats");
  fx.stale("mmx.abcdef");
  fx.file("noise.log", "x");
  fx.stale("mmx-chat-ZZZZZZ");
  const result = run([], fx.root);
  const out = receipt(result);
  assert.equal(out.scanned, 3);
  assert.equal(out.matched, 1);
  assert.equal(out.aged, 1);
  assert.equal(out.status, "ok");
});

test("--help prints usage and exits 0 without scanning", () => {
  const result = run(["--help"], base);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("mmx-clean-temp"));
  assert.ok(result.stdout.includes("--apply"));
});

test("unknown arguments are a usage error", () => {
  const result = run(["--evil"], base);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, "usage_error");
});
