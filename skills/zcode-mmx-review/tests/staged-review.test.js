"use strict";

// These tests use only repository fixture executables. CI additionally places
// the entire suite in a loopback-only network namespace.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const runner = require("../scripts/review-run.js");
const { cleanEnv } = require("./support/env.js");

const RUNNER = path.resolve(__dirname, "../scripts/review-run.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-staged-"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const packetBytes = text => Buffer.from(JSON.stringify({ facts: [{ id: "F1", text }] }) + "\n");

function prepare(name, text = "version A") {
  const out = path.join(root, name);
  const packet = path.join(root, `${name}-packet.json`);
  fs.writeFileSync(packet, packetBytes(text));
  return { out, packet };
}

function cliArgs(job, scenario, extra = []) {
  return [RUNNER, "run", "--backend", "fixture", "--scenario", scenario, "--packet", job.packet, "--out", job.out, ...extra];
}

function run(name, scenario = "both-pass", { text, extra = [] } = {}) {
  const job = prepare(name, text);
  const processResult = spawnSync(process.execPath, cliArgs(job, scenario, extra), {
    env: cleanEnv(), encoding: "utf8", timeout: 15000,
  });
  assert.equal(processResult.error, undefined);
  return { ...job, processResult, result: JSON.parse(processResult.stdout) };
}

function verify(out) {
  const report = runner.verifyRun(out);
  assert.equal(report.replay, "match", JSON.stringify(report));
}

function amend(out, file, transform) {
  const changed = transform(read(out, file));
  const bytes = JSON.stringify(changed, null, 2) + "\n";
  fs.writeFileSync(path.join(out, file), bytes);
  const manifest = read(out, "record-manifest.json");
  manifest.files[file] = digest(bytes);
  fs.writeFileSync(path.join(out, "record-manifest.json"), JSON.stringify(manifest) + "\n");
}

function libraryRound(name, scenario, extra = {}) {
  const job = prepare(name);
  fs.mkdirSync(job.out);
  const bytes = fs.readFileSync(job.packet);
  const inputs = runner.buildRunPacket(bytes);
  runner.writeRunInputs(job.out, { packetBytes: bytes, inputs });
  const assembled = runner.assembleInputs({
    materialPath: path.join(job.out, "material.txt"), idsPath: path.join(job.out, "evidence-ids.json"),
    promptPath: path.join(job.out, "prompt.txt"), timeoutSeconds: 600, maxTokens: 524288,
  });
  const argv = { zcode: assembled.zcode.argv, mmx: assembled.mmx.argv };
  return { ...job, inputs, argv, promise: runner.runFixtureRound(inputs, {
    out: job.out, scenario, timeoutSeconds: 600, maxTokens: 524288, argv,
    envBase: cleanEnv(), fakeProcessMs: 5000, ...extra,
  }) };
}

test("default primary-first publishes a complete primary checkpoint before secondary completion", { timeout: 15000 }, async () => {
  const job = prepare("early-primary");
  const child = spawn(process.execPath, cliArgs(job, "primary-pass-secondary-delayed"), {
    env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let checkpointAtDelivery = null;
  child.stdout.on("data", chunk => { stdout += chunk; });
  const closed = new Promise(resolve => child.once("close", code => resolve(code)));
  child.stderr.on("data", chunk => {
    stderr += chunk;
    if (checkpointAtDelivery || !stderr.includes("\n")) return;
    const event = JSON.parse(stderr.split("\n")[0]);
    // Capture facts in the actual delivery event, before the child can finish.
    checkpointAtDelivery = {
      event, primary: read(job.out, "primary-result.json"),
      primaryExecution: read(job.out, "zcode-execution.json"),
      primaryReceipt: read(job.out, "zcode-stdout.json"),
      observed: read(job.out, "zcode-observed-input.json"),
      requestBytes: fs.readFileSync(path.join(job.out, "request.json"), "utf8"),
      inputDigests: Object.fromEntries(["packet.json", "material.txt", "evidence-ids.json", "prompt.txt"]
        .map(name => [name, digest(fs.readFileSync(path.join(job.out, name)))])),
      finalExists: fs.existsSync(path.join(job.out, "result.json")),
      childExited: child.exitCode !== null,
    };
  });
  assert.equal(await closed, 0, stderr);
  assert.ok(checkpointAtDelivery, "primary event must be delivered before final output");
  const { event, primary, primaryExecution, primaryReceipt } = checkpointAtDelivery;
  assert.equal(event.event, "PRIMARY_REVIEW_READY");
  assert.equal(checkpointAtDelivery.finalExists, false);
  assert.equal(checkpointAtDelivery.childExited, false);
  assert.equal(primary.PRIMARY_REVIEW_GATE, "PASS");
  assert.equal(primary.SECONDARY_REVIEW_GATE, "NOT_EVALUATED");
  assert.equal(primary.REVIEW_GATE, "NOT_EVALUATED");
  assert.equal(primaryExecution.state, "completed");
  assert.equal(primaryReceipt.status, "ok");
  const request = JSON.parse(checkpointAtDelivery.requestBytes);
  assert.equal(request.packet_sha256, checkpointAtDelivery.inputDigests["packet.json"]);
  assert.equal(request.material_sha256, checkpointAtDelivery.inputDigests["material.txt"]);
  assert.equal(request.evidence_ids_sha256, checkpointAtDelivery.inputDigests["evidence-ids.json"]);
  assert.equal(request.prompt_sha256, checkpointAtDelivery.inputDigests["prompt.txt"]);
  assert.equal(primary.request_sha256, digest(checkpointAtDelivery.requestBytes));
  assert.equal(checkpointAtDelivery.observed.side, "zcode");
  assert.equal(request.adjudication_code["review-run.js"], digest(fs.readFileSync(RUNNER)));
  assert.ok(request.provenance_code["zcode-fake-wrapper.cjs"]);
  assert.equal(fs.readFileSync(path.join(job.out, "request.json"), "utf8"), checkpointAtDelivery.requestBytes,
    "finalization must reuse the exact prelaunch intent");
  const result = JSON.parse(stdout);
  assert.equal(result.strategy, "primary-first");
  assert.equal(result.REVIEW_GATE, "PASS");
  assert.equal(result.PRIMARY_REVIEW_GATE, "PASS");
  assert.equal(result.SECONDARY_REVIEW_GATE, "PASS");
  assert.equal(result.material_version, primary.material_version);
  assert.ok(Date.parse(read(job.out, "mmx-execution.json").started_at) >= Date.parse(primaryExecution.ended_at));
  verify(job.out);
});

test("abrupt process-group death after primary delivery leaves complete intent and primary evidence", {
  timeout: 15000, skip: process.platform === "win32" && "POSIX process-group SIGKILL; native Windows lifecycle remains gated",
}, async () => {
  const job = prepare("primary-crash");
  const child = spawn(process.execPath, cliArgs(job, "primary-pass-secondary-delayed"), {
    env: cleanEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  let stderr = "";
  let beforeCrash;
  child.stderr.on("data", chunk => {
    stderr += chunk;
    if (beforeCrash || !stderr.includes("\n")) return;
    assert.equal(JSON.parse(stderr.split("\n")[0]).event, "PRIMARY_REVIEW_READY");
    beforeCrash = Object.fromEntries([
      "packet.json", "material.txt", "evidence-ids.json", "prompt.txt", "request.json",
      "zcode-observed-input.json", "zcode-execution.json", "zcode-stdout.json", "zcode-stderr.log", "primary-result.json",
    ].map(name => [name, fs.readFileSync(path.join(job.out, name))]));
    // Kill both the host and its fixture process group; no orphan is left by
    // this test and no shutdown/finalization handler can manufacture evidence.
    process.kill(-child.pid, "SIGKILL");
  });
  const exit = await closed;
  assert.equal(exit.signal, "SIGKILL", stderr);
  assert.ok(beforeCrash);
  for (const [name, bytes] of Object.entries(beforeCrash)) {
    assert.deepEqual(fs.readFileSync(path.join(job.out, name)), bytes, `${name} survives abrupt death`);
  }
  const primary = read(job.out, "primary-result.json");
  const request = read(job.out, "request.json");
  assert.equal(primary.request_sha256, digest(beforeCrash["request.json"]));
  assert.equal(primary.material_version, request.material_version);
  assert.equal(primary.observed_input, digest(beforeCrash["zcode-observed-input.json"]));
  assert.equal(primary.PRIMARY_REVIEW_GATE, "PASS");
  assert.equal(primary.REVIEW_GATE, "NOT_EVALUATED");
  assert.equal(fs.existsSync(path.join(job.out, "result.json")), false);
  assert.equal(fs.existsSync(path.join(job.out, "record-manifest.json")), false);
  // No full-round verify claim: the secondary phase and manifest never finished.
});

test("request intent exists before first spawn and finalization rejects rewritten intent", async () => {
  const out = path.join(root, "intent-immutable");
  const seen = [];
  let launchIntent;
  const job = libraryRound("intent-immutable", "both-pass", {
    onSpawn: side => {
      seen.push(side);
      const bytes = fs.readFileSync(path.join(out, "request.json"), "utf8");
      if (!launchIntent) launchIntent = bytes;
      assert.equal(bytes, launchIntent);
    },
  });
  const round = await job.promise;
  assert.deepEqual(seen, ["zcode", "mmx"]);
  assert.equal(round.requestJson, launchIntent);
  const changed = JSON.parse(launchIntent);
  changed.provenance_code["mmx-chat.js"] = "0".repeat(64);
  fs.writeFileSync(path.join(out, "request.json"), JSON.stringify(changed) + "\n");
  assert.throws(() => runner.writeRunRecords(out, { round }), /immutable record differs: request.json/);
  assert.equal(fs.existsSync(path.join(out, "result.json")), false);
});

test("a confirmed primary P1 prevents all MMX launches for that material version", () => {
  const { out, result, processResult } = run("skip-blocked", "zcode-fail-mmx-hang");
  assert.equal(processResult.status, 1);
  assert.equal(result.PRIMARY_REVIEW_GATE, "FAIL");
  assert.equal(result.SECONDARY_REVIEW_GATE, "NOT_EVALUATED");
  assert.equal(result.REVIEW_GATE, "FAIL");
  assert.equal(result.round_status, "NOT_EVALUATED");
  assert.equal(fs.existsSync(path.join(out, "mmx-observed-input.json")), false);
  assert.equal(read(out, "mmx-execution.json").state, "not_started");
  assert.equal(read(out, "mmx-execution.json").skip_reason, "primary_confirmed_defect");
  assert.equal(read(out, "primary-result.json").REVIEW_GATE, "FAIL");
  verify(out);
});

test("an invalid primary still permits a valid secondary P1 veto", () => {
  const { out, result, processResult } = run("invalid-primary", "primary-invalid-secondary-fail");
  assert.equal(processResult.status, 1);
  assert.equal(result.PRIMARY_REVIEW_GATE, "NOT_EVALUATED");
  assert.equal(result.SECONDARY_REVIEW_GATE, "FAIL");
  assert.equal(result.REVIEW_GATE, "FAIL");
  assert.equal(result.round_status, "NOT_EVALUATED");
  assert.equal(result.providers.zcode.eligible, false);
  assert.ok(fs.existsSync(path.join(out, "mmx-observed-input.json")));
  verify(out);
});

test("a P1 evidence gap is not a confirmed defect and cannot earn full PASS", () => {
  const { out, result, processResult } = run("primary-gap", "p1-gap");
  assert.equal(processResult.status, 2);
  assert.equal(result.PRIMARY_REVIEW_GATE, "NOT_EVALUATED");
  assert.equal(result.SECONDARY_REVIEW_GATE, "PASS");
  assert.equal(result.REVIEW_GATE, "NOT_EVALUATED");
  assert.equal(result.round_status, "COMPLETED");
  assert.equal(read(out, "mmx-execution.json").state, "completed");
  verify(out);
});

test("a secondary P1 vetoes a successful primary", () => {
  const { out, result } = run("secondary-veto", "secondary-fail");
  assert.equal(result.PRIMARY_REVIEW_GATE, "PASS");
  assert.equal(result.SECONDARY_REVIEW_GATE, "FAIL");
  assert.equal(result.REVIEW_GATE, "FAIL");
  verify(out);
});

test("two passing receipts of one model family cannot satisfy full acceptance", () => {
  const { out, result, processResult } = run("same-family", "same-family-pass");
  assert.equal(processResult.status, 2);
  assert.equal(result.PRIMARY_REVIEW_GATE, "PASS");
  assert.equal(result.SECONDARY_REVIEW_GATE, "PASS");
  assert.equal(result.REVIEW_GATE, "NOT_EVALUATED");
  assert.equal(result.independent, false);
  verify(out);
});

test("dual-parallel is explicit and starts MMX before primary result even when primary blocks", async () => {
  const starts = [];
  let startsAtPrimary;
  const job = libraryRound("explicit-parallel", "primary-fail-secondary-delayed", {
    strategy: "dual-parallel", onSpawn: side => starts.push(side),
    onPrimaryReady: () => { startsAtPrimary = [...starts]; },
  });
  const round = await job.promise;
  assert.deepEqual(startsAtPrimary, ["zcode", "mmx"]);
  assert.deepEqual(starts, ["zcode", "mmx"], "neither side retries");
  assert.equal(round.executions.mmx.execution.state, "completed");
  assert.equal(round.outcome.round_status, "COMPLETED");
  assert.equal(round.outcome.REVIEW_GATE, "FAIL");
});

test("changing the material between phases prevents secondary dispatch", async () => {
  const starts = [];
  const out = path.join(root, "material-change");
  const job = libraryRound("material-change", "both-pass", {
    onSpawn: side => starts.push(side),
    onPrimaryReady: () => fs.appendFileSync(path.join(out, "material.txt"), "changed"),
  });
  const round = await job.promise;
  assert.deepEqual(starts, ["zcode"]);
  assert.equal(round.executions.mmx.execution.state, "not_started");
  assert.equal(round.executions.mmx.execution.skip_reason, "material_version_changed");
  assert.equal(round.outcome.PRIMARY_REVIEW_GATE, "PASS");
  assert.equal(round.outcome.REVIEW_GATE, "NOT_EVALUATED");
});

test("primary persistence failure prevents secondary launch", async () => {
  const starts = [];
  const out = path.join(root, "checkpoint-failure");
  const job = libraryRound("checkpoint-failure", "both-pass", {
    onSpawn: side => starts.push(side),
    onSideClosed: side => { if (side === "zcode") fs.mkdirSync(path.join(out, "primary-result.json")); },
  });
  await assert.rejects(job.promise, /immutable record differs/);
  assert.deepEqual(starts, ["zcode"]);
  assert.equal(fs.existsSync(path.join(out, "mmx-observed-input.json")), false);
});

test("cancellation between phases prevents MMX and remains visible in the archive", async () => {
  const starts = [];
  const job = libraryRound("interphase-cancel", "both-pass", {
    onSpawn: side => starts.push(side),
    onPrimaryReady: () => { process.emit("SIGTERM"); },
  });
  const round = await job.promise;
  assert.deepEqual(starts, ["zcode"]);
  assert.equal(round.cancelled, true);
  assert.equal(round.executions.mmx.execution.skip_reason, "cancelled_before_start");
  assert.equal(round.outcome.PRIMARY_REVIEW_GATE, "PASS");
  assert.equal(round.outcome.REVIEW_GATE, "NOT_EVALUATED");
  runner.writeRunRecords(job.out, {
    scenario: "both-pass", timeoutSeconds: 600, maxTokens: 524288,
    argv: job.argv, envKeys: Object.keys(cleanEnv()).sort(), round,
  });
  verify(job.out);
});

test("a primary checkpoint from another material version cannot be reused even with a refreshed manifest", () => {
  const old = run("version-old", "both-pass", { text: "old material" });
  const current = run("version-new", "both-pass", { text: "fixed material" });
  assert.notEqual(old.result.material_version, current.result.material_version);
  amend(current.out, "primary-result.json", () => read(old.out, "primary-result.json"));
  const report = runner.verifyRun(current.out);
  assert.equal(report.replay, "mismatch");
  assert.ok(report.problems.some(problem => problem.includes("primary-result.json material_version")));
});

test("a secondary execution from another version cannot be counted", () => {
  const { out } = run("stale-secondary");
  amend(out, "mmx-execution.json", execution => ({ ...execution, material_version: "0".repeat(64) }));
  const report = runner.verifyRun(out);
  assert.equal(report.replay, "mismatch");
  assert.ok(report.problems.some(problem => problem.includes("mmx: material_version")));
});

test("changing archived launch provenance cannot evade the primary request digest", () => {
  const { out } = run("request-provenance-tamper");
  amend(out, "request.json", request => {
    request.provenance_code["mmx-profile"] = "0".repeat(64);
    return request;
  });
  const report = runner.verifyRun(out);
  assert.equal(report.replay, "mismatch");
  assert.ok(report.problems.some(problem => problem.includes("request digest")));
});

for (const field of ["PRIMARY_REVIEW_GATE", "SECONDARY_REVIEW_GATE", "REVIEW_GATE"]) {
  test(`verify independently replays ${field}`, () => {
    const { out } = run(`gate-${field}`);
    amend(out, "result.json", result => ({ ...result, [field]: "FAIL" }));
    const report = runner.verifyRun(out);
    assert.equal(report.replay, "mismatch");
    assert.ok(report.problems.some(problem => problem.includes(field)));
  });
}

test("new archives cannot omit the primary checkpoint from the manifest", () => {
  const { out } = run("missing-checkpoint");
  const manifest = read(out, "record-manifest.json");
  delete manifest.files["primary-result.json"];
  fs.writeFileSync(path.join(out, "record-manifest.json"), JSON.stringify(manifest));
  assert.equal(runner.verifyRun(out).integrity, "corrupt");
});

test("an invalid strategy or real backend fails before creating output", () => {
  for (const [name, extra] of [["bad-strategy", ["--strategy", "fallback"]], ["disabled-real", ["--backend", "real"]]]) {
    const job = prepare(name);
    const args = cliArgs(job, "both-pass", extra);
    if (name === "disabled-real") args.splice(args.indexOf("--backend"), 2);
    const report = spawnSync(process.execPath, args, { env: cleanEnv(), encoding: "utf8", timeout: 5000 });
    assert.equal(report.status, 2);
    assert.equal(fs.existsSync(job.out), false);
    assert.match(report.stderr, name === "disabled-real" ? /real backend is not enabled/ : /strategy/);
  }
});

// ---------------------------------------------------------------------------
// Publication integrity: the inputs sealed at launch are verified before any
// result is published. The barrier is the secondary wrapper writing its
// observed-input record (an fs.watch event, not a sleep): both sides have
// then been dispatched on the launch-time material.
// ---------------------------------------------------------------------------
function whenSecondaryObserved(out, action) {
  return {
    onSpawn(side) {
      if (side !== "mmx") return;
      const watcher = fs.watch(out, (event, filename) => {
        if (filename !== "mmx-observed-input.json") return;
        watcher.close();
        action(out);
      });
    },
  };
}
async function publish(job) {
  const round = await job.promise;
  return runner.writeRunRecords(job.out, { round, warnings: job.inputs.warnings });
}
async function refused(job, name, problem) {
  await assert.rejects(publish(job), error => error.code === "ZMX_ARCHIVE_INTEGRITY" &&
    error.message.includes(problem) && error.message.includes(name), "publication must be refused");
  const out = job.out;
  assert.equal(fs.existsSync(path.join(out, "result.json")), false, "no consumable result may be published");
  assert.equal(fs.existsSync(path.join(out, "record-manifest.json")), false, "no manifest may be published");
  const record = read(out, "integrity-error.json");
  assert.equal(record.integrity, "corrupt");
  assert.equal(record.material_version, read(out, "request.json").material_version, "diagnosis stays bound to the launch-time version");
  const report = runner.verifyRun(out);
  assert.equal(report.integrity, "corrupt");
  assert.ok(report.problems.some(text => text.startsWith("publication refused:")), JSON.stringify(report.problems));
  return record;
}

for (const name of ["packet.json", "material.txt", "evidence-ids.json", "prompt.txt"]) {
  test(`publication refuses ${name} changed after both sides were dispatched`, { timeout: 15000 }, async () => {
    const job = libraryRound(`publish-changed-${name}`, "primary-pass-secondary-delayed",
      whenSecondaryObserved(path.join(root, `publish-changed-${name}`), out => fs.appendFileSync(path.join(out, name), "\nchanged after dispatch\n")));
    const record = await refused(job, name, "changed");
    // The launch-time evaluation is retained for diagnosis; it is not a content FAIL.
    assert.equal(record.evaluation_of_launch_material.REVIEW_GATE, "PASS");
    assert.equal(record.evaluation_of_launch_material.SECONDARY_REVIEW_GATE, "PASS");
  });
}

test("publication refuses a sealed input that disappeared after dispatch", { timeout: 15000 }, async () => {
  const job = libraryRound("publish-missing", "primary-pass-secondary-delayed",
    whenSecondaryObserved(path.join(root, "publish-missing"), out => fs.unlinkSync(path.join(out, "material.txt"))));
  await refused(job, "material.txt", "missing");
});

test("publication refuses a sealed input that was replaced by a directory", { timeout: 15000 }, async () => {
  const job = libraryRound("publish-replaced", "primary-pass-secondary-delayed", whenSecondaryObserved(path.join(root, "publish-replaced"), out => {
    fs.renameSync(path.join(out, "evidence-ids.json"), path.join(out, "evidence-ids.moved"));
    fs.mkdirSync(path.join(out, "evidence-ids.json"));
  }));
  await refused(job, "evidence-ids.json", "replaced");
});

test("an interrupted publication never leaves a consumable result", { timeout: 15000 }, async () => {
  const out = path.join(root, "publish-interrupted");
  // result.json is published last; blocking it must leave an archive that
  // verify reports as corrupt rather than a result a consumer could read.
  const job = libraryRound("publish-interrupted", "primary-pass-secondary-delayed",
    { onSideClosed: side => { if (side === "mmx") fs.mkdirSync(path.join(out, "result.json")); } });
  await assert.rejects(publish(job));
  assert.equal(fs.statSync(path.join(out, "result.json")).isDirectory(), true);
  const report = runner.verifyRun(out);
  assert.equal(report.integrity, "corrupt");
  assert.ok(report.problems.some(text => text.includes("result.json")), JSON.stringify(report.problems));
});

test("changing the caller's original packet after launch leaves the sealed inputs authoritative", { timeout: 15000 }, async () => {
  const source = prepare("publish-external-change");
  const job = libraryRound("publish-external-change", "both-pass", { onSpawn: side => { if (side === "mmx") fs.appendFileSync(source.packet, "\nexternal edit\n"); } });
  const result = await publish(job);
  assert.equal(result.REVIEW_GATE, "PASS");
  assert.equal(result.material_version, read(job.out, "request.json").material_version);
  assert.equal(runner.verifyRun(job.out).replay, "match");
  assert.equal(fs.existsSync(path.join(job.out, "integrity-error.json")), false);
});

test("a valid P1 of the launch-time material is retained and not attributed to changed files", { timeout: 15000 }, async () => {
  const job = libraryRound("publish-p1-retained", "zcode-fail", {
    onPrimaryReady() { fs.appendFileSync(path.join(job.out, "material.txt"), "\nchanged between phases\n"); },
  });
  const record = await refused(job, "material.txt", "changed");
  assert.equal(record.evaluation_of_launch_material.PRIMARY_REVIEW_GATE, "FAIL");
  assert.equal(record.evaluation_of_launch_material.REVIEW_GATE, "FAIL", "the veto of the launch-time material is not lost");
});

test("a normal dual PASS publishes a complete archive whose result is the last record", { timeout: 15000 }, async () => {
  const job = libraryRound("publish-complete", "both-pass");
  const result = await publish(job);
  assert.equal(result.REVIEW_GATE, "PASS");
  assert.equal(runner.verifyRun(job.out).replay, "match");
  const manifest = read(job.out, "record-manifest.json");
  assert.equal(manifest.files["result.json"], digest(fs.readFileSync(path.join(job.out, "result.json"))));
  assert.equal(manifest.files["material.txt"], read(job.out, "request.json").material_sha256);
});
