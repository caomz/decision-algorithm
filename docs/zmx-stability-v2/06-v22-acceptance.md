# V2.2 最小修复 — 实施与验收记录

记录时间：2026-11-27（UTC 见 git 提交）。分支：`fix/zmx-main-timeout-stability-20261125`，研究起点 `5a25b93ff2f7a70e50392e63da4d2dab66848725`。所有证据绑定各自提交的完整 SHA；命令均可在对应 checkout 复跑。

## 提交与阶段

| 提交 | 阶段 | 内容 |
| --- | --- | --- |
| `3b7b85d` | S0 | 离线 fixture 显式合同（`resolveWrapper`，两份 batch-safety.js 副本、两个批入口、durable fixtureEnv）；测试子进程白名单环境（`tests/support/env.js`，不再展开 `process.env`）；负向守卫用例（`offline-guard.test.js`，24 项）；符号链接能力探测跳过 |
| `fe7a3e3` | N1 | `mmx-job.js` 的 `syncFile` 改为可写句柄 fsync（保留身份与大小核对，不创建/不截断）；durable 用例 Windows 分支 |
| `22f5f25` | B / F01 | `review-run.js` 发布前按启动摘要复核四个封存输入；清单全部来自内存中已验证字节；先清单后 `result.json`；`integrity-error.json` 保留启动时材料版本的判定；`verify` 报告发布拒绝原因；10 个新回归 |
| `7cbdb6e` | C / F02 | 记录格式 4：完成记录绑定 `receipt.json.shards/plan.json`；`readExecution` 按计划与执行状态推导预期归档集合并逐片核验（启动意图、分片记录精确序列化、原始回执摘要、封存快照与 profile、意外条目拒绝）；只读、不修复、不重发、不动槽；旧格式不静默升级；16 个新回归 |
| `e1039b2` | A | batch-safety：根进程退出后的有界清理升级（不再提前撤销）；生命周期证据独立字段（`root_exit_observed`/`pipe_close_observed`/`owned_process_group`/`wrapper_cli_group`/`survivor_observed`/`local_cleanup`/`lifecycle_validation`）；本地清理未确认时不领取后续分片（`not_started_reason=cleanup_unconfirmed`，`batch.halted`）；批级 gate 需全部片清理确认；8 个新用例 |
| `e7ec68c` | A 修正 | 被阻断批次的 `transport_gate` 如实为 `NOT_EVALUATED`（CI Linux 抓出的测试自身断言错误） |
| `3646001` | D | 实验 runner 分层观测（连接/请求头/完整体/中断体/客户端错误、模型与其他端点、observation unknown 及原因）；guard `MMX_CHAT_GUARD_TRACE` 调度计数（仅实验用）；回执 `fetch_guard_detail`（Node 版本、代理来源、`request_path_verified=false`）；`acceptance-profile.js` 正式验收入口 + 未批准空配置；durable 用例竞态修复；公共回执 schema 测试覆盖新字段 |
| （本提交） | G、F-lite | 文档统一（三层重试口径、宿主调用与提交标记、正本同步清单 `07-owner-sync.md`）；F-lite 交接合同（`durableHandoffKey`、`composeDurableSecondary`，`durable-handoff.test.js` 5 项） |

明确移至 V2.3：E（逻辑分片计划与覆盖门禁；PR #10 仅作设计参考，其字节区间切分不被采用）、F-full（持久任务与统一评审的内容投票）、H-full（托管 runner 的网络隔离证明与三平台完整原生生命周期验收）。

## 离线测试结果

运行环境（Windows 原生）：Windows x64，Node v22.22.2，libuv 1.51.0；`HOME`/`TEMP`/`USERPROFILE` 指向临时目录，代理与凭据变量不传入子进程，PATH 仅含 Node 目录与系统目录。命令形如 `node --test --test-reporter=spec "skills/<suite>/tests/**/*.test.js"`。

