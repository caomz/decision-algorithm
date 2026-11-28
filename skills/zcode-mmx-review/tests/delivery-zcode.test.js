"use strict";

// ZCode 投递验收：调用真实 zcode-chat.js（driver 子进程执行 main()），用
// --cli-path 指向已核对的假原生 CLI，验证 P 在 24576/24577 字节两条路径上的
// 投递一致性。不删文件；产物都在 mkdtemp(os.tmpdir()) 下。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const runner = require("../scripts/review-run.js");
const { cleanEnv, fixtureCliEnv } = require("./support/env.js");
const wrapperSource = fs.readFileSync(path.join(__dirname, "../../zcode/scripts/zcode-chat.js"), "utf8");
const zcodeChat = path.resolve(__dirname, "../../zcode/scripts/zcode-chat.js");
const fakeCli = path.join(__dirname, "fixtures/native/fake-zcode-cli.cjs");
const ATTACHED_PROMPT = "The attached file contains the complete request material. Review it exactly as instructed below and answer from it only.";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-delivery-z-"));

// 构造恰好 target 字节的 P：前缀含多字节字符与转义字符，剩余用单字节字符补齐。
function materialReaching(targetBytes) {
  const base = "中🌟 \"quoted\" \\ backslash \n\ttab 多字节与转义";
  const ids = ["F1"];
  const { buildPrompt } = require("../../zcode/scripts/review.js");
  const packetOf = text => ({ facts: [{ id: "F1", text }] });
  const materialOf = packet => runner.materialFrom(packet);
  const length0 = Buffer.byteLength(buildPrompt(materialOf(packetOf(base)), "review", ids), "utf8");
  const length1 = Buffer.byteLength(buildPrompt(materialOf(packetOf(base + "a")), "review", ids), "utf8");
  const per = length1 - length0;
  const need = targetBytes - length0;
  assert.ok(need >= 0 && need % per === 0, `cannot reach ${targetBytes} exactly (per=${per}, need=${need})`);
  return materialOf(packetOf(base + "a".repeat(need)));
}

