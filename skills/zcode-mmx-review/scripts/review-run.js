#!/usr/bin/env node
"use strict";

// zcode-mmx-review · 统一入口（离线原型，fixture 后端）。
// 让 ZCode 与 MMX 两侧拿到同一个逻辑审核包 P，并用同一个校验器
// （skills/zcode/scripts/review.js 的 validateReview）判定有效票。
// 本文件不调用任何真实模型；`--backend real` 是保留值，读取任何输入
// 之前即以退出码 2 拒绝。verify 只做相对本地记录的自洽核查。

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { buildPrompt, validateReview, validateIds, strictJson } = require("../../zcode/scripts/review.js");

const ENTRY_VERSION = "0.2.0";
const STRATEGIES = Object.freeze(["primary-first", "dual-parallel"]);
const SKILLS = path.resolve(__dirname, "../.."); // <repo>/skills
const LIMITS = Object.freeze({
  materialMaxBytes: 192 * 1024,
  patchMaxBytes: 128 * 1024,
  logTailBytes: 8 * 1024,
  fakeProcessMs: 30000,   // fixture 父进程对每个假 wrapper 的截止时间
  cancelGraceMs: 5000,    // SIGTERM 后最多等 5 秒再 SIGKILL
  timeoutMin: 1,
  timeoutMax: 3570,
  defaultTimeout: 600,
  defaultMaxTokens: 524288,
});
const ZCODE_WRAPPER = path.join(__dirname, "../tests/fixtures/backends/zcode-fake-wrapper.cjs");
const MMX_WRAPPER = path.join(__dirname, "../tests/fixtures/backends/mmx-fake-wrapper.cjs");
const SCENARIOS_FILE = path.join(__dirname, "../tests/fixtures/backends/scenarios.json");
const ADJUDICATION_FILES = Object.freeze({
  "review-run.js": __filename,
  "review.js": path.join(SKILLS, "zcode/scripts/review.js"),
  "review-v1.schema.json": path.join(SKILLS, "zcode/references/review-v1.schema.json"),
});
const PROVENANCE_FILES = Object.freeze({
  "zcode-chat.js": path.join(SKILLS, "zcode/scripts/zcode-chat.js"),
  "mmx-chat.js": path.join(SKILLS, "mmx/scripts/mmx-chat.js"),
  "mmx-profile": path.join(SKILLS, "mmx/profiles/local.json"),
  "scenarios.json": SCENARIOS_FILE,
  "zcode-fake-wrapper.cjs": ZCODE_WRAPPER,
  "mmx-fake-wrapper.cjs": MMX_WRAPPER,
});

const USAGE = "usage: review-run.js doctor --offline [--json]\n" +
  "       review-run.js run --backend fixture --scenario NAME --packet FILE --out NEW_DIR [--strategy primary-first|dual-parallel] [--timeout-seconds 1..3570] [--max-tokens N]\n" +
  "       review-run.js verify --run DIR\n" +
  "       review-run.js pack --out PACKET [--facts FILE] [--goal-file FILE] [--patch-file FILE --base SHA --kind KIND [--head SHA]] [--test-log FILE --test-cmd STR --test-exit N]... [--claims-file FILE]";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sha256File = file => hash(fs.readFileSync(file));
const fail = message => { throw Object.assign(new Error(message), { usage: true }); };
function readJsonFile(file) { return strictJson(fs.readFileSync(file, "utf8")); }
function saveNew(file, bytes, mode = 0o600) { fs.writeFileSync(file, bytes, { flag: "wx", mode }); }

// Publish only complete, fsynced checkpoint files. Existing artifacts are never
// replaced: a later phase must match their exact bytes or fail closed.
function saveDurableRecord(file, bytes) {
  bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`immutable record differs: ${path.basename(file)}`);
    }
    const fd = fs.openSync(file, "r+");
    try {
      if (!fs.readFileSync(fd).equals(bytes)) throw new Error(`immutable record differs: ${path.basename(file)}`);
      // Fixture wrappers write their observed-input records with ordinary wx.
      // The coordinator must flush those bytes before publishing a checkpoint.
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } else {
    const pending = `${file}.pending`;
    const fd = fs.openSync(pending, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // link is exclusive and atomic, unlike rename which could replace a record.
    fs.linkSync(pending, file);
    fs.unlinkSync(pending);
  }
  // Directory fsync is supported on POSIX; Windows durability remains subject
  // to the native lifecycle gate and is never claimed by this fixture entry.
  if (process.platform !== "win32") {
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}

function materialBinding(inputs) {
  const digests = {
    material_sha256: hash(inputs.materialBytes),
    evidence_ids_sha256: hash(inputs.idsBytes),
    prompt_sha256: hash(Buffer.from(inputs.prompt, "utf8")),
  };
  return { ...digests, material_version: hash(JSON.stringify(digests)) };
}

// ---------------------------------------------------------------------------
// packet v1/v2 解析与规范化
// ---------------------------------------------------------------------------

const V1_KEYS = Object.freeze(["facts", "constraints", "assumptions", "uncovered"]);
const V2_KEYS = Object.freeze(["goal", "changes", "execution", "claims", "provenance"]);
const RESERVED_EVIDENCE_IDS = Object.freeze(["GOAL", "DIFFSTAT", "PATCH"]);
const RESERVED_EVIDENCE_PREFIXES = Object.freeze(["AC-", "TEST-", "CLAIM-"]);
const SHA40 = /^[0-9a-f]{40}$/;

function checkV1Common(packet) {
  // 先验类型再迭代：标量 facts 抛 TypeError 会绕过受控的 usage 报错。
  if (packet.facts !== undefined && !Array.isArray(packet.facts)) fail("packet.facts must be an array");
  for (const fact of packet.facts ?? []) {
    if (fact === null || typeof fact !== "object" || Array.isArray(fact)) fail("each fact must be an object");
    // 输入只看键集合；material 渲染时才固定 id、text 的顺序。
    const factKeys = Object.keys(fact).sort();
    if (factKeys.length !== 2 || factKeys[0] !== "id" || factKeys[1] !== "text" ||
        typeof fact.id !== "string" || typeof fact.text !== "string" || !fact.text.trim()) {
      fail("each fact needs exactly an id and a nonempty text");
    }
  }
  if (Array.isArray(packet.facts) && packet.facts.length) validateIds(packet.facts.map(fact => fact.id));
  for (const key of ["constraints", "assumptions", "uncovered"]) {
    if (packet[key] !== undefined &&
        (!Array.isArray(packet[key]) || packet[key].some(value => typeof value !== "string" || !value.trim()))) {
      fail(`packet.${key} must be an array of nonempty strings`);
    }
  }
}

function checkObjectShape(value, keys, where) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
  const present = Object.keys(value);
  if (present.some(key => !keys.includes(key))) fail(`${where} allows only ${keys.join(", ")} (and no hand-written stat)`);
}

function checkV2Sections(packet) {
  if (packet.goal !== undefined) {
    checkObjectShape(packet.goal, ["request", "acceptance"], "goal");
    if (typeof packet.goal.request !== "string" || !packet.goal.request.trim()) fail("goal.request must be a nonempty string");
    if (!Array.isArray(packet.goal.acceptance) || !packet.goal.acceptance.length ||
        packet.goal.acceptance.some(value => typeof value !== "string" || !value.trim())) {
      fail("goal.acceptance must be a nonempty array of strings");
    }
  }
  if (packet.changes !== undefined) {
    checkObjectShape(packet.changes, ["kind", "base", "head", "patch", "patch_sha256"], "changes");
    if (!["worktree_patch", "commit_range"].includes(packet.changes.kind)) fail("changes.kind must be worktree_patch or commit_range");
    if (!SHA40.test(packet.changes.base ?? "")) fail("changes.base must be a 40-hex SHA");
    if (packet.changes.kind === "commit_range" && !SHA40.test(packet.changes.head ?? "")) fail("commit_range needs a 40-hex changes.head");
    if (packet.changes.kind === "worktree_patch" && packet.changes.head !== undefined) fail("worktree_patch must not carry changes.head");
    if (typeof packet.changes.patch !== "string" || !packet.changes.patch.length) fail("changes.patch must be a nonempty string");
    if (!/^[0-9a-f]{64}$/.test(packet.changes.patch_sha256 ?? "")) fail("changes.patch_sha256 must be 64-hex");
  }
  if (packet.execution !== undefined) {
    checkObjectShape(packet.execution, ["tests"], "execution");
    if (!Array.isArray(packet.execution.tests) || !packet.execution.tests.length) fail("execution.tests must be a nonempty array");
    for (const [index, run] of packet.execution.tests.entries()) {
      const keys = Object.keys(run).sort().join(",");
      if (keys !== "cmd,exit_code,log_bytes,log_sha256,output_tail,source,tail_only") fail(`execution.tests[${index}] has unexpected fields`);
      if (typeof run.cmd !== "string" || !run.cmd.trim()) fail(`execution.tests[${index}].cmd must be a nonempty string`);
      // cmd 会渲染成 material 里的 `cmd=…\nexit_code=…` 多行文本；含 CR/LF 就能在
      // 真正的 exit_code 行前伪造一行，与路径注入同属行格式问题（V7），一律拒收。
      if (/[\r\n]/.test(run.cmd)) fail(`execution.tests[${index}].cmd must not contain CR or LF`);
      if (!Number.isSafeInteger(run.exit_code)) fail(`execution.tests[${index}].exit_code must be an integer`);
      if (run.source !== "host_reported") fail(`execution.tests[${index}].source must be "host_reported"`);
      if (!Number.isSafeInteger(run.log_bytes) || run.log_bytes < 0) fail(`execution.tests[${index}].log_bytes must be a nonnegative integer`);
      if (!/^[0-9a-f]{64}$/.test(run.log_sha256 ?? "")) fail(`execution.tests[${index}].log_sha256 must be 64-hex`);
      if (run.tail_only !== true) fail(`execution.tests[${index}].tail_only must be true`);
      if (typeof run.output_tail !== "string") fail(`execution.tests[${index}].output_tail must be a string`);
    }
  }
  if (packet.claims !== undefined) {
    if (!Array.isArray(packet.claims) || packet.claims.some(value => typeof value !== "string" || !value.trim())) {
      fail("claims must be an array of nonempty strings");
    }
  }
  if (packet.provenance !== undefined) {
    checkObjectShape(packet.provenance, ["generated_by", "packet_version"], "provenance");
    if (packet.provenance.generated_by !== "review-run pack" || packet.provenance.packet_version !== 2) {
      fail('provenance only allows {generated_by: "review-run pack", packet_version: 2}');
    }
  }
}

function packetFrom(raw) {
  const packet = strictJson(raw);
  if (packet === null || typeof packet !== "object" || Array.isArray(packet)) fail("packet must be a JSON object");
  const keys = Object.keys(packet);
  const v2 = V2_KEYS.some(key => key in packet);
  if (v2) {
    if (keys.some(key => !V1_KEYS.includes(key) && !V2_KEYS.includes(key))) {
      fail(`packet allows only ${[...V1_KEYS, ...V2_KEYS].join(", ")} at the top level`);
    }
    checkV1Common(packet);
    checkV2Sections(packet);
    // 空 claims 不算证据（claims:[] 的包仍须有其他段或 facts）。
    const derived = (packet.facts?.length ? 1 : 0) + V2_KEYS.filter(key => packet[key] !== undefined && key !== "provenance" && (key !== "claims" || packet.claims.length)).length;
    if (!derived) fail("a v2 packet needs at least one item of evidence (facts or a v2 section)");
    return packet;
  }
  if (keys.some(key => !V1_KEYS.includes(key))) fail(`packet allows only ${V1_KEYS.join(", ")} at the top level`);
  if (!Array.isArray(packet.facts) || !packet.facts.length) fail("packet.facts must be a nonempty array");
  checkV1Common(packet);
  return packet;
}

// ---------------------------------------------------------------------------
// 统一补丁解析与 DIFFSTAT
// ---------------------------------------------------------------------------

// 引号路径 token 的解码：去引号并解 git 的转义（含 \NNN 八进制字节，聚合成字节
// 后 fatal UTF-8 解码——core.quotePath=true 时非 ASCII 路径就是这种形式）。转义
// 聚合出的字节不是合法 UTF-8 时抛错：名字不能无损表示就整份补丁拒收（W1b），
// 与补丁本身不是合法 UTF-8 时的处理相同，与 core.quotePath 的取值无关。
function decodePathToken(token) {
  if (!token.startsWith('"')) return token;
  const parts = [];
  const text = token.slice(1, -1);
  // git quote_c_style 的完整转义表：\a \b \f \n \r \t \v \" \\ 与 \NNN 八进制。
  const simpleEscapes = { a: "\x07", b: "\x08", f: "\x0c", n: "\n", r: "\r", t: "\t", v: "\x0b", '"': '"', "\\": "\\" };
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i);
    if (code === 0x5c) { // 反斜杠转义
      const octal = text.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) { parts.push(Buffer.from([parseInt(octal, 8)])); i += 4; continue; }
      const next = text.codePointAt(i + 1);
      if (next === undefined) { parts.push(Buffer.from("\\", "utf8")); i += 1; continue; } // 行尾孤立反斜杠原样保留
      const name = String.fromCodePoint(next);
      parts.push(Buffer.from(simpleEscapes[name] ?? name, "utf8"));
      i += 1 + (next > 0xffff ? 2 : 1);
    } else {
      // 按 code point 前进（W1）：core.quotePath=false 下引号串里是原始的多字节
      // 字符，代理对必须整体一次转 UTF-8，逐 code unit 转会拆成替换字符。
      parts.push(Buffer.from(String.fromCodePoint(code), "utf8"));
      i += code > 0xffff ? 2 : 1;
    }
  }
  // 聚合出的字节必须能无损解码：失败即整份补丁拒收（W1b）。ignoreBOM：rename to /
  // copy to 行的名字不带 a/、b/ 前缀，名字以 U+FEFF 开头时它就在首位，默认解码会
  // 把它当 BOM 吞掉，与 git 不一致（Y1）。
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts)); }
  catch { throw new Error(`quoted path is not valid UTF-8; patches must be losslessly representable: ${token.slice(0, 40)}`); }
}

