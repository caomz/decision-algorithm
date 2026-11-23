"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const runner = path.resolve(__dirname, "../scripts/review-run.js");
const { buildRunPacket, evaluateSide } = require(runner);
const fixture = path.join(__dirname, "fixtures/native/round-cli.cjs");
const fakeKeychain = path.join(__dirname, "fixtures/native/offline-keychain.cjs");
const mmxBudget = require.resolve("../../mmx/tests/fixtures/native-budget-fixture.cjs");
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));

function setup(scenario, renderedBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-real-offline-"));
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const tmp = path.join(dir, "tmp");
  for (const subdir of [bin, home, tmp]) fs.mkdirSync(subdir, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "scenario.json"), JSON.stringify(scenario));
  const launcher = "#!" + process.execPath + "\nrequire(" + JSON.stringify(fixture) + ").main('zcode', __dirname);\n";
  fs.writeFileSync(path.join(bin, "zcode"), launcher, { mode: 0o700 });
  require(mmxBudget).install(bin, fixture, "main", ["mmx", bin]);
  const packet = path.join(dir, "packet.json");
  const input = { facts: [{ id: "F1", text: "marker F1 for offline review" }] };
  if (renderedBytes !== undefined) {
    const before = buildRunPacket(Buffer.from(JSON.stringify(input))).prompt;
    input.facts[0].text += "x".repeat(renderedBytes - Buffer.byteLength(before));
    const after = buildRunPacket(Buffer.from(JSON.stringify(input))).prompt;
    assert.equal(Buffer.byteLength(after), renderedBytes);
  }
  fs.writeFileSync(packet, JSON.stringify(input));
  const out = path.join(dir, "run");
  const prefix = ["--require", fakeKeychain, "--require", mmxBudget];
  const env = { PATH: bin, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, LANG: "C" };
  const args = [...prefix, runner, "run", "--backend", "real", "--packet", packet, "--out", out,
    "--timeout-seconds", "20"];
  return { bin, out, env, args };
}

