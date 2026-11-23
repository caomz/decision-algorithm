#!/usr/bin/env node
// Rebuild the release manifest that the zcode wrapper verifies before it talks
// to the CLI.
//
// Editing any managed file invalidates .zcode-release.json by design, so an
// installed copy has to be re-pinned after an update. The manifest hashes the
// LF-normalized content, which means one manifest verifies the same file on a
// CRLF checkout (Windows) and on an LF checkout (macOS).
//
// Usage:
//   node repin-release.js [--root <skill_dir>] [--dry-run]
//
// <skill_dir> defaults to the skill directory that holds this script.

"use strict";

const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");

const RELEASE_MARKER = ".zcode-release.json";
const REQUIRED_FILES = [
  "SKILL.md",
  "scripts/zcode-chat.js",
  "scripts/zcode-run.js",
  "scripts/zcode-batch.js",
  "scripts/review.js",
  "references/review-v1.schema.json",
];
// Test fixtures are evaluation assets, not release artifacts: evaluator
// snapshots deliberately omit them, and a manifest referencing them would
// fail checkInstall() on every such snapshot. They must never be pinned.
const TEST_FIXTURES = ["test-prompts.json", "trigger-tests.json"];
// The wrapper rejects any path segment outside this set, so a file that does
// not match can never be listed in a manifest it would accept.
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function usageError(message) {
  process.stderr.write(`repin-release: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { root: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) usageError("--root requires a directory path");
      options.root = value;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      usageError(`unknown option: ${arg}`);
    }
  }
  return options;
}

function walk(root, relative, files, skipped) {
  const absolute = path.join(root, relative);
  let entries;
  try { entries = fs.readdirSync(absolute, { withFileTypes: true }); }
  catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (!SAFE_SEGMENT.test(entry.name) || entry.name === "." || entry.name === "..") {
      skipped.push(childRelative);
      continue;
    }
    const childAbsolute = path.join(root, ...childRelative.split("/"));
    if (entry.isDirectory()) walk(root, childRelative, files, skipped);
    else if (entry.isFile()) files.push(childRelative);
    else skipped.push(childRelative);
  }
}

function digest(file) {
  // Normalize CRLF to LF so a manifest written on one platform verifies on the
  // other one.
  const content = fs.readFileSync(file).toString("utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  let rootStat;
  try { rootStat = fs.statSync(root); }
  catch { usageError(`skill root does not exist: ${root}`); }
  if (!rootStat.isDirectory()) usageError(`skill root is not a directory: ${root}`);

  const files = [];
  const skipped = [];
  walk(root, "", files, skipped);
  // The marker cannot list itself: its own bytes change when it is written.
  files.splice(files.indexOf(RELEASE_MARKER), 1);
  // Fixtures likewise cannot be listed: a snapshot without them would fail
  // install verification through no fault of its own.
  for (const fixture of TEST_FIXTURES) {
    const index = files.indexOf(fixture);
    if (index !== -1) files.splice(index, 1);
  }

  const digests = {};
  for (const relative of files.sort()) {
    digests[relative] = digest(path.join(root, ...relative.split("/")));
  }

  const missing = REQUIRED_FILES.filter(relative => !(relative in digests));
  if (missing.length) {
    process.stderr.write("repin-release: required files are missing, marker not written:\n");
    for (const relative of missing) process.stderr.write(`  - ${relative}\n`);
    process.exit(1);
  }

  const wrapperSource = fs.readFileSync(path.join(root, "scripts/zcode-chat.js"), "utf8");
  const versionMatch = wrapperSource.match(/^const VERSION = "([^"]+)";$/m);
  if (!versionMatch) {
    process.stderr.write("repin-release: cannot derive version from scripts/zcode-chat.js\n");
    process.exit(1);
  }
  const manifest = {
    format: 1,
    // Derived from the wrapper's VERSION so a version bump cannot be forgotten here.
    version: versionMatch[1],
    files: digests,
    review_sha256: digests["scripts/review.js"],
  };
  const target = path.join(root, RELEASE_MARKER);

  if (skipped.length) {
    process.stderr.write(`repin-release: skipped ${skipped.length} path(s) the wrapper cannot verify:\n`);
    for (const relative of skipped) process.stderr.write(`  - ${relative}\n`);
  }
  process.stdout.write(`files: ${Object.keys(digests).length}\n`);
  process.stdout.write(`target: ${target}\n`);
  if (options.dryRun) {
    process.stdout.write("dry-run: marker not written\n");
    return;
  }
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  process.stdout.write("marker written\n");
}

try {
  main();
} catch (err) {
  process.stderr.write(`repin-release: ${err.message}\n`);
  process.exit(1);
}
