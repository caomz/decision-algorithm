"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

exports.run = scenario => {
  const args = process.argv.slice(2);
  if (args.includes("--version")) {
    if (scenario === "version") { process.stdout.write("9.9.9\n"); return; }
    // zcode-app-cli 3.x prints the runtime version on its own second line.
    if (scenario === "runtime_version_bad") { process.stdout.write("zcode-app-cli 3.18.1-46\nzcode-runtime 9.9.9\n"); return; }
    if (scenario === "runtime_version_ok") { process.stdout.write("zcode-app-cli 3.18.1-46\nzcode-runtime 0.17.1\n"); return; }
    process.stdout.write("0.17.1\n");
    return;
  }
  const value = name => args[args.indexOf(name) + 1];
  const argvPrompt = value("--prompt");
  const attachmentPath = args.includes("--attach") ? value("--attach") : null;
  const work = value("--cwd");
  let prompt = argvPrompt;
  let attachedBytes = null;
  if (attachmentPath) {
    try {
      if (scenario === "attachment_missing") fs.rmSync(attachmentPath);
      attachedBytes = fs.readFileSync(attachmentPath);
      prompt = new TextDecoder("utf-8", { fatal: true }).decode(attachedBytes);
    } catch {
      process.stderr.write("synthetic attachment read failure");
      process.exitCode = 9;
      return;
    }
  }
  const home = process.env.HOME;
  const config = JSON.parse(fs.readFileSync(path.join(home, ".zcode/cli/config.json"), "utf8"));
  const denied = value("--disallowed-tools").split(",");
  const isolated = ["plan", "guarded"].includes(value("--mode")) && value("--workflow-mode") === "disabled" &&
    value("--toolsearch-mode") === "off" && value("--output-format") === "stream-json" &&
    work !== home && path.dirname(work) === path.dirname(home) &&
    // process.cwd() is always the resolved physical path; compare through realpath so
    // symlinked temp roots (macOS /var/folders -> /private/var/folders) do not fail isolation.
    process.cwd() === fs.realpathSync(work) &&
    !process.env.ZCODE_MODEL && !process.env.FAKE_UNTRUSTED && !process.env.NODE_OPTIONS &&
    config.features.mcp === false && config.features.memory === false && config.features.subagent === false &&
    config.features.skill === false && config.plugins.enabled === false && config.hooks.enabled === false &&
    config.memory.use === false && config.skills.enabled === false &&
    ["Bash", "Read", "Write", "Edit", "Agent", "Task", "Skill", "js", "CreateSession", "CreateWorkflow", "ToolSearch", "SendMessage"].every(name => denied.includes(name));
  if (!isolated) { process.stderr.write("isolation failed"); process.exitCode = 8; return; }
  const marker = prompt.match(/MAC08_SENTINEL_[A-Za-z0-9_]+/)?.[0] ?? null;
  const observed = {
    attached: Boolean(attachmentPath),
    attachment_bytes: attachedBytes?.length ?? null,
    attachment_sha256: attachedBytes ? createHash("sha256").update(attachedBytes).digest("hex") : null,
    argv_contains_sentinel: Boolean(marker && args.some(arg => arg.includes(marker))),
    env_contains_sentinel: Boolean(marker && Object.values(process.env).some(value => value.includes(marker))),
    argv_prompt_bytes: Buffer.byteLength(argvPrompt ?? "", "utf8"),
    mode: value("--mode"),
    denied_tools: denied,
  };
  fs.writeFileSync(path.join(path.dirname(work), "attachment-observed.json"), JSON.stringify(observed), { flag: "wx", mode: 0o600 });
  if (scenario === "kill_wrapper") { process.kill(process.ppid, "SIGKILL"); return; }
  if (scenario === "hang" || scenario === "tree") {
    if (scenario === "tree") {
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: "ignore" });
      fs.writeFileSync(path.join(path.dirname(work), "child.pid"), String(child.pid));
    }
    setInterval(() => {}, 1000); return;
  }
  if (scenario === "stderr") { process.stderr.write("Bearer synthetic-private-value"); process.exitCode = 1; return; }
  if (scenario === "badjson") { process.stdout.write("unexpected stdout\n"); return; }
  const id = { sessionId: "sess_fake", turnId: "turn_fake", traceId: "trace_fake" };
  const emit = (type, payload = {}) => JSON.stringify({ ...id, type, payload }) + "\n";
  const review = { version: 1, summary: "Reviewed supplied evidence.", findings: [] };
  let text = prompt.includes("REVIEW_SCHEMA\n") ? JSON.stringify(review) : JSON.parse(prompt.split("\n").at(-1)).request;
  if (scenario === "review_bad") text = "not a review";
  if (scenario === "large") text = "中文🌟".repeat(80000);
  let output = "";
  if (scenario !== "missing_model") output += emit("session.updated", { messageCount: 3, iteration: 1, providerId: "fake-provider", modelId: "GLM-test", toolCount: scenario === "exposed_tools" ? 1 : 0 });
  if (scenario === "network_events") {
    output += emit("session.updated", { providerId: "fake-provider", modelId: "GLM-test", querySource: "main_turn", type: "request_start", requestHeaderCount: 0 });
    output += emit("session.updated", { providerId: "fake-provider", modelId: "GLM-test", querySource: "main_turn", type: "response_headers", responseHeaderCount: 0 });
  }
  if (scenario === "tool") output += emit("tool.updated", { kind: "started", toolName: "Bash" });
  if (scenario === "permission") output += emit("permission.requested", {});
  if (scenario === "auth") output += emit("turn.failed", { error: { code: 401 } });
  if (scenario === "quota") output += emit("turn.failed", { error: { code: 429 } });
  if (scenario !== "missing_stop") output += emit("session.updated", { querySource: "main_turn", stopReason: scenario === "truncated" ? "length" : "stop", toolCallCount: 0 });
  const completed = emit("turn.completed", { response: text, resultType: scenario === "cancelled" ? "cancelled" : "success", toolCallCount: 0 });
  if (scenario !== "missing_turn") output += completed;
  if (scenario === "duplicate_turn") output += completed;
  const result = JSON.stringify({ ...id, type: "result", response: text, projection: { status: "idle" }, ...(scenario === "missing_usage" ? {} : { usage: { inputTokens: 12, outputTokens: 4 } }) }) + "\n";
  if (scenario !== "missing_result") output += result;
  if (scenario === "duplicate_result") output += result;
  if (scenario === "trailing") output += emit("session.updated", {});
  if (scenario === "mismatch") output = output.replace('"type":"result"', '"type":"result","turnId":"other"');
  if (scenario === "invalid_utf8") {
    process.stdout.write(Buffer.from([0xff, 0xfe])); return;
  }
  if (scenario === "split_utf8") {
    const bytes = Buffer.from(output);
    const offset = bytes.indexOf(Buffer.from("中")) + 1;
    process.stdout.write(bytes.subarray(0, offset), () => process.stdout.write(bytes.subarray(offset)));
  } else process.stdout.write(output);
  if (scenario === "nonzero") process.exitCode = 2;
};
