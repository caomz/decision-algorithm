#!/usr/bin/env node
"use strict";

// 假 MMX wrapper（fixture 专用）。记录该次实际收到的 prompt 原字节，按场景输出
// 固定回执与退出码；绝不联网、绝不读写运行目录之外的路径。MMX 一侧不接收
// mode、IDs 或 system 文件，证据 ID 以实收 P 里的 IDs 分区为准。

const fs = require("node:fs");
const path = require("node:path");
const { validateReview } = require("../../../../zcode/scripts/review.js");

const argv = process.argv.slice(2);
const value = name => argv[argv.indexOf(name) + 1];
const runDir = process.env.REVIEW_RUN_DIR;
const scenario = process.env.REVIEW_SCENARIO;
const scenarios = require("./scenarios.json");

if (!runDir || !scenario || !Object.hasOwn(scenarios, scenario)) {
  process.stderr.write("fixture wrapper requires REVIEW_RUN_DIR and a known REVIEW_SCENARIO\n");
  process.exit(3);
}

const config = scenarios[scenario].mmx;
const promptBytes = fs.readFileSync(value("--prompt-file"));
const prompt = promptBytes.toString("utf8");

// buildPrompt 的固定分区：EVIDENCE_IDS\n[...]\nMATERIAL_JSON
const idsMatch = prompt.match(/^EVIDENCE_IDS\n(\[.*\])$/m);
const ids = idsMatch ? JSON.parse(idsMatch[1]) : [];

function reviewText(kind) {
  const summary = "Checked: correctness, boundaries; Not checkable: upstream receipt.";
  const finding = { kind: "confirmed_defect", severity: "P1", title: "fixture defect", evidence_refs: [ids[0]], condition: "c", impact: "i", recommendation: "r" };
  if (kind === "p1-defect") return JSON.stringify({ version: 1, summary, findings: [finding] });
  if (kind === "p1-gap") return JSON.stringify({ version: 1, summary, findings: [{ ...finding, kind: "evidence_gap", evidence_refs: [] }] });
  return JSON.stringify({ version: 1, summary, findings: [] });
}

function buildReceipt() {
  const receipt = JSON.parse(JSON.stringify(config.receipt));
  if (typeof receipt.text === "string" && receipt.text.startsWith("@auto:")) receipt.text = reviewText(receipt.text.slice(6));
  // MMX 回执本身不携带 review_gate（那不是 mmx-chat.js 的字段）；这里只在内部
  // 校验 text 可解析，保证场景回执是入口 evaluateSide 可判定的输入。
  if (receipt.status === "ok") validateReview(receipt.text, ids);
  return receipt;
}

function writeObserved() {
  const observed = {
    side: "mmx",
    argv,
    env_keys: Object.keys(process.env).sort(),
    prompt_file_b64: promptBytes.toString("base64"),
  };
  fs.writeFileSync(path.join(runDir, "mmx-observed-input.json"), JSON.stringify(observed, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

if (config.behavior === "hang") {
  // 信号处理器必须先于 observed 安装：取消用例在 observed 文件出现的瞬间就会发
  // 信号；若处理器尚未就位，默认行为会立即杀死 wrapper，取消语义失去确定性。
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
  writeObserved();
  setInterval(() => {}, 1000);
} else if (config.behavior === "slow-exit") {
  // 取消竞态用：先挂好延迟退出的信号处理器，再写 observed 与回执并挂起；收到
  // SIGTERM 后延迟 exitMs 才退出。处理器先于 observed 安装，理由同 hang。
  process.on("SIGTERM", () => setTimeout(() => process.exit(143), config.exitMs ?? 800));
  process.on("SIGINT", () => setTimeout(() => process.exit(130), config.exitMs ?? 800));
  writeObserved();
  process.stdout.write(JSON.stringify(buildReceipt()) + "\n");
  setInterval(() => {}, 1000);
} else if (config.behavior === "ignore-term") {
  // 信号升级用例：先挂好忽略 SIGTERM/SIGINT 的处理器再写 observed 与回执，然后
  // 挂起（SIGKILL 不可挡）。处理器先于 observed 安装，理由同 hang。
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  writeObserved();
  process.stdout.write(JSON.stringify(buildReceipt()) + "\n");
  setInterval(() => {}, 1000);
} else if (config.behavior === "tamper-prompt") {
  // 材料绑定反例：把实收 P 加一个空格后写入 observed，检验入口的 MMX 侧绑定校验。
  const observed = {
    side: "mmx",
    argv,
    env_keys: Object.keys(process.env).sort(),
    prompt_file_b64: Buffer.concat([promptBytes, Buffer.from(" ")]).toString("base64"),
  };
  fs.writeFileSync(path.join(runDir, "mmx-observed-input.json"), JSON.stringify(observed, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const receipt = buildReceipt();
  process.stdout.write(JSON.stringify(receipt) + "\n");
  process.exitCode = config.exit;
} else {
  if (config.behavior !== "no-observed") writeObserved();
  const receipt = buildReceipt();
  process.stdout.write(JSON.stringify(receipt) + "\n");
  process.exitCode = config.exit;
}
