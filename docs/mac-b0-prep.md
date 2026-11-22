# decision-algorithm Mac B0-PREP｜网络强制边界、勘误与待批 B0-RUN

**范围**：只对应 `caomz/decision-algorithm` 的 `cloud/mac-zmx-safety-20261122`，MAC-08/MAC-09/MAC-10。不得混用 CRM/SRE 或 Harness 项目记录。

**固定代码与既有验收 SHA**：`7baf360b7f52e2218ce2828f8a054b0262581d76`。本文件的后续文档提交不应被称为“已经重新通过 487 项的 Mac 运行版本”；原 Mac 回归绑定旧固定 SHA。

**B0-PREP 执行限制**：不运行真实 MMX/ZCode CLI，不建/启真实 durable Job，不向任何供应商发请求，不更换模型/安装/代理/TLS/Keychain/全局 PATH/防火墙；不提权、不安装软件、不覆盖旧证据。本文件是基于指定 SHA 的源码和公开原生沙箱资料得出的**文档级调查与停止裁定**。此 GitHub 执行环境无法打开用户的 `/Users/.../zmx-mac-audit...` 或在其 Mac 本机调用 `sandbox-exec`，故没有伪造本机端口、PID、退出码或内核拒绝日志。

## 1. 必须订正的五项事实

1. **代理**：仓库 `skills/mmx/scripts/mmx-chat.js::cliLaunch` 使用 `const childEnv = {...env}` 复制代理环境，读取代理环境或 MMX config 中的 proxy 并将状态标为 `proxy_limited`。仓库 wrapper 只规范化 `MINIMAX_BASE_URL` 的末尾 `/v1`，**不剥离代理**。不能把旧 `~/.local/bin/mmx` 自定义 bash 包装器的代理剥离等同于仓库 `cliLaunch` 的行为。
2. **Guard**：`skills/mmx/scripts/fetch-timeout-guard.js` 只用候选 undici `Agent({headersTimeout:0,bodyTimeout:0})` 设置全局 dispatcher，并写 `applied` 文件；这不是强制 egress 限制，也不证明 CLI 使用了它的每条 HTTP 路径。
3. **315 秒**：历史 Mac 合成 Node 首次约 301421ms 失败、设置 dispatcher 后约 315024ms/status 200 的记录属于 **SYNTHETIC_LOOPBACK**。真实 CLI 回环必须经过目标 SHA 的仓库 wrapper，且须独立证明守护、代理与凭据边界；真实供应商请求另行授权。三层 PASS 不得传递。
4. **Agent**：同一个 GLM-5.3-Flash 主控与多个同模型子 Agent 只证明编排分工，不是 ZCode 与 MMX 两种独立模型的实际审查。MAC-06 `review-run.js --backend real` 仍是 FAIL，不能用角色数充当双模型证据。
5. **第二 Node**：报告中 Node 24.15.0 覆盖三套 111+129+247=487；Node 26.13.1 只复跑了统一审核 247，不能记成完整第二 Node 487 PASS。

## 2. 原生进程隔离能力调查（不等于用户 Mac 实测）

- macOS 的 `sandbox-exec`/Seatbelt 是一种**候选**原生进程沙箱；`sandbox-exec` 在手册中标记 **DEPRECATED**，用户 Mac 版本的实际存在性、调用兼容性与策略支持均未在本环境实测。
- 可讨论的规则形态为默认拒绝 `network-outbound`，然后只允许 `(remote ip "localhost:<本轮服务端口>")`。但这不足以证明“仅允许严格的 `127.0.0.1:<端口>`”：公开 Seatbelt 后端说明 `localhost` 表示本机地址集合，可能包含该主机的非 loopback 地址，规则不支持直接改成 `127.0.0.1`。单独的 Seatbelt `localhost:port` 不能满足本次**精确地址+端口**的强制边界。
- 仅设置子进程 `HTTP_PROXY/NO_PROXY`、修改 `fetch`、劫持 DNS、检查 usage 或观察空日志，都不是 kernel-enforced egress 阻断。实际代理本身可向外联接；不能复用其他本地代理作为“已隔离”的证明。
- 宿主 XPC/本地 Unix socket 代理、OAuth 刷新、地域探测、更新检查、重定向以及子进程逃逸仍须逐项闭合；子进程 `HOME` 变为空白不证明文件系统无法读真实 Keychain/认证配置。macOS 系统 PF 或 Network Extension 修改若需要提权/全局更改/安装，在本轮明确禁止。
- 已安装的其他隔离运行时若能强制限制 exact IP+port、约束整个子进程树、禁用非受控本地代理和真实凭据，必须先由 Mac 执行账号证明真实接口、版本与作用域，不根据产品名称或文档宣传放行。Linux 容器测试不能冒充 macOS 原生 CLI 运行时。

