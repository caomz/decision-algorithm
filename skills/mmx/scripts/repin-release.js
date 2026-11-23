#!/usr/bin/env node
// Rebuild the managed-release marker next to a cross-validation install.
//
// The mmx wrapper verifies a managed release against
// <skills_root>/.gstack-cross-validation-release.json before it talks to
// MMX. Editing the wrapper invalidates that manifest by design, so a
// managed install has to be re-pinned after an update.
//
// Usage:
//   node repin-release.js --root <skills_root> [--dry-run]
//
// <skills_root> is REQUIRED: it is the directory that holds agy/, mmx/ and
// cross-validation/. The marker is written to
// <skills_root>/.gstack-cross-validation-release.json.
//
// Only release file types are pinned (RELEASE_EXTENSIONS). Hidden entries,
// cache directories and other file types are listed on stderr and left out.

"use strict";

const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");

const RELEASE_MARKER = ".gstack-cross-validation-release.json";
const MANAGED_DIRS = ["agy", "mmx", "cross-validation"];
const REQUIRED_FILES = [
  "mmx/scripts/mmx-chat.js",
  "mmx/scripts/fetch-timeout-guard.js",
  "mmx/scripts/mmx-native-budget.js",
  "mmx/profiles/local.json",
  "cross-validation/scripts/cross_validate.py",
];
// The wrapper rejects any path segment outside this set, so a file that does
// not match can never be listed in a manifest it would accept.
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;
// A release pins only these file types: the set the cross-validation installer
// pins (install_release.py, exact case-sensitive suffix). Everything else under
// the managed directories stays out of the marker, so files that change on
// their own (Python bytecode, checksum lists, editor swap files) can never lock
// the wrapper out with install_mismatch.
const RELEASE_EXTENSIONS = new Set([".md", ".py", ".js", ".json", ".yaml"]);
// Generated caches and dependency trees are never release content.
const VOLATILE_DIRS = new Set(["__pycache__", "node_modules"]);

function usageError(message) {
  process.stderr.write(`repin-release: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  // --root is required here: it must point at the managed install root that
  // holds agy/, mmx/ and cross-validation/ side by side.
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
  if (!options.root) usageError("--root is required (the managed install root that holds agy/, mmx/ and cross-validation/)");
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
    const childRelative = `${relative}/${entry.name}`;
    if (!SAFE_SEGMENT.test(entry.name) || entry.name === "." || entry.name === "..") {
      skipped.push(childRelative);
      continue;
    }
    // Hidden entries are host metadata (.DS_Store, AppleDouble ._* files) or
    // tool state (.git, .pytest_cache), never release content.
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root);
  let rootStat;
  try { rootStat = fs.statSync(root); }
  catch { usageError(`managed root does not exist: ${root}`); }
  if (!rootStat.isDirectory()) usageError(`managed root is not a directory: ${root}`);

  const files = [];
  const skipped = [];
  const excluded = [];
  for (const name of MANAGED_DIRS) walk(root, name, files, skipped, excluded);

  const digests = {};
  for (const relative of files.sort()) {
    digests[relative] = createHash("sha256")
      .update(fs.readFileSync(path.join(root, ...relative.split("/"))))
      .digest("hex");
  }

  const missing = REQUIRED_FILES.filter(relative => !(relative in digests));
  if (missing.length) {
    process.stderr.write("repin-release: required files are missing, marker not written:\n");
    for (const relative of missing) process.stderr.write(`  - ${relative}\n`);
    process.stderr.write("repin-release: a managed release needs agy/, mmx/ and cross-validation/ side by side.\n");
    process.exit(1);
  }

  const manifest = {
    format: 1,
    state: "active",
    release_id: createHash("sha256").update(JSON.stringify(digests)).digest("hex"),
    files: digests,
  };
  const target = path.join(root, RELEASE_MARKER);

  if (skipped.length) {
    process.stderr.write(`repin-release: skipped ${skipped.length} path(s) the wrapper cannot verify:\n`);
    for (const relative of skipped.sort()) process.stderr.write(`  - ${relative}\n`);
  }
  if (excluded.length) {
    process.stderr.write(`repin-release: left ${excluded.length} path(s) out of the marker ` +
      `(hidden entry, cache directory, or a type other than ${[...RELEASE_EXTENSIONS].join(" ")}):\n`);
    for (const relative of excluded.sort()) process.stderr.write(`  - ${relative}\n`);
  }
  process.stdout.write(`files: ${Object.keys(digests).length}\n`);
  process.stdout.write(`release_id: ${manifest.release_id}\n`);
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
