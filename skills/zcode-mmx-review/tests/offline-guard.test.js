"use strict";
// S0: negative safety tests for the offline fixture contract of both batch
// entries. A sentinel launcher named like the real CLI sits first on PATH and
// records any launch attempt. The child PATH never contains the inherited
// directories, so no real CLI can be resolved even if a guard were missing.
// Nothing here starts a real entry: refusals are asserted from the exit
// status, the error envelope and the absence of the sentinel record.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { cleanEnv, fixtureEnv } = require("./support/env.js");

const skills = path.resolve(__dirname, "..", "..");
const ENTRIES = { mmx: path.join(skills, "mmx/scripts/mmx-batch.js"), zcode: path.join(skills, "zcode/scripts/zcode-batch.js") };
const keyOf = side => side.toUpperCase() + "_BATCH_WRAPPER";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-offline-guard-"));

const fixtures = path.join(root, "fixtures");
fs.mkdirSync(fixtures);
const elsewhere = path.join(root, "elsewhere");
fs.mkdirSync(elsewhere);
const shard = path.join(root, "shard.txt");
fs.writeFileSync(shard, "offline guard shard\n");

// A pinned fake wrapper. Its receipt carries a fixture identity so a test can
// prove which wrapper actually served the shard.
const wrapper = path.join(fixtures, "pinned-wrapper.cjs");
fs.writeFileSync(wrapper, `"use strict";
const fs = require("node:fs"), crypto = require("node:crypto");
const argv = process.argv.slice(2), file = argv[argv.indexOf("--prompt-file") + 1];
const config = argv.indexOf("--profile-file"), ids = argv.indexOf("--evidence-ids-file");
const bound = config >= 0 ? argv[config + 1] : ids >= 0 ? argv[ids + 1] : "";
const digest = b => crypto.createHash("sha256").update(b).digest("hex");
process.stdout.write(JSON.stringify({ status: "ok", cli_invoked: true, exit_code: 0, model: "OFFLINE-FIXTURE", text: "synthetic",
  complete: true, truncated: false, signal: null, observed_exit_code: 0, observed_signal: null, local_process_exit_observed: true,
  batch_attempt_id: process.env.ZMX_BATCH_ATTEMPT_ID, batch_material_sha256: digest(fs.readFileSync(file)), batch_config_sha256: bound ? digest(fs.readFileSync(bound)) : "" }) + "\\n");
`);
const digestOf = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const contract = (side, overrides = {}) => ({ ...fixtureEnv(side, wrapper), ...overrides });

const sentinels = path.join(root, "sentinel-bin");
fs.mkdirSync(sentinels);
const sentinelLog = path.join(sentinels, "launched.list");
if (process.platform === "win32") {
  for (const name of ["mmx.cmd", "zcode.cmd"]) fs.writeFileSync(path.join(sentinels, name), `@echo off\r\necho ${name}>> "${sentinelLog}"\r\nexit /b 3\r\n`);
} else {
  for (const name of ["mmx", "zcode"]) fs.writeFileSync(path.join(sentinels, name), `#!/bin/sh\necho ${name} >> "${sentinelLog}"\nexit 3\n`, { mode: 0o755 });
}
const launched = () => fs.existsSync(sentinelLog) ? fs.readFileSync(sentinelLog, "utf8").trim() : "";
let seq = 0;
function attempt(side, env) {
  const receipt = path.join(root, `receipt-${++seq}.json`);
  const run = spawnSync(process.execPath, [ENTRIES[side], "--prompt-file", shard, "--receipt-file", receipt],
    { env: cleanEnv({ PATH: `${sentinels}${path.delimiter}${cleanEnv().PATH}`, ...env }), encoding: "utf8", timeout: 20000, shell: false });
  let envelope = null;
  try { envelope = JSON.parse(run.stdout); } catch {}
  return { run, envelope, receipt, reserved: fs.existsSync(receipt) || fs.existsSync(receipt + ".shards") };
}

