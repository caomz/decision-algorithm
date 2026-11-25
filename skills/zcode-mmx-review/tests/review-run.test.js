"use strict";

// review-run.js 的契约测试：命令行拒绝、packet v1 规范化、fixture 判定矩阵、
// 取消与超时、verify 全部用例、doctor 反例。全部离线；本文件不删除任何文件，
// 自建产物都留在 mkdtemp(os.tmpdir()) 之下（受控 TMPDIR）。

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const RUNNER = path.resolve(__dirname, "../scripts/review-run.js");
const runner = require(RUNNER);
const { cleanEnv } = require("./support/env.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-review-run-"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const PACKET = {
  facts: [
    { id: "F1", text: "fixture fact one" },
    { id: "F2", text: "fixture fact two 中文" },
  ],
  constraints: ["no network"],
  assumptions: ["offline entry"],
  uncovered: ["windows supervision"],
};
const packetBytes = Buffer.from(JSON.stringify(PACKET, null, 2) + "\n");
const inputs = runner.buildRunPacket(packetBytes);

function preparedDir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "material.txt"), inputs.materialBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "evidence-ids.json"), inputs.idsBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "prompt.txt"), Buffer.from(inputs.prompt, "utf8"), { mode: 0o600 });
  return dir;
}

function roundFor(scenario, name, options = {}) {
  const dir = preparedDir(name);
  const assembled = runner.assembleInputs({
    materialPath: path.join(dir, "material.txt"),
    idsPath: path.join(dir, "evidence-ids.json"),
    promptPath: path.join(dir, "prompt.txt"),
    timeoutSeconds: 600, maxTokens: 524288,
  });
  const argv = { zcode: assembled.zcode.argv, mmx: assembled.mmx.argv };
  return runner.runFixtureRound(inputs, {
    out: dir, scenario, timeoutSeconds: 600, maxTokens: 524288,
    argv, envBase: { PATH: process.env.PATH },
    fakeProcessMs: options.fakeProcessMs ?? 10000,
  }).then(round => ({ round, dir, argv }));
}

function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    env: cleanEnv(extraEnv),
  });
}

function runArchive(scenario, name, expectedStatus = 0) {
  const out = path.join(root, name);
  const result = runCli(["run", "--backend", "fixture", "--scenario", scenario, "--packet", packetFile, "--out", out]);
  assert.equal(result.status, expectedStatus, `archive run failed: ${result.stderr}`);
  return out;
}

const packetFile = path.join(root, "packet.json");
fs.writeFileSync(packetFile, packetBytes);

