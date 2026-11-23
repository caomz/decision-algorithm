# 能运生产登录链路：离线安全修复组件（非已安装 Skill）

**状态：独立修复组件已编写并完成合成数据测试；未接入原始 `nengyun-auto-login-test`，不得直接投产。**

本包不包含真实账号、密码、验证码、Cookie、认证文件或浏览器 profile。所有测试仅使用虚构数据和临时文件，无网络调用。未修改用户 Windows 上的 `.zcode` / `.trae-cn` / 生产配置。

## 环境与运行

需要 Node.js >= 20（未执行 `npm install`，无第三方依赖）。在独立解压目录执行：

```powershell
node --version
node --test
```

上述命令只操作本包的临时测试文件，不访问生产登录页面。

## 组件与对应风险

| 文件 | 覆盖方向 | 重要限制 |
| --- | --- | --- |
| `scripts/ny_carrier.js` | C1、C10：锁定整个读改写事务、同目录暂存、预校验、失败不删除原件 | 原 Windows 文件系统语义还需要目标机器的隔离验证；原有写者必须全部迁移 |
| `scripts/ny_sms_state.js` | C2、C3、C4：消息去重、请求绑定、时效门禁、先认领、结果绑定 | 原来的生产填码入口尚未接入；时效策略必须来自已核实的供应商合同 |
| `scripts/ny_log_guard.js` | C7：严格允许字段的结构化日志出口 | 还需将旧 `ny_log.js` 和直接输出调用点迁移；不能自动拦截手写 Markdown |
| `scripts/verify_distribution.js` | C8、C9：明确 allowlist、拒绝秘密文件名/部分典型敏感内容 | 必须接入实际打包流程；启发式内容扫描不保证发现所有编码秘密 |
| `scripts/ny_audit_manifest.js` | C11：证据与外部哈希清单绑定、复核 | 不等于数字签名、不能抵御同时改写整个清单的对手 |
| `scripts/ny_manual_captcha_contract.js` | C6：人工模式的可测试状态/阶段合约 | 实际浏览器操作回调未接入；回调本身必须支持取消/超时 |

## R1 安全改进（仍是独立组件）

- 消息去重历史不再静默保留最后 512 项；达到 4096 项容量时明确拒绝新消息并要求设计持久化迁移方案。不能靠清空历史恢复旧码可用。
- 审计关联 ID 改成随机生成的 `newAuditRef()`；不再对验证码、账号或其它低熵秘密作无盐 SHA-256 形成可枚举摘要。调用方必须生成并持有同一个随机 ID 进行跨事件关联。
- 载体目标是符号链接或硬链接时拒绝直接写入；父目录别名仍解析为同一父目录。Windows reparse point、junction、ACL、网络盘、路径交换等风险**仍需要目标 Windows 本机确认**。
- 分发扫描加强了备份命名和包含编码标识的敏感键名；仅接受 UTF-8 的文本 staging，不能把 UTF-16 或二进制扫描当作 PASS。

在 Windows 机器上，可用以下命令执行**纯隔离文件系统探针**：

```powershell
npm run probe:windows
```

此探针只在系统临时目录生成合成 JSON 并测试当前 Windows+Node+文件系统的替换现象；非 Windows 主机返回 `NOT_EVALUATED`，不证明抗断电耐久性、不验证 ACL/锁/生产链路，也不会修改真实载体。需要将输出与 `node --test` 一起归档后再由独立方评审。**探针 PASS 也不等于生产兼容认证。**

## 绝对禁止直接部署的原因

