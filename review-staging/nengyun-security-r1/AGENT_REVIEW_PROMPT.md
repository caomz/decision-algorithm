# Windows R1 离线安全组件 · 独立多 Agent 评审任务书

> 本目录是 **nengyun-auto-login-test 的隔离审查材料**，不是 decision-algorithm 的组成 Skill，不是已接入的生产修复。任何 Agent 不得把这些代码描述为已修复原生产登录链路。

## 固定边界

- 宿主仓库：`caomz/decision-algorithm`
- 审查分支：`review/windows-nengyun-security-r1-20261123`
- 对比基线：`windows`，创建分支时 HEAD 为 `c954e2c08c8db0c0b488aaf1681db55810e8fb38`。评审前**重新读取两个分支的最新 SHA**，记录 `BASE_SHA`、`HEAD_SHA`。
- 仅审查 `review-staging/nengyun-security-r1/` 下的代码、文档与测试；同时确认 Diff 不包含任何现有 decision-algorithm / ZMX 文件变更。
- `windows-zmx-validation-20261121` 是封存的历史分支，冻结 SHA `edc4cfce242b1fb4005e0b2b7c5c0ef020a5cd05`，禁止修改、rebase、merge、reset、clean。
- `nengyun-auto-login-test` 原始完整源码**尚未纳入仓库**；`login_4a.js`、`ny_common.js`、`ny_log.js` 等真实代码未修复。
- 禁止读取/上传生产 `config.local.json`、真实 SMS、账号口令、Cookie、CDP profile、日志、备份。不得调用生产站点、短信服务或真实供应商模型。
- 不升级 Windows、Node、PowerShell、MMX、ZCode，不改全局 PATH、代理、TLS、认证、Windows 生产 Job。
- 测试仅限合成数据与本地临时目录；Windows 探针仅在隔离目录使用，不触碰真实配置。
- 评审优先只读；未经明确授权不得修改文件、push、merge 或执行生产操作。

## 使用说明

给每个真正独立的 Agent **相同版本的 HEAD_SHA、这份任务书及目录源码**，彼此不预先阅读对方意见。无法分离实例时报告“单模型多视角”，不可冒称多 Agent 审批。记录每份报告的实际模型/平台证据；不同模型只在真实调用时声明。

## 六个角色

| Agent | 聚焦点 | 核查与否决标准 |
| --- | --- | --- |
| A1 架构 | standalone 与原 Skill 边界、路径与接口、旧入口绕过 | 不能证明旧生产入口已接守卫时，集成状态 NOT_EVALUATED |
| A2 Windows 文件系统 | `ny_carrier.js` 锁、替换、符号链接、硬链接、ACL、崩溃恢复 | 严禁先删后换、按锁龄抢锁；Linux Node 测试不等于 Windows 本机验证 |
| A3 生产安全 | `ny_log_guard.js`、`verify_distribution.js`、秘密数据、受限输出 | 代码包/审计包不能含凭据或秘密派生值；任意未受控输出不算已覆盖 |
| A4 并发状态机 | `ny_sms_state.js` 的消息来源、去重、claim、提交与 unknown | 第二领取必须拒绝；旧回调不能改新记录；不能声明服务端 exactly-once |
| A5 测试/回归 | `tests/` 真实行为、跨进程、异常注入、假浏览器和探针 | 跑 `node --test`；真实 Windows Probe 只有实际执行后才能 PASS |
| A6 独立终审 | A1–A5 证据比对、遗漏及 P1/P2 | 未取得真实独立报告时状态 NOT_EVALUATED；P1 未关闭不得批准合并 |

## 优先质疑的实现风险

1. `ny_carrier.js` 使用文件创建锁 `wx`，是否能在受支持 Windows 文件系统、进程崩溃、不同路径别名时提供要求的稳定互斥？`renameSync` 替换 Windows 已存在目标的失败/不确定状态是否被可靠地区分？备份、临时文件、ACL、路径交换是否安全？
2. `ny_sms_state.js` 是否只验证由可信 SMS 请求匹配的时间、去重与有效期？文件中的 `source_message_hash` 是否存在低熵可枚举风险？文件锁是否足以覆盖同浏览器会话的并发？`markSubmitting` 是否早于任何会触发远端副作用的动作？
3. `ny_log_guard.js` 的允许字段、值形态和异常处理是否真能阻断明文落盘？直写 stdout/stderr、手工 Markdown、截图、trace/HAR 等不在该模块能力内，须判 NOT_EVALUATED。
4. `verify_distribution.js` 是否对最终包的真实全部字节做检查？备份、临时文件、UTF-16/二进制、路径穿越和未知内容能否 fail-closed？
5. `ny_manual_captcha_contract.js` 对 challenge 变化、取消/超时、迟到回调、请求是否已发出与服务端是否接受，有无清楚状态边界？
6. `--check` 仍未从真实入口接入：禁止以组件通过测试替代只读检查实测。
7. 核对 R1 代码中是否有内嵌生产 URL、真实账号、真实验证码、密钥、Cookie；不得把测试值误报为真实秘密，也不得打印匹配到的敏感值。

