#!/usr/bin/env node
'use strict';
/*
 * mcode-verify.js — MMX 交叉验证的「最高思考等级」执行入口
 *
 * 背景：mmx CLI（mmx-cli 1.0.28）没有任何 thinking / reasoning / effort 开关，
 *       推理强度完全由服务端默认决定，CLI 侧无法调档。
 * mcode（@minimax-ai/code 0.5.0）提供 `mcode exec --effort <level>`，
 *       合法档位 default|low|medium|high|xhigh|max，其中 max 为最高档，
 *       并在请求体中下发 reasoning.effort（openai-responses 协议）。
 *
 * 职责：
 *   1. 解析本机 ~/.minimax/config.yaml，取 defaultModel 对应 provider 的
 *      baseURL / apiKey / model（不硬编码密钥）
 *   2. 生成「每进程临时」Runtime 配置，为该模型补上 thinking.effortOptions，
 *      经 `mcode exec --config <tmp>` 使用 —— 不修改用户既有配置
 *   3. prompt 经 stdin（--input -）传递，不进 argv
 *   4. stdout 恒为单个 JSON，字段与 mmx-chat.js 对齐
 *
 * 用法：
 *   node mcode-verify.js --prompt-file <path> [--effort max] [--model <id>]
 *                        [--timeout 300] [--max-steps 8] [--dump-config]
 *
 * 环境变量：
 *   MCODE_API_KEY / MCODE_BASE_URL  覆盖从 config.yaml 读取的值
 *   MCODE_BIN                      指定 mcode 入口绝对路径（cli.js 或 npm shim）
 *
 * 已知残余风险（如实告知，不掩饰）：
 *  1. 临时 Runtime 配置含明文 apiKey。mcode 运行时不支持用环境变量提供 custom
 *     provider 的 apiKey（实测报 "api_key not configured"），故无法完全消除该暴露面。
 *     处置：目录 ACL 由 icacls 收紧到「当前用户 + SYSTEM」且 fail-closed（失败即中止）、
 *     系统工具走 System32 绝对路径（防 CWD 投放）、文件 O_EXCL 创建、子进程结束/信号/
 *     异常即刻删除、子进程 env 剔除密钥变量、每次启动按「标记文件 + magic + PID/24h」
 *     四重校验清扫残留。极端情形（SIGKILL / 断电）仍可能残留。
 *  2. mcode 入口的可信度只校验到「目录形态」（位于 node_modules/@minimax-ai/code/
 *     下的合法入口名），未做哈希/签名校验。有意为之：本机单用户开发工具，攻击者若已能
 *     写入本机 PATH 或 CWD，他本就能直接读取 ~/.minimax/config.yaml 里的同一把密钥，
 *     远超本包装器的防护边界。需要更强保证时用 MCODE_BIN 显式钉死绝对路径。
 *  3. ACL 授权主体取自 USERDOMAIN\USERNAME 环境变量。同上，仅在攻击者已能控制本机
 *     环境时才有意义。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const VERSION = '1.1.1';
const EFFORT_LEVELS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = 'max';
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_TIMEOUT_SEC = 3600;   // 上限：超过则 Node 32 位 setTimeout 会被钳制成 1ms
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IS_WIN = process.platform === 'win32';

// 必须「同步写 + 立即退出」：
//  - fs.writeSync 落盘后再 exit()，大 text 不会被异步管道截断成非法 JSON；
//  - process.exit() 紧随其后 ⇒ fail() 绝不返回，调用点后续语句不会继续执行
//    （否则被拒绝的调用仍会写明文密钥并真实调用模型，甚至以 0 退出）。
let emitting = false;
function writeAllSync(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    // 非阻塞管道上单次 writeSync 可能短写；不循环就会把合法 JSON 截断成非法输出
    let n;
    try { n = fs.writeSync(fd, buf, off, buf.length - off); }
    catch (e) { if (e && e.code === 'EAGAIN') continue; throw e; }
    if (!n) break;
    off += n;
  }
  return off;
}
function emit(obj, code) {
  if (emitting) return;
  emitting = true;
  process.exitCode = code;
  let buf;
  try { buf = Buffer.from(JSON.stringify(obj) + '\n', 'utf8'); }
  catch (_) { buf = Buffer.from('{"status":"runtime_error"}\n', 'utf8'); }
  let written = 0;
  try { written = writeAllSync(process.stdout.fd, buf); }
  catch (_) { try { written = writeAllSync(2, buf); } catch (__) {} }
  if (written < buf.length) {
    // 载荷已截断 → stdout 不会再是合法 JSON，必须在 stderr 明说，
    // 否则下游会把残缺 JSON 当成完整结果
    try {
      fs.writeSync(2, Buffer.from(
        `warning: stdout write truncated (${written}/${buf.length} bytes); ` +
        `payload is incomplete JSON\n`, 'utf8'));
    } catch (__) {}
  }
  process.exit(code);
}
function fail(status, message, extra) {
  emit(Object.assign({ status, error: message }, extra || {}), 1);
}

// 已知密钥登记册：脱敏先做「字面量替换」再做启发式规则 ——
// 启发式永远抓不到短密钥或非常规字符集的密钥，但我们确知 apiKey 原文
const KNOWN_SECRETS = new Set();
function registerSecret(s) {
  if (typeof s === 'string' && s.length >= 6) KNOWN_SECRETS.add(s);
}

// 错误负载脱敏：CLI 诊断常回显解析后的配置 / 命令行
function redact(s) {
  if (!s) return s;
  let out = String(s);
  for (const secret of KNOWN_SECRETS) {
    if (out.includes(secret)) out = out.split(secret).join('***');
  }
  return out
    // sk- 前缀（MiniMax/常见 BYOK）
    .replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***')
    // Authorization: Bearer <token> / <token>（必须整体吃掉 token，而非只吃 Bearer）
    .replace(/(Authorization"?\s*[:=]\s*"?)(?:Bearer\s+)?[^\s",}]+/gi, '$1***')
    // x-api-key / api_key / apiKey 等键值形式（含 query string）
    .replace(/((?:x-)?api[_]?key"?\s*[:=]\s*"?)[^\s",}&]+/gi, '$1***')
    .replace(/([?&](?:api_?key|token|access_token)=)[^&\s]+/gi, '$1***')
    // 裸 JWT
    .replace(/\beyJ[A-Za-z0-9_\-+/=]{10,}\.[A-Za-z0-9_\-+/=]{5,}\.[A-Za-z0-9_\-+/=]{5,}\b/g, '***')
    // 长随机串兜底：仅放行「明确安全」的形态（UUID / 纯十六进制摘要），
    // 字符类含 base64 的 + / =，避免 padded base64 密钥整条漏网
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, (m) =>
      (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m) ||
       /^[0-9a-f]{32,}$/i.test(m)) ? m : '***');
}
// URL 内嵌 userinfo（https://user:token@host）不得出现在输出中
function redactUrl(u) {
  if (!u) return u;
  return String(u).replace(/^([a-z]+:\/\/)[^/@\s]*@/i, '$1***@');
}
// 必须「先脱敏再截断」：反序会在切点处留下密钥前缀（clip 后再 redact 救不回来）
function clip(s, n) {
  return redact(s == null ? '' : String(s)).slice(0, n);
}

// ------------------------------------------------------------------ args
const BOOLEAN_FLAGS = new Set(['--dump-config', '-h', '--help']);

function parseArgs(argv) {
  const out = {
    promptFile: null, effort: DEFAULT_EFFORT, model: null,
    timeoutSec: 300, maxSteps: 8, dumpConfig: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    // 无参标志必须先判定：否则会把下一个参数当值吞掉（argument confusion）
    if (BOOLEAN_FLAGS.has(a)) {
      if (a === '--dump-config') out.dumpConfig = true;
      else {
        process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0] + '*/\n');
        process.exit(0);
      }
      continue;
    }
    if (i + 1 >= argv.length) fail('usage_error', `missing value for ${a}`);
    const v = argv[++i];
    switch (a) {
      case '--prompt-file': out.promptFile = v; break;
      case '--effort': out.effort = v; break;
      case '--model': out.model = v; break;
      case '--timeout': out.timeoutSec = v; break;
      case '--max-steps': out.maxSteps = v; break;
      default: fail('usage_error', `unknown argument: ${a}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv);

if (!EFFORT_LEVELS.includes(args.effort)) {
  fail('usage_error', `--effort must be one of: ${EFFORT_LEVELS.join(', ')}`);
}
// 严格整数校验：拒绝 10abc / 0x10 / 1e3 这类被静默强转的值
for (const [k, v] of [['--timeout', args.timeoutSec], ['--max-steps', args.maxSteps]]) {
  if (!/^[0-9]+$/.test(String(v))) fail('usage_error', `${k} must be a positive integer`);
}
args.timeoutSec = parseInt(args.timeoutSec, 10);
args.maxSteps = parseInt(args.maxSteps, 10);
if (args.timeoutSec <= 0 || args.maxSteps <= 0) {
  fail('usage_error', '--timeout / --max-steps must be > 0');
}
if (args.timeoutSec > MAX_TIMEOUT_SEC) {
  fail('usage_error', `--timeout must be <= ${MAX_TIMEOUT_SEC}s`);
}
if (!args.promptFile) fail('usage_error', '--prompt-file is required');

let prompt;
try {
  const st = fs.statSync(args.promptFile);
  if (!st.isFile()) fail('usage_error', '--prompt-file is not a regular file');
  if (st.size > MAX_PROMPT_BYTES) {
    fail('prompt_too_large', `prompt ${st.size} bytes exceeds ${MAX_PROMPT_BYTES}`);
  }
  prompt = fs.readFileSync(args.promptFile, 'utf8').replace(/^﻿/, '');
  // 复检：stat 与 read 之间文件可能增长（TOCTOU），读后再卡一次硬上限
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    fail('prompt_too_large', `prompt exceeds ${MAX_PROMPT_BYTES} bytes after read`);
  }
} catch (e) {
  if (e && e.status) throw e;
  fail('usage_error', `cannot read --prompt-file: ${e.message}`);
}
if (!prompt.trim()) fail('usage_error', 'prompt is empty');

// ------------------------------------------------- resolve local provider
function unquoteYamlScalar(v) {
  let s = String(v).trim();
  const q = s[0];
  if ((q === '"' || q === "'") && s.length > 1 && s.endsWith(q)) {
    return s.slice(1, -1);          // 已加引号：内容整体有效，绝不再剥行尾注释
  }
  return s.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
}

function resolveProvider() {
  const cfgPath = path.join(os.homedir(), '.minimax', 'config.yaml');
  if (!fs.existsSync(cfgPath)) {
    fail('config_missing',
      '~/.minimax/config.yaml not found — run `mcode login` or `mcode provider add` first');
  }
  const raw = fs.readFileSync(cfgPath, 'utf8');

  const dm = raw.match(/^defaultModel:\s*(\S+)\s*$/m);
  if (!dm) fail('config_missing', 'defaultModel not found in ~/.minimax/config.yaml');
  const ref = unquoteYamlScalar(dm[1]);
  const slash = ref.lastIndexOf('/');
  if (slash <= 0) fail('config_missing', `cannot parse defaultModel: ${ref}`);

  let providerId = ref.slice(0, slash);
  const modelId = args.model || ref.slice(slash + 1);
  if (providerId.startsWith('custom_provider:')) {
    providerId = providerId.slice('custom_provider:'.length);
  }
  if (!MODEL_RE.test(providerId)) fail('config_missing', `illegal provider id: ${providerId}`);
  if (!MODEL_RE.test(modelId)) fail('invalid_model', `illegal model id: ${modelId}`);

  const esc = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^  ' + esc + ':\\r?\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_\\-]+:\\r?$|^\\S)', 'm');
  const blockMatch = raw.match(re);
  if (!blockMatch) {
    fail('config_missing',
      `provider "${providerId}" block not found in ~/.minimax/config.yaml — expected mcode's standard two-space indentation ("  ${providerId}:")`);
  }
  const block = blockMatch[1];

  const apiKey = process.env.MCODE_API_KEY || unquoteYamlScalar((block.match(/apiKey:\s*(\S+)/) || [, ''])[1]);
  const baseURL = process.env.MCODE_BASE_URL || unquoteYamlScalar((block.match(/baseURL:\s*(\S+)/) || [, ''])[1]);

  if (!apiKey) fail('config_missing', `provider "${providerId}" has no apiKey — set MCODE_API_KEY`);
  if (/^(YOUR_|REPLACE|CHANGEME|<|\$\{)/i.test(apiKey)) {
    fail('config_missing', `provider "${providerId}" apiKey looks like a placeholder`);
  }
  if (!baseURL) fail('config_missing', `provider "${providerId}" has no baseURL — set MCODE_BASE_URL`);
  if (/[\r\n]/.test(baseURL)) fail('config_missing', 'baseURL contains control characters');

  return {
    providerId, modelId, apiKey, baseURL,
    modelRef: `custom_provider:${providerId}/${modelId}`
  };
}
// ---------------------------------------------- temp Runtime config (per-run)
// 清扫上次崩溃残留的 mcv.*（含明文 apiKey）。
// 必须三重校验后才允许删除：① 目录内有本脚本专属标记文件；② 标记 magic 匹配；
// ③ 标记里的 PID 已死亡。缺任一条一律不动 —— 绝不按前缀盲删共享临时目录，
// 否则并发实例会互删、同机其他用户可借名投放目录诱删。
const DIR_MAGIC = 'mcode-verify.v1';
const MARKER = 'run.json';
const STALE_MS = 24 * 3600 * 1000;   // PID 判定不可靠（Windows PID 回收 / EPERM）时的兜底

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

// Windows 上目录 junction / mount point 的 lstat().isSymbolicLink() 仍为 false。
// 判定方式：解析 realpath 后若不再是临时根目录下的同名直接子目录，即为重解析点，
// 递归删除会穿透到目标目录，必须拒绝。
function isReparsePoint(dir, lst, root) {
  try {
    if (lst.isSymbolicLink()) return true;
  } catch (_) { return true; }
  let real;
  try { real = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir); }
  catch (_) { return true; }                       // 解析失败 → 不可信
  if (!IS_WIN) return false;
  let realRoot;
  try { realRoot = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root); }
  catch (_) { return true; }
  const expect = path.join(realRoot, path.basename(dir));
  return real.toLowerCase() !== expect.toLowerCase();
}