function attempts(bin, side) {
  const log = path.join(bin, side + ".attempts");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

function checkRound(run, code, gate, status) {
  const result = json(path.join(run.out, "result.json"));
  assert.equal(result.backend, "real");
  assert.equal(result.round_status, status);
  assert.equal(result.review_gate, gate);
  assert.equal(result.exit_code, code);
  const verified = verify(run);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.equal(JSON.parse(verified.stdout).replay, "match");
  for (const side of ["zcode", "mmx"]) {
    assert.equal(attempts(run.bin, side).length, 1, side + " invocation count, including verify");
  }
  return result;
}

function verify(run) {
  return spawnSync(process.execPath, [runner, "verify", "--run", run.out],
    { env: run.env, encoding: "utf8", timeout: 30000 });
}

function runCase(scenario, code, gate, status, renderedBytes) {
  const run = setup(scenario, renderedBytes);
  const child = spawnSync(process.execPath, run.args,
    { env: run.env, encoding: "utf8", timeout: 45000 });
  assert.equal(child.status, code, JSON.stringify({ error: child.error?.message, stdout: child.stdout, stderr: child.stderr }));
  return { run, result: checkRound(run, code, gate, status) };
}

describe("real backend through checkout wrappers and local fake native CLIs", {
  skip: process.platform === "win32" && "POSIX executable fixtures; native Windows launchers have a separate contract",
}, () => {
  test("both eligible votes match a single packet and replay detects edits", () => {
    const { run, result } = runCase({}, 0, "PASS", "COMPLETED", 24576);
    assert.equal(result.independent, true);
    for (const side of ["zcode", "mmx"]) {
      assert.equal(result.providers[side].eligible, true);
      assert.equal(result.providers[side].material_bound, true);
    }
    const prompt = fs.readFileSync(path.join(run.out, "prompt.txt"), "utf8");
    assert.equal(json(path.join(run.bin, "mmx-delivery.json")).user_content, prompt);
    const receipt = json(path.join(run.out, "zcode-stdout.json"));
    const delivery = json(path.join(receipt.artifacts_dir, "work", "fake-cli-dump.jsonl"));
    assert.equal(delivery.attach_contents_b64.length, 1);
    assert.equal(Buffer.from(delivery.attach_contents_b64[0], "base64").toString("utf8"), prompt);
    assert.ok(delivery.argv.every(arg => !arg.includes("marker F1 for offline review")));

    fs.appendFileSync(path.join(run.out, "material.txt"), "altered");
    const tampered = verify(run);
    assert.equal(tampered.status, 2);
    assert.equal(JSON.parse(tampered.stdout).integrity, "corrupt");
    for (const side of ["zcode", "mmx"]) assert.equal(attempts(run.bin, side).length, 1);
  });

  test("a rendered attachment one byte over 24 KiB rejects before either CLI or archive creation", () => {
    const run = setup({}, 24577);
    const child = spawnSync(process.execPath, run.args, { env: run.env, encoding: "utf8", timeout: 30000 });
    assert.equal(child.status, 2, child.stdout + child.stderr);
    assert.equal(fs.existsSync(run.out), false);
    for (const side of ["zcode", "mmx"]) assert.equal(attempts(run.bin, side).length, 0);
  });

  test("a successful native reply cannot vote without matching one-attempt, entry and output-limit proofs", () => {
    const { run } = runCase({}, 0, "PASS", "COMPLETED");
    const request = json(path.join(run.out, "request.json"));
    const packet = buildRunPacket(fs.readFileSync(path.join(run.out, "packet.json")));
    for (const side of ["zcode", "mmx"]) {
      const details = {
        execution: json(path.join(run.out, side + "-execution.json")),
        observed: json(path.join(run.out, side + "-observed-input.json")),
        expected: { ...packet, promptBytes: Buffer.from(packet.prompt), backend: "real", argv: request.argv[side], nativeEntry: request.native_entries[side] },
      };
      const receipt = json(path.join(run.out, side + "-stdout.json"));
      const changes = [{ attempts: 2 }, { verified: false }, { blocked: true }, { entry_sha256: "0".repeat(64) },
        { output_limit_verified: false }, { max_output_tokens: request.max_tokens + 1 }];
      if (side === "zcode") changes.push({ model_request_events: 2 });
      for (const change of changes) {
        const altered = { ...receipt, native_request_budget: { ...receipt.native_request_budget, ...change } };
        const outcome = evaluateSide(side, { ...details, stdoutBytes: Buffer.from(JSON.stringify(altered)) });
        assert.equal(outcome.eligible, false);
        assert.equal(outcome.reason, "receipt:native_request_budget");
      }
    }
  });

  test("verify recomputes delivery even when edited records agree on their file digests", () => {
    const { run } = runCase({}, 0, "PASS", "COMPLETED");
    const manifestPath = path.join(run.out, "record-manifest.json");
    const manifest = json(manifestPath);
    function updateRecord(name, record) {
      const bytes = JSON.stringify(record, null, 2) + "\n";
      fs.writeFileSync(path.join(run.out, name), bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      manifest.files[name] = digest;
      return digest;
    }
    const observation = json(path.join(run.out, "mmx-observed-input.json"));
    observation.delivery.prompt_sha256 = "0".repeat(64);
    const execution = json(path.join(run.out, "mmx-execution.json"));
    execution.observed_input = updateRecord("mmx-observed-input.json", observation);
    updateRecord("mmx-execution.json", execution);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const edited = verify(run);
    assert.equal(edited.status, 2);
    assert.equal(JSON.parse(edited.stdout).replay, "mismatch");
    for (const side of ["zcode", "mmx"]) assert.equal(attempts(run.bin, side).length, 1);
  });

  test("truncated MMX receipt makes a single PASS inconclusive", () => {
    const { result } = runCase({ mmx: "truncate" }, 2, "NOT_EVALUATED", "NOT_EVALUATED");
    assert.equal(result.providers.zcode.gate, "PASS");
    assert.equal(result.providers.mmx.eligible, false);
  });

  test("bound P1 survives the other CLI returning no events", () => {
    const { result } = runCase({ zcode: "empty", mmx: "fail" }, 1, "FAIL", "NOT_EVALUATED");
    assert.equal(result.providers.zcode.eligible, false);
    assert.equal(result.providers.mmx.gate, "FAIL");
  });

  test("one post-request EEXIST preserves both completed receipts without retrying or sealing the archive", () => {
    const run = setup({ zcode: "reserve-stderr", mmx: "wait-for-zcode-stdout" });
    const child = spawnSync(process.execPath, run.args, { env: run.env, encoding: "utf8", timeout: 30000 });
    assert.equal(child.status, 2, child.stdout + child.stderr);
    assert.match(child.stderr, /could not archive wrapper output.*EEXIST/);
    assert.equal(fs.readFileSync(path.join(run.out, "zcode-stderr.log"), "utf8"), "reserved by fixture\n");
    for (const side of ["zcode", "mmx"]) {
      const receipt = json(path.join(run.out, side + "-stdout.json"));
      assert.equal(receipt.status, "ok");
      assert.equal(receipt.complete, true);
      assert.equal(receipt.exit_code, 0);
    }
    assert.equal(fs.existsSync(path.join(run.out, "record-manifest.json")), false);
    assert.equal(fs.existsSync(path.join(run.out, "result.json")), false);
    const verified = verify(run);
    assert.equal(verified.status, 2);
    assert.equal(JSON.parse(verified.stdout).integrity, "corrupt");
    for (const side of ["zcode", "mmx"]) assert.equal(attempts(run.bin, side).length, 1);
  });

  test("SIGTERM after both native calls leaves one attempt per side and a verifiable round", { timeout: 45000 }, async t => {
    const run = setup({ zcode: "hang", mmx: "hang" });
    const child = spawn(process.execPath, run.args, { env: run.env, stdio: "ignore" });
    const closed = once(child, "close");
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
    for (let i = 0; i < 200; i++) {
      if (attempts(run.bin, "zcode").length && attempts(run.bin, "mmx").length) break;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(50);
    }
    for (const side of ["zcode", "mmx"]) assert.equal(attempts(run.bin, side).length, 1, side + " started");
    child.kill("SIGTERM");
    const [code, signal] = await closed;
    assert.equal(signal, null);
    assert.equal(code, 2);
    assert.equal(checkRound(run, code, "NOT_EVALUATED", "NOT_EVALUATED").cancelled, true);
  });
});
