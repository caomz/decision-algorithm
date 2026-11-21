# mmx · MiniMax 交叉验证

MMX 一方的文本复核 skill：`/mmx <问题>`、`/mmx review <文件>`、`/mmx challenge <问题>`，与 `zcode` skill 组成默认的 ZCode/MMX 双模型交叉验证。同时收编官方 `mmx-cli` skill 的全量 CLI 参考，图片、视频、语音、网页搜索等非文本能力走同一入口。

> 本目录是**跨平台合并后的本体**。两台机器的安装形态不同：
> - **Windows**：各 harness 的 `skills/mmx/` 都是指向本仓库的 junction（`~/.zcode`、`~/.agents`、`~/.claude`、`~/.codex`、`~/.minimax`、`~/.openclaw` 等），改本目录即两端生效，无需重钉清单。
> - **macOS**：受管发布，安装在 `~/.claude/skills` 等位置，同级有 `agy/` 与 `cross-validation/`，并带 `.gstack-cross-validation-release.json` 清单。更新本目录后需同步到正本并重钉清单（见「跨平台要点」）。
>
> **2026-11-17 三方合并**：macOS 侧 `skills/mmx`（加固 wrapper，受管发布 + review-v1 协议）、Windows 侧 `~/.claude/skills/mmx`（实战版：auth 指引、thinking 分类、mcode 通道、Windows 运维）、官方 `mmx-cli` skill（全模态 CLI 指南）合并为本 skill v2.4.0。
>
> **2026-11-18 v2.5.0**：新增 `scripts/mmx-batch.js` 分片批量入口（有界并发池 + 传输层 gate + 预算自愈），修复多分片交叉验证的两大复发故障：裸 CLI 默认 4096 预算截断、逐片串行墙钟求和。
>
> **2026-11-19 v2.7.0**：从 macOS 线回传三项修复：预加载 fetch 防护，取消 Node fetch 的 300 秒响应头上限；`thinking_budget_exhausted` 只在 `stop_reason=max_tokens` 时成立；只对子进程去掉 `MINIMAX_BASE_URL` 末尾的 `/v1`，并给 HTTP 404 诊断。wrapper 版本与 `SKILL.md` 统一为 2.7.0，并加一致性测试。只在 macOS 实测过，Windows 待测，见 [test-matrix](references/test-matrix.md)。

## 外部依赖

| 依赖 | 说明 |
|------|------|
| MMX CLI | `npm install -g mmx-cli`；需 `mmx auth login` 或配置 `MINIMAX_API_KEY`。macOS 实测 1.0.26，Windows 实测 1.0.28 |
| Node.js | `>=18`；macOS 实测 v24.15.0，Windows 实测 v22.20.0 |
| mcode（可选） | `@minimax-ai/code`，仅 `scripts/mcode-verify.js` 的最高思考等级通道需要 |

## 目录结构

```
mmx/
├── SKILL.md                          # ⭐ Skill 入口（调用、prompt 构造、Review 协议、gate、交叉验证工作流）
├── references/
│   ├── verification.md               # 各平台调用方式、CLI 契约、受管发布、验证矩阵
│   ├── test-matrix.md                # 逐路径实测记录（mock / 真实 / 构造）
│   ├── review-v1.schema.json         # 与 zcode skill 逐字节一致的复核返回结构
│   ├── cli-reference.md              # 官方 mmx-cli 指南收编（全模态 CLI）
│   └── h3-video/                     # 官方 MiniMax-H3 视频子指南收编
├── scripts/
│   ├── mmx-chat.js                   # 同步文本 wrapper（唯一 JSON 回执信封）
│   ├── mmx-batch.js                  # 分片批量入口（并行池 + 传输层 gate + 预算自愈）
│   ├── mcode-verify.js               # 最高思考等级独立通道（mcode --effort max）
│   ├── mmx-clean-temp.js             # Windows %TEMP% 外层目录清理（特征形态 + 显式豁免，默认 dry-run）
│   └── repin-release.js              # 受管发布清单重钉工具
├── profiles/local.json               # 本机运行配置（模型、输出预算、请求/包装超时）
├── tests/mmx-chat.test.js            # 离线测试（假 CLI，不触网、不耗额度）
├── tests/mmx-batch.test.js           # 批量入口离线测试（假 wrapper）
└── evals/evals.json                  # 评测用例
```

## 合并取舍