function sweepStaleDirs() {
  const root = os.tmpdir();
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('mcv.')) continue;
    const dir = path.join(root, e.name);
    // 先 lstat 拒掉 reparse point / 符号链接，再去读标记 —— 顺序不能反，
    // 否则读标记这一步就已经穿透 junction 了
    let lst;
    try { lst = fs.lstatSync(dir); } catch (_) { continue; }
    if (isReparsePoint(dir, lst, root)) continue;
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch (_) { /* 见下 */ }
    if (marker && marker.magic !== DIR_MAGIC) continue;
    const dead = marker ? !pidAlive(marker.pid) : false;
    // 无标记目录只按「创建时间超过过期窗口」回收：mkdtemp 与写标记之间崩溃留下的
    // 目录必须能被动清理，否则明文密钥目录会无限堆积。
    // 某些卷的 birthtimeMs 为 0，必须设下限，否则会把活实例当成过期目录删掉。
    const born = marker && Number.isFinite(marker.startedAt)
      ? marker.startedAt
      : (Number.isFinite(lst.birthtimeMs) && lst.birthtimeMs > 0 ? lst.birthtimeMs : Infinity);
    const aged = Number.isFinite(born) && (Date.now() - born) > STALE_MS;
    if (!dead && !aged) continue;             // 活实例且未过期 → 不动
    try {
      // 删除前再确认一次不是链接，缩小校验与删除之间的置换窗口
      if (isReparsePoint(dir, fs.lstatSync(dir), root)) continue;
      // 额外闸门：只有确认目录未被 group/other 打开（即不是别人为了诱删而投放的
      // 可写目录）才允许递归删除
      if (!IS_WIN) {
        const m = fs.lstatSync(dir).mode;
        if ((m & 0o022) !== 0) continue;     // group/other 可写 → 不可信，放弃删除
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) { process.stderr.write(`warning: could not remove stale ${e.name}: ${err.code || err.message}\n`); }
  }
}
sweepStaleDirs();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcv.'));
const tmpCfg = path.join(tmpDir, 'runtime-config.yaml');
// 归属标记必须先于 ACL 加固落盘：否则 mkdtemp 与加固之间崩溃会留下
// 「无标记的明文密钥目录」，而清扫逻辑会永远跳过它
try {
  fs.writeFileSync(path.join(tmpDir, MARKER),
    JSON.stringify({ magic: DIR_MAGIC, pid: process.pid, startedAt: Date.now() }),
    { encoding: 'utf8', flag: 'wx' });
} catch (_) { /* 标记缺失只会让清扫延后回收，不会造成误删 */ }
let childPid = null;
let cleanedUp = false;