// 前缀只认 git 默认的 a/、b/：diff.mnemonicPrefix（c/ i/）、diff.noprefix（裸名）
// 等生成的补丁一律整份拒收，不静默把前缀当路径的一部分（X3）。
const PREFIX_HINT = "the patch must use git's default a/ and b/ prefixes (regenerate with --src-prefix=a/ --dst-prefix=b/; diff.mnemonicPrefix and diff.noprefix patches are rejected)";

// diff --git 头一侧的名字：引号形式按解码后的文本判前缀，再去掉前缀本身。
function headerSideName(token, prefix, line) {
  const name = decodePathToken(token);
  if (!name.startsWith(prefix + "/")) throw new Error(`diff --git header: ${PREFIX_HINT}: ${line.slice(0, 60)}`);
  return name.slice(2);
}

// diff --git 头只用来给出“默认名字”（git apply 的做法）：两侧都能解析、前缀是
// 默认的 a/、b/ 且去掉前缀后相同，才给出名字；两侧不同或无法对齐（改名、复制
// 段）不报错，路径以 rename to / copy to（或非 /dev/null 的 +++ 行）为准，整段
// 结束仍没有路径才在 parsePatch 里报错。两侧可各自是引号形式或裸形式——改名头
// 一侧带引号、一侧不带是 git 的正常输出（X2），不得拒收。返回 null 表示头本身
// 无法切成两半。
function diffGitPath(line) {
  const body = line.slice("diff --git ".length);
  const firstQuoted = body.match(/^("(?:[^"\\]|\\.)*")/);
  const lastQuoted = body.match(/("(?:[^"\\]|\\.)*")$/);
  if (firstQuoted && lastQuoted && lastQuoted.index > firstQuoted.index) {
    // 两侧都是引号形式："a/…" "b/…"（两个 token 文本可能相同，按位置区分）。
    const between = body.slice(firstQuoted[1].length, body.length - lastQuoted[1].length);
    if (!/^\s+$/.test(between)) return null; // 两个引号 token 之外还有内容：无法解析
    const oldSide = headerSideName(firstQuoted[1], "a", line);
    const newSide = headerSideName(lastQuoted[1], "b", line);
    return { name: oldSide === newSide ? oldSide : null };
  }
  if (firstQuoted) {
    // 旧侧引号、新侧裸："a/…" b/…（从需要加引号的名字改名为普通名，X2）。
    // 新名以 b/ 开头，剥掉分隔空白不会吃掉名字自身的首空格。
    const neu = body.slice(firstQuoted[1].length).replace(/^\s+/, "");
    if (!neu || neu.startsWith('"')) return null; // 新侧缺失或引号不完整
    const oldSide = headerSideName(firstQuoted[1], "a", line);
    const newSide = headerSideName(neu, "b", line);
    return { name: oldSide === newSide ? oldSide : null };
  }
  if (lastQuoted) {
    // 旧侧裸、新侧引号：a/… "b/…"（普通名改名为需要加引号的名字，X2 反方向）。
    const old = body.slice(0, lastQuoted.index).replace(/\s+$/, "");
    if (!old) return null; // 旧侧缺失
    const oldSide = headerSideName(old, "a", line);
    const newSide = headerSideName(lastQuoted[1], "b", line);
    return { name: oldSide === newSide ? oldSide : null };
  }
  // 两侧裸形式：非改名/复制段 a/、b/ 两半完全相等，据此切分（git 不给空格加
  // 引号，"doc x.md" 这类路径只有这一半信息）；两半不等的段从后往前找第一个
  // 旧侧 a/、新侧 b/ 的切分（新名不带空格时即正确切分），两半不同就不给默认
  // 名字。任何切分都凑不出 a/、b/ 时是 mnemonic/noprefix 之类的非默认前缀，
  // 拒收（X3）；一个空格都没有则是畸形头。
  if (!body.includes(" ")) return null;
  for (let at = body.indexOf(" "); at > 0; at = body.indexOf(" ", at + 1)) {
    const left = body.slice(0, at);
    const right = body.slice(at + 1);
    if (left.startsWith("a/") && right.startsWith("b/") && left.slice(2) === right.slice(2)) {
      return { name: left.slice(2) };
    }
  }
  for (let at = body.lastIndexOf(" "); at > 0; at = body.lastIndexOf(" ", at - 1)) {
    const left = body.slice(0, at);
    const right = body.slice(at + 1);
    if (left.startsWith("a/") && right.startsWith("b/")) return { name: null };
  }
  throw new Error(`diff --git header: ${PREFIX_HINT}: ${line.slice(0, 60)}`);
}

// git base85 数据行：首字符表字节数（'A'-'Z' = 1..26，'a'-'z' = 27..52，每行最多
// 52 字节），其余字符属于 git base85 字符集；每 4 字节编 5 字符，故 body 长度恒为
// ceil(bytes/4)*5。行长校验偏严只会误拒、不会放行注入。
const B85_BODY = /^[0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]+$/;
function isBinaryDataLine(line) {
  const c = line.charCodeAt(0);
  const bytes = c >= 65 && c <= 90 ? c - 64 : c >= 97 && c <= 122 ? c - 70 : 0;
  if (!bytes) return false;
  const body = line.slice(1);
  return B85_BODY.test(body) && body.length === Math.ceil(bytes / 4) * 5;
}

// 解析 git unified diff，返回 [{path, additions, deletions, mode_only, binary}]。
// hunk 声明的行数与实际不符视为无法解析。
function parsePatch(patchText) {
  if (typeof patchText !== "string" || !patchText.length) throw new Error("empty patch");
  // CRLF 检出的补丁在解析层归一为 LF（sha256 仍按原始字节计算）。
  const lines = patchText.split("\n").map(line => line.replace(/\r$/, ""));
  if (lines.at(-1) === "") lines.pop();
  if (!lines.some(line => line.startsWith("diff --git "))) throw new Error("not a git diff");
  const files = [];
  let current = null;
  let hunk = null;
  let sawTextHunk = false;    // 本文件段是否已出现 @@ 文本 hunk；与任一二进制标记互斥（V1）
  let binarySkipping = false; // GIT binary patch 段：literal/delta 头 + base85 数据行 + 空行之外一律报错
  let binaryHunks = 0;        // 每段最多两个 hunk（正向 + 反向）
  let binaryHunkOpen = false; // 头之后、结束空行之前
  const finishHunk = () => {
    if (!hunk) return;
    if (hunk.old !== 0 || hunk.neu !== 0) throw new Error(`hunk line count mismatch near ${hunk.header}`);
    hunk = null;
  };
  // 二进制段的段尾检查（V3/K5）：每个 hunk 必须以空行闭合；GIT binary patch 之后
  // 至少要有一个 literal/delta hunk。diff --git 与补丁结尾两处都会经过这里。
  const finishBinarySection = () => {
    if (!binarySkipping) return;
    if (binaryHunkOpen) throw new Error("binary hunk is not closed by a blank line before the section ends");
    if (binaryHunks === 0) throw new Error("GIT binary patch has no literal/delta hunk");
  };
  // 段尾检查（X2 改造的另一面）：改名/复制段的头不给默认名字，路径由 rename to /
  // copy to（或非 /dev/null 的 +++ 行）给出；整段结束仍没有路径说明补丁不完整。
  const finishFileSection = () => {
    if (current && current.path === null) throw new Error(`file section ends without a usable path (rename/copy headers need rename to/copy to): ${current.header}`);
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finishHunk();
      finishBinarySection();
      finishFileSection();
      binarySkipping = false; binaryHunks = 0; binaryHunkOpen = false;
      sawTextHunk = false;
      const header = diffGitPath(line);
      if (!header) throw new Error(`unparseable diff header: ${line.slice(0, 60)}`);
      current = { path: header.name, header: line.slice(0, 60), renameFrom: null, renameTo: null, additions: 0, deletions: 0, sawModeLine: false, mode_only: false, binary: false };
      files.push(current);
      continue;
    }
    if (binarySkipping) {
      // 二进制段失败即关闭：只接受 literal/delta 头、base85 数据行和空行，
      // 其余任何行（含夹带的文本 diff）都报错，不再静默跳过。
      if (line === "") { binaryHunkOpen = false; continue; }
      if (/^(?:literal|delta) \d+$/.test(line)) {
        if (binaryHunkOpen || ++binaryHunks > 2) throw new Error(`unparseable binary patch line: ${JSON.stringify(line.slice(0, 40))}`);
        binaryHunkOpen = true;
        continue;
      }
      if (binaryHunkOpen && isBinaryDataLine(line)) continue;
      throw new Error(`unparseable binary patch line: ${JSON.stringify(line.slice(0, 40))}`);
    }
    if (line === "GIT binary patch") {
      // 同一文件段内文本与二进制互斥（V1）：已出现过文本 hunk 再遇二进制标记，
      // 说明这份补丁把文本改动藏进了二进制段（git 应用前者、统计后者），一律拒收。
      if (sawTextHunk) throw new Error(`binary marker after text hunks in the same file section: ${JSON.stringify(line.slice(0, 40))}`);
      finishHunk();
      if (!current) throw new Error("GIT binary patch before any file header");
      if (current.binary) throw new Error(`duplicate binary marker in the same file section: ${JSON.stringify(line.slice(0, 40))}`);
      // --binary 补丁：literal/delta 头与 base85 数据行；增删记 0。
      current.binary = true;
      binarySkipping = true; binaryHunks = 0; binaryHunkOpen = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      // 互斥的另一方向（V1）：已有任一二进制标记（GIT binary patch 或 Binary files
      // … differ）之后再出现文本 hunk，git 自身会拒收这类补丁，这里同样报错。
      if (current && current.binary) throw new Error(`text hunk after a binary marker in the same file section: ${JSON.stringify(line.slice(0, 40))}`);
      finishHunk();
      if (!current) throw new Error("hunk before any file header");
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) throw new Error(`unparseable hunk header: ${line.slice(0, 40)}`);
      // '-' 行只消耗旧侧槽位，'+' 只消耗新侧；' ' 两侧都消耗。
      hunk = { header: line.slice(0, 40), old: match[2] === undefined ? 1 : Number(match[2]), neu: match[4] === undefined ? 1 : Number(match[4]) };
      sawTextHunk = true;
      continue;
    }
    // hunk 活跃时内容行优先：被删内容 "-- x" 的 diff 行是 "--- x"、被增 "++ y"
    // 是 "+++ y"，必须按 hunk 内容计数，绝不能当成文件头。
    if (hunk) {
      if (line.startsWith("+")) { current.additions++; hunk.neu--; }
      else if (line.startsWith("-")) { current.deletions++; hunk.old--; }
      else if (line.startsWith(" ")) { hunk.old--; hunk.neu--; }
      else if (line.startsWith("\\")) { /* "\ No newline at end of file" 不计行数 */ }
      else throw new Error(`unparseable hunk content: ${JSON.stringify(line.slice(0, 40))}`);
      continue;
    }
    if (current && (line.startsWith("old mode ") || line.startsWith("new mode "))) { current.sawModeLine = true; continue; }
    if (current && (line.startsWith("rename from ") || line.startsWith("copy from "))) {
      // 改名/复制的源名（不带前缀）。随后若有 --- 行，它必须正好是 a/ 加这个名字（Z1）。
      current.renameFrom = decodePathToken(line.slice(line.startsWith("rename from ") ? 12 : 10));
      continue;
    }
    if (current && (line.startsWith("rename to ") || line.startsWith("copy to "))) {
      // 改名/复制的目标路径以这两行为准（这两行不带 a/、b/ 前缀）。真实 git 输出
      // 这两行行尾没有 tab，名字里的首尾空格是路径的一部分，不做任何裁剪；引号
      // 形式交给 decodePathToken。随后若有 +++ 行，它必须正好是 b/ 加这个名字（Z1）。
      current.path = decodePathToken(line.slice(line.startsWith("rename to ") ? 10 : 8));
      current.renameTo = current.path;
      continue;
    }
    if (current && line.startsWith("Binary files ") && line.includes(" differ")) {
      // 只当二进制标记（互斥与重复检查不变），不从这一行取路径：它对
      // a/(.*) and b/(.*) 的贪婪匹配在路径含 " and b/" 时切错（X1），且文件头、
      // rename to / copy to、+++ 行已给出正确路径，git apply 也不从这一行取名字。
      if (current.binary) throw new Error(`duplicate binary marker in the same file section: ${JSON.stringify(line.slice(0, 40))}`);
      current.binary = true;
      continue;
    }
    // 路径统一不带 a/、b/ 前缀，与 git diff --stat 的口径一致。
    if (current && line.startsWith("--- ")) {
      // --- 行不取路径，但非 /dev/null 时必须带 git 默认的 a/ 前缀（X3）。
      const oldName = decodePathToken(line.slice(4).replace(/\t$/, ""));
      if (oldName !== "/dev/null" && !oldName.startsWith("a/")) throw new Error(`--- line: ${PREFIX_HINT}: ${line.slice(0, 60)}`);
      // 改名/复制段（Z1）：--- 必须正好是 a/ 加 rename from / copy from 的名字，/dev/null
      // 也算不一致（git apply 同样核对）。diff.noprefix 下把 a/ 目录里的文件改名或复制
      // 到 b/ 目录并修改内容，头与 ---/+++ 的前缀都像默认前缀，只有这里露出不一致。
      if (current.renameFrom !== null && oldName !== `a/${current.renameFrom}`) throw new Error(`--- line does not match rename from/copy from; ${PREFIX_HINT}: ${line.slice(0, 60)}`);
      continue;
    }
    if (current && line.startsWith("+++ ")) {
      // git 只在 ---/+++ 行的名字含空格时给行尾追加一个 \t（GNU patch 兼容标记），
      // 名字本身的首尾空格必须保留：只去掉这一个 \t，不做 trim。名字里含 tab 时
      // git 必然走引号形式（\t 在引号内转义），裸行尾 tab 只能是 git 追加的标记。
      // 非 /dev/null 时必须带 git 默认的 b/ 前缀（X3）。
      const name = decodePathToken(line.slice(4).replace(/\t$/, ""));
      // 改名/复制段（Z1）：+++ 必须正好是 b/ 加 rename to / copy to 的名字，/dev/null
      // 也算不一致；不一致即拒收，不再用 +++ 的名字覆盖目标路径。
      if (current.renameTo !== null && name !== `b/${current.renameTo}`) throw new Error(`+++ line does not match rename to/copy to; ${PREFIX_HINT}: ${line.slice(0, 60)}`);
      if (name !== "/dev/null") {
        if (!name.startsWith("b/")) throw new Error(`+++ line: ${PREFIX_HINT}: ${line.slice(0, 60)}`);
        current.path = name.slice(2);
      }
      continue;
    }
    if (current && ["rename ", "copy ", "rename from", "rename to", "copy from", "copy to", "old mode", "new mode", "similarity", "dissimilarity", "index ", "new file", "deleted file", "--- ", "+++ "].some(prefix => line.startsWith(prefix))) continue;
    // 文件头之外、hunk 之外的行不允许出现。
    if (current && line.length) throw new Error(`unparseable patch line: ${JSON.stringify(line.slice(0, 40))}`);
  }
  finishHunk();
  finishBinarySection();
  finishFileSection();
  if (!files.length) throw new Error("no file sections");
  // 只改权限模式的文件才记 mode_only：出现 mode 行但又有内容 hunk 的文件按内容统计。
  for (const file of files) file.mode_only = file.sawModeLine && file.additions === 0 && file.deletions === 0 && !file.binary;
  return files;
}

