"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { prepareShardedReview, verifyShardedReview } = require("../scripts/sharded-review.js");
const { buildRunPacket } = require("../scripts/review-run.js");
const mmxFixture = require("../../mmx/tests/fixtures/native-budget-fixture.cjs");

const runner = path.resolve(__dirname, "../scripts/review-run.js");
const nativeDir = path.join(__dirname, "fixtures/native");
const raw = Buffer.from(JSON.stringify({
  facts: [{ id: "TEXT", text: "路径 / 文档 🖋\n".repeat(1350) }],
  constraints: ["Assess only the supplied text."],
  goal: { request: "Check each text fragment.", acceptance: ["Check the local character set."], acceptance_scope: "per_shard" },
}));
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));

// The real wrappers run against two local native CLI fixtures. This driver is
// serialized into the private fixture directory so the child never imports
// the test suite (or the real provider CLI).
function nativeDriver(side, bin, fixtures) {
  const fs = require("node:fs"), path = require("node:path");
  const args = process.argv.slice(2);
  const arg = name => args[args.indexOf(name) + 1];
  if (side === "zcode" && args.includes("--version")) {
    return require(path.join(fixtures, "fake-zcode-cli.cjs")).run();
  }
  const prompt = side === "zcode" ? fs.readFileSync(arg("--attach"), "utf8") :
    JSON.parse(fs.readFileSync(arg("--messages-file"), "utf8"))[0].content;
  const match = prompt.match(/Shard coverage (S-[0-9]+): (AC-1)/);
  if (!match) throw new Error("shard acceptance marker missing from the observed delivery");
  const [line, id] = match;
  const scenario = JSON.parse(fs.readFileSync(path.join(bin, "scenario.json")));
  fs.appendFileSync(path.join(bin, side + ".attempts"), id + "\n");
  if (scenario.action === "hang" && id === "S-0001") { setTimeout(() => {}, 30000); return; }
  if (scenario.action === "unknown" && id === "S-0001" && side === "mmx") return;
  const findings = scenario.action === "fail" && id === "S-0001" && side === "mmx" ? [{
    kind: "confirmed_defect", severity: "P1", title: "Local contradiction", evidence_refs: [id],
    condition: "Contradictory fixture data", impact: "Acceptance fails", recommendation: "Correct the data",
  }] : [];
  const summary = "Checked: local characters; Not checkable: none." +
    (scenario.action === "no-attestation" && side === "zcode" ? "" : "\n" + line);
  const text = JSON.stringify({ version: 1, summary, findings });
  if (side === "mmx") {
    process.env.MMX_FAKE_TEXT = text;
    require(path.join(fixtures, "mmx"));
    return;
  }
  // Keep the existing fake's full process-isolation assertions and native
  // metadata; change only the two copies of its synthetic model response.
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = data => write(String(data).trimEnd().split("\n").map(record => {
    const event = JSON.parse(record);
    if (event.type === "turn.completed") event.payload.response = text;
    if (event.type === "result") event.response = text;
    return JSON.stringify(event) + "\n";
  }).join(""));
  require(path.join(fixtures, "fake-zcode-cli.cjs")).run();
}

function setup(action = "pass", maxShards = 2, input = raw) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-shard-offline-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  for (const p of [bin, home, tmp]) fs.mkdirSync(p, { mode: 0o700 });
  const driver = path.join(bin, "driver.cjs");
  fs.writeFileSync(driver, "exports.main = " + nativeDriver.toString() + ";\n");
  fs.writeFileSync(path.join(bin, "scenario.json"), JSON.stringify({ action }));
  fs.writeFileSync(path.join(bin, "zcode"), "#!" + process.execPath + "\n// fake-zcode-cli.cjs fixture\nrequire(" +
    JSON.stringify(driver) + ").main('zcode', __dirname, " + JSON.stringify(nativeDir) + ");\n", { mode: 0o700 });
  mmxFixture.install(bin, driver, "main", ["mmx", bin, nativeDir]);
  const preloads = [path.join(nativeDir, "offline-keychain.cjs"), require.resolve("../../mmx/tests/fixtures/native-budget-fixture.cjs")];
  const env = { PATH: bin, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    LANG: "C", NODE_OPTIONS: preloads.map(file => "--require=" + JSON.stringify(file)).join(" ") };
  const packet = path.join(root, "input.json"), out = path.join(root, "审核 归档");
  fs.writeFileSync(packet, input);
  const args = [runner, "run", "--backend", "real", "--packet", packet, "--out", out,
    "--timeout-seconds", "20", "--max-shards", String(maxShards)];
  return { root, bin, out, env, args };
}
function run(box) {
  return spawnSync(process.execPath, box.args, { env: box.env, encoding: "utf8", timeout: 60000 });
}
function attempts(box, side) {
  const file = path.join(box.bin, side + ".attempts");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
}
function count(box, ids) {
  for (const side of ["zcode", "mmx"]) assert.deepEqual(attempts(box, side), ids);
}
function result(box, code) {
  const child = run(box);
  assert.equal(child.status, code, (child.stderr + child.stdout).slice(0, 2500));
  assert.equal(verifyShardedReview(box.out).replay, "match");
  return json(path.join(box.out, "result.json"));
}

