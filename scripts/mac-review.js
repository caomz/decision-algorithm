#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const runner = path.resolve(__dirname, "../skills/zcode-mmx-review/scripts/review-run.js");
const { LIMITS, planRealReview, validateMaxShards, verifyReviewArchive } = require(runner);
const { MAX_SHARDS, MAX_MATERIAL_BYTES } = require("../skills/zcode-mmx-review/scripts/shard-coverage.js");
const { createRealBackend } = require("../skills/zcode-mmx-review/scripts/real-round.js");

const usage = `Mac 双模型交叉验证

  mac-review.js [--max-shards N] [--max-tokens N] [--timeout-seconds N] [--mmx-bin-dir DIR] [--results-dir DIR] FILE
  mac-review.js --dry-run [--max-shards N] FILE            只读计算完整审核所需片数和请求数
  TXT/Markdown 可加 --shard-local，只审核各片内部，不判定全文一致性。
  mac-review.js --verify RUN              离线核验已有审核归档
  mac-review.js --help                    显示用法

双击 Mac交叉验证.command 可在 Finder 选择文件。默认每方最多 1 片，长材料可显式设定 1..32 片。
默认保存到 ~/Library/Application Support/Decision Algorithm/Reviews。
真实审核退出码为 PASS=0、FAIL=1、未完成或归档异常=2。`;

function parseArgs(args) {
  let mode = "run", positionalOnly = false, file, resultsDir, maxShards, mmxBinDir, shardLocal = false;
  const budget = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positionalOnly && arg === "--") positionalOnly = true;
    else if (!positionalOnly && ["--dry-run", "--verify", "--help", "-h"].includes(arg)) {
      if (mode !== "run") throw new Error("请一次只指定一个操作。");
      mode = arg === "-h" ? "help" : arg.slice(2);
    } else if (!positionalOnly && arg === "--shard-local") {
      if (shardLocal) throw new Error("--shard-local 重复。");
      shardLocal = true;
    } else if (!positionalOnly && arg === "--max-shards") {
      const value = args[++i];
      if (maxShards !== undefined || !/^\d+$/.test(value || "")) throw new Error("--max-shards 需要一个正整数。");
      maxShards = validateMaxShards(Number(value));
    } else if (!positionalOnly && ["--max-tokens", "--timeout-seconds"].includes(arg)) {
      const value = Number(args[++i]);
      const limit = arg === "--max-tokens" ? LIMITS.defaultMaxTokens : LIMITS.timeoutMax;
      if (budget.has(arg) || !Number.isSafeInteger(value) || value < 1 || value > limit) throw new Error(`${arg} 须在 1 至 ${limit} 之间。`);
      budget.set(arg, value);
    } else if (!positionalOnly && arg === "--results-dir") {
      const value = args[++i];
      if (!value || value.startsWith("--") || resultsDir) throw new Error("--results-dir 需要一个目录。");
      resultsDir = path.resolve(value);
    } else if (!positionalOnly && arg === "--mmx-bin-dir") {
      const value = args[++i];
      if (!value || value.startsWith("-") || mmxBinDir) throw new Error("--mmx-bin-dir 需要本轮使用的 npm CLI 目录。");
      mmxBinDir = path.resolve(value);
    } else {
      if (!positionalOnly && arg.startsWith("-")) throw new Error("未知选项 " + arg);
      if (file) throw new Error("请一次只选择一份审核材料。");
      file = path.resolve(arg);
    }
  }
  if (["dry-run", "verify"].includes(mode) && !file) throw new Error("请提供文件或归档目录。");
  if (mode === "help" && (file || resultsDir || maxShards || mmxBinDir || budget.size || shardLocal)) throw new Error("--help 无需其他参数。");
  if (mode === "verify" && (resultsDir || maxShards || mmxBinDir || budget.size || shardLocal)) throw new Error("--verify 只需已有归档目录。");
  return { mode, file, resultsDir, maxShards, mmxBinDir, shardLocal,
    maxTokens: budget.get("--max-tokens") ?? LIMITS.defaultMaxTokens,
    timeout: budget.get("--timeout-seconds") ?? LIMITS.defaultTimeout };
}