// Windows 忽略 POSIX mode：改用 ACL 收紧到「当前用户 + SYSTEM」。
// fail-closed：icacls 不可用或失败即中止，绝不降级为「明文密钥 + 宽松 ACL」。
// 系统工具一律走绝对路径：CWD 在 Windows 搜索顺序中优先于 System32，
// 用裸名调用等于把加固开关交给 CWD 写入者。解析不到就返回 null（绝不回退裸名）。
function sysTool(name) {
  if (!IS_WIN) return name;
  const root = process.env.SystemRoot;
  if (!root) return null;
  const p = path.join(root, 'System32', name);
  return fs.existsSync(p) ? p : null;
}

function hardenDir(dir) {
  if (!IS_WIN) {
    try {
      fs.chmodSync(dir, 0o700);
      // 复验：目录必须确实不对 group/other 开放，否则视为加固失败
      const st = fs.statSync(dir);
      if ((st.mode & 0o077) !== 0) throw new Error('group/other bits still set');
      return;
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      fail('acl_harden_failed', `cannot restrict temp dir permissions: ${e.message}`);
    }
  }
  const me = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : null;
  const icaclsExe = sysTool('icacls.exe');
  const icacls = icaclsExe
    ? spawnSync(icaclsExe, [dir, '/inheritance:r', '/grant:r',
        me ? `${me}:(OI)(CI)F` : null, '*S-1-5-18:(OI)(CI)F'].filter(Boolean),
        { windowsHide: true, stdio: 'ignore' })
    : { error: new Error('icacls.exe not resolvable under System32') };
  if (icacls.error || icacls.status !== 0) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    fail('acl_harden_failed',
      'icacls could not restrict the temp config ACL; refusing to write a plaintext apiKey');
  }
}
hardenDir(tmpDir);   // 必须在写入任何密钥之前完成

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  // 删除失败绝不能静默：Windows 上 AV / 索引服务持有句柄时 rmSync 常失败，
  // 而此时磁盘上留着明文 apiKey。必须复检 + 走 stderr 告警。
  let leaked = false;
  try { if (fs.existsSync(tmpCfg)) fs.rmSync(tmpCfg, { force: true }); } catch (_) {}
  try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  try {
    if (fs.existsSync(tmpCfg) || fs.existsSync(tmpDir)) {
      leaked = true;
      process.stderr.write(
        `warning: could not remove temp runtime config; a plaintext apiKey may remain at ` +
        `${tmpCfg} — delete it manually\n`);
    }
  } catch (_) { leaked = true; }
  return leaked;
}
process.on('exit', cleanup);
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(s =>
  process.on(s, () => { reapChild(); cleanup(); process.exit(130); }));
