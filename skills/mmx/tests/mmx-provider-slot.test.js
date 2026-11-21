"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { acquireMmxSlot } = require("../scripts/mmx-provider-slot.js");

async function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-slot-test-"));
  try { return await fn(root); }
  finally { fs.rmSync(root, { force: true, recursive: true }); }
}

test("a second process cannot enter the same MMX provider slot before release", async () => {
  await withRoot(async root => {
    const slot = await acquireMmxSlot({ root, waitMs: 1000 });
    const script = [
      "const { acquireMmxSlot } = require(process.argv[1]);",
      "acquireMmxSlot({root:process.argv[2],waitMs:150}).then(s => {s.release();process.stdout.write('ACQUIRED')}).catch(e=>{process.stdout.write(e.code||'ERROR')});",
    ].join("");
    const runner = path.resolve(__dirname, "../scripts/mmx-provider-slot.js");
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script, runner, root], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.on("error", reject);
      child.on("close", code => resolve({ stdout, code }));
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "MMX_SLOT_BUSY");
    slot.release();
    const next = await acquireMmxSlot({ root, waitMs: 100 });
    next.release();
  });
});

test("timeout never deletes another owner or steals a stale-looking slot", async () => {
  await withRoot(async root => {
    const slot = await acquireMmxSlot({ root });
    assert.equal(fs.existsSync(slot.path), true);
    await assert.rejects(acquireMmxSlot({ root, waitMs: 0 }), e => e.code === "MMX_SLOT_BUSY");
    assert.equal(fs.existsSync(slot.path), true);
    slot.release();
  });
});

test("abort while queued refuses to launch a request and preserves the existing owner", async () => {
  await withRoot(async root => {
    const owner = await acquireMmxSlot({ root });
    const ac = new AbortController();
    const pending = acquireMmxSlot({ root, waitMs: 1000, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(pending, e => e.code === "MMX_SLOT_CANCELLED");
    assert.equal(fs.existsSync(owner.path), true);
    owner.release();
  });
});

test("released slots cannot accidentally unlink a later owner's lease", async () => {
  await withRoot(async root => {
    const first = await acquireMmxSlot({ root });
    first.release();
    const second = await acquireMmxSlot({ root });
    first.release();
    assert.equal(fs.existsSync(second.path), true);
    second.release();
  });
});

test("tampered owner record refuses unsafe release", async () => {
  await withRoot(async root => {
    const slot = await acquireMmxSlot({ root });
    fs.writeFileSync(path.join(slot.path, "owner.json"), JSON.stringify({ owner_id: "other", pid: 1 }));
    assert.throws(() => slot.release(), e => e.code === "MMX_SLOT_UNSAFE");
    assert.equal(fs.existsSync(slot.path), true);
  });
});

test("a release between a waiter's mkdir and stat retries acquisition", async () => {
  await withRoot(async root => {
    const owner = await acquireMmxSlot({ root });
    const lstat = fs.lstatSync;
    let raced = false;
    fs.lstatSync = function (file, ...args) {
      if (file === owner.path && !raced) {
        raced = true;
        owner.release();
      }
      return lstat.call(fs, file, ...args);
    };
    let next;
    try { next = await acquireMmxSlot({ root, waitMs: 100 }); }
    finally { fs.lstatSync = lstat; }
    assert.equal(raced, true);
    next.release();
  });
});

test("replaced lock directory cannot be released using a copied owner record", async () => {
  await withRoot(async root => {
    const slot = await acquireMmxSlot({ root });
    const previous = slot.path + "-previous";
    fs.renameSync(slot.path, previous);
    fs.mkdirSync(slot.path, { mode: 0o700 });
    fs.copyFileSync(path.join(previous, "owner.json"), path.join(slot.path, "owner.json"));
    assert.throws(() => slot.release(), error => error.code === "MMX_SLOT_UNSAFE");
    assert.equal(fs.existsSync(path.join(slot.path, "owner.json")), true);
  });
});

test("symlink replacement of a slot cannot delete a file outside the owned directory", {
  skip: process.platform === "win32" ? "symlinks require Windows privileges" : false,
}, async () => {
  await withRoot(async root => {
    const slot = await acquireMmxSlot({ root });
    const original = slot.path + "-original";
    const external = path.join(root, "external");
    fs.mkdirSync(external, { mode: 0o700 });
    fs.copyFileSync(path.join(slot.path, "owner.json"), path.join(external, "owner.json"));
    fs.renameSync(slot.path, original);
    fs.symlinkSync(external, slot.path, "dir");
    assert.throws(() => slot.release(), error => error.code === "MMX_SLOT_UNSAFE");
    assert.equal(fs.existsSync(path.join(external, "owner.json")), true);
  });
});