// DIFFSTAT 路径的引号与转义规则，与 `git -c core.quotePath=false diff --numstat`
// 的路径字段逐字一致（V2）：路径含 "、\、C0 控制字符（0x00–0x1F）或 DEL（0x7F）
// 时整个路径加双引号输出，\a \b \t \n \v \f \r \" \\ 用对应命名转义，其余控制
// 字符用三位八进制 \NNN；不含这些字符的路径照旧原样输出（含空格、首尾空格、
// 中文等非 ASCII）。这样不加引号的行永远不会以 " 开头，一个文件永远只占一行，
// 路径字段无法伪造行边界。parsePatch 返回的 path 仍是解码后的原始名字，与
// numstat -z 一致。
const DIFFSTAT_NAMED_ESCAPES = Object.freeze({
  0x07: "\\a", 0x08: "\\b", 0x09: "\\t", 0x0a: "\\n", 0x0b: "\\v", 0x0c: "\\f", 0x0d: "\\r", 0x22: '\\"', 0x5c: "\\\\",
});
function quoteDiffstatPath(name) {
  let needsQuoting = false;
  for (const ch of name) {
    const code = ch.codePointAt(0);
    if (code === 0x22 || code === 0x5c || code < 0x20 || code === 0x7f) { needsQuoting = true; break; }
  }
  if (!needsQuoting) return name;
  let out = '"';
  for (const ch of name) {
    const code = ch.codePointAt(0);
    if (DIFFSTAT_NAMED_ESCAPES[code] !== undefined) out += DIFFSTAT_NAMED_ESCAPES[code];
    else if (code < 0x20 || code === 0x7f) out += "\\" + code.toString(8).padStart(3, "0");
    else out += ch;
  }
  return out + '"';
}

// DIFFSTAT：首行 kind/base/[head]/patch_sha256，之后每文件一行 路径<TAB>+增<TAB>-删，
// 按路径的 **UTF-8 字节序**排序——名字必须是合法 UTF-8（decodePathToken 保证），
// 合法 UTF-8 的 UTF-8 字节就是原始字节，故行序与 git numstat 一致；只统计 hunk
// 里的增删行；二进制或只改模式的增删记 0。
// 路径字段经 quoteDiffstatPath 转义，不含引号/转义字符时与原始名字相同。
function diffstatText(changes) {
  const files = parsePatch(changes.patch);
  const header = `kind=${changes.kind} base=${changes.base}${changes.head ? ` head=${changes.head}` : ""} patch_sha256=${changes.patch_sha256}`;
  const rows = files
    .map(file => ({ path: file.path, additions: file.binary || file.mode_only ? 0 : file.additions, deletions: file.binary || file.mode_only ? 0 : file.deletions }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")))
    .map(file => `${quoteDiffstatPath(file.path)}\t+${file.additions}\t-${file.deletions}`);
  return [header, ...rows].join("\n") + "\n";
}

// run 的复核：补丁 UTF-8 字节的 sha256、可解析性、空补丁与体积上限。
function verifyChanges(changes) {
  const bytes = Buffer.from(changes.patch, "utf8");
  if (!bytes.length) fail("changes.patch is empty");
  if (bytes.length > LIMITS.patchMaxBytes) fail(`changes.patch exceeds ${LIMITS.patchMaxBytes} bytes`);
  if (createHash("sha256").update(bytes).digest("hex") !== changes.patch_sha256) fail("changes.patch_sha256 does not match the patch bytes");
  try { parsePatch(changes.patch); }
  catch (error) { fail(`changes.patch is not parseable: ${String(error?.message ?? error).slice(0, 120)}`); }
}

// ---------------------------------------------------------------------------
// material 组装（v1 与 v2 共用一套校验和规范化）
// ---------------------------------------------------------------------------

// v1 material 布局：facts、constraints、assumptions、uncovered 依次；缺的段不写；
// facts 每项按 id、text。规范字节 = JSON.stringify(obj, null, 2) + "\n"。
// v2 追加有序的 evidence 数组与（若存在）末尾的 provenance；没有 v2 段时
// 输出与 v1 逐字节相同。补丁和日志的正文只在 evidence 里出现一次。
function materialFrom(packet, options = {}) {
  const isV2 = V2_KEYS.some(key => packet[key] !== undefined);
  if (!isV2) {
    const ordered = { facts: packet.facts.map(fact => ({ id: fact.id, text: fact.text })) };
    for (const key of ["constraints", "assumptions", "uncovered"]) {
      if (packet[key] !== undefined) ordered[key] = [...packet[key]];
    }
    return JSON.stringify(ordered, null, 2) + "\n";
  }
  const ordered = {};
  if (packet.facts?.length) ordered.facts = packet.facts.map(fact => ({ id: fact.id, text: fact.text }));
  for (const key of ["constraints", "assumptions", "uncovered"]) {
    if (packet[key] !== undefined) ordered[key] = [...packet[key]];
  }
  const evidence = [];
  if (packet.goal !== undefined) {
    evidence.push({ id: "GOAL", text: packet.goal.request });
    packet.goal.acceptance.forEach((condition, index) => evidence.push({ id: `AC-${index + 1}`, text: condition }));
  }
  if (packet.changes !== undefined) {
    evidence.push({ id: "DIFFSTAT", text: diffstatText(packet.changes) });
    evidence.push({ id: "PATCH", text: packet.changes.patch });
  }
  if (packet.execution !== undefined) {
    packet.execution.tests.forEach((run, index) => evidence.push({
      id: `TEST-${index + 1}`,
      text: `cmd=${run.cmd}\nexit_code=${run.exit_code}\nsource=${run.source}\nlog_bytes=${run.log_bytes}\nlog_sha256=${run.log_sha256}\ntail_only=${run.tail_only}\noutput_tail=${run.output_tail}`,
    }));
  }
  if (packet.claims !== undefined) {
    packet.claims.forEach((claim, index) => evidence.push({ id: `CLAIM-${index + 1}`, text: claim }));
  }
  if (evidence.length) ordered.evidence = evidence;
  if (packet.provenance !== undefined) ordered.provenance = { generated_by: packet.provenance.generated_by, packet_version: packet.provenance.packet_version };
  const material = JSON.stringify(ordered, null, 2) + "\n";
  if (options.skipLimits !== true && Buffer.byteLength(material, "utf8") > LIMITS.materialMaxBytes) {
    fail(`material exceeds ${LIMITS.materialMaxBytes} bytes; use the batch entry and shard by hand`);
  }
  return material;
}

function evidenceIdsFrom(packet) {
  const isV2 = V2_KEYS.some(key => packet[key] !== undefined);
  const ids = [];
  // 保留名/前缀冲突是 v2 material 布局的约束（派生 ID 会与 facts id 撞车）；
  // v1 包没有派生 ID，沿用 S1 合同：evidencePattern 允许的 id 都合法。
  const factIds = (packet.facts ?? []).map(fact => fact.id);
  if (isV2) {
    for (const id of factIds) {
      if (RESERVED_EVIDENCE_IDS.includes(id) || RESERVED_EVIDENCE_PREFIXES.some(prefix => id.startsWith(prefix))) {
        fail(`fact id ${JSON.stringify(id)} collides with a reserved evidence name or prefix`);
      }
    }
  }
  if (!isV2 || packet.facts?.length) ids.push(...factIds);
  if (isV2) {
    if (packet.goal !== undefined) { ids.push("GOAL"); ids.push(...packet.goal.acceptance.map((_, index) => `AC-${index + 1}`)); }
    if (packet.changes !== undefined) { ids.push("DIFFSTAT", "PATCH"); }
    if (packet.execution !== undefined) ids.push(...packet.execution.tests.map((_, index) => `TEST-${index + 1}`));
    if (packet.claims !== undefined) ids.push(...packet.claims.map((_, index) => `CLAIM-${index + 1}`));
  }
  validateIds(ids);
  return ids;
}

function materialWarnings(packet) {
  const warnings = [];
  if (packet.goal === undefined) warnings.push("no_goal");
  if (packet.changes === undefined) warnings.push("no_changes");
  if (packet.execution === undefined) warnings.push("no_execution");
  if (packet.claims !== undefined && packet.execution === undefined) warnings.push("claims_without_execution");
  return warnings;
}

function buildRunPacket(rawPacketBytes) {
  const packet = packetFrom(rawPacketBytes.toString("utf8"));
  const isV2 = V2_KEYS.some(key => packet[key] !== undefined);
  if (isV2 && packet.changes !== undefined) verifyChanges(packet.changes);
  const material = materialFrom(packet);
  if (Buffer.byteLength(material, "utf8") > LIMITS.materialMaxBytes) {
    fail(`material exceeds ${LIMITS.materialMaxBytes} bytes; use the batch entry and shard by hand`);
  }
  const ids = evidenceIdsFrom(packet);
  return {
    packet, ids, packetBytes: Buffer.from(rawPacketBytes),
    material, materialBytes: Buffer.from(material, "utf8"),
    idsBytes: Buffer.from(JSON.stringify(ids) + "\n", "utf8"),
    prompt: buildPrompt(material, "review", ids),
    warnings: materialWarnings(packet),
  };
}

// ---------------------------------------------------------------------------
// 两侧 argv / 环境组装（入口与测试共用同一组函数）
// ---------------------------------------------------------------------------

// ZCode 与 MMX 的参数域不同：ZCode 用 --mode/--evidence-ids-file/--timeout-seconds；
// MMX 用 --timeout/--wrap-timeout/--max-tokens，且从不接收 mode、IDs 或 system 文件。
function assembleInputs({ materialPath, idsPath, promptPath, timeoutSeconds, maxTokens, zcodeOutputDir }) {
  const zcodeArgv = ["--prompt-file", materialPath, "--mode", "review", "--evidence-ids-file", idsPath, "--timeout-seconds", String(timeoutSeconds)];
  if (zcodeOutputDir) zcodeArgv.push("--output-dir", zcodeOutputDir);
  const mmxArgv = ["--prompt-file", promptPath, "--timeout", String(timeoutSeconds), "--wrap-timeout", String(timeoutSeconds + 30), "--max-tokens", String(maxTokens)];
  const envBase = {};
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) envBase[key] = process.env[key];
  }
  return { zcode: { argv: zcodeArgv, env: { ...envBase } }, mmx: { argv: mmxArgv, env: { ...envBase } } };
}

