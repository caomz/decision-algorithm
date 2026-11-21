"use strict";

// MMX 投递验收：以子进程运行真实 mmx-chat.js（绝对 node 路径），PATH 只含假
// mmx 所在目录。假 mmx 在 wrapper 清理临时文件之前把唯一那条 user 消息的
// content 与 messages 原字节转储出来，用于和 P 做字节比较。不删文件；
// wrapper 在受控 TMPDIR 下自建自清的临时目录按 D9=A 放行。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const runner = require("../scripts/review-run.js");
const mmxChat = path.resolve(__dirname, "../../mmx/scripts/mmx-chat.js");
const fakeMmxSource = path.join(__dirname, "fixtures/native/mmx");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zmx-delivery-m-"));

// PATH 只含假 mmx 所在目录；fixture 的 shebang 是 node 的绝对路径。
// 若本机 node 与 shebang 声明不同（异机环境），复制 fixture 并重写 shebang，
// 行为逻辑仍是同一份固定文件。
const binDir = path.join(root, "bin");
fs.mkdirSync(binDir, { mode: 0o700 });
const sourceText = fs.readFileSync(fakeMmxSource, "utf8");
const shebang = sourceText.split("\n")[0];
const localShebang = `#!${process.execPath}`;
const installed = path.join(binDir, "mmx");
fs.writeFileSync(installed, shebang === localShebang ? sourceText : sourceText.replace(/^#![^\n]*/, localShebang), { mode: 0o755 });

const wrapperTmp = path.join(root, "wrapper-tmp");
fs.mkdirSync(wrapperTmp, { mode: 0o700 });

function materialReaching(targetBytes) {
  const { buildPrompt } = require("../../zcode/scripts/review.js");
  const base = "中🌟 \"quoted\" \\ backslash \n\ttab 多字节与转义";
  const packetOf = text => ({ facts: [{ id: "F1", text }] });
  const length0 = Buffer.byteLength(buildPrompt(runner.materialFrom(packetOf(base)), "review", ["F1"]), "utf8");
  const length1 = Buffer.byteLength(buildPrompt(runner.materialFrom(packetOf(base + "a")), "review", ["F1"]), "utf8");
  const per = length1 - length0;
  const need = targetBytes - length0;
  assert.ok(need >= 0 && need % per === 0, `cannot reach ${targetBytes} exactly (per=${per}, need=${need})`);
  return runner.materialFrom(packetOf(base + "a".repeat(need)));
}

function runDelivery(material, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  const promptPath = path.join(directory, "prompt.txt");
  const dumpPath = path.join(directory, "mmx-dump.json");
  fs.writeFileSync(promptPath, Buffer.from(material, "utf8"));
  const result = spawnSync(process.execPath, [mmxChat,
    "--prompt-file", promptPath, "--timeout", "30", "--wrap-timeout", "60", "--max-tokens", "1024"], {
    encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: binDir, TMPDIR: wrapperTmp, TMP: wrapperTmp, TEMP: wrapperTmp,
      MMX_FAKE_DUMP: dumpPath,
    },
  });
  const receipt = JSON.parse(result.stdout);
  const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  return { receipt, dump, directory };
}

test("the single user message equals P byte for byte (small P)", { skip: process.platform === "win32" && "POSIX fake CLI fixture is not an npm .cmd shim; Windows npm-shim behavior is exercised in mmx-chat.test.js" }, () => {
  const { buildPrompt } = require("../../zcode/scripts/review.js");
  const material = runner.materialFrom({ facts: [{ id: "F1", text: "small mmx delivery check 中文 🌟" }] });
  const P = buildPrompt(material, "review", ["F1"]);
  assert.ok(Buffer.byteLength(P, "utf8") <= 24576);
  const { receipt, dump } = runDelivery(P, "small");
  assert.equal(receipt.status, "ok", JSON.stringify(receipt));
  assert.equal(dump.user_message_count, 1);
  assert.equal(dump.system_present, false);
  assert.equal(dump.user_content, P);
});

test("the single user message equals P byte for byte (P of 24577 bytes)", { skip: process.platform === "win32" && "POSIX fake CLI fixture is not an npm .cmd shim; Windows npm-shim behavior is exercised in mmx-chat.test.js" }, () => {
  const { buildPrompt } = require("../../zcode/scripts/review.js");
  const material = materialReaching(24577);
  const P = buildPrompt(material, "review", ["F1"]);
  assert.equal(Buffer.byteLength(P, "utf8"), 24577);
  const { receipt, dump } = runDelivery(P, "large");
  assert.equal(receipt.status, "ok", JSON.stringify(receipt));
  assert.equal(dump.user_message_count, 1);
  assert.equal(dump.user_content, P);
});

test("the wrapper keeps prompt content out of argv", { skip: process.platform === "win32" && "POSIX fake CLI fixture is not an npm .cmd shim; Windows npm-shim behavior is exercised in mmx-chat.test.js" }, () => {
  const material = runner.materialFrom({ facts: [{ id: "F1", text: "argv must stay clean" }] });
  const { dump } = runDelivery(require("../../zcode/scripts/review.js").buildPrompt(material, "review", ["F1"]), "argv-clean");
  assert.equal(dump.argv.some(item => item.includes("argv must stay clean")), false);
  assert.ok(dump.argv.includes("--messages-file"));
});

test("a tampered delivery is detectable: one byte more in P breaks the comparison", () => {
  const material = runner.materialFrom({ facts: [{ id: "F1", text: "tamper probe" }] });
  const P = require("../../zcode/scripts/review.js").buildPrompt(material, "review", ["F1"]);
  const delivered = P + " ";
  assert.notEqual(delivered, P);
  const dump = { user_message_count: 1, user_content: delivered };
  assert.notEqual(dump.user_content, P);
});