function chooseFile() {
  if (process.platform !== "darwin") throw new Error("请在命令行提供审核文件路径。");
  const prompt = 'POSIX path of (choose file with prompt "选择已脱敏的 TXT、Markdown 或审核包 JSON。小文件选定后将各向 ZCode 和 MMX 发一次请求；长文件会先显示片数并请你确认。")';
  const picker = spawnSync("/usr/bin/osascript", ["-e", prompt], { encoding: "utf8" });
  if (picker.error) throw picker.error;
  if (picker.status !== 0) {
    if (/\(-128\)/.test(picker.stderr || "")) return null;
    throw new Error("文件选择器未完成，请用终端传入文件路径。");
  }
  const selected = picker.stdout.replace(/\r?\n$/, "");
  if (!selected || !path.isAbsolute(selected)) throw new Error("文件选择器没有返回可用路径。");
  return selected;
}

function confirmDialog(message) {
  const question = `display dialog "${message}" buttons {"取消", "继续"} default button "取消" cancel button "取消"`;
  const response = spawnSync("/usr/bin/osascript", ["-e", question], { encoding: "utf8" });
  if (response.error) throw response.error;
  if (response.status === 0) return true;
  if (/\(-128\)/.test(response.stderr || "")) return false;
  throw new Error("无法确认本轮审核选项。");
}

function preparePacket(file, maxShards, shardLocal) {
  const ext = path.extname(file).toLowerCase();
  if (![".txt", ".md", ".json"].includes(ext)) throw new Error("支持 .txt、.md 和审核包 .json。");
  if (shardLocal && ext === ".json") throw new Error("JSON 审核包请在 goal.acceptance_scope 里指定 per_shard 或 whole_document。");
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("输入必须是普通文件。");
  if (stat.size > MAX_MATERIAL_BYTES) throw new Error("文件超过 512 KiB 的规划上限。");
  const raw = fs.readFileSync(file);
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new Error("请使用 UTF-8 编码的文件。"); }
  if (!source.trim() || source.includes("\0")) throw new Error("材料为空或包含无效的空字符。");
  const packet = ext === ".json" ? raw : Buffer.from(JSON.stringify({
    goal: shardLocal ? {
      request: "逐片检查每段可独立核实的局部错误。段间对应、唯一性和全文一致性不在本轮结论范围内。",
      acceptance: ["指出仅凭当前片段及随附目标即可核实的错误并引用相应证据。"],
      acceptance_scope: "per_shard",
    } : {
      request: "审核给定材料的准确性、内部一致性和论据是否支持结论。",
      acceptance: ["引用材料中的证据，区分可确认的缺陷、待补的证据和建议。"],
    },
    facts: [{ id: "DOC", text: source }],
  }) + "\n", "utf8");
  const plan = planRealReview(packet, maxShards);
  return { packet, bytes: plan.promptBytes, count: plan.shardCount, ids: plan.input.ids,
    scope: plan.input.packet.goal?.acceptance_scope ?? "whole_document" };
}

function runReview(input, out, { count, mmxBinDir, maxTokens, timeout }) {
  // Only the parent receives terminal signals. The runner manages the two
  // provider process groups and records their final status after cancellation.
  const args = [runner, "run", "--backend", "real", "--packet", input, "--out", out, "--max-shards", String(count),
    "--max-tokens", String(maxTokens), "--timeout-seconds", String(timeout)];
  if (mmxBinDir) args.push("--mmx-bin-dir", mmxBinDir);
  const child = spawn(process.execPath, args, {
    shell: false, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "inherit"],
  });
  const cancel = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, cancel);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(signal || ![0, 1, 2].includes(code) ? 2 : code));
  }).finally(() => { for (const signal of signals) process.removeListener(signal, cancel); });
}