// ---------------------------------------------------------------------------
// 判定：模型族、单方资格、汇总
// ---------------------------------------------------------------------------

// 模型族按前缀判断：glm 或 minimax 开头，后接 -、_、. 或直接结束，不区分大小写。
function family(model) {
  if (typeof model !== "string") return null;
  if (/^glm(?:[-_.]|$)/i.test(model)) return "glm";
  if (/^minimax(?:[-_.]|$)/i.test(model)) return "minimax";
  return null;
}

const CLEANUP_DISQUALIFY = Object.freeze({ null: "cleanup_unconfirmed", false: "cleanup_failed" });

function evaluateSideCore(side, { execution, stdoutBytes, observed, expected }) {
  // 返回 { eligible, gate, reason, model, model_family, material_bound, review, diagnostic }
  const diagnostic = { receipt_status: null, gate: null, text: null };
  const keep = receipt => {
    diagnostic.receipt_status = typeof receipt?.status === "string" ? receipt.status : null;
    diagnostic.text = typeof receipt?.text === "string" ? receipt.text : null;
    try { diagnostic.gate = validateReview(receipt.text, expected.ids).review_gate; } catch { diagnostic.gate = null; }
  };
  if (execution.state !== "completed") return { eligible: false, gate: null, reason: `execution:${execution.state}`, model: null, model_family: null, material_bound: false, review: null, diagnostic };
  let receipt;
  try {
    receipt = strictJson(stdoutBytes.toString("utf8"));
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("not an object");
  } catch { return { eligible: false, gate: null, reason: "invalid_receipt:stdout_not_one_json_object", model: null, model_family: null, material_bound: false, review: null, diagnostic }; }
  keep(receipt);
  // 计划合同要求 wrapper 正常结束且退出码为 0、没有信号；进程级退出码/信号
  // 独立于回执字段检查——stdout 恰好带一份合法回执不能替代进程正常结束。
  // 诊断已保留（keep），便于事后翻查非零退出方到底说了什么。
  if (execution.exit_code !== 0) return { eligible: false, gate: null, reason: `execution:nonzero_exit:${execution.exit_code}`, model: null, model_family: null, material_bound: false, review: null, diagnostic };
  if (execution.signal !== null && execution.signal !== undefined) return { eligible: false, gate: null, reason: `execution:signaled:${execution.signal}`, model: null, model_family: null, material_bound: false, review: null, diagnostic };
  const nonEmpty = value => typeof value === "string" && value.trim();
  if (receipt.cli_invoked !== true || receipt.exit_code !== 0 || receipt.status !== "ok" ||
      receipt.complete !== true || receipt.truncated !== false || !nonEmpty(receipt.text) || !nonEmpty(receipt.model)) {
    return { eligible: false, gate: null, reason: "receipt:common_checks_failed", model: null, model_family: null, material_bound: false, review: null, diagnostic };
  }
  if (side === "zcode") {
    if (receipt.signal !== null) return { eligible: false, gate: null, reason: "receipt:signal", model: null, model_family: null, material_bound: false, review: null, diagnostic };
    if (!nonEmpty(receipt.provider)) return { eligible: false, gate: null, reason: "receipt:provider_empty", model: null, model_family: null, material_bound: false, review: null, diagnostic };
    if (receipt.model_identity_source !== "runtime.model_request") return { eligible: false, gate: null, reason: "receipt:model_identity_source", model: null, model_family: null, material_bound: false, review: null, diagnostic };
    if (receipt.tool_calls !== 0 || receipt.tool_requests !== 0) return { eligible: false, gate: null, reason: "receipt:tool_activity", model: null, model_family: null, material_bound: false, review: null, diagnostic };
    if (!["stop", "end_turn", "stop_sequence"].includes(receipt.stop_reason)) return { eligible: false, gate: null, reason: `receipt:stop_reason:${receipt.stop_reason}`, model: null, model_family: null, material_bound: false, review: null, diagnostic };
    if (!Object.hasOwn(receipt, "cleanup_confirmed") || typeof receipt.cleanup_confirmed !== "boolean") {
      if (receipt.cleanup_confirmed === null || receipt.cleanup_confirmed === false) {
        return { eligible: false, gate: null, reason: `receipt:${CLEANUP_DISQUALIFY[receipt.cleanup_confirmed]}`, model: null, model_family: null, material_bound: false, review: null, diagnostic };
      }
      return { eligible: false, gate: null, reason: "receipt:invalid_receipt:cleanup_confirmed_type", model: null, model_family: null, material_bound: false, review: null, diagnostic };
    }
    if (receipt.cleanup_confirmed !== true) return { eligible: false, gate: null, reason: "receipt:cleanup_failed", model: null, model_family: null, material_bound: false, review: null, diagnostic };
  } else {
    if (receipt.model_identity_source !== "response.model") return { eligible: false, gate: null, reason: "receipt:model_identity_source", model: null, model_family: null, material_bound: false, review: null, diagnostic };
    if (!["end_turn", "stop_sequence"].includes(receipt.stop_reason)) return { eligible: false, gate: null, reason: `receipt:stop_reason:${receipt.stop_reason}`, model: null, model_family: null, material_bound: false, review: null, diagnostic };
  }
  // 回执和内容校验的最后一项：复判 review 与回执声明一致。
  let checked;
  try { checked = validateReview(receipt.text, expected.ids); }
  catch (error) { return { eligible: false, gate: null, reason: `receipt:review_schema:${String(error?.message ?? "").slice(0, 120)}`, model: null, model_family: null, material_bound: false, review: null, diagnostic }; }
  if (side === "zcode" && (receipt.review_gate !== checked.review_gate || JSON.stringify(receipt.review) !== JSON.stringify(checked.review))) {
    return { eligible: false, gate: null, reason: "receipt:review_gate_mismatch", model: null, model_family: null, material_bound: false, review: null, diagnostic };
  }
  // 材料绑定：比内容，不比文件路径。
  if (!observed) return { eligible: false, gate: null, reason: "binding:unobserved", model: null, model_family: null, material_bound: false, review: null, diagnostic };
  try {
    const argvOk = JSON.stringify(observed.argv) === JSON.stringify(expected.argv);
    if (!argvOk) throw new Error("argv differs from the assembled invocation");
    if (side === "zcode") {
      const material = Buffer.from(observed.prompt_file_b64, "base64");
      const idsBytes = Buffer.from(observed.evidence_ids_file_b64, "base64");
      if (!material.equals(expected.materialBytes)) throw new Error("observed material differs");
      if (!idsBytes.equals(expected.idsBytes)) throw new Error("observed evidence IDs differ");
      const ids = validateIds(strictJson(idsBytes.toString("utf8")));
      if (buildPrompt(material.toString("utf8"), "review", ids) !== expected.prompt) throw new Error("rebuilt prompt differs");
    } else {
      const prompt = Buffer.from(observed.prompt_file_b64, "base64");
      if (!prompt.equals(expected.promptBytes)) throw new Error("observed prompt differs");
    }
  } catch (error) {
    return { eligible: false, gate: null, reason: `binding:${String(error?.message ?? "mismatch").slice(0, 120)}`, model: receipt.model, model_family: family(receipt.model), material_bound: false, review: null, diagnostic };
  }
  return { eligible: true, gate: checked.review_gate, reason: null, model: receipt.model, model_family: family(receipt.model), material_bound: true, review: checked.review, diagnostic };
}

// coverage_declared：只看 summary 第一行的形状。Checked: 开头、"; Not checkable: "
// 恰好出现一次、两侧非空。写 none 合法——这只代表做了声明，不代表覆盖充分，
// 也不参与 gate；无资格的一侧为 null。
function coverageDeclared(summary) {
  if (typeof summary !== "string") return false;
  const firstLine = summary.split("\n", 1)[0];
  if (!firstLine.startsWith("Checked: ")) return false;
  const parts = firstLine.split("; Not checkable: ");
  if (parts.length !== 2) return false;
  return parts[0].slice("Checked: ".length).trim().length > 0 && parts[1].trim().length > 0;
}

// evaluateSide 的外壳：在核心判定之外补 coverage_declared，让每个返回路径都有该字段。
function evaluateSide(side, details) {
  const result = evaluateSideCore(side, details);
  result.coverage_declared = result.review ? coverageDeclared(result.review.summary) : null;
  return result;
}

function tally({ cancelled, sides }) {
  const [zcode, mmx] = [sides.zcode, sides.mmx];
  const familiesKnown = [zcode, mmx].every(side => side.eligible && side.model_family);
  const independent = familiesKnown && zcode.model_family !== mmx.model_family;
  const roundStatus = !cancelled && zcode.eligible && mmx.eligible && independent ? "COMPLETED" : "NOT_EVALUATED";
  const votes = [zcode, mmx].filter(side => side.eligible);
  let gate = "NOT_EVALUATED";
  // A completed, bound P1 defect keeps its veto even if the other side is
  // cancelled. Cancellation still prevents a full round or a PASS.
  if (votes.some(side => side.gate === "FAIL")) gate = "FAIL";
  else if (cancelled) gate = "NOT_EVALUATED";
  else if (roundStatus === "COMPLETED" && votes.length === 2 && votes.every(side => side.gate === "PASS")) gate = "PASS";
  const exitCode = gate === "PASS" ? 0 : gate === "FAIL" ? 1 : 2;
  return {
    round_status: roundStatus, review_gate: gate, exit_code: exitCode, families_known: familiesKnown, independent,
    PRIMARY_REVIEW_GATE: zcode.eligible ? zcode.gate : "NOT_EVALUATED",
    SECONDARY_REVIEW_GATE: mmx.eligible ? mmx.gate : "NOT_EVALUATED",
    REVIEW_GATE: gate,
  };
}

// ---------------------------------------------------------------------------
// fixture 运行
// ---------------------------------------------------------------------------

function checkFixtureFile(file, directory) {
  // realpath 必须在 fixture 目录内、是普通文件且不是符号链接，否则启动次数为 0。
  const real = fs.realpathSync(file);
  const realDir = fs.realpathSync(directory);
  if (path.dirname(real) !== realDir) fail("fixture file must live directly inside tests/fixtures/backends");
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("fixture file must be a regular file, not a link");
  return real;
}

function stopAndAwait(child, graceMs) {
  return new Promise(resolve => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve("already-exited");
    try { child.kill("SIGTERM"); } catch {}
    const force = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, graceMs);
    child.once("close", () => { clearTimeout(force); resolve("terminated"); });
  });
}

// 进程级信号枢纽：process.on（非 once），安装后不再移除——监听保留到记录写完、
// 入口退出为止。活跃 round 通过 ctx 注册进来；信号到达时对每个 ctx 计数：第 1 次
// 走原取消路径（SIGTERM + 宽限升级），第 2 次起立即对尚未 close 的子进程 SIGKILL，
// 然后照常写完记录。无活跃 ctx 时为 no-op——入口在"两侧 close 之后、记录写完
// 之前"收到的信号只被接住，不改任何状态（AC2 迟到信号不记取消）。
const signalHub = { installed: false, rounds: new Set() };

