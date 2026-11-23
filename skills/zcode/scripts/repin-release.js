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
//
// Only release file types are pinned (RELEASE_EXTENSIONS). Hidden entries,
// cache directories and other file types are listed on stderr and left out.

"use strict";

const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");

const RELEASE_MARKER = ".zcode-release.json";
const REQUIRED_FILES = [
  "SKILL.md",
  "scripts/zcode-chat.js",
  "scripts/request-budget.js",
  "scripts/request-budget-preload.cjs",
  "scripts/zcode-run.js",
  "scripts/zcode-batch.js",
  "scripts/review.js",
  "references/review-v1.schema.json",
];
// The wrapper rejects any path segment outside this set, so a file that does
// not match can never be listed in a manifest it would accept.
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;
// The file types this skill ships (exact, case-sensitive suffix). Everything
// else in the skill directory stays out of the manifest, so files that change
// on their own (editor swap files, checksum lists, logs) can never lock the
// wrapper out with install_mismatch.
const RELEASE_EXTENSIONS = new Set([".md", ".js", ".cjs", ".json", ".yaml"]);
// Generated caches and dependency trees are never release content.
const VOLATILE_DIRS = new Set(["__pycache__", "node_modules"]);

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

function walk(root, relative, files, skipped, excluded) {
  const absolute = path.join(root, relative);
  let entries;
  try { entries = fs.readdirSync(absolute, { withFileTypes: true }); }
  catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    // The marker cannot list itself: its own bytes change when it is written.
    if (childRelative === RELEASE_MARKER) continue;
    if (!SAFE_SEGMENT.test(entry.name) || entry.name === "." || entry.name === "..") {
      skipped.push(childRelative);
      continue;
    }
    // Hidden entries are host metadata (.DS_Store, AppleDouble ._* files) or
    // tool state (.git), never release content.
    if (entry.name.startsWith(".")) {
      excluded.push(childRelative);
      continue;
    }
    if (entry.isDirectory()) {
      if (VOLATILE_DIRS.has(entry.name)) excluded.push(childRelative);
      else walk(root, childRelative, files, skipped, excluded);
    } else if (entry.isFile()) {
      if (RELEASE_EXTENSIONS.has(path.extname(entry.name))) files.push(childRelative);
      else excluded.push(childRelative);
    } else skipped.push(childRelative);
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
  const excluded = [];
  walk(root, "", files, skipped, excluded);

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
    for (const relative of skipped.sort()) process.stderr.write(`  - ${relative}\n`);
  }
  if (excluded.length) {
    process.stderr.write(`repin-release: left ${excluded.length} path(s) out of the manifest ` +
      `(hidden entry, cache directory, or a type other than ${[...RELEASE_EXTENSIONS].join(" ")}):\n`);
    for (const relative of excluded.sort()) process.stderr.write(`  - ${relative}\n`);
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