test("planning binds UTF-8 bytes, common context and the complete per-side prompt", () => {
  const p = prepareShardedReview(raw, { maxShards: 2 });
  const other = prepareShardedReview(raw, { maxShards: 2, roundId: "a".repeat(32) });
  assert.deepEqual(p.promptBytes, other.promptBytes);
  assert.notDeepEqual(p.packets[0], other.packets[0], "each parent round binds different payload bytes");
  assert.equal(p.shardCount, 2);
  for (const [i, packet] of p.packets.entries()) {
    const part = JSON.parse(packet), source = JSON.parse(raw);
    assert.deepEqual(part.goal, source.goal);
    assert.ok(part.constraints.includes(source.constraints[0]));
    assert.ok(part.facts[0].text.includes(p.plan.shards[i].sha256));
    assert.ok(p.promptBytes[i] <= 24576);
    assert.equal(Buffer.byteLength(buildRunPacket(packet).prompt), p.promptBytes[i]);
    assert.ok(!part.facts[0].text.includes("\ufffd"));
  }
  assert.throws(() => prepareShardedReview(raw, { maxShards: 1 }), /budget/);
});

test("goal acceptance scope is validated and bound to canonical input bytes", () => {
  const source = JSON.parse(raw);
  const build = () => buildRunPacket(Buffer.from(JSON.stringify(source)));
  const local = build();
  source.goal.acceptance_scope = "whole_document";
  assert.notDeepEqual(local.materialBytes, build().materialBytes);
  source.goal.acceptance_scope = "any";
  assert.throws(build, /goal.acceptance_scope/);
  delete source.goal.acceptance_scope;
  assert.equal(Object.hasOwn(JSON.parse(build().material), "acceptance_scope"), false);
});