function installSignalHub() {
  if (signalHub.installed) return;
  signalHub.installed = true;
  const onSignal = () => {
    for (const ctx of signalHub.rounds) {
      ctx.signalCount += 1;
      if (ctx.signalCount === 1) {
        ctx.cancelled = true;
        for (const entry of Object.values(ctx.sides)) {
          if (entry && !entry.closeDone) entry.cancelRequested = true;
        }
        ctx.interrupting = Promise.all(Object.values(ctx.sides).filter(entry => entry && entry.child && !entry.closeDone)
          .map(entry => stopAndAwait(entry.child, ctx.cancelGraceMs)));
      } else {
        // 第二次及以后：不再等宽限期，立即 SIGKILL 尚未 close 的子进程，然后照常
        // 写完记录（cancelled、NOT_EVALUATED、退出码 2）。已 spawn_error 或已退出
        // （closeDone=true / exitCode、signalCode 已设）的跳过。
        for (const entry of Object.values(ctx.sides)) {
          if (entry && entry.child && !entry.closeDone &&
              entry.child.exitCode === null && entry.child.signalCode === null) {
            try { entry.child.kill("SIGKILL"); } catch {}
          }
        }
      }
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function runFixtureRound(inputs, { out, scenario, timeoutSeconds, maxTokens, argv, envBase, strategy = "primary-first", fakeProcessMs = LIMITS.fakeProcessMs, cancelGraceMs = LIMITS.cancelGraceMs, onSpawn = null, onSideClosed = null, onPrimaryReady = null }) {
  if (!STRATEGIES.includes(strategy)) fail(`unsupported strategy: ${strategy}`);
  fs.mkdirSync(path.join(out, "tmp"), { mode: 0o700 });
  const binding = materialBinding(inputs);
  writeRunInputs(out, { packetBytes: inputs.packetBytes, inputs });
  // Freeze request intent and code fingerprints before either wrapper starts.
  // A crash after PRIMARY_REVIEW_READY still leaves the exact launch contract;
  // finalization never re-labels a run with hashes from later source edits.
  const requestJson = JSON.stringify(buildRunRequest(inputs, {
    strategy, scenario, timeoutSeconds, maxTokens, argv, envKeys: Object.keys(envBase).sort(),
  }), null, 2) + "\n";
  saveDurableRecord(path.join(out, "request.json"), requestJson);
  const expected = {
    materialBytes: inputs.materialBytes,
    idsBytes: inputs.idsBytes,
    ids: inputs.ids,
    prompt: inputs.prompt,
    promptBytes: Buffer.from(inputs.prompt, "utf8"),
  };
  const wrappers = { zcode: checkFixtureFile(ZCODE_WRAPPER, path.dirname(SCENARIOS_FILE)), mmx: checkFixtureFile(MMX_WRAPPER, path.dirname(SCENARIOS_FILE)) };
  const sides = {};
  // 取消状态机：信号枢纽只同步置 cancelRequested 并终止进程；最终状态在 close
  // 处理完成的那一处统一决定（cancelRequested → cancelled；terminating → timed_out；
  // 其余 completed），不依赖监听器执行顺序。close 已处理完的一侧不受迟到信号影响。
  // onSpawn / onSideClosed 只供测试注入（无 CLI 入口），默认 null 时零行为差异。
  const ctx = { sides, cancelled: false, interrupting: null, signalCount: 0, cancelGraceMs };
  installSignalHub();
  signalHub.rounds.add(ctx);

  const runSide = async side => {
    const entry = { child: null, state: "running", stdout: [], stderr: [], cancelRequested: false, closeDone: false };
    sides[side] = entry;
    const startedAt = new Date().toISOString();
    const argvFull = [...argv[side]];
    // Do not dispatch a new phase with files changed since packet assembly.
    // Repair/re-review requires a fresh packet and a new output directory.
    for (const [file, digest] of [["material.txt", binding.material_sha256], ["evidence-ids.json", binding.evidence_ids_sha256], ["prompt.txt", binding.prompt_sha256]]) {
      const target = path.join(out, file);
      if (fs.lstatSync(target).isSymbolicLink() || sha256File(target) !== digest) {
        entry.state = "not_started";
        entry.closeDone = true;
        entry.envKeys = [];
        entry.skipReason = "material_version_changed";
        return finishSide(side, entry, startedAt, null, null);
      }
    }
    const env = {
      ...envBase,
      TMPDIR: path.join(out, "tmp"), TMP: path.join(out, "tmp"), TEMP: path.join(out, "tmp"),
      REVIEW_SIDE: side, REVIEW_SCENARIO: scenario, REVIEW_RUN_DIR: out,
    };
    entry.envKeys = Object.keys(env).sort();
    try {
      // ZMX_TEST_SPAWN_EXECUTABLE 只供测试注入（如指向不存在的可执行文件，复现
      // 异步 spawn 失败）。不进入子进程 env（env 由固定键组装）、不进入任何记录
      // （execution.argv 记逻辑参数，不含可执行文件）。
      const childExec = process.env.ZMX_TEST_SPAWN_EXECUTABLE || process.execPath;
      entry.child = spawn(childExec, [wrappers[side], ...argvFull], { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      entry.child.stdout.on("data", chunk => entry.stdout.push(chunk));
      entry.child.stderr.on("data", chunk => entry.stderr.push(chunk));
      // 异步 spawn 失败（ENOENT/EACCES 等）不走 try/catch，走 error 事件：记
      // spawn_error 并视为已 close（信号升级路径不会再对它发 SIGKILL）。kill 失败
      // 类的 error（pid 已存在）不动状态机，交给 stopAndAwait 的宽限 SIGKILL。
      entry.child.once("error", () => {
        if (entry.state !== "running") return;
        if (entry.child.pid === undefined) {
          entry.state = "spawn_error";
          entry.closeDone = true;
        }
      });
      if (onSpawn) { try { onSpawn(side, entry.child); } catch {} }
    } catch {
      entry.state = "spawn_error";
      entry.closeDone = true; // 与异步 spawn_error 同一不变量：终态即 closeDone。
    }
    if (entry.state !== "running") {
      return finishSide(side, entry, startedAt, null, null);
    }
    const deadline = setTimeout(() => {
      // 取消之后才到的截止时间不改判：这一侧将由 close 后的取消优先级记 cancelled。
      if (entry.cancelRequested) return;
      if (entry.state === "running") {
        // 进程已自然退出（exitCode/signalCode 已设、close 事件尚未派发）时
        // 不标超时：close 会走正常完成路径。
        if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
        entry.state = "terminating";
        stopAndAwait(entry.child, cancelGraceMs).catch(() => {});
      }
    }, fakeProcessMs);
    await new Promise(resolve => {
      entry.child.once("close", resolve);
      // 正常情况下 spawn 失败后 close 仍会派发；此兜底仅防其缺席导致挂死。
      entry.child.once("error", () => { if (entry.child.pid === undefined) resolve(); });
    });
    clearTimeout(deadline);
    entry.closeDone = true;
    // Test-only cross-process synchronization: signal only after ZCode's
    // close event has been observed. No provider input or archive receipt
    // is modified, and the flag is absent outside this explicit test mode.
    if (side === "zcode" && process.env.ZMX_TEST_CLOSE_MARKER === "1") {
      fs.writeFileSync(path.join(out, "tmp", "zcode-closed.marker"), "closed\n", { flag: "wx", mode: 0o600 });
    }
    // 单点定态：取消优先于超时，超时优先于正常完成；spawn_error 已是终态，不改写。
    if (entry.state === "running" || entry.state === "terminating") {
      entry.state = entry.cancelRequested ? "cancelled" : entry.state === "terminating" ? "timed_out" : "completed";
    }
    if (onSideClosed) { try { onSideClosed(side, entry); } catch {} }
    // spawn_error 的进程从未启动：Node 会把 ENOENT 的 errno 填进 exitCode（如 -2），
    // 该值不是进程退出码，记录一律置 null。
    const failedToSpawn = entry.state === "spawn_error";
    return finishSide(side, entry, startedAt, failedToSpawn ? null : entry.child.exitCode, failedToSpawn ? null : entry.child.signalCode);
  };

  const finishSide = (side, entry, startedAt, code, signal) => {
    const stdoutBytes = Buffer.concat(entry.stdout.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    const stderrBytes = Buffer.concat(entry.stderr.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    // 状态已由 runSide 在 close 后单点决定（或 spawn_error/not_started 路径直接给定）。
    const state = entry.state;
    entry.child = null;
    const observedPath = path.join(out, `${side}-observed-input.json`);
    let observed = null;
    // 取消或超时的假进程也可能在挂起前已写完 observed（hang 场景就是先写再挂起）；
    // 文件存在即算捕获（execution 记其 sha）。内容不是合法 JSON 时降级为空对象，
    // 让绑定检查以不投票收场——不能记 unobserved，那要求文件必须不存在。
    if ((state === "completed" || state === "cancelled" || state === "timed_out") && fs.existsSync(observedPath)) {
      try { observed = readJsonFile(observedPath); } catch { observed = {}; }
      // 合法 JSON 但根不是对象（null/false/0/"" 等 falsey 值）同样降级：
      // 文件存在就必须记 sha，不能落回 unobserved 造成自相矛盾的档案。
      if (observed === null || typeof observed !== "object" || Array.isArray(observed)) observed = {};
    }
    const execution = {
      state, exit_code: code, signal: signal ?? null,
      started_at: startedAt, ended_at: new Date().toISOString(),
      stdout_sha256: hash(stdoutBytes), stderr_sha256: hash(stderrBytes),
      observed_input: observed ? sha256File(observedPath) : "unobserved",
      argv: argv[side],
      env_keys: entry.envKeys,
      deadline_ms: fakeProcessMs,
      material_version: binding.material_version,
    };
    if (entry.skipReason) execution.skip_reason = entry.skipReason;
    return { side, execution, stdoutBytes, stderrBytes, observed };
  };

  const results = {};
  const evaluated = {};
  let primaryResult = null;
  const persistAndEvaluate = side => {
    const record = results[side];
    persistSideRecords(out, record);
    evaluated[side] = evaluateSide(side, {
      execution: record.execution, stdoutBytes: record.stdoutBytes, observed: record.observed,
      expected: { ...expected, argv: argv[side] },
    });
    if (side === "zcode") {
      primaryResult = {
        entry_version: ENTRY_VERSION, backend: "fixture", strategy, ...binding,
        request_sha256: hash(requestJson),
        PRIMARY_REVIEW_GATE: evaluated.zcode.eligible ? evaluated.zcode.gate : "NOT_EVALUATED",
        SECONDARY_REVIEW_GATE: "NOT_EVALUATED",
        REVIEW_GATE: evaluated.zcode.eligible && evaluated.zcode.gate === "FAIL" ? "FAIL" : "NOT_EVALUATED",
        provider: evaluated.zcode,
        execution_sha256: sha256File(path.join(out, "zcode-execution.json")),
        stdout_sha256: record.execution.stdout_sha256,
        stderr_sha256: record.execution.stderr_sha256,
        observed_input: record.execution.observed_input,
        completed_at: record.execution.ended_at,
        note: "Primary checkpoint only; a primary PASS is not full dual-model acceptance.",
      };
      saveDurableRecord(path.join(out, "primary-result.json"), JSON.stringify(primaryResult, null, 2) + "\n");
      if (onPrimaryReady) onPrimaryReady(primaryResult);
    }
  };
  const runAndPersist = async side => {
    if (ctx.cancelled && !sides[side]) {
      results[side] = finishSide(side, { child: null, state: "not_started", stdout: [], stderr: [], envKeys: [], skipReason: "cancelled_before_start" }, new Date().toISOString(), null, null);
    } else {
      results[side] = await runSide(side);
    }
    persistAndEvaluate(side);
  };
  try {
    if (strategy === "dual-parallel") {
      // allSettled keeps a persistence failure from abandoning the other child.
      const running = ["zcode", "mmx"].map(side => runAndPersist(side).catch(async error => {
        ctx.cancelled = true;
        await Promise.all(Object.values(sides).filter(entry => entry.child && !entry.closeDone).map(entry => {
          entry.cancelRequested = true;
          return stopAndAwait(entry.child, cancelGraceMs);
        }));
        throw error;
      }));
      const settled = await Promise.allSettled(running);
      const rejected = settled.find(result => result.status === "rejected");
      if (rejected) throw rejected.reason;
    } else {
      await runAndPersist("zcode");
      if (evaluated.zcode.eligible && evaluated.zcode.gate === "FAIL") {
        results.mmx = finishSide("mmx", { child: null, state: "not_started", stdout: [], stderr: [], envKeys: [], skipReason: "primary_confirmed_defect" }, new Date().toISOString(), null, null);
        persistAndEvaluate("mmx");
      } else {
        // An invalid primary or P1 evidence gap cannot pass the round, but MMX
        // may still establish an independently valid P1 defect.
        await runAndPersist("mmx");
      }
    }
    if (ctx.interrupting) await ctx.interrupting;
  } finally {
    // 监听器本身进程级不卸载；只注销本轮上下文。信号在 round 结束后、记录写完
    // 前到达时由枢纽以 no-op 接住（入口存活、记录照常写出、不记取消）。
    signalHub.rounds.delete(ctx);
  }
  // 取消只在实际作用于某一侧时才记入结果：两侧均已完成后才到达的迟到信号
  // 不产生 cancelled=true，否则 result 与 execution 记录脱节、verify 永远 mismatch。
  const effectiveCancelled = ctx.cancelled && ["zcode", "mmx"].some(side =>
    results[side].execution.state === "cancelled" || results[side].execution.skip_reason === "cancelled_before_start");
  const outcome = tally({ cancelled: effectiveCancelled, sides: evaluated });
  return { strategy, material_version: binding.material_version, requestJson, primaryResult, cancelled: effectiveCancelled, executions: results, evaluated, outcome };
}

// ---------------------------------------------------------------------------
// 运行目录记录
// ---------------------------------------------------------------------------

const REQUIRED_RECORDS = Object.freeze([
  "packet.json", "material.txt", "evidence-ids.json", "prompt.txt", "request.json",
  "zcode-execution.json", "zcode-stdout.json", "zcode-stderr.log",
  "mmx-execution.json", "mmx-stdout.json", "mmx-stderr.log",
  "result.json",
]);

// 输入组必须在两侧 wrapper 启动之前落盘：wrapper 一启动就会读这些文件。
function writeRunInputs(out, { packetBytes, inputs }) {
  saveDurableRecord(path.join(out, "packet.json"), packetBytes);
  saveDurableRecord(path.join(out, "material.txt"), inputs.materialBytes);
  saveDurableRecord(path.join(out, "evidence-ids.json"), inputs.idsBytes);
  saveDurableRecord(path.join(out, "prompt.txt"), Buffer.from(inputs.prompt, "utf8"));
}

// Returns the digests of the exact bytes it verified and published, so the
// final manifest never has to re-read a file that may have changed since.
function persistSideRecords(out, record) {
  const digests = {};
  if (record.execution.observed_input !== "unobserved") {
    const file = path.join(out, `${record.side}-observed-input.json`);
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== record.execution.observed_input) throw new Error("observed input changed before persistence");
    saveDurableRecord(file, bytes);
    digests[`${record.side}-observed-input.json`] = record.execution.observed_input;
  }
  saveDurableRecord(path.join(out, `${record.side}-stdout.json`), record.stdoutBytes);
  saveDurableRecord(path.join(out, `${record.side}-stderr.log`), record.stderrBytes);
  const executionBytes = Buffer.from(JSON.stringify(record.execution, null, 2) + "\n", "utf8");
  saveDurableRecord(path.join(out, `${record.side}-execution.json`), executionBytes);
  digests[`${record.side}-stdout.json`] = record.execution.stdout_sha256;
  digests[`${record.side}-stderr.log`] = record.execution.stderr_sha256;
  digests[`${record.side}-execution.json`] = hash(executionBytes);
  return digests;
}

function buildRunRequest(inputs, { strategy, scenario, timeoutSeconds, maxTokens, argv, envKeys }) {
  return {
    entry_version: ENTRY_VERSION,
    strategy,
    ...materialBinding(inputs),
    packet_sha256: hash(inputs.packetBytes),
    backend: "fixture", scenario, timeout_seconds: timeoutSeconds, max_tokens: maxTokens,
    argv,
    // 组装时的基础环境键名（不含 fixture 机制注入的 TMPDIR/TMP/TEMP/REVIEW_*）；
    // 子进程实际键集见 <side>-observed-input.json 的 env_keys。
    env_keys: envKeys,
    adjudication_code: Object.fromEntries(Object.entries(ADJUDICATION_FILES).map(([name, file]) => [name, sha256File(file)])),
    provenance_code: Object.fromEntries(Object.entries(PROVENANCE_FILES).map(([name, file]) => [name, sha256File(file)])),
  };
}

// Inputs are sealed before either wrapper starts. Publication verifies the
// archived copies against the launch-time digests recorded in the prelaunch
// request. Nothing is recomputed from files that may have changed after
// dispatch, and a changed, missing or replaced input publishes no result.
const SEALED_INPUTS = Object.freeze([
  ["packet.json", "packet_sha256"],
  ["material.txt", "material_sha256"],
  ["evidence-ids.json", "evidence_ids_sha256"],
  ["prompt.txt", "prompt_sha256"],
]);

function writeRunRecords(out, { round, warnings = [] }) {
  // Reuse the exact immutable prelaunch intent, including its original code
  // fingerprints. Never rebuild a request from mutable files after execution.
  const request = strictJson(round.requestJson);
  const manifest = {};
  for (const [name, key] of SEALED_INPUTS) {
    const file = path.join(out, name);
    let stat = null;
    try { stat = fs.lstatSync(file); } catch {}
    const problem = !stat ? "missing" : stat.isSymbolicLink() || !stat.isFile() ? "replaced"
      : sha256File(file) !== request[key] ? "changed" : null;
    if (problem) {
      // An integrity problem is not a content FAIL. The evaluation below
      // describes only the launch-time material version and is kept for
      // diagnosis; no complete result is published for any later file state.
      saveNew(path.join(out, "integrity-error.json"), JSON.stringify({
        entry_version: ENTRY_VERSION, backend: "fixture", integrity: "corrupt",
        problem: `archived input ${problem} before publication: ${name}`,
        material_version: round.material_version,
        evaluation_of_launch_material: { cancelled: round.cancelled, round_status: round.outcome.round_status,
          review_gate: round.outcome.review_gate, PRIMARY_REVIEW_GATE: round.outcome.PRIMARY_REVIEW_GATE,
          SECONDARY_REVIEW_GATE: round.outcome.SECONDARY_REVIEW_GATE, REVIEW_GATE: round.outcome.REVIEW_GATE },
        note: "No result.json or record-manifest.json is published. The gates above belong to the launch-time material version only.",
      }, null, 2) + "\n");
      throw Object.assign(new Error(`archived input ${problem} before publication: ${name}`), { code: "ZMX_ARCHIVE_INTEGRITY" });
    }
    manifest[name] = request[key];
  }
  saveDurableRecord(path.join(out, "request.json"), round.requestJson);
  manifest["request.json"] = hash(round.requestJson);
  for (const side of ["zcode", "mmx"]) Object.assign(manifest, persistSideRecords(out, round.executions[side]));
  const primaryBytes = Buffer.from(JSON.stringify(round.primaryResult, null, 2) + "\n", "utf8");
  saveDurableRecord(path.join(out, "primary-result.json"), primaryBytes);
  manifest["primary-result.json"] = hash(primaryBytes);
  const result = {
    entry_version: ENTRY_VERSION,
    backend: "fixture",
    strategy: round.strategy,
    material_version: round.material_version,
    scenario: request.scenario, timeout_seconds: request.timeout_seconds, max_tokens: request.max_tokens,
    cancelled: round.cancelled,
    round_status: round.outcome.round_status,
    review_gate: round.outcome.review_gate,
    PRIMARY_REVIEW_GATE: round.outcome.PRIMARY_REVIEW_GATE,
    SECONDARY_REVIEW_GATE: round.outcome.SECONDARY_REVIEW_GATE,
    REVIEW_GATE: round.outcome.REVIEW_GATE,
    exit_code: round.outcome.exit_code,
    families_known: round.outcome.families_known,
    independent: round.outcome.independent,
    material_warnings: warnings,
    providers: Object.fromEntries(["zcode", "mmx"].map(side => [side, round.evaluated[side]])),
    note: "backend=fixture: served by repository fixtures, not an external review",
    completed_at: new Date().toISOString(),
  };
  const resultBytes = Buffer.from(JSON.stringify(result, null, 2) + "\n", "utf8");
  // Every digest above comes from bytes verified in memory. The manifest is
  // published first and result.json last, so a visible result.json always
  // belongs to a complete, verified archive; a manifest without result.json
  // fails verify as incomplete.
  manifest["result.json"] = hash(resultBytes);
  saveNew(path.join(out, "record-manifest.json"), JSON.stringify({ format: 1, files: manifest }, null, 2) + "\n");
  saveNew(path.join(out, "result.json"), resultBytes);
  return result;
}

// ---------------------------------------------------------------------------
// verify：只读运行，不跟随外链，不调用任何 wrapper
// ---------------------------------------------------------------------------

function verifyRun(directory) {
  const problems = [];
  const problem = message => problems.push(message);
  const resolveInside = name => {
    if (typeof name !== "string" || !name || path.isAbsolute(name) || name.split("/").some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) {
      problem(`manifest path is not a safe relative name: ${JSON.stringify(name)}`);
      return null;
    }
    return path.join(directory, name);
  };
  const refused = path.join(directory, "integrity-error.json");
  if (fs.existsSync(refused)) {
    // Publication was refused before any result existed; say why.
    try { problem(`publication refused: ${readJsonFile(refused).problem}`); } catch { problem("publication refused: integrity-error.json is unreadable"); }
  }
  let manifest = null;
  try {
    const manifestPath = path.join(directory, "record-manifest.json");
    // 清单自身同样不得是链接、不得逃出运行目录。
    const manifestStat = fs.lstatSync(manifestPath);
    const runRoot = fs.realpathSync(directory);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) problem("record-manifest.json is not a regular file");
    else if (!fs.realpathSync(manifestPath).startsWith(runRoot + path.sep)) problem("record-manifest.json escapes the run directory");
    else {
      const raw = fs.readFileSync(manifestPath);
      manifest = strictJson(raw.toString("utf8"));
      if (manifest === null || typeof manifest !== "object" || manifest.format !== 1 || manifest.files === null || typeof manifest.files !== "object" || Array.isArray(manifest.files)) problem("record-manifest.json is malformed");
    }
  } catch { problem("record-manifest.json is missing or not strict JSON"); }
  const listed = new Set(manifest && manifest.files ? Object.keys(manifest.files) : []);
  for (const name of REQUIRED_RECORDS) if (!listed.has(name)) problem(`required record missing from manifest: ${name}`);
  for (const [name, digest] of manifest && manifest.files ? Object.entries(manifest.files) : []) {
    const file = resolveInside(name);
    if (!file) continue;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) { problem(`record is not a regular file: ${name}`); continue; }
      const real = fs.realpathSync(file);
      if (!real.startsWith(fs.realpathSync(directory) + path.sep)) { problem(`record escapes the run directory: ${name}`); continue; }
      if (sha256File(file) !== digest) problem(`record digest mismatch: ${name}`);
    } catch { problem(`record unreadable: ${name}`); }
  }
  const read = name => { try { return fs.readFileSync(path.join(directory, name)); } catch { problem(`cannot read ${name}`); return null; } };
  const executions = {};
  for (const side of ["zcode", "mmx"]) {
    const raw = read(`${side}-execution.json`);
    if (!raw) continue;
    try {
      const execution = strictJson(raw.toString("utf8"));
      if (!["completed", "timed_out", "cancelled", "not_started", "spawn_error"].includes(execution?.state)) problem(`${side}-execution.json: bad state`);
      for (const field of ["state", "exit_code", "signal", "started_at", "ended_at", "stdout_sha256", "stderr_sha256", "observed_input", "argv", "env_keys"]) {
        if (execution[field] === undefined) problem(`${side}-execution.json: ${field} missing`);
      }
      if (typeof execution.observed_input !== "string") problem(`${side}-execution.json: observed_input missing`);
      else if (execution.observed_input === "unobserved") {
        if (fs.existsSync(path.join(directory, `${side}-observed-input.json`))) problem(`${side}: observed file exists but execution says unobserved`);
      } else {
        const observedName = `${side}-observed-input.json`;
        if (!listed.has(observedName)) problem(`${side}: observed file referenced but not listed`);
        else if (manifest.files[observedName] !== execution.observed_input) problem(`${side}: observed digest disagrees with execution record`);
      }
      if (!Array.isArray(execution.argv) || !Array.isArray(execution.env_keys)) problem(`${side}-execution.json: argv/env_keys missing`);
      // execution 里声明的 stdout/stderr 摘要必须与归档文件（经 manifest 校验）一致。
      for (const stream of ["stdout", "stderr"]) {
        const archive = `${side}-${stream}${stream === "stdout" ? ".json" : ".log"}`;
        if (typeof execution[`${stream}_sha256`] === "string" && listed.has(archive) && manifest.files[archive] !== execution[`${stream}_sha256`]) {
          problem(`${side}: execution ${stream} digest disagrees with the archive`);
        }
      }
      executions[side] = execution;
    } catch { problem(`${side}-execution.json is not strict JSON`); }
  }
  let request = null;
  const requestRaw = read("request.json");
  if (requestRaw) {
    try {
      request = strictJson(requestRaw.toString("utf8"));
      for (const key of ["packet_sha256", "material_sha256", "evidence_ids_sha256", "prompt_sha256", "argv", "adjudication_code"]) {
        if (request?.[key] === undefined) problem(`request.json: ${key} missing`);
      }
      if (request?.adjudication_code !== undefined && (request.adjudication_code === null || typeof request.adjudication_code !== "object" || Array.isArray(request.adjudication_code))) {
        problem("request.json: adjudication_code must be an object");
      }
      if (request?.argv !== undefined && (request.argv === null || typeof request.argv !== "object" || Array.isArray(request.argv))) {
        problem("request.json: argv must be an object");
      }
      if (request?.entry_version === ENTRY_VERSION) {
        if (!STRATEGIES.includes(request.strategy)) problem("request.json: invalid strategy");
        if (!/^[0-9a-f]{64}$/.test(request.material_version ?? "")) problem("request.json: material_version missing or invalid");
        if (!listed.has("primary-result.json")) problem("required record missing from manifest: primary-result.json");
      }
    } catch { problem("request.json is not strict JSON"); }
  }
  if (problems.length) return { integrity: "corrupt", problems, replay: null, exit_code: 2 };

  // 判定代码集一致才复判；否则只报版本漂移。
  const drift = Object.entries(ADJUDICATION_FILES).filter(([name, file]) => request.adjudication_code[name] !== sha256File(file)).map(([name]) => name);
  if (drift.length) return { integrity: "ok", replay: "version_drift", drifted: drift, exit_code: 2 };

  // 从归档与实收数据重算。
  const packetBytes = read("packet.json");
  const materialBytes = read("material.txt");
  const idsBytes = read("evidence-ids.json");
  const promptBytes = read("prompt.txt");
  const recomputed = {
    packet_sha256: hash(packetBytes),
    material_sha256: hash(materialBytes),
    evidence_ids_sha256: hash(idsBytes),
    prompt_sha256: hash(promptBytes),
  };
  const replayProblems = [];
  if (request.entry_version !== ENTRY_VERSION) replayProblems.push("request.json: entry_version disagrees with adjudication code");
  let inputs = null;
  try {
    inputs = buildRunPacket(packetBytes);
    if (!inputs.materialBytes.equals(materialBytes)) replayProblems.push("material.txt does not match the packet");
    if (!inputs.idsBytes.equals(idsBytes)) replayProblems.push("evidence-ids.json does not match the packet");
    if (Buffer.compare(Buffer.from(inputs.prompt, "utf8"), promptBytes) !== 0) replayProblems.push("prompt.txt does not match the packet");
    for (const key of ["packet_sha256", "material_sha256", "evidence_ids_sha256", "prompt_sha256"]) {
      if (recomputed[key] !== request[key]) replayProblems.push(`request.json ${key} disagrees with the archive`);
    }
    if (materialBinding(inputs).material_version !== request.material_version) replayProblems.push("request.json material_version disagrees with the packet");
  } catch (error) { replayProblems.push(`packet does not reparse: ${String(error?.message ?? error).slice(0, 120)}`); }
  const cancelled = ["zcode", "mmx"].some(side => executions[side]?.state === "cancelled" || executions[side]?.skip_reason === "cancelled_before_start");
  const sides = {};
  for (const side of ["zcode", "mmx"]) {
    if (executions[side].material_version !== request.material_version) replayProblems.push(`${side}: material_version disagrees with the request`);
    let observed = null;
    if (executions[side].observed_input !== "unobserved") {
      try { observed = readJsonFile(path.join(directory, `${side}-observed-input.json`)); } catch { observed = {}; }
      if (observed === null || typeof observed !== "object" || Array.isArray(observed)) observed = {}; // 与 run 侧同降级：坏/falsey 内容交给绑定检查拒票
    }
    sides[side] = evaluateSide(side, {
      execution: executions[side],
      stdoutBytes: read(`${side}-stdout.json`),
      observed,
      expected: {
        materialBytes, idsBytes,
        ids: inputs ? inputs.ids : [],
        prompt: promptBytes.toString("utf8"),
        promptBytes,
        argv: (request.argv && request.argv[side]) || [],
      },
    });
  }
  const outcome = tally({ cancelled, sides });
  let primary = null;
  try { primary = readJsonFile(path.join(directory, "primary-result.json")); }
  catch { replayProblems.push("primary-result.json is not strict JSON"); }
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) replayProblems.push("primary-result.json must be an object");
  else {
    for (const key of ["material_version", "material_sha256", "evidence_ids_sha256", "prompt_sha256", "strategy", "entry_version", "backend"]) {
      if (primary[key] !== request[key]) replayProblems.push(`primary-result.json ${key} disagrees with the request`);
    }
    if (primary.request_sha256 !== manifest.files["request.json"]) replayProblems.push("primary-result.json request digest disagrees with the prelaunch intent");
    if (primary.execution_sha256 !== manifest.files["zcode-execution.json"]) replayProblems.push("primary-result.json execution digest disagrees with the primary archive");
    for (const key of ["stdout_sha256", "stderr_sha256", "observed_input"]) {
      if (primary[key] !== executions.zcode[key]) replayProblems.push(`primary-result.json ${key} disagrees with the primary execution`);
    }
    if (JSON.stringify(primary.provider) !== JSON.stringify(sides.zcode)) replayProblems.push("primary-result.json provider disagrees with replayed primary");
    if (primary.PRIMARY_REVIEW_GATE !== outcome.PRIMARY_REVIEW_GATE) replayProblems.push("primary-result.json PRIMARY_REVIEW_GATE disagrees with replayed primary");
    if (primary.SECONDARY_REVIEW_GATE !== "NOT_EVALUATED") replayProblems.push("primary-result.json cannot assert secondary acceptance");
    if (primary.REVIEW_GATE !== (outcome.PRIMARY_REVIEW_GATE === "FAIL" ? "FAIL" : "NOT_EVALUATED")) replayProblems.push("primary-result.json REVIEW_GATE disagrees with primary-only adjudication");
  }
  if (request.strategy === "primary-first") {
    if (sides.zcode.eligible && sides.zcode.gate === "FAIL" &&
        (executions.mmx.state !== "not_started" || executions.mmx.skip_reason !== "primary_confirmed_defect")) {
      replayProblems.push("primary-first must skip MMX after a valid primary blocker");
    }
    if (executions.mmx.state !== "not_started" &&
        !(Date.parse(executions.mmx.started_at) >= Date.parse(executions.zcode.ended_at))) {
      replayProblems.push("primary-first MMX started before primary completion");
    }
  }
  let result = null;
  try { result = readJsonFile(path.join(directory, "result.json")); } catch { replayProblems.push("result.json is not strict JSON"); }
  // 合法 JSON 但根不是对象（null 等 falsey 值）同样按畸形处理，不能静默跳过比对。
  if (result !== null && (typeof result !== "object" || Array.isArray(result))) {
    replayProblems.push("result.json must be a JSON object");
    result = null;
  }
  if (!result) {
    if (!replayProblems.some(problem => problem.startsWith("result.json"))) replayProblems.push("result.json missing or unusable");
  } else {
    if (result.round_status !== outcome.round_status) replayProblems.push(`result.json round_status ${result.round_status} != replayed ${outcome.round_status}`);
    if (result.review_gate !== outcome.review_gate) replayProblems.push(`result.json review_gate ${result.review_gate} != replayed ${outcome.review_gate}`);
    if (result.cancelled !== cancelled) replayProblems.push(`result.json cancelled ${result.cancelled} != replayed ${cancelled}`);
    if (result.exit_code !== outcome.exit_code) replayProblems.push(`result.json exit_code ${result.exit_code} != replayed ${outcome.exit_code}`);
    if (result.families_known !== outcome.families_known) replayProblems.push(`result.json families_known ${result.families_known} != replayed ${outcome.families_known}`);
    if (result.independent !== outcome.independent) replayProblems.push(`result.json independent ${result.independent} != replayed ${outcome.independent}`);
    for (const key of ["PRIMARY_REVIEW_GATE", "SECONDARY_REVIEW_GATE", "REVIEW_GATE"]) {
      if (result[key] !== outcome[key]) replayProblems.push(`result.json ${key} disagrees with replayed gate`);
    }
    for (const key of ["strategy", "material_version"]) {
      if (result[key] !== request[key]) replayProblems.push(`result.json ${key} disagrees with the request`);
    }
    for (const side of ["zcode", "mmx"]) {
      const recorded = result.providers?.[side];
      if (!recorded) { replayProblems.push(`result.json missing provider ${side}`); continue; }
      const replayed = sides[side];
      if (recorded.eligible !== replayed.eligible) replayProblems.push(`${side}: eligible ${recorded.eligible} != replayed ${replayed.eligible}`);
      if (recorded.gate !== replayed.gate) replayProblems.push(`${side}: gate ${recorded.gate} != replayed ${replayed.gate}`);
      if (recorded.model_family !== replayed.model_family) replayProblems.push(`${side}: model_family ${recorded.model_family} != replayed ${replayed.model_family}`);
      if (recorded.material_bound !== replayed.material_bound) replayProblems.push(`${side}: material_bound ${recorded.material_bound} != replayed ${replayed.material_bound}`);
      if ((recorded.reason ?? null) !== (replayed.reason ?? null)) replayProblems.push(`${side}: reason ${JSON.stringify(recorded.reason)} != replayed ${JSON.stringify(replayed.reason)}`);
      if (JSON.stringify(recorded.diagnostic?.text ?? null) !== JSON.stringify(replayed.diagnostic?.text ?? null)) replayProblems.push(`${side}: diagnostic.text disagrees with the archived receipt`);
      if ((recorded.diagnostic?.gate ?? null) !== (replayed.diagnostic?.gate ?? null)) replayProblems.push(`${side}: diagnostic.gate ${recorded.diagnostic?.gate} != replayed ${replayed.diagnostic?.gate}`);
      if ((recorded.diagnostic?.receipt_status ?? null) !== (replayed.diagnostic?.receipt_status ?? null)) replayProblems.push(`${side}: diagnostic.receipt_status ${recorded.diagnostic?.receipt_status} != replayed ${replayed.diagnostic?.receipt_status}`);
      if ((recorded.coverage_declared ?? null) !== (replayed.coverage_declared ?? null)) replayProblems.push(`${side}: coverage_declared ${JSON.stringify(recorded.coverage_declared)} != replayed ${JSON.stringify(replayed.coverage_declared)}`);
      if (recorded.model !== replayed.model) replayProblems.push(`${side}: model ${JSON.stringify(recorded.model)} != replayed ${JSON.stringify(replayed.model)}`);
      if (JSON.stringify(recorded.review ?? null) !== JSON.stringify(replayed.review ?? null)) replayProblems.push(`${side}: review content disagrees with the replayed adjudication`);
    }
  }
  return {
    integrity: "ok",
    replay: replayProblems.length ? "mismatch" : "match",
    problems: replayProblems,
    replayed: { round_status: outcome.round_status, review_gate: outcome.review_gate,
      PRIMARY_REVIEW_GATE: outcome.PRIMARY_REVIEW_GATE, SECONDARY_REVIEW_GATE: outcome.SECONDARY_REVIEW_GATE, REVIEW_GATE: outcome.REVIEW_GATE, cancelled },
    exit_code: replayProblems.length ? 2 : 0,
    note: "local self-consistency check only: it does not prove what the upstream model received and cannot detect tampering",
  };
}

// ---------------------------------------------------------------------------
// doctor --offline（本轮唯一的预检）
// ---------------------------------------------------------------------------

function doctorOffline(root = SKILLS) {
  const checks = [];
  const required = [
    "zcode/scripts/review.js", "zcode/scripts/zcode-chat.js", "zcode/references/review-v1.schema.json",
    "zcode/.zcode-release.json",
    "mmx/scripts/mmx-chat.js", "mmx/references/review-v1.schema.json", "mmx/profiles/local.json",
    "zcode-mmx-review/scripts/review-run.js", "zcode-mmx-review/examples/packet.json", "zcode-mmx-review/examples/packet-v2.json",
    "zcode-mmx-review/tests/fixtures/backends/zcode-fake-wrapper.cjs",
    "zcode-mmx-review/tests/fixtures/backends/mmx-fake-wrapper.cjs",
    "zcode-mmx-review/tests/fixtures/backends/scenarios.json",
    "zcode-mmx-review/tests/fixtures/native/fake-zcode-cli.cjs",
    "zcode-mmx-review/tests/fixtures/native/mmx",
  ];
  for (const relative of required) {
    const file = path.join(root, relative);
    let ok = true;
    try { if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) ok = false; } catch { ok = false; }
    checks.push({ name: `file:${relative}`, ok });
  }
  try {
    const a = fs.readFileSync(path.join(root, "zcode/references/review-v1.schema.json"));
    const b = fs.readFileSync(path.join(root, "mmx/references/review-v1.schema.json"));
    checks.push({ name: "review_schema_byte_equal", ok: a.equals(b) });
  } catch { checks.push({ name: "review_schema_byte_equal", ok: false }); }
  try {
    const marker = readJsonFile(path.join(root, "zcode/.zcode-release.json"));
    const versionRun = spawnSync(process.execPath, [path.join(root, "zcode/scripts/zcode-chat.js"), "--version"], { encoding: "utf8", timeout: 15000, shell: false });
    const version = versionRun.status === 0 ? strictJson(versionRun.stdout).version : null;
    checks.push({ name: "zcode_release_version_matches_wrapper", ok: marker?.format === 1 && typeof marker?.version === "string" && marker.version === version, manifest_version: marker?.version ?? null, wrapper_version: version });
  } catch { checks.push({ name: "zcode_release_version_matches_wrapper", ok: false }); }
  try {
    require(path.join(root, "zcode/scripts/zcode-chat.js")).checkInstall();
    checks.push({ name: "zcode_check_install", ok: true });
  } catch { checks.push({ name: "zcode_check_install", ok: false }); }
  checks.push({ name: "cli", ok: true, result: "unchecked" });
  return {
    status: checks.every(check => check.ok) ? "ok" : "failed",
    mode: "offline", platform: process.platform, arch: process.arch, checks,
    real_api: "not_called",
    note: "proves only that the manifest matches local files; it does not vouch for provenance or CLI readiness",
  };
}

// ---------------------------------------------------------------------------
// pack（材料合同 v2 组装；不启动 git，也不运行测试）
// ---------------------------------------------------------------------------

// 日志尾部：取末尾不超过 limit 的字节，按 UTF-8 字符边界截取。
function tailUtf8(bytes, limit = LIMITS.logTailBytes) {
  if (bytes.length <= limit) return bytes.toString("utf8");
  let slice = bytes.subarray(bytes.length - limit);
  // 开头若是多字节字符的中间字节，跳到下一个字符边界；极端情况下整段都是
  // 中间字节时清空（返回空串），不产生替换字符。
  while (slice.length && (slice[0] & 0xc0) === 0x80) slice = slice.subarray(1);
  return slice.toString("utf8");
}

function readJsonArgument(file, what) {
  let parsed;
  try { parsed = strictJson(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${what} (${file}) is unreadable or not strict JSON: ${String(error?.message ?? error).slice(0, 80)}`); }
  return parsed;
}

function readUtf8Argument(file, what) {
  const bytes = fs.readFileSync(file);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail(`${what} (${file}) is not valid UTF-8; patches and logs must be losslessly representable`); }
}

function packFrom(args) {
  const packet = {};
  if (args.facts) {
    const facts = readJsonArgument(args.facts, "--facts");
    if (!Array.isArray(facts) || facts.some(fact => fact === null || typeof fact !== "object" || Array.isArray(fact) ||
        Object.keys(fact).length !== 2 || typeof fact.id !== "string" || typeof fact.text !== "string" || !fact.text.trim())) {
      fail("--facts must be a JSON array of {id, text}");
    }
    packet.facts = facts;
  }
  if (args.goalFile) {
    const goal = readJsonArgument(args.goalFile, "--goal-file");
    if (goal === null || typeof goal !== "object" || Array.isArray(goal)) fail("--goal-file must be a JSON object");
    packet.goal = goal;
  }
  if (args.patchFile) {
    const patch = readUtf8Argument(args.patchFile, "--patch-file");
    const bytes = Buffer.from(patch, "utf8");
    if (!bytes.length) fail("--patch-file is empty; an empty patch cannot be represented");
    if (bytes.length > LIMITS.patchMaxBytes) fail(`--patch-file exceeds ${LIMITS.patchMaxBytes} bytes`);
    packet.changes = {
      kind: args.kind,
      base: args.base,
      ...(args.head ? { head: args.head } : {}),
      patch,
      patch_sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  if (args.testLogs.length) {
    packet.execution = { tests: args.testLogs.map(triple => {
      const bytes = fs.readFileSync(triple.log);
      // 日志与补丁同门槛：不能无损 UTF-8 表示的输入拒绝，不把替换字符带进材料。
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { fail(`--test-log (${triple.log}) is not valid UTF-8; patches and logs must be losslessly representable`); }
      return {
        cmd: triple.cmd,
        exit_code: triple.exit,
        source: "host_reported",
        log_bytes: bytes.length,
        log_sha256: createHash("sha256").update(bytes).digest("hex"),
        tail_only: true,
        output_tail: tailUtf8(bytes),
      };
    }) };
  }
  if (args.claimsFile) {
    const claims = readJsonArgument(args.claimsFile, "--claims-file");
    if (!Array.isArray(claims) || claims.some(value => typeof value !== "string" || !value.trim())) fail("--claims-file must be a JSON array of nonempty strings");
    packet.claims = claims;
  }
  const hasSection = ["goal", "changes", "execution", "claims"].some(key => packet[key] !== undefined);
  if (hasSection || packet.facts) packet.provenance = { generated_by: "review-run pack", packet_version: 2 };
  // 与 run/verify 共用同一套校验和规范化；pack 不得写出 run 会拒收的包。
  const validated = packetFrom(JSON.stringify(packet));
  if (validated.changes !== undefined) verifyChanges(validated.changes);
  evidenceIdsFrom(validated); // 保留 ID 冲突等 ID 层校验也在 pack 侧执行。
  materialFrom(validated); // 同时强制 material 上限。
  return validated;
}

function parsePackArgs(argv) {
  const args = { action: "pack", testLogs: [] };
  const singles = { "--out": "out", "--facts": "facts", "--goal-file": "goalFile", "--patch-file": "patchFile", "--base": "base", "--kind": "kind", "--head": "head", "--claims-file": "claimsFile" };
  const seen = new Set();
  const logs = [], cmds = [], exits = [];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--test-log") { if (!argv[i + 1] || argv[i + 1].startsWith("--")) fail("--test-log requires exactly one value"); logs.push(argv[++i]); continue; }
    if (flag === "--test-cmd") { if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) fail("--test-cmd requires exactly one value"); cmds.push(argv[++i]); continue; }
    if (flag === "--test-exit") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail("--test-exit requires an integer");
      exits.push(Number(value)); i++; continue;
    }
    if (!Object.hasOwn(singles, flag) || seen.has(flag)) fail(`unknown or duplicate option: ${flag}`);
    seen.add(flag);
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) fail(`${flag} requires exactly one value`);
    args[singles[flag]] = argv[++i];
  }
  if (!(logs.length === cmds.length && cmds.length === exits.length)) fail("--test-log/--test-cmd/--test-exit must appear in complete triples");
  args.testLogs = logs.map((log, index) => ({ log, cmd: cmds[index], exit: exits[index] }));
  if (!args.out) fail("pack requires --out");
  if (args.patchFile && (!args.base || !args.kind)) fail("--patch-file requires --base and --kind");
  if (!args.patchFile && (args.base || args.kind || args.head)) fail("--base/--kind/--head only pair with --patch-file");
  if (args.kind && !["worktree_patch", "commit_range"].includes(args.kind)) fail("--kind must be worktree_patch or commit_range");
  if (args.kind === "commit_range" && !args.head) fail("commit_range requires --head");
  if (args.kind === "worktree_patch" && args.head) fail("worktree_patch must not carry --head");
  if (args.base && !SHA40.test(args.base)) fail("--base must be a 40-hex SHA");
  if (args.head && !SHA40.test(args.head)) fail("--head must be a 40-hex SHA");
  return args;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argsFrom(argv) {
  const action = argv[0];
  if (!["doctor", "run", "verify", "pack"].includes(action)) fail(USAGE);
  if (action === "pack") return parsePackArgs(argv);
  const args = { action, strategy: "primary-first", timeout: LIMITS.defaultTimeout, maxTokens: LIMITS.defaultMaxTokens };
  const allowed = action === "doctor" ? ["--offline", "--json"]
    : action === "verify" ? ["--run"]
    : ["--backend", "--scenario", "--packet", "--out", "--strategy", "--timeout-seconds", "--max-tokens"];
  const names = { "--packet": "packet", "--out": "out", "--run": "run", "--backend": "backend", "--scenario": "scenario", "--timeout-seconds": "timeout", "--max-tokens": "maxTokens" };
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag) || seen.has(flag)) fail(`unknown or duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--offline" || flag === "--json") args[flag.slice(2)] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) fail(`${flag} requires exactly one value`);
      args[names[flag] ?? flag.slice(2)] = argv[++i];
    }
  }
  if (action === "run") {
    if (!args.backend) fail("--backend is required and has no default");
    if (args.backend === "real") fail("the real backend is not enabled in this version");
    if (args.backend !== "fixture") fail(`unsupported backend: ${args.backend}`);
    if (!STRATEGIES.includes(args.strategy)) fail(`--strategy must be ${STRATEGIES.join(" or ")}`);
    if (!args.scenario || !args.packet || !args.out) fail("run requires --scenario, --packet and --out");
    args.timeout = Number(args.timeout);
    args.maxTokens = Number(args.maxTokens);
    if (!Number.isSafeInteger(args.timeout) || args.timeout < LIMITS.timeoutMin || args.timeout > LIMITS.timeoutMax) fail(`--timeout-seconds must be an integer in ${LIMITS.timeoutMin}..${LIMITS.timeoutMax}`);
    if (!Number.isSafeInteger(args.maxTokens) || args.maxTokens < 1) fail("--max-tokens must be a positive safe integer");
  }
  if (action === "verify" && !args.run) fail("verify requires --run");
  return args;
}

async function main(argv) {
  const args = argsFrom(argv);
  if (args.action === "doctor") {
    const report = doctorOffline();
    if (args.json) process.stdout.write(JSON.stringify(report) + "\n");
    else {
      for (const check of report.checks) process.stdout.write(`${check.ok ? "ok" : "FAIL"}  ${check.name}${check.ok === false ? `  (${JSON.stringify(check).slice(0, 160)})` : ""}\n`);
      process.stdout.write(`doctor: ${report.status} (offline)\n`);
    }
    return report.status === "ok" ? 0 : 1;
  }
  if (args.action === "verify") {
    const report = verifyRun(path.resolve(args.run));
    process.stdout.write(JSON.stringify(report) + "\n");
    return report.exit_code;
  }
  if (args.action === "run") {
    // 场景表与 wrapper 同样必须是 fixtures/backends 目录内的普通文件、非符号链接。
    checkFixtureFile(SCENARIOS_FILE, path.dirname(SCENARIOS_FILE));
    const scenarios = readJsonFile(SCENARIOS_FILE);
    if (!Object.hasOwn(scenarios, args.scenario)) fail(`--scenario must name a key of tests/fixtures/backends/scenarios.json; got ${JSON.stringify(args.scenario)}`);
    const packetBytes = fs.readFileSync(args.packet);
    const inputs = buildRunPacket(packetBytes);
    const out = path.resolve(args.out);
    if (fs.existsSync(out)) fail(`--out must be a new directory: ${out} already exists`);
    fs.mkdirSync(out, { mode: 0o700 });
    writeRunInputs(out, { packetBytes, inputs });
    const assembled = assembleInputs({ materialPath: path.join(out, "material.txt"), idsPath: path.join(out, "evidence-ids.json"), promptPath: path.join(out, "prompt.txt"), timeoutSeconds: args.timeout, maxTokens: args.maxTokens });
    const argvBySide = { zcode: assembled.zcode.argv, mmx: assembled.mmx.argv };
    const round = await runFixtureRound(inputs, {
      out, scenario: args.scenario, strategy: args.strategy, timeoutSeconds: args.timeout, maxTokens: args.maxTokens,
      argv: argvBySide, envBase: assembled.zcode.env,
      // Keep final stdout a single JSON object for existing consumers. Hosts
      // can deliver this event immediately and read the durable checkpoint.
      onPrimaryReady: primary => process.stderr.write(JSON.stringify({
        event: "PRIMARY_REVIEW_READY", file: path.join(out, "primary-result.json"),
        material_version: primary.material_version,
        PRIMARY_REVIEW_GATE: primary.PRIMARY_REVIEW_GATE,
        SECONDARY_REVIEW_GATE: primary.SECONDARY_REVIEW_GATE,
        REVIEW_GATE: primary.REVIEW_GATE,
      }) + "\n"),
    });
    // 只供测试：撑开"两侧 close 之后、记录写完之前"的窗口，供 CLI 层信号用例
    // 确定性发信号。默认 0，生产路径无延迟。该 env 不进入子进程环境与任何记录。
    const holdMs = Number(process.env.ZMX_TEST_HOLD_BEFORE_RECORDS_MS ?? 0);
    if (Number.isSafeInteger(holdMs) && holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs));
    let result;
    try {
      result = writeRunRecords(out, { scenario: args.scenario, timeoutSeconds: args.timeout, maxTokens: args.maxTokens, argv: argvBySide, envKeys: Object.keys(assembled.zcode.env).sort(), round, warnings: inputs.warnings });
    } catch (error) {
      // A sealed input changed, disappeared or was replaced: nothing is
      // published. The event names the diagnostic record; stdout stays empty
      // so no consumer can mistake this for a complete result.
      if (error.code === "ZMX_ARCHIVE_INTEGRITY") process.stderr.write(JSON.stringify({
        event: "RESULT_NOT_PUBLISHED", file: path.join(out, "integrity-error.json"),
        material_version: round.material_version, error: error.message,
      }) + "\n");
      throw error;
    }
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.exit_code;
  }
  if (args.action === "pack") {
    const packet = packFrom(args);
    const out = path.resolve(args.out);
    if (fs.existsSync(out)) fail(`--out must be a new file: ${out} already exists`);
    saveNew(out, Buffer.from(JSON.stringify(packet, null, 2) + "\n", "utf8"));
    const warnings = materialWarnings(packet);
    process.stdout.write(JSON.stringify({ status: "ok", packet_file: out, material_warnings: warnings }) + "\n");
    return 0;
  }
  fail("unreachable action");
}

