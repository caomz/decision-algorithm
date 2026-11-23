#!/usr/bin/env node
"use strict";

// 假 ZCode wrapper（fixture 专用）。记录该次实际收到的内容，按场景输出固定
// 回执与退出码；绝不联网、绝不读写运行目录之外的路径。真实调用的组装结果
// 由 review-run.js 的 assembleInputs 提供，本文件只被动接收。

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

const config = scenarios[scenario].zcode;
const materialBytes = fs.readFileSync(value("--prompt-file"));
const idsBytes = fs.readFileSync(value("--evidence-ids-file"));
const ids = JSON.parse(idsBytes.toString("utf8"));

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
  if (receipt.review_gate === "@auto" || receipt.review === undefined) {
    const checked = validateReview(receipt.text, ids);
    receipt.review_gate = checked.review_gate;
    receipt.review = checked.review;
  }
  return receipt;
}

function writeObserved(materialB64) {
  const observed = {
    side: "zcode",
    argv,
    env_keys: Object.keys(process.env).sort(),
    prompt_file_b64: materialB64,
    evidence_ids_file_b64: idsBytes.toString("base64"),
  };
  fs.writeFileSync(path.join(runDir, "zcode-observed-input.json"), JSON.stringify(observed, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

if (config.behavior === "hang") {
  writeObserved(materialBytes.toString("base64"));
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
  setInterval(() => {}, 1000);
} else if (config.behavior === "slow-exit") {
  // 取消竞态用：先写完 observed 与回执再挂起；收到 SIGTERM 后延迟 exitMs 才退出，
  // 用于确定性复现"取消信号已到、进程退出晚于父层截止"的窗口。
  writeObserved(materialBytes.toString("base64"));
  process.stdout.write(JSON.stringify(buildReceipt()) + "\n");
  process.on("SIGTERM", () => setTimeout(() => process.exit(143), config.exitMs ?? 800));
  process.on("SIGINT", () => setTimeout(() => process.exit(130), config.exitMs ?? 800));
  setInterval(() => {}, 1000);
} else {
  if (config.behavior === "bad-observed") {
    // 写出非法 JSON 的 observed：检验 run 侧"文件存在即捕获、坏内容降级拒票"
    // 与 verify 的同降级重放保持一致（不再记 unobserved 造成自相矛盾档案）。
    fs.writeFileSync(path.join(runDir, "zcode-observed-input.json"), "not-json{", { mode: 0o600, flag: "wx" });
  } else if (config.behavior === "null-observed") {
    // 合法 JSON 但根是 falsey 值：同样必须记 sha 而不是 unobserved。
    fs.writeFileSync(path.join(runDir, "zcode-observed-input.json"), "null", { mode: 0o600, flag: "wx" });
  } else if (config.behavior !== "no-observed") {
    // tamper-material：把实收 material 换一个字节后写入 observed，模拟上游材料偏移，
    // 用于检验入口的材料绑定校验能够发现不一致（"facts" 的 a 改成 A）。
    let bytes = materialBytes;
    if (config.behavior === "tamper-material") {
      bytes = Buffer.from(materialBytes);
      const at = bytes.indexOf(Buffer.from("facts"));
      bytes[at + 1] = 0x41;
    }
    writeObserved(bytes.toString("base64"));
  }
  const receipt = buildReceipt();
  process.stdout.write(JSON.stringify(receipt) + "\n");
  process.exitCode = config.exit;
}
