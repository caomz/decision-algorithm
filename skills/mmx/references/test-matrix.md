# MMX 实测矩阵

如实记录每条路径的覆盖方式。"mock" = 用假 `mmx` 二进制构造该失败形态；"真实" = 调用本机真实 mmx 走通 API；"构造" = 本地构造输入触发。

本文件是**事实记录**，不是契约。契约见 [verification.md](verification.md)。

## 2026-11-18 增量验证（Windows，mmx-cli 1.0.28，Node v22.20.0）

| 路径 | 覆盖方式 | 结果 |
|---|---|---|
| `mmx-batch.js` 离线契约（`MMX_BATCH_WRAPPER` 注入假 wrapper） | mock：`tests/mmx-batch.test.js` | 15/15 通过；覆盖参数拒绝、输入顺序、传输 gate、预算/额度重试、坏 stdout、目录输入与落盘回执 |
| 两片真实并行批量 + 小预算自愈 | 真实：2 片并行，含一次预算重发 | 批级墙钟 4.5s；`--max-tokens 128` 片首发 `thinking_budget_exhausted`，按 profile 提至 524288 重发一次，`first_attempt` 与终态回执均保留 |
| 外层超时公式复核 | 构造 | 修正为 `ceil(N/C)×(2×wrap-timeout+30s)+60s`，覆盖每片一次重发与限流退避；原单次公式会误杀重试中的批次 |
| 目录自然序与 `receipt_file` 一致性 | 构造/离线 | `.txt` 按 `p1,p2,p10` 自然序处理；stdout 与落盘回执分片顺序一致，落盘文件同样携带 `receipt_file` 字段 |

## 2026-11-17 合并验证（Windows，mmx-cli 1.0.28，Node v22.20.0）

| 路径 | 覆盖方式 | 结果 |
|---|---|---|
| `node --check`（四个脚本） | 真实（Git Bash + PowerShell） | 全部通过 |
| `node --test tests/mmx-chat.test.js` | 真实（Git Bash + PowerShell 各一遍） | 36/36 通过 |
| `node scripts/mmx-chat.js --version` | 真实 | `mmx-chat 2.4.0` |
| 真实 API 冒烟（受管布局 fixture） | 真实 ×1 | `status:"ok"`, `model:"MiniMax-M3.1-Flash"`, `stop_reason:"end_turn"`, `input_tokens:7`, `output_tokens:29` |
| 真实 API 冒烟（**已安装的 junction 路径** `~/.zcode/skills/mmx`，PowerShell 调用块） | 真实 ×1 | `status:"ok"`, `text:"MMX_MERGED_OK"`, `model:"MiniMax-M3.1-Flash"`, `input_tokens:84`, `output_tokens:20` |
| 真实 API Review 路径（nonce 定界 + system prompt + review-v1 schema 指令） | 真实 ×1 | `status:"ok"`, 正文为单个 JSON 对象 `{"version":1,"summary":"...","findings":[]}`；经 `jsonschema` 对本地 `review-v1.schema.json` 校验**通过**；空 findings 数组表示无发现 |
| 受管布局（`agy/` + `cross-validation/` 同级）缺清单 | 真实 | `install_mismatch`，`cli_invoked:false`，未启动 CLI |
| 非受管布局（仅 `mmx/`、无兄弟目录）无清单 | 真实 | 放行，正常调用 |
| `repin-release.js` 产出的清单被 wrapper 接受 | 真实 | 校验通过，正常调用 |
| 超时优先级（flag > 环境变量 > profile）与非法值 | mock | 覆盖 env 与 flag 两档来源；`0`/`1.2`/`abc`/`3601` 与 `wrap<=req` 均 `usage_error` |
| 只有 thinking 块的回复 | mock ×2 | 均为 `thinking_budget_exhausted`（含 `stop_reason=max_tokens` 变体），不是 `schema_mismatch` |
| `auth_error` 的可执行指引 | mock | 错误文本含 `mmx auth login` |
| wrapper 使用的 CLI flag 在 mmx-cli 1.0.28 中存在 | 真实（源码核对） | `--timeout`（全局）、`--no-color`、`--non-interactive`、`--messages-file`、`--max-tokens` 均存在 |
| CLI 端点与响应形状 | 真实（源码核对） | 走 `/v1/messages`，Anthropic 风格（`model`/`stop_reason`/`content[]`/`usage.input_tokens`/`output_tokens`），与 wrapper 契约一致 |
| 官方 `mmx-cli` skill 全量指南收编 | 真实（逐字节比对） | `references/cli-reference.md` 正文与官方一致；`h3-video/` 两文件一致 |
| 安装器回归（`pytest tests -q`） | 真实 | 11 passed |