process.on('uncaughtException', e => { cleanup(); fail('runtime_error', clip(e.message, 300)); });

function yamlEscape(v) {
  // 双引号标量：必须转义反斜杠、双引号与全部控制字符，否则可突破标量注入配置
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function writeRuntimeConfig(p) {
  const yaml = [
    'logLevel: error',
    'minimaxModelSource: custom_provider',
    `defaultModel: custom_provider:${p.providerId}/${p.modelId}`,
    'custom_provider:',
    `  ${p.providerId}:`,
    '    api: openai-responses',
    '    options:',
    `      baseURL: "${yamlEscape(p.baseURL)}"`,
    `      apiKey: "${yamlEscape(p.apiKey)}"`,
    '    models:',
    `      ${p.modelId}:`,
    `        name: ${p.modelId}`,
    '        limit:',
    '          context: 1000000',
    '          output: 131072',
    '        reasoning: true',
    '        modalities:',
    '          input:',
    '            - text',
    '          output:',
    '            - text',
    '        thinking:',              // ← 关键：声明 effort 档位（mmx CLI 无法做到）
    '          effortOptions:',
    ...EFFORT_LEVELS.map(l => '            - ' + l),
    '          defaultEffort: default',
    '    name: mcode-verify',
    '    kind: custom',
    '    enabled: true',
    'defaultModelContextWindow: 1000000',
    'defaultModelVariant: thinking',
    ''
  ].join('\n');
  // wx = O_EXCL：绝不覆盖已存在的（可能带宽松 ACL 的）文件
  fs.writeFileSync(tmpCfg, yaml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

// ------------------------------------------------------------------ runner
// 允许的 JS 入口：必须是 shim 同目录 node_modules/@minimax-ai/code/ 下的入口文件。
// 双重约束（shim 目录归属 + 包路径形态）阻断 shim 内容里的 ..\..\ 越权路径。
const PKG_REL = path.join('node_modules', '@minimax-ai', 'code');
const ENTRY_FILE_RE = /^(cli|index|main)\.(js|mjs|cjs)$/;

function resolveMcodeBin() {
  const explicit = process.env.MCODE_BIN;
  if (explicit) {
    if (!path.isAbsolute(explicit)) fail('usage_error', 'MCODE_BIN must be an absolute path');
    if (!fs.existsSync(explicit)) fail('cli_missing', `MCODE_BIN not found: ${explicit}`);
    return explicit;
  }
  // 无 MCODE_BIN：只接受「可解析出合法包内 JS 入口」的 shim。
  // 裸 .exe/.bat 无从校验归属，一律不采信 —— 避免 PATH 劫持拿到含密钥的 --config。
  // 且只扫 PATH 中的绝对路径条目：CWD 相对条目（. / ..）是投放 shim 的经典手法。
  const exts = IS_WIN ? ['.cmd', ''] : [''];
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(d)) continue;                 // 拒绝相对 PATH 条目
    for (const e of exts) {
      const p = path.join(d, 'mcode' + e);
      try {
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
      } catch (_) { continue; }
      if (resolveNodeEntry(p)) return p;      // 解析失败即视为不可信，跳过
    }
  }
  return null;
}

// npm 生成的 .cmd shim 形如: "%_prog%" "%dp0%\node_modules\<pkg>\cli.js" %*
// 直接取出 JS 入口，用当前 node 以 shell:false 启动 —— 彻底绕开 cmd 重新解析。
// POSIX 上 mcode 是符号链接到包入口的 JS，同样必须通过归属校验后才可执行。
function resolveNodeEntry(bin) {
  const binPath = path.resolve(bin);
  const isJs = /\.(js|mjs|cjs)$/i.test(binPath);
  if (isJs) {
    // 直接钉死 JS 入口（MCODE_BIN 的推荐用法）：同样要求它位于受管包目录内。
    // Windows 同样走这条路径 —— 否则 MCODE_BIN 在 Windows 上必然失败。
    let real;
    try { real = fs.realpathSync(binPath); } catch (_) { return null; }
    const idx = real.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    if (idx < 0) return null;
    const tail = real.slice(idx + 1);
    if (!tail.startsWith(PKG_REL + path.sep)) return null;
    if (!ENTRY_FILE_RE.test(path.basename(real))) return null;
    // 执行「已校验的 real 路径」而不是原始 binPath：否则校验与 spawn 之间
    // 一次符号链接替换就会把运行重定向到未经检查的脚本上
    return IS_WIN
      ? { cmd: process.execPath, prefix: [real] }
      : { cmd: real, prefix: [] };
  }
  if (!IS_WIN) return null;                 // POSIX 上没有 npm shim，无从解析
  if (!/\.(cmd|bat)$/i.test(binPath)) return null;   // .exe 不做 shim 解析
  let shim;
  try { shim = fs.readFileSync(binPath, 'utf8'); } catch (_) { return null; }
  const m = shim.match(/"%~dp0\\([^"]+\.(?:js|mjs|cjs))"/i) ||
            shim.match(/"%dp0%\\([^"]+\.(?:js|mjs|cjs))"/i);
  if (!m) return null;

  const binDir = path.dirname(binPath);
  const js = path.resolve(binDir, m[1].replace(/\\/g, path.sep));

  // 归属校验 1：解析后必须仍在 shim 所在目录内（阻断 ..\..\ 越权）
  const rel = path.relative(binDir, js);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  // 归属校验 2：必须落在 node_modules/@minimax-ai/code/ 下且是合法入口文件名
  const segs = rel.split(path.sep);
  const pkgIdx = segs.indexOf('node_modules');
  if (pkgIdx < 0) return null;
  const tail = segs.slice(pkgIdx).join(path.sep);
  if (!tail.startsWith(PKG_REL + path.sep)) return null;
  if (!ENTRY_FILE_RE.test(segs[segs.length - 1])) return null;

  if (!fs.existsSync(js)) return null;
  return { cmd: process.execPath, prefix: [js] };
}

