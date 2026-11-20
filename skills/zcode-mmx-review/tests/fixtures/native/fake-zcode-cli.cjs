"use strict";

// 假 ZCode 原生 CLI（fixture 专用，供 delivery-zcode 投递验收以 --cli-path 指定）。
// --version 调用单独计数；chat 调用把 process.argv 与每个 --attach 指向文件的
// 原字节转储到 FAKE_CLI_DUMP，并输出能通过 EventParser 的事件流。绝不联网。

const fs = require("node:fs");
const path = require("node:path");

exports.run = function run() {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    // version 探测继承完整环境（zcode-chat.js 的 isolatedEnv 只过滤 chat 调用），
    // 所以这条调用经 FAKE_CLI_DUMP 单独计数。
    if (process.env.FAKE_CLI_DUMP) fs.appendFileSync(process.env.FAKE_CLI_DUMP, JSON.stringify({ kind: "version", argv: args }) + "\n");
    process.stdout.write("0.17.1\n");
    return;
  }

  const value = name => args[args.indexOf(name) + 1];
  const prompt = value("--prompt");
  const work = value("--cwd");
  const home = process.env.HOME;
  const attachPaths = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--attach") attachPaths.push(args[i + 1]);
  const attachContents = attachPaths.map(file => fs.readFileSync(file));

  // chat 调用运行在隔离环境里，自定义环境变量不可见；cwd 是 wrapper 建的
  // work 目录，把取证记录落在那里。
  const dumpFile = path.join(process.cwd(), "fake-cli-dump.jsonl");
  fs.appendFileSync(dumpFile, JSON.stringify({
    kind: "chat",
    argv: args,
    prompt,
    attach_paths: attachPaths,
    attach_contents_b64: attachContents.map(bytes => bytes.toString("base64")),
  }) + "\n");

  // 与 zcode-chat.test.js 的 fake-zcode.cjs 相同的隔离自检。
  const config = JSON.parse(fs.readFileSync(path.join(home, ".zcode/cli/config.json"), "utf8"));
  const denied = value("--disallowed-tools").split(",");
  const isolated = ["plan", "guarded"].includes(value("--mode")) && value("--workflow-mode") === "disabled" &&
    value("--toolsearch-mode") === "off" && value("--output-format") === "stream-json" &&
    work !== home && path.dirname(work) === path.dirname(home) &&
    process.cwd() === fs.realpathSync(work) &&
    !process.env.ZCODE_MODEL && !process.env.FAKE_UNTRUSTED && !process.env.NODE_OPTIONS &&
    config.features.mcp === false && config.features.memory === false && config.features.subagent === false &&
    config.features.skill === false && config.plugins.enabled === false && config.hooks.enabled === false &&
    config.memory.use === false && config.skills.enabled === false && config.skills.includeInstructions === false &&
    ["Bash", "Read", "Write", "Edit", "Agent", "Task", "Skill", "js", "CreateSession", "CreateWorkflow", "ToolSearch", "SendMessage"].every(name => denied.includes(name));
  if (!isolated) { process.stderr.write("isolation failed"); process.exitCode = 8; return; }

  const id = { sessionId: "sess_fake", turnId: "turn_fake", traceId: "trace_fake" };
  const emit = (type, payload = {}) => JSON.stringify({ ...id, type, payload }) + "\n";
  const review = { version: 1, summary: "Checked: isolation, delivery; Not checkable: upstream model.", findings: [] };
  // 走附件路径时 prompt 只剩固定短句，审核指令在附件里。
  const sawReviewMaterial = prompt.includes("REVIEW_SCHEMA\n") || attachContents.some(bytes => bytes.includes(Buffer.from("REVIEW_SCHEMA\n")));
  const text = sawReviewMaterial ? JSON.stringify(review) : "ok";
  let output = "";
  output += emit("session.updated", { messageCount: 3, iteration: 1, providerId: "fake-provider", modelId: "GLM-test", toolCount: 0 });
  output += emit("session.updated", { querySource: "main_turn", stopReason: "stop", toolCallCount: 0 });
  output += emit("turn.completed", { response: text, resultType: "success", toolCallCount: 0 });
  output += JSON.stringify({ ...id, type: "result", response: text, projection: { status: "idle" }, usage: { inputTokens: 12, outputTokens: 4 } }) + "\n";
  process.stdout.write(output);
};

if (require.main === module) exports.run();