**公开调查参考**：
- `sandbox-exec(1)` deprecated： https://man.freebsd.org/cgi/man.cgi?manpath=macOS+13.6.5&query=sandbox-exec&sektion=1
- Anthropic sandbox-runtime 的 macOS Seatbelt 规则： https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts
- Microsoft mxc Seatbelt 网络限制与 `localhost` 地址语义： https://github.com/microsoft/mxc/blob/main/docs/backends/seatbelt/seatbelt-backend.md

## 3. 本机只允许使用“真实监听 canary + 合成子进程”评估候选边界

本次 GitHub 执行账号**没有在 Mac 主机运行**这些检查，结果为 `NOT_RUN`；以下属于供本机执行账号使用的严格证据合同，不是测试 PASS。

- 仅在私有 `mkdtemp` 或新独占审计目录启动 **两个真实 TCP canary listener**：允许目标 `127.0.0.1:P`，禁止目标 `127.0.0.1:Q`（`Q != P`）。监听先于客户端，进程、端口和 ready 回执必须由父进程记录。可选第三个 `::1:R`，IPv6 不可用则记 `NOT_EVALUATED`。
- 必须先由沙箱外的合成客户端连接 P、Q，**均成功并各自增加 listener accept 计数**，证明确实在监听，而不是端口空缺。
- 再从**真实受控原生隔离进程**的合成 Node 子进程连接 P（必须成功），连接 Q（必须被内核策略以 `EPERM/EACCES` 或明确的沙箱拒绝事件阻断）。若 Q 返回 `ECONNREFUSED/ETIMEDOUT/DNS 失败`、空日志或 server 未监听，则判 `NOT_EVALUATED/FAIL`，不宣称强制拒绝。
- 同一隔离子进程派生的**孙进程**必须也无法连接 Q；本地 Unix socket 的独立合成 canary 必须用于排查借其他本地代理绕行的风险；若没有受控 FS/IPC 策略，`LOCAL_PROXY_BYPASS=BLOCKED`。
- 禁止客户端向公网 IP 发包、解析公共 DNS 或测试外部服务；非回环地址的拒绝必须由**实际策略语义与可验证的本地非公网目标**证明，不能靠“没看到外发”推断。不得创建暴露给 LAN 的全接口监听器。
- 需单独证明**严格 IP 绑定**（而不只是 `localhost:port`）、真实凭据/配置不可见、代理不可越界、工作目录与子进程树完整继承约束。任一无法证明都维持 `BLOCKED`。禁止用 `fetch` hook 充当这层证明。
- 只有当地址+端口与权限边界**全部成立**时，才有资格另行申请真实 CLI B0-RUN；上述端口 canary 即使通过，也不能自动抵消 Seatbelt `localhost` 匹配范围的已知限制。

## 4. B0-PREP 的证据状态与立即停止条件

| 检查项 | 当前状态 | 依据/缺口 |
| --- | --- | --- |
| REPOSITORY_BASELINE | PASS | GitHub HEAD 与 `7baf360b7f52e2218ce2828f8a054b0262581d76` 相同（文档修订前） |
| MAC08_OFFLINE | PASS | 上一轮 Mac 报告 487/487；本轮不重跑，非本账号亲自 Mac 实测 |
| MAC08_REAL_MODEL_CONSUMPTION | NOT_EVALUATED | 未做真实模型附件消费验证 |
| MAC10_IDENTITY_BINDING | PASS | 保留旧 Mac 479 项与探针证据，不重跑 |
| FETCH_GUARD_INITIALIZATION | PASS | 继承上一轮 Mac 合成探针报告；不是外发阻断 |
| MAC09_SYNTHETIC_315S | PASS | 继承 315024ms 合成对照报告；非真实 CLI |
| B0_NATIVE_SANDBOX_AVAILABILITY | NOT_RUN | 无用户 Mac 原生接口回执 |
| B0_CANARY_ALLOWED_DENIED | NOT_RUN | 无两个已监听 canary 的原生证据 |
| B0_STRICT_ADDRESS_PORT_BOUNDARY | BLOCKED | Seatbelt `localhost` 不证明严格 127.0.0.1；未发现其他已核实强制机制 |
| B0_CHILD_AND_CREDENTIAL_ISOLATION | BLOCKED | 缺完整子进程、文件系统/Keychain 与 IPC 证据 |
| MAC09_REAL_CLI_LOOPBACK | BLOCKED | 不得启动真实 CLI |
| MAC09_REAL_PROVIDER | NOT_RUN | 0 次被测供应商请求授权 |
| MAC06_REAL_REVIEW | FAIL | --backend real 尚未实现 |
| DURABLE_JOB_REAL | NOT_RUN | 禁止启动 |
| INSTALL_SWITCH | BLOCKED | 不改正式安装 |