| 套件 | 5a25b93 时 Windows（历史记录） | 本轮最终 checkout（本次实测，Windows 原生） |
| --- | --- | --- |
| zcode | 94 项：88 过 / 0 败 / 6 跳（POSIX 专属） | 94 项：88 过 / 0 败 / 6 跳 |
| mmx | 127 项：102 过 / 15 败 / 10 跳（15 败 = N1） | 157 项：141 过 / 0 败 / 16 跳 |
| zcode-mmx-review | 229 项：221 过 / 3 败 / 5 跳（3 败 = 符号链接权限） | 268 项：260 过 / 0 败 / 8 跳（5 POSIX + 3 符号链接权限） |

合计 519 项：489 过 / 0 败 / 30 跳。全部跳过为平台专属或宿主权限专属；跳过不是通过。CI（Linux 隔离，Node 22.23.5）数字以推送后的两组 run 为准。

历史数字不得改写为本次结果。Linux 隔离 CI 的最终数字以推送后 CI 为准（push 与 pull_request 分别记录，不得混用）。

新增覆盖（关键生命周期用例，非仅总数）：
- S0：假 wrapper 缺失/为空/相对/越界/摘要不符/目录冒充、伪造凭据与代理与 NODE_OPTIONS、同名哨兵启动器零启动、正向合同命中固定 wrapper。
- N1：Windows 原生 durable 全链路到 `finished`（此前必然失败）。
- F01：四类封存输入在两侧派发后变化、缺失、被目录替换、发布中断、外部原文件编辑、启动时有效 P1 保留且不归属新版本、正常双 PASS 提交完整性。
- F02：原始回执删除/截断/换料交换、分片记录损坏与改写、计划改写、整目录删除、启动意图删除、意外条目、封存快照与 profile 改写、换料 raw 交换、失败片承诺无 raw、旧格式不升级、只读与槽不动、重复只读查询一致。
- A：正常失败信封后继续派发；无回执死亡后不再派发（`cleanup_unconfirmed`）；监督超时残留清理；POSIX：根退出后同组残留升级击杀、成功回执但同组残留阻断安全完成、wrapper 的 CLI 组报告参与判定、detached 后代超出观测范围如实声明、持管道后代清理。
- D：完整模型请求逐层计数；中断体与无头连接记 unknown 及原因；其他端点不算模型重试；guard 调度计数接口；验收组合缺失/未批准/格式坏/漂移拒绝、合成包干跑匹配。
- F-lite：稳定键推导与目录一致；同键同材料复用；换料冲突拒绝；引用未落盘时按键恢复；wait 到期不取消不重提；resume 只读；合成 gate 不授内容 PASS、保留有效主侧 P1。

## 事故记录（本分支工作之前，审查环境）

历史事故与本分支代码无关，按以下区别如实记录：真实 MMX CLI 曾被启动（6 次，`mmx-cli` 1.0.29，Windows）；每次约 0.5 秒后以退出码 3 认证失败；**模型输出未观察到**；**是否向供应方发出过被拒请求未知**；**费用未知**（认证失败路径通常无生成，但本地记录不能证明）。因此本分支的证据**不能**写成 `real_api=not_called`——准确表述是：本轮分支工作与测试的运行记录内零真实启动；该结论仅限定于本轮记录范围，不含上述历史事故。

## 仍然 NOT_EVALUATED

- 真实 MMX CLI 1.0.29 的 300 秒边界、代理行为（含 Node 环境代理覆盖 guard）、内部重试（`E1–E8` 实验矩阵，需 Mac 与授权）。
- macOS / Windows 原生生命周期（断连、信号、进程组清理、恢复）；本分支 Windows 原生运行的 fixture 通过不构成原生生命周期验收。
- 断电/重启持久性；Windows 目录同步。
- 真实供应方评审、默认持久任务、real backend。
- 规则正本同步（`07-owner-sync.md`，OWNER_ACTION_REQUIRED）。
- 托管 runner 的可验证网络隔离（`H-full`）。

> V2.2.1 增量（六项审核缺陷专项收尾）的验收记录见 `08-v221-acceptance.md`；本文件以上内容保持历史原样。
