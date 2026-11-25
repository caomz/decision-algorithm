"use strict";
// Offline tests for scripts/repin-release.js: which paths a re-pin puts in the
// managed marker, and that the wrapper accepts the marker afterwards. No MMX
// CLI and no network: a missing prompt file stops the wrapper right after its
// install check, so the result is usage_error when the check passed and
// install_mismatch when it did not.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { cleanEnv } = require("./support/env.js");

const skillDir = path.resolve(__dirname, "..");
const repin = path.join(skillDir, "scripts", "repin-release.js");
const MARKER = ".gstack-cross-validation-release.json";
// Evaluation fixtures live beside the skill but are never release content:
// evaluator snapshots deliberately omit them, so a marker referencing them
// would fail install verification on every such snapshot.
const TEST_FIXTURES = ["test-prompts.json", "trigger-tests.json"];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-repin-"));
// Cleanup removes exactly what these tests created, one path at a time.
const createdFiles = new Set();
const createdDirs = [];
let counter = 0;

function ensureDir(directory) {
  if (fs.existsSync(directory)) return;
  ensureDir(path.dirname(directory));
  fs.mkdirSync(directory);
  createdDirs.push(directory);
}
function put(base, relative, bytes) {
  const file = path.join(base, ...relative.split("/"));
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, bytes);
  createdFiles.add(file);
}
after(() => {
  for (const file of createdFiles) {
    try { fs.unlinkSync(file); } catch (err) { if (err.code !== "ENOENT") throw err; }
  }
  for (const directory of createdDirs.sort((a, b) => b.length - a.length)) fs.rmdirSync(directory);
  fs.rmdirSync(root);
});
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// An installer copies the skill itself, never host metadata or caches.
function skillFiles(directory = skillDir, relative = "") {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "__pycache__"].includes(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...skillFiles(path.join(directory, entry.name), child));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

// agy/ and cross-validation/ are not part of this repository; small fixtures
// stand in for them.
const SIBLINGS = {
  "agy/SKILL.md": "# agy fixture\n",
  "agy/agents/openai.yaml": "name: agy\n",
  "agy/scripts/agy_runner.py": "# fixture runner\n",
  "cross-validation/SKILL.md": "# coordinator fixture\n",
  "cross-validation/scripts/cross_validate.py": "# fixture coordinator\n",
};
// What hosts and tools leave next to a release. None of it is release content.
const LEFT_OUT = {
  "agy/.git/config": "[core]\n",
  "mmx/.DS_Store": "finder state",
  "mmx/._SKILL.md": "AppleDouble metadata",
  "mmx/node_modules/dep/index.js": "module.exports = 1;\n",
  "mmx/SHA256SUMS.txt": "0000  SKILL.md\n",
  "mmx/CHANGES.MD": "suffixes match case-sensitively, as in the installer\n",
  "cross-validation/scripts/__pycache__/cross_validate.cpython-311.pyc": "bytecode",
  "cross-validation/run.sh": "#!/bin/sh\n",
};
// A left-out directory is reported once, not file by file.
const REPORTED = ["agy/.git", "cross-validation/run.sh", "cross-validation/scripts/__pycache__",
  "mmx/.DS_Store", "mmx/._SKILL.md", "mmx/CHANGES.MD", "mmx/SHA256SUMS.txt", "mmx/node_modules"];

function makeRelease({ leftOut = true, omit = [] } = {}) {
  const managed = path.join(root, `managed-${counter++}`);
  ensureDir(managed);
  for (const relative of skillFiles()) {
    put(managed, `mmx/${relative}`, fs.readFileSync(path.join(skillDir, ...relative.split("/"))));
  }
  for (const [name, bytes] of Object.entries(SIBLINGS)) if (!omit.includes(name)) put(managed, name, bytes);
  if (leftOut) for (const [name, bytes] of Object.entries(LEFT_OUT)) put(managed, name, bytes);
  return managed;
}
function runRepin(managed, ...args) {
  const result = spawnSync(process.execPath, [repin, "--root", managed, ...args], { encoding: "utf8", timeout: 15000, env: cleanEnv() });
  const marker = path.join(managed, MARKER);
  if (fs.existsSync(marker)) createdFiles.add(marker);
  return { result, marker };
}
function installCheck(managed) {
  const run = spawnSync(process.execPath, [path.join(managed, "mmx", "scripts", "mmx-chat.js"),
    "--prompt-file", path.join(managed, "missing-prompt.txt")], { encoding: "utf8", timeout: 15000, env: cleanEnv() });
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.cli_invoked, false);
  return receipt.status;
}