**停止裁定**：在无法核实严格的回环地址+端口与真实凭据隔离以前，B0-RUN 不具备启动条件。重复 315 秒合成测试不会改变该决定。不要通过调整真实 `mmx` 代理、卸载防火墙或删除凭据尝试“找一个通过”。

## 5. 待批准 B0-RUN 单（仅草案；不得执行）

| 属性 | 约束 |
| --- | --- |
| AUTHORIZATION | **NOT_GRANTED** |
| SOURCE_SHA | `7baf360b7f52e2218ce2828f8a054b0262581d76`（B0-PREP 文档修订的 SHA 不改变这个测试身份） |
| 入口 | 仅固定 SHA 的仓库 `skills/mmx/scripts/mmx-chat.js` wrapper，候选 npm shim 只在该隔离验收进程的 PATH 前置；禁止裸 `mmx` |
| 服务与材料 | 独占 `127.0.0.1:P` 非生产合成 HTTP 服务；1 份无密钥的合成请求材料，1 个明确固定的合成模型标识 |
| 调用上限 | **1 次真实 CLI 启动、恰好 1 次允许的本地业务请求、0 次真实供应商请求、0 次真实凭据访问**；任何额外 HTTP 尝试（包含地域探测/更新检查/重定向/重试）须阻断并记录 |
| 延迟与时限 | 服务端延迟响应头 **315000ms**；候选 CLI request timeout **390s**，仓库 wrapper timeout **435s**，总验收 cutoff **470s**；执行前再次验证上述参数确实由受控 wrapper/固定版本解释且没有额外后台重试 |
| 网络 | 在批准之前实证只允许本次 `127.0.0.1:P`；其它端口及地址、代理和本地 Unix socket 绕行必须强制拒绝，重定向不能逃逸 |
| 凭据 | 私有合成 HOME/配置/环境，不挂载真实 Keychain/配置、无真实 Token；需要可证明的文件与 IPC 隔离；不得改全局配置 |
| 计数/证据 | 业务服务 listener accept 次数、每次 HTTP path、CLI/子进程 PID、连接拒绝事件、guard `applied`、完整脱敏 stdout/stderr/退出码、时间戳与 SHA256 |
| 停止条件 | 强制隔离或凭据证明缺失；额外连接尝试；未知调用；接近超时预算；guard 失败；请求数超限；终态未知、自动重试或进程树残留 |
| 阶段结束 | 仅 B0 本地真实 CLI 回环，不提升 `REAL_PROVIDER`、`DURABLE_JOB_REAL`、`MAC06_REAL_REVIEW`、`INSTALL_SWITCH` |

**批准门槛**：Mac 本地 B0 canary、严格地址/端口、完整子进程/凭据/代理隔离均需新原生证据；再次给出完整 SHA、命令与成本/时长后，由用户对**这份 B0-RUN 草案**单独明确批准。当前继续指令、零费用和既往批准不构成许可。

## 6. 归档要求

B0-PREP 后续 Mac 本机执行账号应创建新的证据根，保存候选机制、profile 原文及 SHA256、canary listener ready/accept 计数、子/孙进程 stdout/stderr/退出码、禁止端口权限拒绝、凭据隔离与代理阻断、`b0-run-authorization.md`、`verdict.md` 和 `SHA256SUMS`。

不能重用旧成功目录、删锁或清理 Job；本 GitHub 文档调查不是这些 Mac 原生证据。