## 离线执行与验收

在 `review-staging/nengyun-security-r1` 执行：

```powershell
node --version
node --test
node .\scripts\ny_windows_probe.js
```

不能修改系统版本。保留脱敏的命令退出码、运行环境、TAP 摘要和 Probe 结果。

验收分层：
- `STANDALONE_OFFLINE_TEST`：仅代码包单元/隔离测试。
- `WINDOWS_FILESYSTEM_PROBE`：仅被测 Windows 主机上的具体文件替换行为。
- `ORIGINAL_SKILL_INTEGRATION`：NOT_EVALUATED，直到有真正的登录 Skill 源码、入口调用图和回归证据。
- `REAL_PROVIDER`：NOT_AUTHORIZED。
- `PRODUCTION_READINESS`：NOT_APPROVED。

## 必需交付格式

对每个角色给出：角色、实际工具/模型、BASE_SHA、HEAD_SHA、被审文件 path:line、实测与推断的区别、P1/P2、未覆盖项、APPROVE / CHANGES_REQUIRED / INSUFFICIENT_EVIDENCE。

A6 汇总：
1. `GATE: PASS / PARTIAL / FAIL`，P1 证实存在则 FAIL；关键证据不足 PARTIAL。
2. Windows 兼容性矩阵：每个实际上机版本独立 PASS/FAIL/NOT_EVALUATED，禁止推断“全 Windows 通过”。
3. 安全状态：说明是否达到仅“独立组件审阅”，绝不将其称为原 Skill 或生产登录验收。
4. 若 P1/P2 需修改，按 `path:line@HEAD_SHA` 给最小 Diff 指令，提交复审前禁止合并。
5. 明确冻结历史 Windows 验收分支及生产资源未被触碰。

**本 PR 应保持 Draft，不自动合并。**


## R2 Windows Skills runtime isolation - new review scope (2026-11-23)

Review \`WINDOWS_RUNTIME_R2.md\` and these newly staged modules:
\`ny_runtime_resources.js\`, \`ny_windows_runtime.js\`, \`ny_owned_json.js\`,
\`ny_runtime_cli.js\`, their tests and fixtures. The current HEAD SHA must be
fetched from GitHub and fixed in every report; R1 SHA is history only.

- A1: prove original cwd and argv boundaries; map observed MMX/ZCode wrappers
  read-only. Business integration is NOT_EVALUATED until a real entry is wired.
- A2: independently audit \`wx\` markers, Windows ACL and reparse identity,
  lock ordering, process tree isolation, Windows replace failure classification.
  A lock must NOT be reclaimed by time or by a failed PID check.
- A3: check logger event values, wrapper stdout/stderr fidelity, env inheritance,
  file/manifest packaging and exposure through arbitrary original output.
- A4: verify independent resource concurrency, shared session exclusion,
  cancellation, timeout, retained locks when tree ownership is unknown, and no retries.
- A5: run inspected synthetic tests, not business scripts. Cross-process tests
  must use two actual OS processes. Never pass a Linux result as Windows proof.
- A6: compare five genuine independent results. If none available, record
  \`MULTI_AGENT_REVIEW=NOT_PERFORMED\`, not approved.

Required evidence:
\`STANDALONE_OFFLINE_TEST\`, \`WINDOWS_COMPATIBILITY\`,
\`CROSS_SKILL_RUNTIME_STABILITY\`, \`BUSINESS_BEHAVIOR_REGRESSION\`,
\`ORIGINAL_SKILL_INTEGRATION\`, \`MULTI_AGENT_REVIEW\`,
\`PRODUCTION_READINESS\`. Only a verified individual layer may receive PASS.

Known blockers (do not silently bypass):
1. \`.cmd/.bat\` launch intentionally returns \`EUNVERIFIED_CMD_BRIDGE\`.
2. Windows PowerShell argv, filesystem replacement, ACL, junction, native process
   tree ownership and stdout streaming compatibility are not independently tested.
3. Caller-declared \`assumeNoDescendants\` is not proof of descendant ownership;
   uncertain resource runs must remain blocked.
4. The original Nengyun Skill entrypoint and production CDP profile are absent.
5. The existing MMX/ZCode business wrappers and all ZMX files remain untouched.

No production network, credentials, SMS, login, browser, provider requests,
job manipulation, node upgrades, system changes, branch merge or release.