1. 当前原始 `scripts/login_4a.js`、`scripts/login_cdp.js`、`scripts/ny_autologin.js` 的真实代码未提供，不能证明它们都执行了新的守卫。
2. 新 SMS 记录使用 `environments.prod.sms_record`，旧 `prod.sms` 只能置空。旧脚本仍可能在空值时回退到仓库测试占位值，**必须先移除所有生产旧入口的占位回退**。
3. 原始 `ny_common.js` 的 JSON 解析吞错、`ny_log.js` 的明文日志出口仍需在源码中逐一替换；仅复制本包不会生效。
4. `--check` 必须保持只读：只读登录态探测不得认领短信、发送短信或改写载体。
5. 不应依赖本包提供的 `publishSms()` 参数去推断供应商 TTL；消息原始时间必须可信且消息需绑定本次短信请求。
6. 测试在隔离的 Linux Node 22 环境执行；尚未在 Windows 11 Home / Node 22.20.0 上验证文件替换、ACL、真实脚本契约。

## 集成建议

先读取 `LOCAL_INTEGRATION_TASK.md`，在 Windows **隔离的、已剔除敏感文件的源码副本**中实施。要完成真正的原位修复，需要取得原技能完整源码（尤其 7 个脚本、SKILL.md 和现有测试），先核对内容，再制作最小 Diff。不得凭材料里的行号盲目自动改写文件。

## 模块 API（仅演示，禁止直接针对生产载体执行）

```js
const { publishSms, claimSms, markSubmitting, finishAttempt } = require('./scripts/ny_sms_state');
// 使用前必须迁移全部生产入口，并确认可靠的消息原始时间与 TTL 来源。
// publishSms(path, { code, sourceMessageId, messageCreatedAt, expiresAt, requestId }, { now, maxLifetimeMs });
// const claim = claimSms(path, { requestId, attemptId });  // 领取后盘上不再保留 raw code
// markSubmitting(path, { recordId: claim.recordId, attemptId }); // 在浏览器提交之前
// 浏览器侧只使用进程内存中的 claim.code；绝不打印、传命令行参数、写入日志。
// finishAttempt(path, { recordId: claim.recordId, attemptId, outcome: 'confirmed_success' | 'confirmed_rejected' | 'unknown' });
```

出现超时、失败和未知结果时不可自动重用或重新提交相同短信验证码。仅独立的、显式授权的新短信请求才可以产生新记录。

## R2: opt-in Windows Skills runtime isolation (review only)

The `ny_windows_runtime.js` / `ny_runtime_resources.js` / `ny_owned_json.js`
modules and `ny_runtime_cli.js` form a separate opt-in runner for synthetic or
independently authorized Skills. They **do not modify MMX, ZCode, ZMX, or the
original Nengyun entrypoints**. They do not load or relocate authentication.

- Per-run `skillId`, cryptographic `runId`, independent `runDir`; original `cwd`
  is passed unchanged to the subprocess; the inherited environment is copied.
- Stable file and browser resource keys; sorted, cross-process `wx` lock files
  under a caller-supplied shared `lockRoot`, with bounded waiting and no stale
  lock takeover. Resource ownership is checked before release.
- Cancellation, timeout and unknown descendant ownership fail closed. If a
  shared-resource child may still own descendants, its lock is intentionally
  retained; manual inspection is required before reusing that resource.
- `ny_owned_json.js` commits **only** synthetic/owned run files, preserving
  prior bytes on verified pre-commit failures and retaining resource blocking
  for indeterminate results. Do not use it to migrate a production carrier.
- Original business stdout/stderr bytes and exit codes can pass through the
  optional CLI; wrapper diagnostics use only bounded error codes on stderr.
  stdout timing/streaming and terminal/interactive behavior are **not** yet
  proven equivalent to MMX/ZCode wrappers.
- `.cmd/.bat` is explicitly **unsupported** pending a safe Windows argument
  bridge and real Windows tests; Node files are launched with `process.execPath`,
  `.exe` directly, `.ps1` through Windows PowerShell without changing policy.
- Any legacy `--check` must run through a separately audited read-only path:
  the runner rejects it without spawning a child. CLI `inspect` only reports
  entry type; it does not run a login-state check.

The full resource contract, CLI usage, T01-T14 evidence matrix and blockers are
in [WINDOWS_RUNTIME_R2.md](WINDOWS_RUNTIME_R2.md). Nothing in R2 is installed
by this PR. Do not merge this staging directory into the production Windows
Skills installation.