for (const side of ["mmx", "zcode"]) {
  const refused = (name, env, pattern) => test(`S0 ${side}: ${name} is refused before any launch`, () => {
    const before = launched();
    const result = attempt(side, env);
    assert.ok(Number.isInteger(result.run.status) && result.run.status !== 0, `exit status ${result.run.status}`);
    assert.equal(result.envelope?.status, "usage_error", result.run.stdout + result.run.stderr);
    assert.match(result.envelope.error, pattern);
    assert.equal(result.envelope.gate, "NOT_EVALUATED");
    assert.equal(result.reserved, false, "no evidence archive may be reserved");
    assert.equal(launched(), before, "no CLI launcher may be started");
  });

  test(`S0 ${side}: an override without its fixture contract is never launched`, () => {
    const before = launched();
    const result = attempt(side, { [keyOf(side)]: wrapper });
    assert.equal(result.envelope?.status, "usage_error");
    assert.match(result.envelope.error, /fixture root missing/);
    assert.equal(result.reserved, false);
    assert.equal(launched(), before);
  });
  refused("offline mode without a wrapper", { ZMX_OFFLINE_FIXTURE: "1" }, /wrapper path missing/);
  refused("offline mode with an empty wrapper", contract(side, { [keyOf(side)]: "" }), /wrapper path missing/);
  refused("offline mode with a wrong wrapper path", contract(side, { [keyOf(side)]: path.join(fixtures, "absent.cjs") }), /wrapper not found/);
  refused("offline mode with a relative wrapper path", contract(side, { [keyOf(side)]: "pinned-wrapper.cjs" }), /must be absolute/);
  refused("a wrapper outside the declared root", contract(side, { ZMX_FIXTURE_ROOT: fixtures, [keyOf(side)]: (() => { const f = path.join(elsewhere, "outside.cjs"); fs.copyFileSync(wrapper, f); return f; })() }), /escapes the fixture root/);
  refused("a wrapper whose digest differs", contract(side, { ZMX_FIXTURE_SHA256: "0".repeat(64) }), /digest mismatch/);
  refused("a contract without a digest", contract(side, { ZMX_FIXTURE_SHA256: undefined }), /digest missing/);
  refused("a contract without a root", contract(side, { ZMX_FIXTURE_ROOT: "relative/root" }), /fixture root missing/);
  refused("a directory named as the wrapper", contract(side, { ZMX_FIXTURE_ROOT: root, [keyOf(side)]: fixtures }), /not a regular file/);
  refused("forged credentials, proxy and NODE_OPTIONS in the parent environment", (() => {
    const canary = path.join(root, `canary-${side}.cjs`), marker = path.join(root, `canary-${side}.ran`);
    fs.writeFileSync(canary, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
    return { ZMX_OFFLINE_FIXTURE: "1", MINIMAX_API_KEY: "synthetic-not-a-key", HTTPS_PROXY: "http://127.0.0.1:9", NODE_OPTIONS: `--require ${canary}` };
  })(), /wrapper path missing/);

  test(`S0 ${side}: a valid contract runs exactly the pinned wrapper and never consults PATH`, () => {
    const before = launched();
    const result = attempt(side, contract(side));
    assert.equal(result.run.status, 0, result.run.stdout + result.run.stderr);
    assert.equal(result.envelope.status, "ok");
    assert.equal(result.envelope.transport_gate, "PASS", "chat mode keeps the content gate NOT_EVALUATED; transport must pass");
    assert.equal(result.envelope.shards.length, 1);
    assert.equal(result.envelope.shards[0].model, "OFFLINE-FIXTURE", "the pinned wrapper identity must be served");
    assert.equal(result.envelope.shards[0].transport_validation, "PASS");
    assert.equal(launched(), before, "the same-name sentinel launcher must not be started");
    assert.equal(result.reserved, true);
  });
}