| 维度 | 采用 | 未采用 |
|------|------|--------|
| 超时 | 默认请求 600s / 包装 630s（对齐 `zcode-mmx-review.md` 的每方 600 秒与 zcode 侧默认值）；CLI flag > 环境变量 > profile | macOS 原 profile 的 21600s / 21630s（6 小时对交互式工具不合理） |
| 认证 | 不预检，改为 `auth_error` 附 `mmx auth login` 指引（零额外调用成本） | Windows 版的 `mmx auth status` 预检（实测 2.3s，且可能误判） |
| gate | 结构化 findings（`kind` + `severity`）计算 | Windows 版的 `[P1]` 字符串匹配（`No [P1] findings` 会误判） |
| 输出预算 | 不设字节上限，由宿主控制范围 | Windows 版的 256 KiB `prompt_too_large`（仓库版既有测试明确要求不截断） |
| 思考块 | `stop_reason=max_tokens` 且只有思考块时归类为 `thinking_budget_exhausted`（预算问题，不是契约漂移）；其他结束原因下没有正文记 `schema_mismatch`，附 `stop_reason` 与块类型（v2.7.0 起） | 一律归类为 `schema_mismatch`（会误导人去核对 CLI 契约） |
| 错误回执 | 只输出分类、数值码与固定提示，不回显上游原文 | Windows 版的原文回显（需额外脱敏） |

## 长任务持久化 Job（阶段 3，实验性）

新增 `scripts/mmx-job.js`，在独立后台进程中调用现有 `mmx-batch.js`。启动时原子创建任务目录，并复制分片及运行 Profile 到只读用途的输入快照（附 SHA-256）。重复使用同一个目录时 **start 拒绝**，避免主 Agent 等待超时后再次发送付费请求。

```bash
# 在项目目录外选一个从未存在的 Job 路径；先用离线测试验收
node skills/mmx/scripts/mmx-job.js start /absolute/path/to/jobs/review-001 --prompt-file /absolute/path/to/shard1.txt --concurrency 1
node skills/mmx/scripts/mmx-job.js status /absolute/path/to/jobs/review-001
node skills/mmx/scripts/mmx-job.js resume /absolute/path/to/jobs/review-001
node skills/mmx/scripts/mmx-job.js verify /absolute/path/to/jobs/review-001
node skills/mmx/scripts/mmx-job.js cancel /absolute/path/to/jobs/review-001
```

- `start`：创建持久 Job 和独立监督进程，返回目录与 PID；不等待供应商请求完成。
- `status`：核验完成记录、最终回执；只有原子发布的 `completion.json` 与各记录摘要一致，且观察到批进程退出（或启动前取消）时才报告 `finished`。旧版、缺失、变动或未完成的记录保持 `unknown`，不得据此再启动。
- `resume`：**只重新附着到已有记录查询**，不重发请求。自动从中断点重新执行尚未实现。
- `verify`：核对输入快照、实际参数与快照绑定、请求与批处理脚本摘要，以及输出/回执/退出记录的一致性；只有 `integrity=match` 时退出 0，损坏或未完成时退出 2。这是本地记录自洽校验，不是供应商响应的真实性证明。
- `cancel`：写取消标志；启动前已取消则不创建批进程。运行中先请求协作清理，POSIX 下 5 秒宽限后升级强制结束，再最多等待 2 秒。记录分别报告 `batch_exit_observed`、`batch_group_gone`；它们不证明独立进程组内的 CLI 或服务端请求已结束。`termination_confirmed=true` 仅用于从未启动批进程的取消；已启动任务正常退出记 `null`、取消后记 `false`。Windows 原生取消仍需独立验收。
- Job 进程崩溃、强杀或监督进程失联时，状态可能保持 `unknown`；**不要自动重试或删除已有 Job**。如已启用 `MMX_GLOBAL_SLOT=1`，仍须核实遗留 Provider 锁与外部请求。

新 Job 使用记录格式 2：`request-digest.json` 绑定请求，`completion.json` 最后原子发布，永久保留的 `worker.lock` 拒绝 worker 重入。仅有 `execution.json` 不再充当完成凭据。批处理也要求成功回执与实际零退出一致，输出成功 JSON 后异常退出或被信号终止不能得到 PASS。

此阶段先实现持久化执行、查询与保守不重放。分片级断点续跑、跨进程完整树退出证明和任务孤儿回收留待进一步验收；云端离线 CI 通过不等于 Mac 真机带凭据验证通过。

## 跨会话并发槽位（实验性，显式开启）