if (require.main === module) {
  // 入口兜底：未预期的异常（promise 链之外：事件回调、流 error、定时器）统一
  // 退出码 2，不与 FAIL=1 混淆。只在直跑入口时安装，被 require 的库用法（测试）
  // 不受影响。只置 exitCode 不 process.exit——让在途的记录写出自然排空。
  process.on("uncaughtException", error => {
    process.stderr.write(`error: ${String(error?.message ?? error)}\n`);
    process.exitCode = 2;
  });
  main(process.argv.slice(2)).then(code => { process.exitCode = code ?? 0; })
    .catch(error => {
      process.stderr.write(`${error.usage ? "usage error: " : "error: "}${String(error?.message ?? error)}\n`);
      process.exitCode = error.usage ? 2 : 2;
    });
}

// ---------------------------------------------------------------------------
// F-lite: transport-and-recovery handoff to the durable fixture entry. The
// durable secondary carries no content vote (the pinned fixture protocol is
// not review-v1), so the composed gates keep any valid primary verdict and
// never turn a transport PASS into a review PASS.
// ---------------------------------------------------------------------------
function durableHandoffKey(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.some(part => typeof part !== "string" || !part)) {
    fail("durable handoff key needs an array of nonempty strings");
  }
  return hash(parts.join("\u0000"));
}
function composeDurableSecondary(primaryResult, jobStatus) {
  const primaryGate = primaryResult && typeof primaryResult === "object" ? primaryResult.PRIMARY_REVIEW_GATE : "NOT_EVALUATED";
  return {
    PRIMARY_REVIEW_GATE: primaryGate,
    SECONDARY_REVIEW_GATE: "NOT_EVALUATED",
    SECONDARY_NOT_EVALUATED_REASON: "durable_content_vote_not_wired",
    REVIEW_GATE: primaryGate === "FAIL" ? "FAIL" : "NOT_EVALUATED",
    secondary_transport: jobStatus?.status ?? "unknown",
    note: "the durable fixture handoff proves idempotent transport and read-only recovery only",
  };
}

module.exports = {
  ENTRY_VERSION, LIMITS, USAGE, SKILLS, STRATEGIES, materialBinding,
  packetFrom, materialFrom, evidenceIdsFrom, buildRunPacket, assembleInputs,
  materialWarnings, tailUtf8, parsePatch, diffstatText, verifyChanges, coverageDeclared,
  family, evaluateSide, tally, runFixtureRound, verifyRun, doctorOffline, argsFrom, ADJUDICATION_FILES,
  writeRunInputs, writeRunRecords, durableHandoffKey, composeDurableSecondary,
};
