"use strict";
// Offline tests for scripts/repin-release.js: which paths a re-pin puts in the
// manifest, and that the wrapper's install check accepts the manifest after.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const skillDir = path.resolve(__dirname, "..");
const MARKER = ".zcode-release.json";
// Evaluation fixtures live beside the skill but are never release content:
// evaluator snapshots deliberately omit them, so a manifest referencing them
// would fail install verification on every such snapshot.
const TEST_FIXTURES = ["test-prompts.json", "trigger-tests.json"];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-repin-"));
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
// The manifest hashes LF-normalized content.
const digest = bytes => createHash("sha256").update(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8").digest("hex");

// An installer copies the skill itself, never host metadata, caches or an old
// manifest, so a copy starts without .zcode-release.json.
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
// What hosts and tools leave in a skill directory. None of it is release content.
const LEFT_OUT = {
  ".DS_Store": "finder state",
  "._SKILL.md": "AppleDouble metadata",
  ".git/HEAD": "ref: refs/heads/main\n",
  "node_modules/dep/index.js": "module.exports = 1;\n",
  "scripts/__pycache__/helper.cpython-311.pyc": "bytecode",
  "SHA256SUMS.txt": "0000  SKILL.md\n",
  "NOTES.MD": "suffixes match case-sensitively\n",
  "Thumbs.db": "Windows thumbnail cache",
};
// A left-out directory is reported once, not file by file.
const REPORTED = [".DS_Store", "._SKILL.md", ".git", "NOTES.MD", "SHA256SUMS.txt", "Thumbs.db",
  "node_modules", "scripts/__pycache__"];

function makeSkill({ leftOut = true } = {}) {
  const skill = path.join(root, `skill-${counter++}`);
  ensureDir(skill);
  for (const relative of skillFiles()) put(skill, relative, fs.readFileSync(path.join(skillDir, ...relative.split("/"))));
  if (leftOut) for (const [name, bytes] of Object.entries(LEFT_OUT)) put(skill, name, bytes);
  return skill;
}
function runRepin(skill, ...args) {
  // The copy inside the skill runs with its default root.
  const result = spawnSync(process.execPath, [path.join(skill, "scripts", "repin-release.js"), ...args], { encoding: "utf8", timeout: 15000 });
  const marker = path.join(skill, MARKER);
  if (fs.existsSync(marker)) createdFiles.add(marker);
  return { result, marker };
}
function installCheck(skill) {
  return spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(skill, "scripts", "zcode-chat.js"))}).checkInstall();`], { encoding: "utf8", timeout: 15000 });
}

test("a re-pin of a fresh copy pins every skill file and repeats byte for byte", () => {
  const skill = makeSkill({ leftOut: false });
  assert.equal(fs.existsSync(path.join(skill, MARKER)), false);
  const first = runRepin(skill);
  assert.equal(first.result.status, 0, first.result.stderr);
  const bytes = fs.readFileSync(first.marker, "utf8");
  const manifest = JSON.parse(bytes);
  // Every release-type file of the skill must be pinned. Evaluation fixtures
  // are the exception: they are never release content (see TEST_FIXTURES).
  const expected = skillFiles().sort().filter(name => !TEST_FIXTURES.includes(name));
  assert.ok(!TEST_FIXTURES.some(name => name in manifest.files), "fixtures must not be pinned");
  assert.deepEqual(Object.keys(manifest.files), expected);
  for (const name of expected) {
    assert.equal(manifest.files[name], digest(fs.readFileSync(path.join(skill, ...name.split("/")))), name);
  }
  const wrapperSource = fs.readFileSync(path.join(skill, "scripts", "zcode-chat.js"), "utf8");
  assert.equal(manifest.version, wrapperSource.match(/^const VERSION = "([^"]+)";$/m)[1]);
  assert.equal(manifest.review_sha256, manifest.files["scripts/review.js"]);
  assert.equal(installCheck(skill).status, 0);
  // With the manifest present the same tree pins to the same bytes.
  const second = runRepin(skill);
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(fs.readFileSync(second.marker, "utf8"), bytes);
});

test("a re-pin reports every path it leaves out of the manifest", () => {
  const skill = makeSkill();
  put(skill, "references/bad name.md", "the wrapper cannot verify this segment\n");
  const symlinked = process.platform !== "win32";
  if (symlinked) {
    const link = path.join(skill, "references", "linked.md");
    fs.symlinkSync("verification.md", link);
    createdFiles.add(link);
  }
  const { result, marker } = runRepin(skill);
  assert.equal(result.status, 0, result.stderr);
  const reported = [...REPORTED, ...skillFiles().filter(name => TEST_FIXTURES.includes(name))];
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(marker, "utf8")).files),
    skillFiles().sort().filter(name => !TEST_FIXTURES.includes(name)));
  assert.match(result.stderr, new RegExp(`left ${reported.length} path\\(s\\) out of the manifest`));
  for (const name of reported) assert.ok(result.stderr.includes(`  - ${name}\n`), name);
  const skipped = ["references/bad name.md", ...(symlinked ? ["references/linked.md"] : [])];
  assert.match(result.stderr, new RegExp(`skipped ${skipped.length} path\\(s\\) the wrapper cannot verify`));
  for (const name of skipped) assert.ok(result.stderr.includes(`  - ${name}\n`), name);
});

test("files left out of the manifest can change without locking the wrapper out", () => {
  const skill = makeSkill();
  assert.equal(runRepin(skill).result.status, 0);
  assert.equal(installCheck(skill).status, 0);
  // What Finder, Python, a package manager or a checksum run does afterwards.
  for (const name of Object.keys(LEFT_OUT)) put(skill, name, `rewritten ${name}`);
  // Fixtures are evaluation assets: rewriting one must not lock the wrapper.
  put(skill, "test-prompts.json", "rewritten fixture\n");
  put(skill, "scripts/__pycache__/helper.cpython-314.pyc", "recompiled");
  put(skill, "references/._verification.md", "new AppleDouble file");
  assert.equal(installCheck(skill).status, 0);
  // Release files stay protected.
  put(skill, "SKILL.md", "# tampered\n");
  const tampered = installCheck(skill);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /install_mismatch/);
});