// 文件级 helper：复制档案构造反例（改写后同步清单摘要）。
function copyArchive(source, name, { skip = [], edits = {} } = {}) {
  const target = path.join(root, name);
  fs.mkdirSync(target, { mode: 0o700 });
  for (const entry of fs.readdirSync(source)) {
    if (skip.includes(entry) || !fs.statSync(path.join(source, entry)).isFile()) continue;
    fs.copyFileSync(path.join(source, entry), path.join(target, entry));
  }
  for (const [file, bytes] of Object.entries(edits)) fs.writeFileSync(path.join(target, file), bytes);
  if (Object.keys(edits).length) {
    const manifestPath = path.join(target, "record-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const file of Object.keys(edits)) manifest.files[file] = sha256(fs.readFileSync(path.join(target, file)));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  return target;
}
const verifyCli = dir => runCli(["verify", "--run", dir]);
const reportOf = result => JSON.parse(result.stdout);

// ---------------------------------------------------------------------------
// packet v1 解析与规范化
// ---------------------------------------------------------------------------

describe("packet v1 parsing and canonical bytes", () => {
  const bad = (name, raw) => test(name, () => {
    assert.throws(() => runner.packetFrom(raw), /packet|fact|must|needs|duplicate JSON key/);
  });
  bad("rejects duplicate top-level keys", '{"facts":[{"id":"F1","text":"a"}],"facts":[{"id":"F1","text":"a"}]}');
  bad("rejects unknown top-level keys", '{"facts":[{"id":"F1","text":"a"}],"extra":1}');
  bad("rejects a missing facts array", '{"constraints":["a"]}');
  bad("rejects an empty facts array", '{"facts":[]}');
  bad("rejects facts with extra keys", '{"facts":[{"id":"F1","text":"a","note":"x"}]}');
  bad("rejects facts with empty text", '{"facts":[{"id":"F1","text":" "}]}');
  bad("rejects duplicate evidence IDs", '{"facts":[{"id":"F1","text":"a"},{"id":"F1","text":"b"}]}');
  bad("rejects non-string constraints", '{"facts":[{"id":"F1","text":"a"}],"constraints":[1]}');

  test("material layout is canonical and ordered", () => {
    const packet = runner.packetFrom('{"facts":[{"text":"b","id":"S1"},{"id":"S2","text":"c"}],"uncovered":["u"]}');
    const material = runner.materialFrom(packet);
    assert.equal(material, JSON.stringify({ facts: [{ id: "S1", text: "b" }, { id: "S2", text: "c" }], uncovered: ["u"] }, null, 2) + "\n");
    // 缺的段不写；键序 facts→constraints→assumptions→uncovered。
    const partial = runner.materialFrom(runner.packetFrom('{"facts":[{"id":"S1","text":"b"}],"assumptions":["a"]}'));
    assert.deepEqual(Object.keys(JSON.parse(partial)), ["facts", "assumptions"]);
  });

  test("canonical bytes are pinned by sha256", () => {
    const local = runner.buildRunPacket(packetBytes);
    assert.equal(sha256(local.materialBytes), sha256(Buffer.from(JSON.stringify({
      facts: PACKET.facts, constraints: PACKET.constraints, assumptions: PACKET.assumptions, uncovered: PACKET.uncovered,
    }, null, 2) + "\n")));
    assert.equal(sha256(local.idsBytes), sha256(Buffer.from('["F1","F2"]\n')));
  });

  test("oversized material is a usage error before any run", () => {
    const big = { facts: [{ id: "F1", text: "中".repeat(100000) }] };
    assert.throws(() => runner.buildRunPacket(Buffer.from(JSON.stringify(big))), /192 KiB|batch/);
  });
});

// ---------------------------------------------------------------------------
// 命令行拒绝（退出码 2，且 --out 未被创建：启动次数为 0）
// ---------------------------------------------------------------------------

describe("cli rejections", () => {
  const cases = [
    ["missing --backend", ["run", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "reject-a")]],
    ["real backend is disabled before reading input", ["run", "--backend", "real", "--scenario", "both-pass", "--packet", path.join(root, "no-such-packet.json"), "--out", path.join(root, "reject-b")]],
    ["unknown backend", ["run", "--backend", "other", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "reject-c")]],
    ["unknown scenario", ["run", "--backend", "fixture", "--scenario", "nope", "--packet", packetFile, "--out", path.join(root, "reject-d")]],
    ["timeout below range", ["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "reject-e"), "--timeout-seconds", "0"]],
    ["timeout above range", ["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "reject-f"), "--timeout-seconds", "3571"]],
    ["timeout not an integer", ["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "reject-g"), "--timeout-seconds", "600.5"]],
    ["max-tokens zero", ["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "reject-h"), "--max-tokens", "0"]],
    ["max-tokens not a number", ["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "reject-i"), "--max-tokens", "abc"]],
    ["duplicate option", ["run", "--backend", "fixture", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "reject-j")]],
    ["unknown option", ["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "reject-k"), "--extra", "1"]],
    ["missing packet value", ["run", "--backend", "fixture", "--scenario", "both-pass", "--packet"]],
    ["verify without --run", ["verify"]],
    ["oversized material hints at batch entry", ["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", path.join(root, "big-packet.json"), "--out", path.join(root, "reject-l")]],
  ];
  for (const [name, args] of cases) {
    test(name, () => {
      const result = runCli(args);
      assert.equal(result.status, 2, `${name}: expected exit 2, got ${result.status}; stderr=${result.stderr}`);
      for (const flag of ["--out"]) {
        const at = args.indexOf(flag);
        if (at >= 0 && args[at + 1]) assert.equal(fs.existsSync(args[at + 1]), false, `${name}: out directory must not be created`);
      }
    });
  }
  fs.writeFileSync(path.join(root, "big-packet.json"), JSON.stringify({ facts: [{ id: "F1", text: "中".repeat(100000) }] }));

  test("existing --out is refused", () => {
    const existing = path.join(root, "reject-existing");
    fs.mkdirSync(existing);
    const result = runCli(["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", existing]);
    assert.equal(result.status, 2);
  });
});

// ---------------------------------------------------------------------------
// 判定矩阵
// ---------------------------------------------------------------------------

describe("fixture adjudication matrix", () => {
  const matrix = [
    ["both-pass", "COMPLETED", "PASS", 0],
    ["zcode-fail", "COMPLETED", "FAIL", 1],
    ["same-family-fail", "NOT_EVALUATED", "FAIL", 1],
    ["mmx-invalid-zcode-fail", "NOT_EVALUATED", "FAIL", 1],
    ["p1-gap", "COMPLETED", "NOT_EVALUATED", 2],
    ["zcode-toolcalls", "NOT_EVALUATED", "NOT_EVALUATED", 2],
    ["zcode-provider-empty", "NOT_EVALUATED", "NOT_EVALUATED", 2],
    ["zcode-cleanup-null", "NOT_EVALUATED", "NOT_EVALUATED", 2],
    ["zcode-cleanup-missing", "NOT_EVALUATED", "NOT_EVALUATED", 2],
    ["zcode-cleanup-type-error", "NOT_EVALUATED", "NOT_EVALUATED", 2],
    ["zcode-stop-max-tokens", "NOT_EVALUATED", "NOT_EVALUATED", 2],
    ["zcode-tampered-material", "NOT_EVALUATED", "NOT_EVALUATED", 2],
    ["zcode-unobserved", "NOT_EVALUATED", "NOT_EVALUATED", 2],
  ];
  for (const [scenario, roundStatus, gate, exitCode] of matrix) {
    test(`${scenario} → ${roundStatus}/${gate}/${exitCode}`, async () => {
      const { round } = await roundFor(scenario, `matrix-${scenario}`);
      assert.equal(round.outcome.round_status, roundStatus, `round_status: ${JSON.stringify(round.evaluated)}`);
      assert.equal(round.outcome.review_gate, gate);
      assert.equal(round.outcome.exit_code, exitCode);
    });
  }

  test("same-family keeps the bound FAIL on record", async () => {
    const { round } = await roundFor("same-family-fail", "detail-family");
    assert.equal(round.evaluated.zcode.eligible, true);
    assert.equal(round.evaluated.zcode.gate, "FAIL");
    assert.equal(round.evaluated.mmx.eligible, true);
    assert.equal(round.evaluated.mmx.model_family, "glm");
  });

  test("one-sided invalidity does not erase a bound FAIL", async () => {
    const { round } = await roundFor("mmx-invalid-zcode-fail", "detail-one-sided");
    assert.equal(round.evaluated.zcode.eligible, true);
    assert.equal(round.evaluated.zcode.gate, "FAIL");
    assert.equal(round.evaluated.zcode.material_bound, true);
    assert.equal(round.evaluated.mmx.eligible, false);
    assert.match(round.evaluated.mmx.reason, /^receipt:/);
  });

  test("tampered material keeps the raw diagnostic of the FAIL vote", async () => {
    const { round } = await roundFor("zcode-tampered-material", "detail-tamper");
    const zcode = round.evaluated.zcode;
    assert.equal(zcode.eligible, false);
    assert.match(zcode.reason, /^binding:/);
    assert.equal(zcode.material_bound, false);
    assert.equal(zcode.diagnostic.gate, "FAIL");
    assert.ok(zcode.diagnostic.text.includes("confirmed_defect"));
    assert.equal(round.evaluated.mmx.eligible, true);
    assert.equal(round.evaluated.mmx.gate, "PASS");
  });

  test("unobserved FAIL keeps its diagnostic and does not vote", async () => {
    const { round } = await roundFor("zcode-unobserved", "detail-unobserved");
    const zcode = round.evaluated.zcode;
    assert.equal(zcode.eligible, false);
    assert.equal(zcode.reason, "binding:unobserved");
    assert.equal(zcode.diagnostic.gate, "FAIL");
    assert.ok(zcode.diagnostic.text.includes("confirmed_defect"));
  });

  test("hang exceeds the fixture deadline and becomes timed_out", async () => {
    const { round } = await roundFor("hang", "detail-timeout", { fakeProcessMs: 400 });
    assert.equal(round.executions.zcode.execution.state, "timed_out");
    assert.equal(round.executions.mmx.execution.state, "timed_out");
    assert.equal(round.evaluated.zcode.eligible, false);
    assert.equal(round.evaluated.zcode.reason, "execution:timed_out");
    assert.equal(round.outcome.review_gate, "NOT_EVALUATED");
    assert.equal(round.outcome.exit_code, 2);
  });

  test("cleanup_confirmed null / missing / mistyped map to distinct reasons", async () => {
    const reasons = {};
    for (const scenario of ["zcode-cleanup-null", "zcode-cleanup-missing", "zcode-cleanup-type-error"]) {
      const { round } = await roundFor(scenario, `detail-${scenario}`);
      reasons[scenario] = round.evaluated.zcode.reason;
    }
    assert.equal(reasons["zcode-cleanup-null"], "receipt:cleanup_unconfirmed");
    assert.equal(reasons["zcode-cleanup-missing"], "receipt:invalid_receipt:cleanup_confirmed_type");
    assert.equal(reasons["zcode-cleanup-type-error"], "receipt:invalid_receipt:cleanup_confirmed_type");
  });

  test("a wrapper exiting nonzero never votes even with a valid receipt on stdout", async () => {
    const { round } = await roundFor("zcode-exit-nonzero", "detail-exit-nonzero");
    const zcode = round.evaluated.zcode;
    assert.equal(zcode.eligible, false);
    assert.match(zcode.reason, /^execution:nonzero_exit:1$/);
    assert.equal(zcode.diagnostic.gate, "PASS"); // 回执本身合法，但进程没有正常结束
    assert.equal(round.evaluated.mmx.eligible, true);
    assert.equal(round.outcome.round_status, "NOT_EVALUATED");
    assert.equal(round.outcome.exit_code, 2);
  });

  test("a corrupt observed file fails binding and still verifies afterwards", async () => {
    const { round } = await roundFor("zcode-bad-observed", "detail-bad-observed");
    const zcode = round.evaluated.zcode;
    assert.equal(zcode.eligible, false);
    assert.match(zcode.reason, /^binding:/); // 坏内容降级为空对象后 argv/内容比较失败
    assert.equal(round.outcome.exit_code, 2);
    // 该档案必须能通过自身的 verify（不再出现 unobserved+文件存在的矛盾）。
    const out = path.join(root, "cli-bad-observed");
    const result = runCli(["run", "--backend", "fixture", "--scenario", "zcode-bad-observed", "--packet", packetFile, "--out", out]);
    assert.equal(result.status, 2);
    const verify = runCli(["verify", "--run", out]);
    assert.equal(verify.status, 0, verify.stdout);
    assert.equal(JSON.parse(verify.stdout).replay, "match");
  });

  test("a falsey JSON observed root still archives its sha and self-verifies", async () => {
    const out = path.join(root, "cli-null-observed");
    const result = runCli(["run", "--backend", "fixture", "--scenario", "zcode-null-observed", "--packet", packetFile, "--out", out]);
    assert.equal(result.status, 2);
    const execution = JSON.parse(fs.readFileSync(path.join(out, "zcode-execution.json"), "utf8"));
    assert.match(execution.observed_input, /^[0-9a-f]{64}$/); // 不是 "unobserved"
    assert.ok(fs.existsSync(path.join(out, "zcode-observed-input.json")));
    const verify = runCli(["verify", "--run", out]);
    assert.equal(verify.status, 0, verify.stdout);
    assert.equal(JSON.parse(verify.stdout).replay, "match");
  });
});

// ---------------------------------------------------------------------------
// CLI 冒烟与运行记录
// ---------------------------------------------------------------------------

describe("cli run smoke", () => {
  test("both-pass exits 0 with the full record set", () => {
    const out = path.join(root, "cli-both-pass");
    const result = runCli(["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", out]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.backend, "fixture");
    assert.equal(record.review_gate, "PASS");
    assert.match(record.note, /backend=fixture/);
    for (const name of ["packet.json", "material.txt", "evidence-ids.json", "prompt.txt", "request.json",
      "zcode-execution.json", "zcode-stdout.json", "zcode-stderr.log", "zcode-observed-input.json",
      "mmx-execution.json", "mmx-stdout.json", "mmx-stderr.log", "mmx-observed-input.json",
      "result.json", "record-manifest.json"]) {
      assert.ok(fs.existsSync(path.join(out, name)), `missing record ${name}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "record-manifest.json"), "utf8"));
    assert.equal(Object.hasOwn(manifest.files, "record-manifest.json"), false);
    for (const [name, digest] of Object.entries(manifest.files)) {
      assert.equal(sha256(fs.readFileSync(path.join(out, name))), digest, `manifest digest for ${name}`);
    }
    const request = JSON.parse(fs.readFileSync(path.join(out, "request.json"), "utf8"));
    assert.equal(request.argv.mmx.includes("--mode"), false);
    assert.equal(request.argv.mmx.includes("--evidence-ids-file"), false);
    assert.deepEqual(request.argv.mmx.slice(-6), ["--timeout", "600", "--wrap-timeout", "630", "--max-tokens", "524288"]);
  });

  test("zcode-fail exits 1", () => {
    const out = path.join(root, "cli-zcode-fail");
    const result = runCli(["run", "--backend", "fixture", "--scenario", "zcode-fail", "--packet", packetFile, "--out", out]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).review_gate, "FAIL");
  });

  test("mmx side input binding: observed P equals the expected P", () => {
    const out = path.join(root, "cli-both-pass-binding");
    const result = runCli(["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", out]);
    assert.equal(result.status, 0);
    const observed = JSON.parse(fs.readFileSync(path.join(out, "mmx-observed-input.json"), "utf8"));
    assert.equal(Buffer.from(observed.prompt_file_b64, "base64").toString("utf8"), inputs.prompt);
    const zobserved = JSON.parse(fs.readFileSync(path.join(out, "zcode-observed-input.json"), "utf8"));
    assert.equal(Buffer.from(zobserved.prompt_file_b64, "base64").toString("utf8"), inputs.material);
    assert.equal(Buffer.from(zobserved.evidence_ids_file_b64, "base64").toString("utf8"), inputs.idsBytes.toString("utf8"));
  });
});

// ---------------------------------------------------------------------------
// 取消：已完成的单方 FAIL 保留，未完成一侧记 cancelled
// ---------------------------------------------------------------------------

test("SIGTERM mid-run cancels but preserves the bound FAIL", { timeout: 60000 }, async () => {
  const out = path.join(root, "cli-cancel");
  const child = spawn(process.execPath, [RUNNER, "run", "--backend", "fixture", "--scenario", "zcode-fail-mmx-hang", "--packet", packetFile, "--out", out], {
    stdio: ["ignore", "pipe", "pipe"], env: cleanEnv(),
  });
  let stdout = "";
  child.stdout.on("data", data => { stdout += data; });
  // mmx 一侧 hang 前会先写 observed 文件；它出现即说明两侧均已启动。
  const mmxStarted = path.join(out, "mmx-observed-input.json");
  for (let i = 0; i < 200 && !fs.existsSync(mmxStarted); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(fs.existsSync(mmxStarted), "mmx side should have started before cancellation");
  // 快速失败的 zcode 一侧在 mmx observed 出现后几十毫秒内 close；给入口留出处理
  // close、绑定 FAIL 的时间再发取消信号，避免"取消先于 zcode close"的负载竞态
  // 把本用例变成假失败。
  await new Promise(resolve => setTimeout(resolve, 300));
  child.kill("SIGTERM");
  const code = await new Promise(resolve => child.once("close", resolve));
  assert.equal(code, 2);
  const result = JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8"));
  assert.equal(result.cancelled, true);
  assert.equal(result.round_status, "NOT_EVALUATED");
  assert.equal(result.review_gate, "NOT_EVALUATED");
  assert.equal(result.providers.zcode.eligible, true);
  assert.equal(result.providers.zcode.gate, "FAIL");
  const mmxExecution = JSON.parse(fs.readFileSync(path.join(out, "mmx-execution.json"), "utf8"));
  assert.equal(mmxExecution.state, "cancelled");
});

// ---------------------------------------------------------------------------
// 第二次信号与入口兜底（fix2 U3/C-1）：同类第二次信号不再杀掉入口，而是立即
// SIGKILL 尚未 close 的子进程并照常写完记录；"两侧 close 之后、记录写完之前"
// 的信号只被接住；spawn 异步失败记 spawn_error、退出码 2。
// ---------------------------------------------------------------------------

describe("second signals and entry hardening (fix2)", () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const leftoverPids = dir => {
    const found = spawnSync("pgrep", ["-f", dir], { encoding: "utf8" });
    assert.equal(found.error, undefined, "pgrep is required for the orphan check");
    return found.status === 0 ? found.stdout.trim().split("\n").filter(Boolean) : [];
  };
  const spawnRun = (name, scenario, extraEnv = {}) => {
    const out = path.join(root, name);
    const child = spawn(process.execPath, [RUNNER, "run", "--backend", "fixture", "--scenario", scenario, "--packet", packetFile, "--out", out], {
      stdio: ["ignore", "pipe", "pipe"], env: cleanEnv(extraEnv),
    });
    return { out, child };
  };
  const waitForMmxObserved = async out => {
    const mmxStarted = path.join(out, "mmx-observed-input.json");
    for (let i = 0; i < 200 && !fs.existsSync(mmxStarted); i++) await sleep(100);
    assert.ok(fs.existsSync(mmxStarted), "mmx side should have started");
  };

  const doubleSignalCase = (name, scenario, signal) => test(`${signal} twice: records survive, exit 2, mmx cancelled by SIGKILL, verify match (${name})`, { timeout: 60000 }, async () => {
    const { out, child } = spawnRun(`cli-2x-${name}-${signal.toLowerCase()}`, scenario);
    await waitForMmxObserved(out);
    child.kill(signal);
    await sleep(300); // 仍在宽限期内（slow-exit 的 1500ms 退出计时未到 / ignore-term 根本不退）
    const secondAt = Date.now();
    child.kill(signal); // 第二次：立即 SIGKILL，不再等宽限期
    const code = await new Promise(resolve => child.once("close", resolve));
    const elapsed = Date.now() - secondAt;
    assert.equal(code, 2, "the entry must survive the second signal and exit 2");
    assert.ok(elapsed < 4500, `second signal must escalate immediately (took ${elapsed}ms; grace is 5000ms)`);
    const result = JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8"));
    assert.equal(result.cancelled, true);
    assert.equal(result.review_gate, "NOT_EVALUATED");
    const mmxExecution = JSON.parse(fs.readFileSync(path.join(out, "mmx-execution.json"), "utf8"));
    assert.equal(mmxExecution.state, "cancelled");
    // 决定性判别：不升级时 slow-exit 会走自己的 SIGTERM 处理记 exit 143。
    assert.equal(mmxExecution.signal, "SIGKILL");
    assert.equal(mmxExecution.exit_code, null);
    const verify = runCli(["verify", "--run", out]);
    assert.equal(verify.status, 0, verify.stdout);
    assert.equal(JSON.parse(verify.stdout).replay, "match");
  });

  doubleSignalCase("slow", "zcode-fail-mmx-slow", "SIGTERM");
  doubleSignalCase("slow", "zcode-fail-mmx-slow", "SIGINT");

  test("second SIGTERM on a SIGTERM-deaf wrapper: SIGKILL wins, no orphan left", { timeout: 60000 }, async () => {
    const { out, child } = spawnRun("cli-2x-deaf", "zcode-fail-mmx-ignore-term");
    await waitForMmxObserved(out);
    child.kill("SIGTERM");
    await sleep(300);
    const secondAt = Date.now();
    child.kill("SIGTERM");
    const code = await new Promise(resolve => child.once("close", resolve));
    assert.equal(code, 2);
    assert.ok(Date.now() - secondAt < 4500, "second signal must SIGKILL immediately");
    const result = JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8"));
    assert.equal(result.cancelled, true);
    const mmxExecution = JSON.parse(fs.readFileSync(path.join(out, "mmx-execution.json"), "utf8"));
    assert.equal(mmxExecution.state, "cancelled");
    assert.equal(mmxExecution.signal, "SIGKILL");
    assert.deepEqual(leftoverPids(out), [], "no wrapper process may outlive the entry");
    await sleep(500);
    assert.deepEqual(leftoverPids(out), [], "no wrapper process may outlive the entry (recheck)");
    const verify = runCli(["verify", "--run", out]);
    assert.equal(verify.status, 0, verify.stdout);
    assert.equal(JSON.parse(verify.stdout).replay, "match");
  });

  test("a signal in the between-close-and-record window does not kill the entry and keeps cancelled=false", { timeout: 60000 }, async () => {
    // ZMX_TEST_HOLD_BEFORE_RECORDS_MS 撑开"两侧 close 之后、记录写完之前"的窗口。
    const { out, child } = spawnRun("cli-window-signal", "both-pass", { ZMX_TEST_HOLD_BEFORE_RECORDS_MS: "3000" });
    const zcodeStarted = path.join(out, "zcode-observed-input.json");
    for (let i = 0; i < 200 && !(fs.existsSync(zcodeStarted) && fs.existsSync(path.join(out, "mmx-observed-input.json"))); i++) await sleep(100);
    await sleep(1000); // wrapper 已退出，入口停在 hold 内
    child.kill("SIGTERM");
    await sleep(200);
    child.kill("SIGTERM"); // 窗口内第二信号同样是 no-op（处理幂等）
    const code = await new Promise(resolve => child.once("close", resolve));
    assert.equal(code, 0, "the entry must survive window signals and finish PASS");
    const result = JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8"));
    assert.equal(result.cancelled, false);
    assert.equal(result.review_gate, "PASS");
    const verify = runCli(["verify", "--run", out]);
    assert.equal(verify.status, 0, verify.stdout);
    assert.equal(JSON.parse(verify.stdout).replay, "match");
  });

  test("spawning a nonexistent executable records spawn_error on both sides and exits 2", { timeout: 60000 }, () => {
    const out = path.join(root, "cli-spawn-error");
    const result = runCli(["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", out], { ZMX_TEST_SPAWN_EXECUTABLE: path.join(root, "no-such-zmx-executable") });
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}\nstderr: ${result.stderr}`);
    assert.ok(!result.stderr.includes("Unhandled"), `no unhandled error crash:\n${result.stderr}`);
    const record = JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8"));
    assert.equal(record.cancelled, false);
    assert.equal(record.round_status, "NOT_EVALUATED");
    for (const side of ["zcode", "mmx"]) {
      const execution = JSON.parse(fs.readFileSync(path.join(out, `${side}-execution.json`), "utf8"));
      assert.equal(execution.state, "spawn_error", `${side} must record spawn_error`);
      assert.equal(execution.exit_code, null);
      assert.equal(execution.signal, null);
      assert.equal(execution.observed_input, "unobserved");
      assert.equal(record.providers[side].reason, "execution:spawn_error");
    }
    const verify = runCli(["verify", "--run", out]);
    assert.equal(verify.status, 0, verify.stdout);
    assert.equal(JSON.parse(verify.stdout).replay, "match");
  });
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

describe("verify", () => {
  const baseBoth = runArchive("both-pass", "verify-both");
  const baseFail = runArchive("zcode-fail", "verify-fail", 1);
  const baseUnobserved = runArchive("zcode-unobserved", "verify-unobserved", 2);

  // 从零复制档案到新目录；skip 列出的文件不复制；tmp/ 是子进程工作区，不复制。
  function copyArchive(source, name, { skip = [], edits = {} } = {}) {
    const target = path.join(root, name);
    fs.mkdirSync(target, { mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      if (skip.includes(entry) || !fs.statSync(path.join(source, entry)).isFile()) continue;
      fs.copyFileSync(path.join(source, entry), path.join(target, entry));
    }
    for (const [file, bytes] of Object.entries(edits)) fs.writeFileSync(path.join(target, file), bytes);
    if (Object.keys(edits).length) {
      const manifestPath = path.join(target, "record-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      for (const file of Object.keys(edits)) manifest.files[file] = sha256(fs.readFileSync(path.join(target, file)));
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    return target;
  }

  const verifyCli = dir => runCli(["verify", "--run", dir]);
  const report = result => JSON.parse(result.stdout);

  test("an intact PASS archive replays to match with exit 0", () => {
    const result = verifyCli(baseBoth);
    assert.equal(result.status, 0);
    assert.equal(report(result).integrity, "ok");
    assert.equal(report(result).replay, "match");
    assert.match(report(result).note, /self-consistency/);
  });

  test("an original FAIL archive still verifies (exit 0)", () => {
    const result = verifyCli(baseFail);
    assert.equal(result.status, 0);
    assert.equal(report(result).replay, "match");
  });

  test("a legitimate unobserved archive verifies", () => {
    const result = verifyCli(baseUnobserved);
    assert.equal(result.status, 0);
    assert.equal(report(result).replay, "match");
  });

  test("missing record file is integrity=corrupt", () => {
    const dir = copyArchive(baseBoth, "verify-missing-record", { skip: ["zcode-stdout.json"] });
    const result = verifyCli(dir);
    assert.equal(result.status, 2);
    assert.equal(report(result).integrity, "corrupt");
    assert.ok(report(result).problems.some(problem => problem.includes("zcode-stdout.json")));
  });

  test("observed file listed but absent is integrity=corrupt", () => {
    const dir = copyArchive(baseBoth, "verify-missing-observed", { skip: ["zcode-observed-input.json"] });
    const result = verifyCli(dir);
    assert.equal(result.status, 2);
    assert.equal(report(result).integrity, "corrupt");
  });

  test("edited receipt replays to mismatch", () => {
    const receipt = JSON.parse(fs.readFileSync(path.join(baseBoth, "zcode-stdout.json"), "utf8"));
    receipt.text = JSON.stringify({ version: 1, summary: "Checked: none; Not checkable: all.", findings: [{ kind: "confirmed_defect", severity: "P1", title: "x", evidence_refs: ["F1"], condition: "c", impact: "i", recommendation: "r" }] });
    const receiptBytes = Buffer.from(JSON.stringify(receipt) + "\n");
    // 彻底的篡改会连 execution 里的声明摘要一起同步；replay 层仍要抓住结果不一致。
    const execution = JSON.parse(fs.readFileSync(path.join(baseBoth, "zcode-execution.json"), "utf8"));
    execution.stdout_sha256 = sha256(receiptBytes);
    const dir = copyArchive(baseBoth, "verify-edited-receipt", {
      edits: {
        "zcode-stdout.json": receiptBytes,
        "zcode-execution.json": Buffer.from(JSON.stringify(execution, null, 2) + "\n"),
      },
    });
    const result = verifyCli(dir);
    assert.equal(result.status, 2);
    assert.equal(report(result).replay, "mismatch");
  });

  test("edited packet replays to mismatch", () => {
    const packet = JSON.parse(fs.readFileSync(path.join(baseBoth, "packet.json"), "utf8"));
    packet.facts[0].text = "edited after the fact";
    const dir = copyArchive(baseBoth, "verify-edited-packet", { edits: { "packet.json": Buffer.from(JSON.stringify(packet, null, 2) + "\n") } });
    const result = verifyCli(dir);
    assert.equal(result.status, 2);
    assert.equal(report(result).replay, "mismatch");
    assert.ok(report(result).problems.some(problem => problem.includes("material.txt")));
  });

  test("edited observed IDs replay to mismatch", () => {
    const observed = JSON.parse(fs.readFileSync(path.join(baseBoth, "zcode-observed-input.json"), "utf8"));
    observed.evidence_ids_file_b64 = Buffer.from('["F1","F9"]\n').toString("base64");
    const execution = JSON.parse(fs.readFileSync(path.join(baseBoth, "zcode-execution.json"), "utf8"));
    const dir = copyArchive(baseBoth, "verify-edited-ids", {
      edits: {
        "zcode-observed-input.json": Buffer.from(JSON.stringify(observed, null, 2) + "\n"),
        "zcode-execution.json": Buffer.from(JSON.stringify({ ...execution, observed_input: sha256(Buffer.from(JSON.stringify(observed, null, 2) + "\n")) }, null, 2) + "\n"),
      },
    });
    const result = verifyCli(dir);
    assert.equal(result.status, 2);
    assert.equal(report(result).replay, "mismatch");
  });

  test("adjudication code drift reports version_drift without claiming a replay", () => {
    const request = JSON.parse(fs.readFileSync(path.join(baseBoth, "request.json"), "utf8"));
    request.adjudication_code["review.js"] = "0".repeat(64);
    const dir = copyArchive(baseBoth, "verify-drift", { edits: { "request.json": Buffer.from(JSON.stringify(request, null, 2) + "\n") } });
    const result = verifyCli(dir);
    assert.equal(result.status, 2);
    assert.equal(report(result).replay, "version_drift");
    assert.deepEqual(report(result).drifted, ["review.js"]);
  });

  test("editing a non-adjudicating file still replays to match", () => {
    const request = JSON.parse(fs.readFileSync(path.join(baseBoth, "request.json"), "utf8"));
    request.provenance_code["mmx-profile"] = "0".repeat(64);
    const dir = copyArchive(baseBoth, "verify-nonadj", { edits: { "request.json": Buffer.from(JSON.stringify(request, null, 2) + "\n") } });
    const result = verifyCli(dir);
    assert.equal(result.status, 0);
    assert.equal(report(result).replay, "match");
  });

  test("tampering result exit_code replays to mismatch", () => {
    const result = JSON.parse(fs.readFileSync(path.join(baseBoth, "result.json"), "utf8"));
    result.exit_code = 1;
    const dir = copyArchive(baseBoth, "verify-exit-code", { edits: { "result.json": Buffer.from(JSON.stringify(result, null, 2) + "\n") } });
    const outcome = verifyCli(dir);
    assert.equal(outcome.status, 2);
    assert.equal(report(outcome).replay, "mismatch");
    assert.ok(report(outcome).problems.some(problem => problem.includes("exit_code")));
  });

  test("tampering a provider model_family replays to mismatch", () => {
    const result = JSON.parse(fs.readFileSync(path.join(baseBoth, "result.json"), "utf8"));
    result.providers.zcode.model_family = "minimax";
    const dir = copyArchive(baseBoth, "verify-family", { edits: { "result.json": Buffer.from(JSON.stringify(result, null, 2) + "\n") } });
    const outcome = verifyCli(dir);
    assert.equal(outcome.status, 2);
    assert.equal(report(outcome).replay, "mismatch");
    assert.ok(report(outcome).problems.some(problem => problem.includes("model_family")));
  });

  test("a symlinked record-manifest.json fails integrity", () => {
    const dir = copyArchive(baseBoth, "verify-manifest-link");
    // 从零构造：真清单移作副本外的原件，目录内放指向它的符号链接（不删除任何文件）。
    const outside = path.join(root, "verify-manifest-outside.json");
    fs.copyFileSync(path.join(dir, "record-manifest.json"), outside);
    fs.renameSync(path.join(dir, "record-manifest.json"), path.join(dir, "record-manifest.real.json"));
    fs.symlinkSync(outside, path.join(dir, "record-manifest.json"));
    const outcome = verifyCli(dir);
    assert.equal(outcome.status, 2);
    assert.equal(report(outcome).integrity, "corrupt");
    assert.ok(report(outcome).problems.some(problem => problem.includes("record-manifest.json")));
  });

  test("a cancelled archive verifies from execution state", () => {
    const dir = path.join(root, "cli-cancel");
    if (!fs.existsSync(path.join(dir, "result.json"))) return; // 取消用例未在本机跑出档案时跳过
    const result = verifyCli(dir);
    assert.equal(result.status, 0);
    assert.equal(report(result).replay, "match");
    assert.equal(report(result).replayed.cancelled, true);
  });

  test("a constructed not_started archive verifies", () => {
    const execution = JSON.parse(fs.readFileSync(path.join(baseBoth, "mmx-execution.json"), "utf8"));
    const notStarted = { ...execution, state: "not_started", exit_code: null, signal: null, observed_input: "unobserved", stdout_sha256: sha256(Buffer.alloc(0)), stderr_sha256: sha256(Buffer.alloc(0)) };
    const result = JSON.parse(fs.readFileSync(path.join(baseBoth, "result.json"), "utf8"));
    result.providers.mmx = { eligible: false, gate: null, reason: "execution:not_started", model: null, model_family: null, material_bound: false, review: null, diagnostic: { receipt_status: null, gate: null, text: null } };
    result.round_status = "NOT_EVALUATED";
    result.review_gate = "NOT_EVALUATED";
    result.exit_code = 2;
    result.families_known = false;
    result.independent = false;
    const dir = copyArchive(baseBoth, "verify-not-started", {
      skip: ["mmx-observed-input.json"],
      edits: {
        "mmx-execution.json": Buffer.from(JSON.stringify(notStarted, null, 2) + "\n"),
        "mmx-stdout.json": Buffer.from(""),
        "result.json": Buffer.from(JSON.stringify(result, null, 2) + "\n"),
      },
    });
    const manifestPath = path.join(dir, "record-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.files["mmx-observed-input.json"];
    for (const file of ["mmx-execution.json", "mmx-stdout.json", "result.json"]) manifest.files[file] = sha256(fs.readFileSync(path.join(dir, file)));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const outcome = verifyCli(dir);
    assert.equal(outcome.status, 0, outcome.stdout);
    assert.equal(report(outcome).replay, "match");
  });
});

// ---------------------------------------------------------------------------
// doctor --offline 与反例（在 X 的副本上从零构造）
// ---------------------------------------------------------------------------

describe("doctor offline", () => {
  const scenariosRoot = process.env.ZMX_DOCTOR_FIXTURES_ROOT || path.join(root, "doctor-fixtures");
  const skills = ["zcode", "mmx", "zcode-mmx-review"];

  function makeCopy(name, transform) {
    const target = path.join(scenariosRoot, name);
    fs.mkdirSync(target, { recursive: true });
    for (const skill of skills) fs.cpSync(path.join(runner.SKILLS, skill), path.join(target, skill), { recursive: true });
    if (transform) transform(target);
    return target;
  }

  const readMarker = rootDir => path.join(rootDir, "zcode/.zcode-release.json");

  test("an intact tree passes", () => {
    const report = runner.doctorOffline(makeCopy("intact"));
    assert.equal(report.status, "ok");
    assert.equal(report.mode, "offline");
    assert.equal(report.checks.at(-1).result, "unchecked");
  });

  test("missing manifest fails", () => {
    // 从零构造：复制时就不带 .zcode-release.json，不靠删除制造缺清单。
    const replaced = path.join(scenariosRoot, "no-manifest-marker");
    fs.mkdirSync(replaced, { recursive: true });
    for (const skill of skills) {
      if (skill === "zcode") {
        fs.mkdirSync(path.join(replaced, "zcode"), { recursive: true });
        for (const entry of fs.readdirSync(path.join(runner.SKILLS, "zcode"))) {
          if (entry === ".zcode-release.json") continue;
          fs.cpSync(path.join(runner.SKILLS, "zcode", entry), path.join(replaced, "zcode", entry), { recursive: true });
        }
      } else fs.cpSync(path.join(runner.SKILLS, skill), path.join(replaced, skill), { recursive: true });
    }
    assert.equal(fs.existsSync(readMarker(replaced)), false);
    assert.equal(runner.doctorOffline(replaced).status, "failed");
  });

  test("wrong manifest version fails", () => {
    const rootDir = makeCopy("bad-version", target => {
      const marker = JSON.parse(fs.readFileSync(readMarker(target), "utf8"));
      marker.version = "9.9.9";
      fs.writeFileSync(readMarker(target), JSON.stringify(marker, null, 2) + "\n");
    });
    assert.equal(runner.doctorOffline(rootDir).status, "failed");
  });

  test("a changed file hash fails", () => {
    const rootDir = makeCopy("bad-hash", target => {
      fs.appendFileSync(path.join(target, "zcode/SKILL.md"), "\n<!-- tampered -->\n");
    });
    assert.equal(runner.doctorOffline(rootDir).status, "failed");
  });

  test("divergent schemas fail", () => {
    const rootDir = makeCopy("schema-split", target => {
      fs.appendFileSync(path.join(target, "mmx/references/review-v1.schema.json"), "\n");
    });
    assert.equal(runner.doctorOffline(rootDir).status, "failed");
  });

  test("cli is recorded as unchecked", () => {
    const rootDir = makeCopy("cli-unchecked");
    const report = runner.doctorOffline(rootDir);
    const cli = report.checks.find(check => check.name === "cli");
    assert.deepEqual(cli, { name: "cli", ok: true, result: "unchecked" });
  });
});

// ---------------------------------------------------------------------------
// assembleInputs 的参数域
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// coverage_declared（S3）：只看 summary 第一行的形状，不影响 gate
// ---------------------------------------------------------------------------

describe("coverage_declared", () => {
  const cd = runner.coverageDeclared;
  test("a well-formed first line declares coverage", () => {
    assert.equal(cd("Checked: correctness; Not checkable: upstream."), true);
    assert.equal(cd("Checked: none; Not checkable: none."), true);
    assert.equal(cd("Checked: none; Not checkable: none.\nextra note on later lines"), true);
  });
  test("missing half, blank sides or a duplicated separator fail the shape check", () => {
    assert.equal(cd("Checked: correctness only."), false);
    assert.equal(cd("Not checkable: everything; Checked: none"), false);
    assert.equal(cd("Checked:  ; Not checkable: upstream."), false);
    assert.equal(cd("Checked: correctness; Not checkable: a; Not checkable: b"), false);
    assert.equal(cd(""), false);
    assert.equal(cd(null), false);
  });
  test("an extra top-level key in the reply is rejected by the schema before coverage matters", () => {
    assert.throws(() => require("../../zcode/scripts/review.js").validateReview(JSON.stringify({
      version: 1, summary: "Checked: a; Not checkable: b.", findings: [], coverage: true,
    }), ["F1"]), /unexpected/);
  });
  test("a P1 gap without evidence keeps gate NOT_EVALUATED regardless of the declaration", async () => {
    const { round } = await roundFor("p1-gap", "coverage-gap");
    assert.equal(round.evaluated.zcode.gate, "NOT_EVALUATED");
    assert.equal(round.evaluated.zcode.coverage_declared, true);
    assert.equal(round.outcome.review_gate, "NOT_EVALUATED");
  });
  test("a declaration contradicting the logs is still only a declaration", async () => {
    // 场景 summary 声称检查了 correctness/boundaries，而材料里根本没有日志——
    // coverage_declared 只认形状，语义矛盾由人复核，gate 不变。
    const { round } = await roundFor("both-pass", "coverage-contradiction");
    assert.equal(round.evaluated.zcode.coverage_declared, true);
    assert.equal(round.outcome.review_gate, "PASS");
  });
  test("an ineligible side reports coverage_declared as null", async () => {
    const { round } = await roundFor("zcode-unobserved", "coverage-null");
    assert.equal(round.evaluated.zcode.eligible, false);
    assert.equal(round.evaluated.zcode.coverage_declared, null);
  });
});

describe("assembleInputs argument domains", () => {  test("zcode and mmx argv stay separate", () => {
    const assembled = runner.assembleInputs({ materialPath: "/m", idsPath: "/i", promptPath: "/p", timeoutSeconds: 120, maxTokens: 1024 });
    assert.deepEqual(assembled.zcode.argv, ["--prompt-file", "/m", "--mode", "review", "--evidence-ids-file", "/i", "--timeout-seconds", "120"]);
    assert.deepEqual(assembled.mmx.argv, ["--prompt-file", "/p", "--timeout", "120", "--wrap-timeout", "150", "--max-tokens", "1024"]);
    assert.equal(assembled.mmx.argv.some(flag => flag === "--mode" || flag === "--evidence-ids-file" || flag === "--system-file"), false);
  });

  test("zcode never receives --max-tokens", () => {
    const assembled = runner.assembleInputs({ materialPath: "/m", idsPath: "/i", promptPath: "/p", timeoutSeconds: 120, maxTokens: 1024 });
    assert.equal(assembled.zcode.argv.includes("--max-tokens"), false);
  });

  test("family prefixes follow the documented rule", () => {
    assert.equal(runner.family("glm-4.7"), "glm");
    assert.equal(runner.family("GLM_4"), "glm");
    assert.equal(runner.family("glm."), "glm");
    assert.equal(runner.family("glmix"), null);
    assert.equal(runner.family("minimax-m2"), "minimax");
    assert.equal(runner.family("MiniMax-M2"), "minimax");
    assert.equal(runner.family("minimaxus"), null);
    assert.equal(runner.family(null), null);
  });
});

// ---------------------------------------------------------------------------
// 取消状态机（F1）：信号发给测试进程自身，驱动库级 runFixtureRound；
// 时序确定性不依赖墙钟竞速（slow-exit 的退出永远晚于信号与截止时间）。
// ---------------------------------------------------------------------------

describe("cancellation state machine", () => {
  const waitFor = async (predicate, label, budgetMs = 10000) => {
    for (let i = 0; i < budgetMs / 50 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(predicate(), `${label} timed out`);
  };

  async function prepareRoundDir(name) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 输入组用入口自己的写入函数落盘（packet/material/ids/prompt 四件齐全）。
    runner.writeRunInputs(dir, { packetBytes, inputs });
    const assembled = runner.assembleInputs({
      materialPath: path.join(dir, "material.txt"), idsPath: path.join(dir, "evidence-ids.json"),
      promptPath: path.join(dir, "prompt.txt"), timeoutSeconds: 600, maxTokens: 524288,
    });
    const argvBySide = { zcode: assembled.zcode.argv, mmx: assembled.mmx.argv };
    return { dir, assembled, argvBySide };
  };

  test("(a) first signal lands deterministically while mmx is running (onSpawn-synced); the later deadline does not override", { timeout: 60000 }, async () => {
    const { dir, assembled, argvBySide } = await prepareRoundDir("cancel-a");
    let mmxAtSignal = null;
    const roundPromise = runner.runFixtureRound(inputs, {
      out: dir, scenario: "zcode-fail-mmx-slow", timeoutSeconds: 600, maxTokens: 524288,
      argv: argvBySide, envBase: { PATH: process.env.PATH }, fakeProcessMs: 300, // 截止时间短于 exitMs 1500
      onSpawn: (side, child) => {
        if (side !== "mmx") return;
        // 同步于 mmx spawn 之后发信号：两侧 entry 都已建、都尚未 close（U5 前置）。
        // 回调异常会被入口吞掉，状态先记录、round 后断言。
        mmxAtSignal = { exitCode: child.exitCode, signalCode: child.signalCode };
        process.kill(process.pid, "SIGTERM");
      },
    });
    const round = await roundPromise;
    assert.ok(mmxAtSignal, "onSpawn should have fired for mmx");
    assert.equal(mmxAtSignal.exitCode, null, "signal must land while mmx is still running");
    assert.equal(mmxAtSignal.signalCode, null, "signal must land while mmx is still running");
    assert.equal(round.cancelled, true);
    assert.equal(round.outcome.review_gate, "NOT_EVALUATED");
    assert.equal(round.executions.mmx.execution.state, "cancelled"); // 取消后才到的截止时间不改判
    assert.equal(round.executions.zcode.execution.state, "cancelled"); // 信号同步于两侧 close 之前
    const result = runner.writeRunRecords(dir, {
      scenario: "zcode-fail-mmx-slow", timeoutSeconds: 600, maxTokens: 524288,
      argv: argvBySide, envKeys: Object.keys(assembled.zcode.env).sort(), round,
    });
    assert.equal(result.review_gate, "NOT_EVALUATED");
    const verify = runCli(["verify", "--run", dir]);
    assert.equal(verify.status, 0, verify.stdout);
    assert.equal(JSON.parse(verify.stdout).replay, "match");
  });

  test("(a') cancel after the zcode side closed (onSideClosed-synced): completed FAIL preserved, mmx cancelled", { timeout: 60000 }, async () => {
    const { dir, assembled, argvBySide } = await prepareRoundDir("cancel-a2");
    let signalled = false;
    const roundPromise = runner.runFixtureRound(inputs, {
      out: dir, scenario: "zcode-fail-mmx-slow", timeoutSeconds: 600, maxTokens: 524288,
      argv: argvBySide, envBase: { PATH: process.env.PATH }, fakeProcessMs: 1200, // 仍短于 exitMs 1500
      onSideClosed: side => {
        if (side !== "zcode" || signalled) return;
        // 信号同步于 zcode close 处理之后：zcode 已定态 completed；mmx 的退出只可能
        // 由 SIGTERM/SIGKILL 触发（slow-exit 先挂起），此刻必在运行——无需墙钟竞速。
        signalled = true;
        process.kill(process.pid, "SIGTERM");
      },
    });
    const round = await roundPromise;
    assert.ok(signalled, "onSideClosed should have fired for zcode");
    assert.equal(round.cancelled, true);
    assert.equal(round.outcome.review_gate, "NOT_EVALUATED");
    assert.equal(round.executions.zcode.execution.state, "completed");
    assert.equal(round.executions.mmx.execution.state, "cancelled");
    assert.equal(round.evaluated.zcode.eligible, true);
    assert.equal(round.evaluated.zcode.gate, "FAIL"); // 已绑定的单方 FAIL 保留在 providers 里
    const result = runner.writeRunRecords(dir, {
      scenario: "zcode-fail-mmx-slow", timeoutSeconds: 600, maxTokens: 524288,
      argv: argvBySide, envKeys: Object.keys(assembled.zcode.env).sort(), round,
    });
    assert.equal(result.review_gate, "NOT_EVALUATED");
    const verify = runCli(["verify", "--run", dir]);
    assert.equal(verify.status, 0, verify.stdout);
    assert.equal(JSON.parse(verify.stdout).replay, "match");
  });

  test("(b) cancel while terminating: result identical to (a)", { timeout: 60000 }, async () => {
    const { dir, assembled, argvBySide } = await prepareRoundDir("cancel-b");
    const roundPromise = runner.runFixtureRound(inputs, {
      out: dir, scenario: "zcode-fail-mmx-slow", timeoutSeconds: 600, maxTokens: 524288,
      argv: argvBySide, envBase: { PATH: process.env.PATH }, fakeProcessMs: 300,
    });
    await waitFor(() => fs.existsSync(path.join(dir, "mmx-observed-input.json")), "mmx observed");
    // 等 deadline（300ms）触发、进入 terminating（mmx 收到 SIGTERM 开始 1500ms 退出计时）之后再取消。
    await new Promise(resolve => setTimeout(resolve, 450));
    process.kill(process.pid, "SIGTERM");
    const round = await roundPromise;
    assert.equal(round.cancelled, true);
    assert.equal(round.outcome.review_gate, "NOT_EVALUATED");
    assert.equal(round.executions.mmx.execution.state, "cancelled"); // 取消接管 terminating，不再记 timed_out
    assert.equal(round.evaluated.zcode.gate, "FAIL");
    runner.writeRunRecords(dir, {
      scenario: "zcode-fail-mmx-slow", timeoutSeconds: 600, maxTokens: 524288,
      argv: argvBySide, envKeys: Object.keys(assembled.zcode.env).sort(), round,
    });
    const verify = runCli(["verify", "--run", dir]);
    assert.equal(verify.status, 0, verify.stdout);
    assert.equal(JSON.parse(verify.stdout).replay, "match");
  });

  // 原 (c)（round 返回后发信号、断言已返回的对象）按第四轮 U5 裁决删除：它测不到
  // runner。"两侧 close 之后、记录写完之前"的窗口改由 CLI 层用例锁定（见
  // "second signals and entry hardening" 的 hold 窗口用例）。
});

// ---------------------------------------------------------------------------
// F2 锁定用例：verify 逐字段篡改、完整性反例、run 侧行为锁定。
// 每个用例对应一个已知变异（见 L1 复核 tools/mutations.json），变异去掉对应
// 检查后该用例必须红。
// ---------------------------------------------------------------------------

describe("verify field-level tampering (F2: M02-M09, M31)", () => {
  const baseRun = runCli(["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "f2-both")]);
  assert.equal(baseRun.status, 0, baseRun.stderr);
  const base = path.join(root, "f2-both");
  const tamper = (name, mutate) => {
    const result = JSON.parse(fs.readFileSync(path.join(base, "result.json"), "utf8"));
    mutate(result);
    const dir = copyArchive(base, `f2-${name}`, { edits: { "result.json": Buffer.from(JSON.stringify(result, null, 2) + "\n") } });
    const outcome = verifyCli(dir);
    assert.equal(outcome.status, 2, `${name}: expected exit 2`);
    const report_ = reportOf(outcome);
    assert.equal(report_.replay, "mismatch", `${name}: expected mismatch, got ${JSON.stringify(report_)}`);
    return report_.problems.join(" | ");
  };
  const cases = [
    ["model", r => { r.providers.zcode.model = "glm-forged"; }, "model"],
    ["reason", r => { r.providers.zcode.reason = "forged"; }, "reason"],
    ["material_bound", r => { r.providers.zcode.material_bound = false; }, "material_bound"],
    ["diagnostic_text", r => { r.providers.zcode.diagnostic.text = "forged"; }, "diagnostic.text"],
    ["diagnostic_gate", r => { r.providers.zcode.diagnostic.gate = "FAIL"; }, "diagnostic.gate"],
    ["diagnostic_receipt_status", r => { r.providers.zcode.diagnostic.receipt_status = "api_error"; }, "receipt_status"],
    ["coverage_declared", r => { r.providers.zcode.coverage_declared = false; }, "coverage_declared"],
    ["review", r => { r.providers.zcode.review = { version: 1, summary: "forged", findings: [] }; }, "review content"],
    ["cancelled", r => { r.cancelled = true; }, "cancelled"],
  ];
  for (const [name, mutate, needle] of cases) {
    test(`tampering ${name} replays to mismatch and names the field`, () => {
      const problems = tamper(name, mutate);
      assert.ok(problems.includes(needle), `${name}: problems must name ${needle}, got: ${problems}`);
    });
  }
});

describe("verify integrity locks (F2: M12b, M20, M32, M35)", () => {
  const baseRun = runCli(["run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", path.join(root, "f2i-both")]);
  assert.equal(baseRun.status, 0, baseRun.stderr);
  const base = path.join(root, "f2i-both");
  const verifyCli = dir => runCli(["verify", "--run", dir]);
  const report = result => JSON.parse(result.stdout);
  const copyArchive = (source, name, { skip = [], edits = {} } = {}) => {
    const target = path.join(root, name);
    fs.mkdirSync(target, { mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      if (skip.includes(entry) || !fs.statSync(path.join(source, entry)).isFile()) continue;
      fs.copyFileSync(path.join(source, entry), path.join(target, entry));
    }
    for (const [file, bytes] of Object.entries(edits)) fs.writeFileSync(path.join(target, file), bytes);
    if (Object.keys(edits).length) {
      const manifestPath = path.join(target, "record-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      for (const file of Object.keys(edits)) manifest.files[file] = sha256(fs.readFileSync(path.join(target, file)));
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    return target;
  };

  test("execution stdout digest disagreeing with the archive is corrupt (M20)", () => {
    const execution = JSON.parse(fs.readFileSync(path.join(base, "zcode-execution.json"), "utf8"));
    execution.stdout_sha256 = "0".repeat(64);
    const dir = copyArchive(base, "f2i-m20", { edits: { "zcode-execution.json": Buffer.from(JSON.stringify(execution, null, 2) + "\n") } });
    const outcome = verifyCli(dir);
    assert.equal(outcome.status, 2);
    assert.equal(report(outcome).integrity, "corrupt");
    assert.ok(report(outcome).problems.some(problem => problem.includes("stdout digest disagrees")));
  });

  test("observed file present but execution says unobserved is corrupt (M35)", () => {
    const execution = JSON.parse(fs.readFileSync(path.join(base, "zcode-execution.json"), "utf8"));
    execution.observed_input = "unobserved";
    const dir = copyArchive(base, "f2i-m35", { edits: { "zcode-execution.json": Buffer.from(JSON.stringify(execution, null, 2) + "\n") } });
    const outcome = verifyCli(dir);
    assert.equal(outcome.status, 2);
    assert.equal(report(outcome).integrity, "corrupt");
    assert.ok(report(outcome).problems.some(problem => problem.includes("observed file exists but execution says unobserved")));
  });

  test("execution missing a required field is corrupt (M32)", () => {
    const execution = JSON.parse(fs.readFileSync(path.join(base, "zcode-execution.json"), "utf8"));
    delete execution.started_at;
    const dir = copyArchive(base, "f2i-m32", { edits: { "zcode-execution.json": Buffer.from(JSON.stringify(execution, null, 2) + "\n") } });
    const outcome = verifyCli(dir);
    assert.equal(outcome.status, 2);
    assert.equal(report(outcome).integrity, "corrupt");
    assert.ok(report(outcome).problems.some(problem => problem.includes("started_at missing")));
  });

  test("a record-manifest symlink pointing inside the run directory is corrupt (M12b)", () => {
    const dir = copyArchive(base, "f2i-m12b");
    // 目录内符号链接：真清单改名收存，链接指回它。lstat 拒链接本身。
    fs.renameSync(path.join(dir, "record-manifest.json"), path.join(dir, "record-manifest.real.json"));
    fs.symlinkSync("record-manifest.real.json", path.join(dir, "record-manifest.json"));
    const outcome = verifyCli(dir);
    assert.equal(outcome.status, 2);
    assert.equal(report(outcome).integrity, "corrupt");
    assert.ok(report(outcome).problems.some(problem => problem.includes("record-manifest.json is not a regular file")));
  });
});

describe("run-level regression locks (F2: M27, M28, M33)", () => {
  test("a tampered MMX prompt loses binding and does not vote (M27)", () => {
    const out = path.join(root, "f2-tamper-prompt");
    const result = runCli(["run", "--backend", "fixture", "--scenario", "mmx-tamper-prompt", "--packet", packetFile, "--out", out]);
    assert.equal(result.status, 2);
    const record = JSON.parse(result.stdout);
    const mmx = record.providers.mmx;
    assert.equal(mmx.eligible, false);
    assert.match(mmx.reason, /^binding:/);
    assert.equal(mmx.material_bound, false);
    assert.equal(record.providers.zcode.eligible, true);
    assert.equal(record.round_status, "NOT_EVALUATED");
  });

  test("cleanup_confirmed=false never votes (M28)", () => {
    const out = path.join(root, "f2-cleanup-false");
    const result = runCli(["run", "--backend", "fixture", "--scenario", "zcode-cleanup-false", "--packet", packetFile, "--out", out]);
    assert.equal(result.status, 2);
    const record = JSON.parse(result.stdout);
    assert.equal(record.providers.zcode.eligible, false);
    assert.equal(record.providers.zcode.reason, "receipt:cleanup_failed");
    assert.equal(record.round_status, "NOT_EVALUATED");
  });

  test("a symlinked scenarios.json refuses to start with zero launches (M33)", () => {
    // 在 X 风格的副本树里构造：scenarios.json 换成指向目录内副本的符号链接。
    const tree = path.join(root, "f2-m33-tree");
    fs.mkdirSync(tree, { recursive: true });
    for (const skill of ["zcode", "mmx", "zcode-mmx-review"]) fs.cpSync(path.join(runner.SKILLS, skill), path.join(tree, skill), { recursive: true });
    const scenarios = path.join(tree, "zcode-mmx-review", "tests", "fixtures", "backends", "scenarios.json");
    fs.renameSync(scenarios, path.join(path.dirname(scenarios), "scenarios.real.json"));
    fs.symlinkSync("scenarios.real.json", scenarios);
    const out = path.join(root, "f2-m33-out");
    const result = spawnSync(process.execPath, [path.join(tree, "zcode-mmx-review", "scripts", "review-run.js"),
      "run", "--backend", "fixture", "--scenario", "both-pass", "--packet", packetFile, "--out", out],
      { encoding: "utf8", timeout: 60000, env: cleanEnv() });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /regular file|link/);
    assert.equal(fs.existsSync(out), false, "no run directory may be created");
  });
});
