# V2.2.1 验收记录：审核缺陷专项收尾

固定研究基准 `6396f0ed282ce524b1f4342312a7d04276f84137`。本记录只追加，不改写 `05`/`06` 的任何历史内容（含事故记录）。

## 范围

只修复 V2.2 独立审核发现的六项缺陷（P1：D1 清理证据识别、S0 测试隔离；P2：D3 发布原子性、D4 批准绑定、D5 HTTP 观测、D6 teardown），不扩大架构改造，不提前实施 V2.3（E/F-full/H-full 维持既定移交）。

## 每项缺陷：位置、反例、回归

### D1（P1）ZCode 批处理误判清理证据

- 修复位置：`skills/zcode/scripts/batch-safety.js`（`wrapperGroupReport` + `CONFIRMED_WRAPPER_REPORT`，`confirmed` 无条件要求 wrapper 清理报告在允许清单内）、`skills/zcode/scripts/zcode-batch.js`（投票改为要求监督器推导的 `local_cleanup === "confirmed"`）。
- 修复前反例：七种清理证据形态（false / null / 类型错误 / 字段缺失 / scope 缺失 / scope 未知 / `descendants_unverified`）全部被判 `local_cleanup: "confirmed"` 且下一片付费分片照常启动；review 模式下 scope 缺失仍产出 gate `PASS`。
- 修复后：七种形态全部 `unconfirmed`，批次 `halted: "cleanup_unconfirmed"`，后续分片 `not_started`；业务失败 + 清理确认时后续分片继续运行；PASS 投票需要已知 scope。
- 回归：`skills/zcode/tests/zcode-batch.test.js` 9 个新用例。

### S0（P1）测试隔离

- 修复位置：`tests/support/offline-test.js` ×3（强制入口）、`tests/support/env.js` ×3（`ZMX_OFFLINE_FIXTURE=1` 恒定、PATH 前置 + 基础目录恒保留、外来目录点名拒绝）、`zcode-chat.js` / `mmx-chat.js`（fixture 模式下的 CLI fixture 合同：声明根目录内 + SHA-256 一致，不合格候选拒绝而非继续搜索）、16 个测试文件的迁移、CI 与文档命令。
- 修复前反例：`mmx-chat.test.js` 14 处拼接宿主 PATH；`mmx-job` / `mmx-provider-slot` 子进程继承宿主环境；漏配 fixture 时回退生产 wrapper 并预留归档；假 CLI 不可执行时继续搜索 PATH；宿主 PATH 同名哨兵可达。
- 修复后：入口外 `cleanEnv()` 直接拒绝；强制标志使漏配 fixture 在预留归档前拒绝；哨兵在缺失/未绑定/不可执行三种形态下零启动；正向绑定是唯一可启动对象。
- 回归：`skills/zcode-mmx-review/tests/offline-entry.test.js` 7 个用例 + 跨套件 spawn 源码扫描 + 三份副本字节一致检查。

### D3（P2）result.json 发布原子性

- 修复位置：`skills/zcode-mmx-review/scripts/review-run.js`（`publishExclusive`：同目录完整临时文件 → fsync → 排他 link；`verifyRun` 报告 `*.pending` 残留）。
- 修复前反例：旧 `saveNew`（`wx`）先以最终名建空文件再写且不 fsync，ENOSPC 注入留下以 `result.json` 命名的空文件；SIGKILL 注入留下残缺文件。
- 修复后：任何瞬间都没有部分文件顶着最终名；既有记录永不替换；被捕获的失败清理临时文件；fsync 与 unlink 之间崩溃的残留由 verify 显式报问题；启动时 P1 证据保留在 `primary-result.json` 且绑定 `request.json` 的 `material_version`。
- 回归：ENOSPC 与进程中断两个子进程用例（故障预载双分支同时覆盖新旧写路径）+ 两个进程内守卫（既有 result.json 不被覆盖、正常发布无残留）。

### D4（P2）批准对象绑定实际执行

- 修复位置：`skills/mmx/scripts/acceptance-profile.js`（把已核对身份经 `ZMX_ACCEPTANCE_BINDING` 交给入口）、`skills/mmx/scripts/mmx-timeout-experiment.js`（重排：解析 CLI 身份 → 绑定校验 → 隔离检查 → 建输出目录；`checkBinding`；无绑定直接运行 mmx-cli 套件也拒绝）。
- 修复前反例：批准 A、`--cli-root` 指定 B 时 runner 从不比对，隔离 Linux 上会直接带 B 启动。
- 修复后：拒绝码 `ZMX_ACCEPTANCE_REFUSED`，消息点名 `cli.entry_sha256 differs` 与 `undici.version differs`；B 零启动；输出目录不创建。
- 回归：A/B 反例、`checkBinding` 字段表（缺绑定、逐字段差异、绑定缺字段）、profile → 入口身份传递探针；原 zero-request synthetic CLI 用例携带匹配绑定成为 CI Linux 上的正向准入路径。

### D5（P2）HTTP 观测逐 socket 判定