function reapChild() {
  if (!childPid) return;
  try {
    if (IS_WIN) {
      const tk = sysTool('taskkill.exe');
      if (tk) {
        spawnSync(tk, ['/PID', String(childPid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' });
      } else {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    } else {
      try { process.kill(-childPid, 'SIGKILL'); } catch (_) { try { process.kill(childPid, 'SIGKILL'); } catch (_) {} }
    }
  } catch (_) {}
}

function runMcode(p) {
  return new Promise((resolve) => {
    const bin = resolveMcodeBin();
    if (!bin) { resolve({ status: 'cli_missing', message: 'mcode not found on PATH (or set MCODE_BIN)' }); return; }

    const entry = resolveNodeEntry(bin);
    if (!entry) {
      resolve({ status: 'cli_unresolved',
        message: 'cannot resolve node entry from npm shim; set MCODE_BIN to the cli.js path' });
      return;
    }

    // 全部 argv 均为机器生成或已白名单/正则校验（effort 枚举、model 正则、
    // 数字转字符串），不含任何调用方自由文本 → 无注入面。
    const argv = entry.prefix.concat([
      'exec',
      '--config', tmpCfg,
      '--model', p.modelRef,
      '--effort', args.effort,          // ← 最高思考等级入口
      '--input', '-',                   // prompt 经 stdin 传入，不进 argv
      '--input-format', 'text',
      '--permission', 'off',
      '--max-steps', String(args.maxSteps),
      '--timeout', `${args.timeoutSec}s`,
      '--output-format', 'json'
    ]);

    // 子进程环境用白名单重建：mcode 的可信度只校验到「目录形态」，
    // 不能让它顺手继承宿主环境里的其它密钥。
    // NODE_OPTIONS / NODE_PATH 是可执行代码 / 模块解析注入面，采用双重排除：
    // 白名单正则本就不含它们，循环里的 continue 保留为防重构回归的保险。
    const ENV_ALLOW = /^(PATH|PATHEXT|SystemRoot|SystemDrive|windir|ComSpec|TEMP|TMP|TMPDIR|HOME|USERPROFILE|USERNAME|USERDOMAIN|COMPUTERNAME|LANG|LC_ALL|LC_CTYPE|MCODE_CHROME_PATH|MCODE_BROWSER_BACKEND|NODE_EXTRA_CA_CERTS|NODE_NO_WARNINGS|NODE_ENV|NODE_DEBUG)$/;
    const childEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!ENV_ALLOW.test(k)) continue;
      if (k === 'NODE_OPTIONS' || k === 'NODE_PATH') continue;   // 可执行代码注入面（双保险）
      childEnv[k] = v;
    }
    delete childEnv.MCODE_API_KEY;
    delete childEnv.MCODE_BASE_URL;
    delete childEnv.MCODE_BIN;

    const child = spawn(entry.cmd, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,                      // 绝不经过 cmd 重新解析
      windowsHide: true,
      env: childEnv,
      detached: !IS_WIN                  // POSIX 下用进程组，便于整组回收
    });
    childPid = child.pid;

    let out = '', err = '', outBytes = 0, errBytes = 0, done = false, overflow = false, stdinError = null;
    const wallStart = Date.now();
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reapChild();
      resolve({ status: 'timeout', message: `wall clock exceeded ${args.timeoutSec}s` });
    }, (args.timeoutSec + 30) * 1000);

    // stdout / stderr 均为「累计」有界；任一超限即杀进程并如实上报 output_truncated
    const onData = (which) => (d) => {
      const s = d.toString();
      const isOut = which === 'out';
      if (isOut) outBytes += Buffer.byteLength(s); else errBytes += Buffer.byteLength(s);
      if (outBytes + errBytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        reapChild();
        try { child.kill('SIGKILL'); } catch (_) {}
        return;
      }
      if (isOut) out += s; else err += s;
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));
    child.on('error', e => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ status: 'cli_error', message: e.message });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      cleanup();                                     // 子进程结束即销毁含密钥的配置
      resolve({ status: 'closed', code, stdout: out, stderr: err,
                overflow, stdinError, wallMs: Date.now() - wallStart });
    });

    // stdin 必须挂 error 监听：子进程提前退出时的 EPIPE 否则会变成 uncaughtException，
    // 反而吞掉真正有用的 stderr 诊断
    child.stdin.on('error', e => { stdinError = e.code || e.message; });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ------------------------------------------------------------------- main