// Model-provided text is data, including when displayed in Terminal.
function display(text) {
  return String(text ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

// Use only fixed, parsed categories from a receipt whose archive just replayed.
function quotaExplanation(runDir) {
  const receipt = JSON.parse(fs.readFileSync(path.join(runDir, "mmx-stdout.json"), "utf8"));
  switch (receipt.quota_cause) {
    case "plan_window_exhausted": return "MMX 套餐时段额度已耗尽。请在账户显示的重置时间后核对剩余额度。";
    case "rate_limit": return "MMX 触发请求频率或 Token 速率限制。";
    case "insufficient_balance_or_credit": return "MMX 报告余额或可用信用额度不足，请核对账户。";
    case "model_not_in_plan": return "当前 MMX 套餐不包含所请求的模型。";
    case "quota_exhausted": return "MMX 报告额度耗尽，需在账户中确认额度类型和重置时间。";
    case "billing_or_quota_unspecified": return "MMX 将可用额度和余额合并报告，请先核对套餐窗口及账户余额。";
    default: return "MMX 未提供可区分额度不足与限流的原因。可用同一账号的官方只读额度查询核对。";
  }
}

function report(out) {
  const verdict = verifyReviewArchive(out);
  const lines = [`归档目录 ${display(out)}`, `归档核验 ${verdict.integrity} / ${verdict.replay ?? "未复算"}`];
  if (verdict.exit_code !== 0) {
    if (verdict.replay === "version_drift") lines.push("文件完整性已核对。用记录中的原版本可复算审核结论。");
    for (const problem of [...(verdict.problems || []), ...(verdict.drifted || [])]) lines.push(display(problem));
  } else {
    const result = JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8"));
    lines.push(`审核轮次 ${result.round_status}　内容裁决 ${result.review_gate}`);
    if (result.sharded) lines.push(`验收范围 ${result.acceptance_scope ?? "whole_document"}　逐片覆盖 ${result.coverage.covered_shards}/${result.shard_count}`);
    const rounds = result.sharded ? result.shards : [result];
    for (const round of rounds) {
      if (result.sharded) lines.push("", `分片 ${display(round.id)}　${display(round.review_gate ?? round.gate ?? "NOT_EVALUATED")}`);
      for (const [key, label] of [["zcode", "ZCode"], ["mmx", "MMX"]]) {
        const side = round.providers?.[key];
        if (!side) { lines.push(`${label}　未取得有效回执`); continue; }
        lines.push("", `${label}　${display(side.model || "模型未知")}　${side.gate || "NOT_EVALUATED"}`);
        if (side.reason) lines.push(display(side.reason));
        if (!side.eligible && side.diagnostic?.receipt_status) lines.push("供应方回执 " + display(side.diagnostic.receipt_status));
        const details = side.diagnostic?.details;
        if (details) {
          lines.push(`退出码 wrapper=${details.wrapper_exit_code ?? "未知"}，CLI=${details.cli_exit_code ?? "未知"}`);
          if (Number.isFinite(details.request_timeout_seconds)) {
            lines.push(`生效时限 请求 ${details.request_timeout_seconds} 秒` +
              (details.wrapper_timeout_seconds ? `，wrapper ${details.wrapper_timeout_seconds} 秒` : ""));
          }
          if (Number.isSafeInteger(details.http_status)) {
            lines.push(`供应方 HTTP ${details.http_status}` +
              (Number.isSafeInteger(details.provider_error_code) ? `，错误码 ${details.provider_error_code}` : ""));
          }
          if (details.review_error) lines.push("回执协议 " + display(details.review_error));
        }
        if (key === "mmx" && side.diagnostic?.receipt_status === "quota_error") {
          const runDir = result.sharded ? path.join(out, "parts", round.id, "run") : out;
          lines.push(quotaExplanation(runDir));
        }
        if (side.review) {
          lines.push(display(side.review.summary));
          for (const finding of side.review.findings) {
            lines.push(`- [${finding.severity}] ${display(finding.title)}`, display(finding.recommendation));
          }
        }
      }
    }
    lines.push("", "完整回执及逐项发现见归档中的 result.json。");
  }
  return { text: lines.join("\n") + "\n", code: verdict.exit_code };
}

async function main() {
  const { mode, file, resultsDir, maxShards, mmxBinDir, maxTokens, timeout, shardLocal } = parseArgs(process.argv.slice(2));
  if (mode === "help") { console.log(usage); return 0; }
  if (mode === "verify") {
    const dir = fs.existsSync(path.join(file, "input.json")) && fs.existsSync(path.join(file, "run")) ? path.join(file, "run") : file;
    const verified = report(dir);
    process.stdout.write(verified.text);
    return verified.code;
  }
  const selected = file || chooseFile();
  if (!selected) { console.log("已取消。"); return 0; }
  const input = preparePacket(selected, maxShards ?? (file ? 1 : MAX_SHARDS), shardLocal);
  if (mode === "dry-run") {
    console.log(`预检通过　完整提示词 ${input.bytes} 字节　每片上限 ${LIMITS.realAttachmentMaxBytes} 字节　${input.count} 片，两侧合计最多 ${input.count * 2} 次模型请求　每次输出预算 ${maxTokens} tokens，时限 ${timeout} 秒　证据 ID ${input.ids.join(", ")}`);
    if (input.count > 1) console.log(`验收范围 ${input.scope}。只有明确逐片可验的条件才能合成内容 PASS。`);
    return 0;
  }
  if (!file && input.count > 1 && !confirmDialog(`材料需要 ${input.count} 片，两侧合计最多 ${input.count * 2} 次模型请求。`)) {
    console.log("已取消。"); return 0;
  }
  let selectedMmx = mmxBinDir;
  const preflight = dir => createRealBackend({ envBase: { PATH: process.env.PATH }, timeoutSeconds: timeout, mmxBinDir: dir });
  try {
    preflight(selectedMmx);
  } catch (error) {
    if (error.side !== "mmx" || selectedMmx || file) throw error;
    const npmBin = path.join(os.homedir(), ".npm-global", "bin");
    preflight(npmBin);
    if (!confirmDialog("默认 MMX 启动器无法验证单次请求上限。本轮是否直接使用已校验的 npm MMX？自定义启动脚本的代理设置可能不同。")) {
      console.log("已取消。"); return 0;
    }
    selectedMmx = npmBin;
  }
  const root = resultsDir || path.join(os.homedir(), "Library", "Application Support", "Decision Algorithm", "Reviews");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const job = fs.mkdtempSync(path.join(root, stamp + "-"));
  const packet = path.join(job, "input.json");
  const out = path.join(job, "run");
  fs.writeFileSync(packet, input.packet, { flag: "wx", mode: 0o600 });
  console.log(`正在审核。结果目录 ${display(job)}`);
  const code = await runReview(packet, out, { count: input.count, mmxBinDir: selectedMmx, maxTokens, timeout });
  const summary = report(out);
  const summaryFile = path.join(job, "审核摘要.txt");
  fs.writeFileSync(summaryFile, summary.text, { flag: "wx", mode: 0o600 });
  process.stdout.write(summary.text);
  console.log("文字摘要 " + display(summaryFile));
  if (!file) {
    const reveal = spawnSync("/usr/bin/open", ["-R", summaryFile], { stdio: "ignore" });
    if (reveal.error || reveal.status !== 0) console.error("Finder 无法显示文件，可从上面的文字摘要路径打开。");
  }
  return summary.code === 0 ? code : 2;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("交叉验证未完成。", display(error.message));
  process.exitCode = 2;
});
