# mmx · MiniMax 交叉验证

MMX 一方的文本复核 skill：`/mmx <问题>`、`/mmx review <文件>`、`/mmx challenge <问题>`，与 `zcode` skill 组成默认的 ZCode/MMX 双模型交叉验证。同时收编官方 `mmx-cli` skill 的全量 CLI 参考，图片、视频、语音、网页搜索等非文本能力走同一入口。

> 本目录是**跨平台合并后的本体**。两台机器的安装形态不同：
> - **Windows**：各 harness 的 `skills/mmx/` 都是指向本仓库的 junction（`~/.zcode`、`~/.agents`、`~/.claude`、`~/.codex`、`~/.minimax`、`~/.openclaw` 等），改本目录即两端生效，无需重钉清单。
> - **macOS**：受管发布，安装在 `~/.claude/skills` 等位置，同级有 `agy/` 与 `cross-validation/`，并带 `.gstack-cross-validation-release.json` 清单。更新本目录后需同步到正本并重钉清单（见「跨平台要点」）。
>
> **2026-11-17 三方合并**：macOS 侧 `skills/mmx`（加固 wrapper，受管发布 + review-v1 协议）、Windows 侧 `~/.claude/skills/mmx`（实战版：auth 指引、thinking 分类、mcode 通道、Windows 运维）、官方 `mmx-cli` skill（全模态 CLI 指南）合并为本 skill v2.4.0。
>
> **2026-11-18 v2.5.0**：新增 `scripts/mmx-batch.js` 分片批量入口（有界并发池 + 传输层 gate + 单次调用安全门禁），修复多分片交叉验证的两大复发故障：裸 CLI 默认 4096 预算截断、逐片串行墙钟求和。
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
│   ├── mmx-batch.js                  # 分片批量入口（并行池 + 传输层 gate + 单次调用安全门禁）
│   ├── mcode-verify.js               # 最高思考等级独立通道（mcode --effort max）
│   ├── mmx-clean-temp.js             # Windows %TEMP% 外层目录清理（特征形态 + 显式豁免，默认 dry-run）
│   └── repin-release.js              # 受管发布清单重钉工具
├── profiles/local.json               # 本机运行配置（模型、输出预算、请求/包装超时）
├── tests/mmx-chat.test.js            # 离线测试（假 CLI，不触网、不耗额度）
├── tests/mmx-batch.test.js           # 批量入口离线测试（假 wrapper）
└── evals/evals.json                  # 评测用例
```

## V2.1 候选行为

- ZCode 主校验优先并立即交付，MMX 后续复核；有效主侧 P1 阻断同版本 MMX。完整双模型门禁不变，详见[调度合同](../zcode-mmx-review/zcode-mmx-review.md)。
- MMX 批内并发 1、自动重试 0；请求/wrapper/supervisor 保持 600/630/650 秒，输出预算保持 524288。
- 逻辑分片实验目标 12 KiB，batch 默认单片上限 16 KiB，可用 `--shard-max-bytes 8192..16384` 调整。按完整断言/模块拆分；超限先拒绝，不静默截断。直接 chat 的既有大输入合同不变。
- `--expected-cli-version 1.0.29` 可固定本次已安装 CLI，版本不符先拒绝并记录可核验元数据，不自动升级。
- `mmx-job.js` 仅显式 fixture 实验，提供幂等提交、查询和跨会话单槽；默认禁用真实持久任务。`UNKNOWN` 不自动重发，宿主等待到期不取消。
- guard 初始化、真实 CLI 传输行为、真实供应方和原生生命周期分别验收，见[超时实验](../../docs/zmx-stability-v2/03-v21-timeout-experiment.md)与[持久任务](../../docs/zmx-stability-v2/04-durable-tasks.md)。历史 Windows/Mac 测试不代替本提交验收。

## 合并取舍

| 维度 | 采用 | 未采用 |
|------|------|--------|
| 超时 | 默认请求 600s / 包装 630s（对齐 `zcode-mmx-review.md` 的每方 600 秒与 zcode 侧默认值）；CLI flag > 环境变量 > profile | macOS 原 profile 的 21600s / 21630s（6 小时对交互式工具不合理） |
| 认证 | 不预检，改为 `auth_error` 附 `mmx auth login` 指引（零额外调用成本） | Windows 版的 `mmx auth status` 预检（实测 2.3s，且可能误判） |
| gate | 结构化 findings（`kind` + `severity`）计算 | Windows 版的 `[P1]` 字符串匹配（`No [P1] findings` 会误判） |
| 输出预算 | 不设字节上限，由宿主控制范围 | Windows 版的 256 KiB `prompt_too_large`（仓库版既有测试明确要求不截断） |
| 思考块 | `stop_reason=max_tokens` 且只有思考块时归类为 `thinking_budget_exhausted`（预算问题，不是契约漂移）；其他结束原因下没有正文记 `schema_mismatch`，附 `stop_reason` 与块类型（v2.7.0 起） | 一律归类为 `schema_mismatch`（会误导人去核对 CLI 契约） |
| 错误回执 | 只输出分类、数值码与固定提示，不回显上游原文 | Windows 版的原文回显（需额外脱敏） |

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