function runDelivery(material, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  const materialPath = path.join(directory, "material.txt");
  const idsPath = path.join(directory, "evidence-ids.json");
  const dumpPath = path.join(directory, "cli-dump.jsonl");
  const driver = path.join(directory, "driver.cjs");
  fs.writeFileSync(materialPath, material);
  fs.writeFileSync(idsPath, '["F1"]\n');
  fs.writeFileSync(driver, `require(${JSON.stringify(zcodeChat)}).main(process.argv.slice(2), {setupMacKeychain:()=>null}).then(r=>{process.stdout.write(JSON.stringify(r)+"\\n");process.exitCode=["ok","usage","version"].includes(r.status)?0:1;});\n`);
  const args = [driver, "--prompt-file", materialPath, "--mode", "review", "--evidence-ids-file", idsPath, "--cli-path", fakeCli, "--timeout-seconds", "60"];
  const outputDir = path.join(directory, "artifacts");
  args.push("--output-dir", outputDir);
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    env: cleanEnv({ FAKE_CLI_DUMP: dumpPath, ...fixtureCliEnv(fakeCli) }),
  });
  assert.equal(result.stderr, "", result.stderr);
  const receipt = JSON.parse(result.stdout);
  // version 探测经 env 单独计数；chat 记录由假 CLI 落在 work 目录（隔离环境里
  // 自定义环境变量不可见，cwd 是唯一可靠通道）。
  const versionLines = fs.existsSync(dumpPath) ? fs.readFileSync(dumpPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const chatDump = path.join(outputDir, "work", "fake-cli-dump.jsonl");
  const chatLines = fs.existsSync(chatDump) ? fs.readFileSync(chatDump, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  return { receipt, versionLines, chatLines, outputDir, directory };
}

// 取证断言：同一条断言判定缺附件、多附件与正常两条路径。
function assertDelivery(record, P) {
  const argv = record.argv;
  const promptIndex = argv.indexOf("--prompt");
  const attachCount = argv.filter(item => item === "--attach").length;
  if (Buffer.byteLength(P, "utf8") <= 24576) {
    assert.equal(argv[promptIndex + 1], P, "small P must travel on argv verbatim");
    assert.equal(attachCount, 0, "small P must not attach a file");
  } else {
    assert.equal(argv[promptIndex + 1], ATTACHED_PROMPT, "large P must replace argv with the fixed sentence");
    assert.equal(attachCount, 1, `large P must attach exactly one file, got ${attachCount}`);
    assert.equal(record.attach_contents_b64.length, 1);
    assert.equal(Buffer.from(record.attach_contents_b64[0], "base64").toString("utf8"), P, "attached bytes must equal P");
  }
}

// Move this pin only after the delivery tests below pass against the new wrapper.
// 1.5.1 changed the supervisor status check and the manifest re-pin, not delivery.
test("the wrapper advertises the version this delivery contract was written for", () => {
  assert.match(wrapperSource, /VERSION = "1\.5\.1"/);
});

test("P of exactly 24576 bytes stays on argv", () => {
  const material = materialReaching(24576);
  const { receipt, versionLines, chatLines } = runDelivery(material, "exact-24576");
  assert.equal(receipt.status, "ok", JSON.stringify(receipt));
  assert.equal(receipt.review_gate, "PASS");
  assert.equal(versionLines.length, 1, "the --version probe must be counted separately");
  assert.ok(versionLines[0].argv.includes("--version"));
  assert.equal(chatLines.length, 1);
  const P = require("../../zcode/scripts/review.js").buildPrompt(material, "review", ["F1"]);
  assert.equal(Buffer.byteLength(P, "utf8"), 24576);
  assertDelivery(chatLines[0], P);
});

test("P of exactly 24577 bytes travels as the single attachment", () => {
  const material = materialReaching(24577);
  const { receipt, chatLines } = runDelivery(material, "exact-24577");
  assert.equal(receipt.status, "ok", JSON.stringify(receipt));
  assert.equal(chatLines.length, 1);
  const P = require("../../zcode/scripts/review.js").buildPrompt(material, "review", ["F1"]);
  assert.equal(Buffer.byteLength(P, "utf8"), 24577);
  assertDelivery(chatLines[0], P);
});

test("a missing attachment fails the same forensic assertion", () => {
  const P = "x".repeat(24577);
  const record = { argv: ["--prompt", ATTACHED_PROMPT, "--cwd", "/w"], attach_contents_b64: [], prompt: ATTACHED_PROMPT };
  assert.throws(() => assertDelivery(record, P), /exactly one file/);
});

test("multiple attachments fail the same forensic assertion", () => {
  const P = "x".repeat(24577);
  const b64 = Buffer.from(P).toString("base64");
  const record = { argv: ["--prompt", ATTACHED_PROMPT, "--attach", "/a", "--attach", "/b"], attach_contents_b64: [b64, b64], prompt: ATTACHED_PROMPT };
  assert.throws(() => assertDelivery(record, P), /exactly one file/);
});

test("artifacts land in the requested --output-dir", () => {
  const { receipt, outputDir } = runDelivery(runner.materialFrom({ facts: [{ id: "F1", text: "short delivery check" }] }), "output-dir");
  assert.equal(receipt.status, "ok");
  assert.ok(fs.existsSync(path.join(outputDir, "receipt.json")));
  assert.ok(fs.existsSync(path.join(outputDir, "prompt.txt")));
});

test("material with multibyte and escape characters survives delivery byte for byte", () => {
  const text = "转义检查 \\ \" \n\t emoji 🌟 中文内容 ending";
  const material = runner.materialFrom({ facts: [{ id: "F1", text }] });
  const { receipt, chatLines } = runDelivery(material, "multibyte");
  assert.equal(receipt.status, "ok");
  assert.equal(chatLines.length, 1);
  const P = require("../../zcode/scripts/review.js").buildPrompt(material, "review", ["F1"]);
  assertDelivery(chatLines[0], P);
});
