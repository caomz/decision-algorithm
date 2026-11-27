#!/usr/bin/env node
"use strict";
// Formal acceptance admission. An acceptance run must name the exact approved
// runtime combination before anything starts: Node version, CLI package, CLI
// version, the full digest of the CLI entry file and the resolved undici
// version. Anything missing, partial, malformed or different refuses before a
// process is started. The configuration shipped with the repository is
// deliberately unapproved and carries no values: it can never enable a run.
// Daily mmx-chat.js / mmx-batch.js calls do not go through this entry.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { strictJson } = require("../../zcode/scripts/review.js");
const { mmxPackageEntry, findMmx, npmShimEntry, linkedEntry } = require("./mmx-chat.js");

const SEMVER = /^\d+\.\d+\.\d+$/;
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = [["node.version", null], ["cli.package", null], ["cli.version", SEMVER], ["cli.entry_sha256", HASH], ["undici.version", SEMVER]];

function pick(config, where) {
  return where.split(".").reduce((value, key) => (value === null || typeof value !== "object" ? undefined : value[key]), config);
}

// Pure comparison: returns the list of problems, empty when the observed
// runtime is exactly the approved combination.
function checkAcceptance(config, observed) {
  if (!config || typeof config !== "object" || Array.isArray(config) || config.format !== 1) return ["format must be 1"];
  const problems = [];
  if (config.approved !== true) problems.push("config is not approved");
  for (const [where, pattern] of FIELDS) {
    const expected = pick(config, where);
    if (typeof expected !== "string" || !expected) problems.push(`${where} is missing`);
    else if (pattern && !pattern.test(expected)) problems.push(`${where} is malformed`);
    else if (observed[where] !== expected) problems.push(`${where} differs: expected ${expected}, found ${observed[where] ?? "nothing"}`);
  }
  return problems;
}

// What is actually installed right now, resolved the same way the wrapper
// resolves it. Never launches the CLI.
function observeRuntime(env = process.env) {
  const observed = { "node.version": process.version };
  const mmx = findMmx(process.platform, env.PATH || "", fs, npmShimEntry, process.execPath, linkedEntry);
  const pkg = mmx && mmx.argsPrefix.length === 1 ? mmxPackageEntry(mmx.argsPrefix[0]) : null;
  if (pkg) {
    observed["cli.package"] = "mmx-cli";
    observed["cli.version"] = pkg.version;
    observed["cli.entry_sha256"] = createHash("sha256").update(fs.readFileSync(pkg.entry)).digest("hex");
    try {
      const resolved = require.resolve("undici", { paths: [pkg.root] });
      observed["undici.version"] = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved), "package.json"), "utf8")).version;
    } catch {}
  }
  return observed;
}

function parse(argv) {
  const out = { config: null, dryRun: false, command: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && argv[i + 1]) out.config = argv[++i];
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--") { out.command = argv.slice(i + 1); break; }
    else throw Object.assign(new Error("usage: acceptance-profile.js --config FILE --dry-run | --config FILE -- ENTRY.js [args]"), { usage: true });
  }
  if (!out.config) throw Object.assign(new Error("--config FILE is required"), { usage: true });
  if (!out.dryRun && !out.command.length) throw Object.assign(new Error("nothing to run: pass --dry-run or -- ENTRY.js"), { usage: true });
  return out;
}

async function main(argv) {
  const options = parse(argv);
  let config;
  try { config = strictJson(fs.readFileSync(options.config, "utf8")); }
  catch { throw Object.assign(new Error("acceptance config is unreadable or not strict JSON"), { usage: true }); }
  const observed = observeRuntime();
  const problems = checkAcceptance(config, observed);
  if (problems.length) {
    process.stdout.write(JSON.stringify({ status: "refused", launched: false, problems, observed }) + "\n");
    return 2;
  }
  if (options.dryRun) { process.stdout.write(JSON.stringify({ status: "matched", launched: false, observed }) + "\n"); return 0; }
  const [entry, ...args] = options.command;
  if (!entry || !path.isAbsolute(entry) || !fs.statSync(entry).isFile()) throw Object.assign(new Error("the command must be one absolute JavaScript entry file"), { usage: true });
  // Hand the verified identity to the entry. The entry re-derives the identity
  // of what it actually launches and must refuse on any difference (V2.2.1 D4).
  const binding = Object.fromEntries(FIELDS.map(([where]) => [where, observed[where]]));
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit", shell: false, env: { ...process.env, ZMX_ACCEPTANCE_BINDING: JSON.stringify(binding) } });
    child.once("error", () => resolve(2));
    child.once("close", code => resolve(code ?? 2));
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(error => { process.stderr.write(`usage error: ${error.message}\n`); process.exitCode = 2; });
} else {
  module.exports = { checkAcceptance, observeRuntime, FIELDS };
}