## 2026-10-26 增量（Windows，mmx-cli 1.0.28，默认模型 MiniMax-M3.1-Flash）

| 路径 | 覆盖方式 | 结果 |
|---|---|---|
| 小 prompt 冒烟（`Reply with exactly MMX_AUDIT_OK.`） | 真实 ×1 | `status:"ok"`, `text:"MMX_AUDIT_OK"`, `model:"MiniMax-M3.1-Flash"`, `input_tokens:213`, `output_tokens:25` |
| 不传 `--max-tokens`（默认 524288）对 M3.1-Flash | 真实 ×1 | 未触发 HTTP 400；**长输出与 400 分支未覆盖** |
| `--timeout` / `--wrap-timeout`（CLI 覆盖 env） | mock dump argv | `--timeout 7` 覆盖 env=70；非法值 / `wrap<=req` → `usage_error` |
| Windows 超时子进程树回收（mock 孙进程） | mock ×1 | 超时返回 `timeout`；`taskkill /T /F` 后孙进程 `CHILD_GONE`，无残留 |
| 模型标识 | 真实 ×1 | 文档记 `MiniMax-M3.1-Flash-Preview`，实际返回 `MiniMax-M3.1-Flash`；以响应 `model` 为准 |
| `auth status` 预检开销 | 实测 ×1 | 2342ms（exit 0）——不是零成本；本版不预检，改为在 `auth_error` 里给 `mmx auth login` 指引 |
| mock 负向矩阵（thinking / truncated / badjson / empty / api_error / 非零退出+成功形状 / auth code3） | mock ×7 | 各 status 正确，无伪 PASS |
| 改造后 challenge 真实请求（240s / 300s 各一次） | 真实 ×2 | 均 `api_error`(code 5) `Request timed out`；gate = **NOT_EVALUATED**（服务端思考超时，按硬上限停止） |

## 2026-10-19 真机补验（Windows，mmx-cli 1.0.28）

| 路径 | 覆盖方式 | 结果 |
|---|---|---|
| Windows Git Bash POSIX 块端到端（含 cygpath 转换） | 真实 ×1 | `status:"ok"`, `model:"MiniMax-M3.1-Flash-Preview"`, `truncated:false` |
| Windows PowerShell 块端到端（`WriteAllText` 无 BOM） | 真实 ×1 | `status:"ok"`, `text:"MMX_PS_OK"`, `input_tokens:212` |
| 内部临时目录泄漏复查（`%TEMP%\mmx-chat-*`） | 真实 ×1 | 为 0 —— wrapper 内部清理闭环无泄漏 |
| Linux POSIX 块 / 真实未认证机 `auth_error` / 真实 `timeout` | — | **仍未覆盖** |

## 2026-10 复核增量（mmx-cli 1.0.28）

| 路径 | 覆盖方式 | 结果 |
|---|---|---|
| 调用面 / 配置面复核（`mmx text chat --help`、`mmx --help`、`mmx config show`） | 真实 ×3 | 无任何 thinking / reasoning / effort flag 或配置项 |
| 请求体复核（`--dry-run`） | 真实 ×1 | `{model, messages, max_tokens, stream}`，无 `thinking` 字段 |
| 响应含思考 + 端点确认 | 真实 ×1 | 含 `{"type":"thinking"}` 块 + `usage.thinking_tokens`(12)；端点 `/anthropic/v1/messages` |
| 复杂 prompt × `MMX_CHAT_REQ_TIMEOUT=80` | 真实 ×1 | `api_error`(code 5) `Request timed out`；调至 180 / 210 后 `status:"ok"` |