(async function main() {
  const provider = resolveProvider();
  registerSecret(provider.apiKey);
  const userinfo = (provider.baseURL.match(/^[a-z]+:\/\/[^/@]+@/i) || [])[0];
  if (userinfo) registerSecret(userinfo);

  // --dump-config 是纯诊断模式：绝不为它落盘明文密钥
  if (args.dumpConfig) {
    emit({ status: 'ok', effort: args.effort, available_efforts: EFFORT_LEVELS,
           model: provider.modelRef, base_url: clip(redactUrl(provider.baseURL), 200) }, 0);
    return;
  }

  writeRuntimeConfig(provider);

  const r = await runMcode(provider);

  if (r.status === 'cli_missing') fail('cli_missing', r.message);
  if (r.status === 'cli_unresolved') fail('cli_unresolved', r.message);
  if (r.status === 'cli_error') fail('cli_error', clip(r.message, 300));
  if (r.status === 'timeout') {
    emit({ status: 'timeout', error: r.message, effort: args.effort, model: provider.modelRef }, 1);
    return;
  }
  if (r.stdinError && !r.stdout.trim()) {
    fail('stdin_error', `prompt delivery failed (${r.stdinError}); stderr=${clip(r.stderr.trim(), 300)}`);
  }

  // CLI 层的报错只出现在 stderr；stdout 若能解析成 JSON，那是模型输出，
  // 绝不能拿它去匹配「effort 被拒绝」这类关键字 —— 模型正文里引用了这些
  // 英文短语会把一次成功的运行误判成失败。
  if (r.overflow) {
    fail('output_truncated', `child output exceeded ${MAX_OUTPUT_BYTES} bytes and was killed`,
      { effort: args.effort, model: provider.modelRef });
  }

  let j = null;
  try { j = JSON.parse(r.stdout.trim()); } catch (_) { /* fallthrough */ }

  if (!j || typeof j !== 'object') {
    if (/does not support reasoning effort|Available levels:|not in this Session's model list/i
        .test(r.stderr)) {
      fail('effort_unsupported', 'runtime rejected --effort for this model/provider',
        { effort: args.effort, available_efforts: EFFORT_LEVELS, detail: clip(r.stderr.trim(), 400) });
    }
    if (!r.stdout.trim()) {
      fail('empty_stdout', `exit=${r.code}; stderr=${clip(r.stderr.trim(), 300)}`);
    }
    fail('invalid_json', clip(r.stdout.trim(), 300), { exit_code: r.code });
  }
  if (j.status === 'limit_exceeded') {
    fail('limit_exceeded', clip((j.error && j.error.message) || 'run hit --max-steps', 300),
      { max_steps: args.maxSteps, hint: 'raise --max-steps or narrow the task' });
  }
  if (j.status !== 'succeeded') {
    const msg = (j.error && j.error.message) || `run status=${j.status}`;
    if (/api[_ ]?key|credential|401|unauthor/i.test(msg)) fail('auth_error', clip(msg, 300));
    fail('api_error', clip(msg, 400), { exit_code: r.code, upstream_status: j.status });
  }

  emit({
    status: 'ok',
    // text 是交付物本体（交叉验证结论），逐字透传：对其做通用脱敏会破坏合法内容
    // （代码片段 / 哈希 / 长标识符）。调用方按「模型输出即不可信数据」对待即可；
    // 错误与诊断字段才走 clip()/redact()。
    text: typeof j.output === 'string' ? j.output : JSON.stringify(j.output),
    effort: args.effort,
    available_efforts: EFFORT_LEVELS,
    model: j.model ? `${j.model.providerId}/${j.model.modelId}` : provider.modelRef,
    variant: j.model ? j.model.variant : null,
    protocol: j.model ? j.model.protocol : null,
    input_tokens: j.usage ? j.usage.inputTokens : null,
    output_tokens: j.usage ? j.usage.outputTokens : null,
    cache_read_tokens: j.usage ? (j.usage.cacheReadTokens ?? null) : null,
    duration_ms: j.durationMs != null ? j.durationMs : r.wallMs,
    wall_ms: r.wallMs,
    wrapper_version: VERSION,
    truncated: false
  }, 0);
})().catch(e => {
  cleanup();
  fail('runtime_error', clip(e && e.message ? e.message : String(e), 300));
});
