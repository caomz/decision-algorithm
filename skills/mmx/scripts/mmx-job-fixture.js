"use strict";
// Deliberately synthetic. This pinned fixture never invokes a CLI, network,
// subprocess, or loads user configuration. It exercises the real batch archive.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const argv = process.argv.slice(2);
const value = flag => argv[argv.indexOf(flag) + 1];
const promptFile = value("--prompt-file");
const bytes = fs.readFileSync(promptFile);
const configBytes = fs.readFileSync(value("--profile-file"));
const digest = data => createHash("sha256").update(data).digest("hex");
// These are per-attempt events in the batch-owned sealed input directory. Their
// identities are established by that archive, not by a caller-provided path.
fs.writeFileSync(path.join(path.dirname(promptFile), "fixture-start.json"),
  JSON.stringify({ started_ms: Date.now(), pid: process.pid, stdin_ended: false }), { flag: "wx", mode: 0o600 });
const delay = Number(process.env.MMX_DURABLE_FIXTURE_DELAY_MS);
if (!Number.isSafeInteger(delay) || delay < 0 || delay > 120000) throw new Error("invalid fixture delay");
let stdinEnded = false;
process.stdin.on("end", () => { stdinEnded = true; });
process.stdin.resume();
setTimeout(() => {
  const failed = bytes.toString("utf8").startsWith("FIXTURE_TRANSPORT_FAIL");
  const receipt = { status: failed ? "api_error" : "ok", backend: "fixture", synthetic: true,
    // These protocol fields simulate a child CLI; they are never real evidence.
    cli_invoked: true, text: "SYNTHETIC_MMX_REVIEW", model: "offline-fixture",
    complete: true, truncated: false, stop_reason: "end_turn", exit_code: failed ? 1 : 0,
    observed_exit_code: failed ? 1 : 0, observed_signal: null, local_process_exit_observed: true,
    batch_attempt_id: process.env.ZMX_BATCH_ATTEMPT_ID,
    batch_material_sha256: digest(bytes), batch_config_sha256: digest(configBytes), fixture_stdin_ended: stdinEnded };
  fs.writeFileSync(path.join(path.dirname(promptFile), "fixture-end.json"), JSON.stringify({ ended_ms: Date.now() }),
    { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify(receipt) + "\n");
  process.exitCode = failed ? 1 : 0;
}, delay);