- 修复位置：`skills/mmx/scripts/mmx-timeout-experiment.js`（`observe` 逐 socket 记录请求头数、关闭/存活两种无头计数、`checkContinue`/`upgrade`/`connect` 亦算到达；`summarize` 抽出判定）。
- 修复前反例：一条 keep-alive 连接两个请求 + 一条无头连接（连接 2 = 请求头 2）永远判 `complete`；汇总用任意端点请求数充当模型传输证据。
- 修复后：无头连接计入 `headless_connections`，观测 `unknown` 且原因含 `connections_without_request_head`；`real_mmx_transport` 与 `provider_internal_retry` 要求每个用例连接集完全观测 + 模型端点完整请求；非模型端点、残缺/在途请求体、client error、无头连接均为 unknown 非零；原始任意端点重复计数保留供诊断。
- 回归：keep-alive 掩盖用例 + 判定表（5 种合成用例组合）。

### D6（P2）teardown 有界强制清理

- 修复位置：`tests/support/teardown.js` ×3（track/stop/teardown：spawn 的 ChildProcess 与带命令行标记的记录 pid；SIGTERM → 1.5 s → SIGKILL → 5 s → 验证退出；幸存者点名失败；无标记活 pid 永不触碰）、`teardown.test.js`、两个批处理套件的 fixture 记录 pid、六个测试文件的 spawn/收尾迁移。
- 修复前反例：PIPE_HOLDER 式 detached 后代在父进程被杀后独立存活（父已死：true，后代存活：true）；旧收尾只发一次 SIGTERM 且不等待不验证。
- 修复后：有界停止 + 验证退出；归属证明（命令行标记，Windows 探针绝对路径解析）；无标记 pid 判定「原进程已退出、pid 复用」。
- 回归：三个 teardown 用例（deaf 子进程有界停止并验证退出、带标记记录 pid 停止、无标记 pid 不触碰）。

## 测试结果（最终 HEAD `dca6ab58e49985dddc3d468b3edb6e0dc43d2e7a`，Windows 原生 Node v22.22.2，强制离线入口）

| 套件 | 基线 `6396f0e` | 最终 HEAD |
| --- | --- | --- |
| skills/zcode | 94 = 88 过 / 0 败 / 6 跳 | 103 = 97 过 / 0 败 / 6 跳 |
| skills/mmx | 157 = 141 过 / 0 败 / 16 跳 | 162 = 146 过 / 0 败 / 16 跳 |
| skills/zcode-mmx-review | 268 = 260 过 / 0 败 / 8 跳 | 282 = 272 过 / 0 败 / 10 跳 |

既有用例跳过数无一增加；新增 2 个跳过均为 offline-entry 的 POSIX 专属用例（executable-bit 语义），在 CI Linux 上真实执行。证据明细见 `evidence/v221-local-regression.json`。

## CI

最终 SHA `3f6bcc01e3c8e21b6c6cfc4e7f07d0b645259a3a` 的两组 CI 均已完成且成功，日志已逐项核对实际 checkout SHA 与计数：

- [push 46101699690](https://github.com/caomz/decision-algorithm/actions/runs/46101699690)：ZCode 103/103、MMX 162/162、cross-review 290/290（Linux 上 8 个 POSIX 专属用例真实执行）、0 失败 0 跳过；Python 173/173；offline doctor `status=ok`。
- [pull_request 46101704389](https://github.com/caomz/decision-algorithm/actions/runs/46101704389)：同上，全部成功。
- 合并后 main（merge commit `57b95a8b0d96e560f3f4a77d3c8c144d2c8271cf`）的 push CI [46102066174](https://github.com/caomz/decision-algorithm/actions/runs/46102066174)：success。

途中三轮失败（46099068621、46099957363、46100878219）如实保留在 run 历史中，修复内容见 PR #39 的 V2.2.1 增量段落。

## 状态

PR=DRAFT（收尾阶段转 ready 并自动合并，见 PR 记录）；DURABLE_DEFAULT=DISABLED；REAL_BACKEND=DISABLED；REAL_PROVIDER=NOT_EVALUATED。本轮零真实供应方调用。

## 仍未验证的边界

- 真实 CLI 传输栈（E1–E8 矩阵）、真实供应方：未验证，零真实启动。
- macOS / Windows 原生生命周期、断电重启：未验证（CI 的 macOS/Windows 作业仅语法检查）。
- 规则正本同步：OWNER_ACTION_REQUIRED（`07-owner-sync.md`），未处理。
- D1 的既定后果（决策 A）：真实 wrapper 在 Windows 上报 `cleanup_confirmed:null` + `descendants_unverified`，原生 Windows 上真实 `zcode-batch` 每批跑完第一片即停。
- D3 的 ENOSPC 与进程中断是注入模拟，不是真实磁盘写满或断电。
- D6 的 `stop()` "survived" 分支是防御性代码，SIGKILL 正常工作时不可达；归属证明与发信号之间存在微秒级 pid 复用窗口。
- MMX 托管安装的 release marker 在用户安装根目录（`agy/`、`mmx/`、`cross-validation/` 并列），不在仓库内，本轮不重钉，不覆盖用户全局安装。
- 本机 Python 基线套件（tests 20 败、lead-acquisition-coach 1 败）为宿主环境既有问题（Python 3.13 vs CI 3.11；基线 stash 对照逐字一致，分支 diff 中 Python 文件数为 0），不进入本分支门禁。
- `skills/mmx/references/test-matrix.md` 保留历史运行记录未改写；权威命令以 README / verification.md / CI 为准。