test("a re-pin pins the whole release and reports every path it leaves out", () => {
  const managed = makeRelease();
  put(managed, "mmx/bad name.md", "the wrapper cannot verify this segment\n");
  const symlinked = process.platform !== "win32";
  if (symlinked) {
    const link = path.join(managed, "agy", "linked.md");
    fs.symlinkSync("SKILL.md", link);
    createdFiles.add(link);
  }
  const { result, marker } = runRepin(managed);
  assert.equal(result.status, 0, result.stderr);
  const release = JSON.parse(fs.readFileSync(marker, "utf8"));
  // Every release-type file of the release must be pinned. Evaluation fixtures
  // are the exception: they are never release content (see TEST_FIXTURES).
  const expected = [...Object.keys(SIBLINGS),
    ...skillFiles().map(relative => `mmx/${relative}`)
      .filter(relative => !TEST_FIXTURES.includes(path.basename(relative)))].sort();
  assert.ok(!Object.keys(release.files).some(relative => TEST_FIXTURES.includes(path.basename(relative))),
    "fixtures must not be pinned");
  assert.deepEqual(Object.keys(release.files), expected);
  for (const name of expected) {
    assert.equal(release.files[name], sha256(fs.readFileSync(path.join(managed, ...name.split("/")))), name);
  }
  assert.equal(release.format, 1);
  assert.equal(release.state, "active");
  assert.equal(release.release_id, sha256(JSON.stringify(release.files)));
  const reported = [...REPORTED, ...skillFiles()
    .filter(relative => TEST_FIXTURES.includes(relative))
    .map(relative => `mmx/${relative}`)];
  assert.match(result.stderr, new RegExp(`left ${reported.length} path\\(s\\) out of the marker`));
  for (const name of reported) assert.ok(result.stderr.includes(`  - ${name}\n`), name);
  const skipped = ["mmx/bad name.md", ...(symlinked ? ["agy/linked.md"] : [])];
  assert.match(result.stderr, new RegExp(`skipped ${skipped.length} path\\(s\\) the wrapper cannot verify`));
  for (const name of skipped) assert.ok(result.stderr.includes(`  - ${name}\n`), name);
  assert.equal(installCheck(managed), "usage_error");
  // The same tree pins to the same bytes again.
  const bytes = fs.readFileSync(marker, "utf8");
  assert.equal(runRepin(managed).result.status, 0);
  assert.equal(fs.readFileSync(marker, "utf8"), bytes);
});

test("files left out of the marker can change without locking the wrapper out", () => {
  const managed = makeRelease();
  assert.equal(runRepin(managed).result.status, 0);
  assert.equal(installCheck(managed), "usage_error");
  // What Python, Finder, a package manager or a checksum run does afterwards.
  for (const name of Object.keys(LEFT_OUT)) put(managed, name, `rewritten ${name}`);
  // Fixtures are evaluation assets: rewriting one must not lock the wrapper.
  put(managed, "mmx/test-prompts.json", "rewritten fixture\n");
  put(managed, "cross-validation/scripts/__pycache__/cross_validate.cpython-314.pyc", "recompiled");
  put(managed, "agy/._SKILL.md", "new AppleDouble file");
  assert.equal(installCheck(managed), "usage_error");
  // Release files stay protected.
  put(managed, "mmx/SKILL.md", "# tampered\n");
  assert.equal(installCheck(managed), "install_mismatch");
});

test("a dry run writes nothing and a missing required file blocks the marker", () => {
  const managed = makeRelease({ leftOut: false });
  const dry = runRepin(managed, "--dry-run");
  assert.equal(dry.result.status, 0, dry.result.stderr);
  assert.match(dry.result.stdout, /dry-run: marker not written/);
  assert.equal(fs.existsSync(dry.marker), false);
  const incomplete = makeRelease({ leftOut: false, omit: ["cross-validation/scripts/cross_validate.py"] });
  const blocked = runRepin(incomplete);
  assert.equal(blocked.result.status, 1);
  assert.ok(blocked.result.stderr.includes("  - cross-validation/scripts/cross_validate.py\n"));
  assert.equal(fs.existsSync(blocked.marker), false);
});