describe("shard orchestration with isolated native CLI fixtures", {
  skip: process.platform === "win32" && "native test launchers are POSIX executables",
}, () => {
  test("all children replay, preserve proofs and never resubmit an existing directory", () => {
    const box = setup();
    const pass = result(box, 0);
    assert.equal(pass.review_gate, "PASS");
    assert.equal(pass.coverage.covered_shards, 2);
    count(box, ["S-0001", "S-0002"]);
    assert.equal(run(box).status, 2);
    count(box, ["S-0001", "S-0002"]);
    const first = path.join(box.out, "parts/S-0001/run");
    const second = path.join(box.out, "parts/S-0002/run");
    fs.renameSync(first, path.join(box.root, "first-child"));
    fs.renameSync(second, first);
    assert.equal(verifyShardedReview(box.out).exit_code, 2);
    count(box, ["S-0001", "S-0002"]);
  });
  test("an intact older sharded archive reports version drift and still rejects content changes", () => {
    const box = setup();
    result(box, 0);
    const requestFile = path.join(box.out, "sharded-request.json");
    const manifestFile = path.join(box.out, "record-manifest.json");
    const request = json(requestFile);
    request.code.sharding = "0".repeat(64);
    fs.writeFileSync(requestFile, JSON.stringify(request));
    const manifest = json(manifestFile);
    manifest.files["sharded-request.json"] = require("node:crypto").createHash("sha256")
      .update(fs.readFileSync(requestFile)).digest("hex");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const verified = verifyShardedReview(box.out);
    assert.equal(verified.integrity, "ok");
    assert.equal(verified.replay, "version_drift");
    assert.equal(verified.exit_code, 2);
    fs.appendFileSync(path.join(box.out, "parts/S-0001/run/zcode-stdout.json"), "changed");
    assert.equal(verifyShardedReview(box.out).integrity, "corrupt");
    count(box, ["S-0001", "S-0002"]);
  });
  test("insufficient budget rejects before an output or native attempt exists", () => {
    const box = setup("pass", 1);
    assert.equal(run(box).status, 2);
    assert.equal(fs.existsSync(box.out), false);
    count(box, []);
  });
  for (const scope of [undefined, "whole_document"]) {
    test("whole-document uniqueness cannot pass on unanimous local votes: " + (scope ?? "default"), () => {
      const source = JSON.parse(raw);
      source.goal = { request: "Check identifiers across this document.", acceptance: ["Every identifier is unique across all records."] };
      if (scope) source.goal.acceptance_scope = scope;
      source.facts[0].text = "DUPLICATE-ID\n" + source.facts[0].text + "\nDUPLICATE-ID";
      const input = Buffer.from(JSON.stringify(source));
      const prepared = prepareShardedReview(input, { maxShards: 2 });
      assert.equal(prepared.shardCount, 2);
      assert.ok(prepared.packets.every(buffer => JSON.parse(buffer).facts[0].text.includes("DUPLICATE-ID")));
      const box = setup("pass", 2, input), r = result(box, 2);
      assert.equal(r.acceptance_scope, "whole_document");
      assert.equal(r.delivery_complete, true);
      assert.equal(r.coverage.coverage_complete, true);
      assert.equal(r.round_status, "COMPLETED");
      assert.equal(r.review_gate, "NOT_EVALUATED");
      for (const shard of r.shards) for (const side of ["zcode", "mmx"]) {
        assert.equal(shard.providers[side].gate, "PASS");
      }
      count(box, ["S-0001", "S-0002"]);
    });
  }
  test("a confirmed local defect remains FAIL for a whole-document requirement", () => {
    const source = JSON.parse(raw);
    source.goal.acceptance_scope = "whole_document";
    const r = result(setup("fail", 2, Buffer.from(JSON.stringify(source))), 1);
    assert.equal(r.review_gate, "FAIL");
  });
  test("missing coverage declarations prevent a synthesized PASS", () => {
    const box = setup("no-attestation"), r = result(box, 2);
    assert.equal(r.review_gate, "NOT_EVALUATED");
    assert.equal(r.coverage.covered_shards, 0);
    count(box, ["S-0001", "S-0002"]);
  });
  test("a bound P1 survives aggregation", () => {
    const box = setup("fail"), r = result(box, 1);
    assert.equal(r.review_gate, "FAIL");
    assert.equal(r.shards[0].providers.mmx.gate, "FAIL");
    count(box, ["S-0001", "S-0002"]);
  });
  test("incomplete native response retains evidence and stops the following shard", () => {
    const box = setup("unknown"), r = result(box, 2);
    assert.equal(r.review_gate, "NOT_EVALUATED");
    assert.ok(r.coverage.missing_shards.includes("S-0002"));
    count(box, ["S-0001"]);
    fs.mkdirSync(path.join(box.out, "parts", "extra"));
    assert.equal(verifyShardedReview(box.out).exit_code, 2);
  });
  test("cancellation retains the partial archive and never dispatches the next shard", { timeout: 55000 }, async t => {
    const box = setup("hang");
    const child = spawn(process.execPath, box.args, { env: box.env, stdio: "ignore" });
    const ended = once(child, "close");
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
    for (let i = 0; i < 250; i++) {
      if (attempts(box, "zcode").length && attempts(box, "mmx").length) break;
      if (child.exitCode !== null) break;
      await delay(40);
    }
    count(box, ["S-0001"]);
    child.kill("SIGTERM");
    assert.deepEqual(await ended, [2, null]);
    assert.equal(json(path.join(box.out, "result.json")).cancelled, true);
    assert.equal(verifyShardedReview(box.out).replay, "match");
    count(box, ["S-0001"]);
  });
});