MMX 2.7.0 后续云端改造新增 `scripts/mmx-provider-slot.js`。当 `MMX_GLOBAL_SLOT=1` 时，`mmx-chat.js` 在发起 CLI 子进程前取得**同一用户、同一台主机**共用的原子文件锁（`~/.zmx/locks/mmx/slot-0/`），直到请求子进程确认结束后释放。独立 Agent 会话或 Batch 只有在都启用了这一开关后才参与排队；它**不是跨机器分布式锁**，也不是云端 API 配额仲裁。

未明确启用时，沿用原来的并发行为；在 Mac/Windows 真机验收前不默认开启。此锁采用 **fail closed**：进程遭强制杀死或无法确认其子进程树清理完成时，锁可能保留，不会自动判定上游请求结束并抢锁重发。应先确认原请求已经停止，再人工处理遗留的 `slot-0`；不得在未知请求状态下直接删除锁。等待超过 120 秒会返回 `slot_unavailable`，不会静默绕过保护或发起新请求。

POSIX 下，CLI 主进程退出后仍存在同一进程组的后代时，wrapper 返回 `cleanup_error` 并尝试有时限的清理；只有确认该进程组不存在才释放槽位，否则回执标记 `provider_slot: held_for_recovery`。发送终止信号成功不等于清理完成。槽位被替换或目录变成符号链接时也拒绝释放，避免删除其他请求的记录。Windows 原生子进程树清理仍须单独验收；本地进程退出也不能证明服务端已经撤销断线或超时请求。

锁释放无法确认时，回执返回 `slot_unavailable` 和 `provider_slot=release_unverified`，并保留已观察到的 CLI 退出码。若 `cli_invoked=true`，先核对原请求状态和锁归属，再决定是否重试。

受管 Mac 发布时，要把 `mmx-provider-slot.js` 与 wrapper 一同发布，再按原有发布流程重钉清单。显式开启槽位时，该 helper 必须在发布清单中且哈希匹配，否则在启动 CLI 前返回 `install_mismatch`。文件还未同步到受管安装目录时，不得仅更新 `mmx-chat.js`。

## 跨平台要点

- wrapper 的受管根按**结构**判定（同级 `agy/` 与 `cross-validation/` 目录 + 发布清单），不再依赖某一台机器的绝对路径。
- Windows 分支已在真机验证：`.cmd` shim 解析、`taskkill` 树终止、MSYS 路径转换、`node --check` 与 36 个离线测试（PowerShell 与 Git Bash 各一遍）。
- Windows 上 `%TEMP%` 不会自动回收，`mmx` 形态的外层目录（含 `mmxP1.*`、`mmxA.*`、`mmxrun.*`、`mmxdbg3.*` 等手工暂存）会持续积累，用 `node scripts/mmx-clean-temp.js` 清理（默认 dry-run，`--apply` 才删；`mmx-chat-*` 与 `mcv.*` 显式豁免）。
- 受管安装更新 wrapper 后清单哈希必然失配，需重钉：

```bash
# macOS 受管安装：<skills_root> 是含 agy/、mmx/、cross-validation/ 的目录
node /Volumes/WorkSSD/.claude/skills/mmx/scripts/repin-release.js \
  --root /Volumes/WorkSSD/.claude/skills
```

脚本按 wrapper 的校验契约重建 `.gstack-cross-validation-release.json`；缺必需文件时拒绝写入并列出缺失项，`--dry-run` 只报告不写入。清单只收 `.md`、`.py`、`.js`、`.json`、`.yaml` 五类发布文件（后缀集合与受管安装器相同，区分大小写）。隐藏条目（`.DS_Store`、`._*`、`.git` 等）、`__pycache__`、`node_modules` 和其他类型的文件不入清单，并在 stderr 逐条列出，所以 Python 重编译或 Finder 写元数据不会再让 wrapper 报 `install_mismatch`。

## 安装

仓库根目录的一键安装器把本 skill 链接到各平台安装位（Windows 上 symlink 不可用时自动回退 NTFS junction）：

```bash
python3 scripts/install_skills.py --skill mmx --apply
```

## 验证

```bash
cd skills/mmx
node --check scripts/mmx-chat.js
node --check scripts/mmx-batch.js
node --test tests/mmx-chat.test.js
node --test tests/mmx-batch.test.js
node --test tests/mmx-clean-temp.test.js
node scripts/mmx-chat.js --version
node scripts/mmx-batch.js --version
```

真实 API 冒烟会消耗 quota，须经用户授权后进行。