## 2026-08 基线（mmx-cli 1.0.19）

| 路径 | 覆盖方式 | 结果 |
|---|---|---|
| `ok`（含 SKILL.md bash 块端到端） | 真实 ×2 | `status:"ok"`, `text:"MMX_OK"`, `model:"MiniMax-M3"` |
| `auth_error`（code 3） | mock | 正确短路 |
| auth 输出带噪音前缀 / auth 不可判定 | mock | 容忍前缀；不可判定→`ok` + `warning` |
| `api_error`（stderr 错误对象） | mock | `code`/`message`/`hint` 正确，`sk-***` 脱敏生效 |
| `api_error`（上游瞬时 HTTP 404） | 真实 ×1 | 正确报 `api_error`（`code:1`），exit 1；重试即恢复 `ok` |
| `empty_stdout` / `invalid_json` / `schema_mismatch` / `base_resp` 非零 | mock | 各 status 正确 |
| 非零退出 + 成功形状 → 降级 | mock | 正确降为 `api_error` |
| `truncated:true`（stop_reason=max_tokens） | mock | 正确 |
| 挂起 → `timeout` | mock（WRAP=2s） | `timeout`, `exit_code:124` |
| `--model` 透传 / `invalid_model` / 未知参数 | mock | 正确 |
| `prompt_too_large`（262145B）/ 空 prompt / 缺 prompt / 非法 timeout knob | 构造 | 正确（旧版 `mmx-chat.js` 行为；当前版本不设字节上限，`mcode-verify.js` 仍保留该上限） |
| `cli_missing` | PATH 隔离 | 正确 |
| prompt 保真（`$()`、反引号、引号、中文、多行） | mock dump messages.json | 逐字送达，本地无执行 |
| 临时目录清理 / 外来文件保留不递归删 | 构造 | 正确 |
| `--max-tokens 1000000` → API 拒绝 | 真实 ×1 | `api_error`(HTTP 400)：`MiniMax-M3 does not support max tokens > 524288` |
| 真实未认证机 `auth_error` | — | **未覆盖** |

## mcode `--effort` 突破最高思考等级（对 @minimax-ai/code 0.5.0）

| 路径 | 覆盖方式 | 结果 |
|---|---|---|
| mcode 能力面（`exec --help`） | 真实 ×1 | 有 `--effort <level>` |
| 合法档位枚举 | 真实 ×1 | `default, low, medium, high, xhigh, max` —— **`max` 为最高档** |
| 默认模型不支持 effort | 真实 ×1 | `does not support reasoning effort selection`，exit 2 |
| `--config` 临时 Runtime 配置补 `effortOptions` | 真实 ×1 | exit 0，`status:"ok"`，`variant:"thinking"`，`protocol:"openai-responses"` |
| 请求体载荷取证（本地捕获代理） | 真实 ×2 | `--effort low` → `reasoning:{"effort":"low"}`；`--effort max` → `reasoning:{"effort":"max"}`（真实下发） |
| 档位与输出 token 单调性（同 prompt 5 题） | 真实 ×3 | low 385 < xhigh 491 < **max 612** output tokens |
| 与 native mmx 对照（同题库） | 真实 ×1 | native mmx 5/5、outTok 378、**wall 5.1s**；mcode max 5/5、outTok 612、wall 64.2s |
| 成本对比 | 真实 ×1 | mcode 每次注入约 **18k** input token 的 agent 系统提示（mmx 约 270） |
| `mcode-verify.js` 包装器契约测试 | 真实 ×8 | node --check / effort 枚举校验 / `--model` 白名单 / `--timeout` 严格整数与上限 / `--dump-config` 不吞参且不落盘 / `--effort bogus` 立即 exit 1 且零落盘零模型调用 / 临时目录零残留 |
| POSIX 路径校验 / Windows junction 判定 | — | **未覆盖**（本机为 Windows） |

## 仍未覆盖

- Linux / WSL 的真机调用路径。
- 真实未认证机上的 `auth_error`。
- 真实请求的 `timeout`（仅 mock 与构造覆盖）。
- `--max-tokens` 超 524288 的真实 HTTP 400 分支（仅 1.0.19 时期覆盖过）。
