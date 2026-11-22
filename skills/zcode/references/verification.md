# ZCode 调用与验证

## 当前契约

以本机 `zcode --version`、`zcode doctor --json`、解析器和实际运行事件为准。当前适配 `0.17.1`，不向 CLI 传入不支持的 `--model`、`--max-tokens`、`--allowed-tools`、`--settings`、`--max-turns` 或 stdin prompt。

官方参考：[CLI 参数](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/02-cli-reference.md)、[运行配置](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/03-config.md)、[自动化](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/13-automation.md)。升级后需复核解析器、事件契约、工具清单及禁用配置。版本相同不证明两个构建相同；每轮 `launch.json` 保存实际入口 SHA256。

`--prompt` 默认使用 `yolo`，本 wrapper 固定改为只读权限模式。模式按平台取默认值：macOS/Linux 为 `plan`（Mac 端既有验收结论），Windows 为 `guarded`（Windows 端既有适配）。`ZCODE_CLI_MODE` 可显式覆盖为 `plan` 或 `guarded`，其它值在请求前拒绝（`usage_error`）。实际使用的模式写入 `launch.json` 的 `mode` 字段，回溯以该文件为准。项目配置会过滤 `features` 等设置，因此不能靠项目配置关闭个人插件。wrapper 为 CLI 子进程创建独立用户目录，在其中写入用户运行配置，关闭 MCP、插件、skills、记忆、Hook、compact、rewind 和子 Agent，并传入全部已知工具 denylist。运行事件中的 `model_request.toolCount`、`model_complete.toolCallCount` 和 `turn.completed.toolCallCount` 均须为零；发现暴露工具或工具/权限事件立即终止并记录违规。运行事件校验属于检测，不能替代启动时配置。

本机 `zcode --version` 输出两行：`zcode-app-cli 3.18.1-46` 与 `zcode-runtime 0.17.1`。受支持的契约是 runtime 版本，取第二行的 `zcode-runtime`；单行输出（如 `zcode 0.17.1`）按原样比较。

子进程通过原 `ZCODE_DATA_BASE_DIR` 和 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 引用既有 provider/认证数据，不读取其内容到报告。CLI 自身按既有机制认证；wrapper 不执行登录、登出或配置迁移命令。用户目录、session DB、存储和日志独立，provider 数据根共享。仅转发必要 PATH/系统、语言、证书和明确的 `ZCODE_HTTP_PROXY`、`ZCODE_NO_PROXY`、`ZCODE_AGENT_CA_CERT`；用户运行配置中的网络设置不会自动继承。

macOS 的 Security.framework 按子进程 HOME 查找默认 Keychain，空白用户目录会导致 `CREDENTIAL_SECURE_STORAGE_UNAVAILABLE`。启动前在原用户环境执行只读的 `security default-keychain -d user`，在私有临时 HOME 的 `Library/Keychains/login.keychain-db` 链接该现有文件。不复制 Keychain、不设置新的系统默认 Keychain、不绕过系统解锁或访问控制。查找失败在请求前返回 `auth_environment_error`。运行目录保留这个认证链接，归档时不可跟随符号链接复制其目标。假 CLI 测试通过显式依赖注入跳过真实 Keychain 查询；适配本身用合成 Keychain 文件测试。

## 调用

### 持久后台运行

`node <skill>/scripts/zcode-run.js start <new-job-dir> <wrapper 参数>` 创建私有 job，后台监督进程与调用方终端分离，stdin 关闭，日志写入文件。它只启动一次 wrapper，后续使用 `status <job-dir>` 读取同一任务。不要对同一请求重复 start，也不要把观察超时当作任务退出。

job 保存 `request.json`（仅参数及文件路径）、`launch.json`、`started.json`、`execution.json`、`stdout.json` 和 `stderr.log`，wrapper 的产物位于 `run/`。`execution.json` 的退出码和信号来自外层 `close` 事件，即使 wrapper 被 SIGKILL、未写最终回执也会保存。最终 `receipt.json` 原子发布；若存量回执损坏，`status` 保留外层退出信息并显示 `receipt_unreadable=true`，不据此判成功。`finished` 是进程终态，不是审核通过；实际接受还要求完整 wrapper 回执、成功终态与内容协议有效。POSIX `running` 同时检查 PID 存活及完整宽度的监督进程命令归属；无法确认时是 `unknown`，核对同一进程，不重新调用模型。Windows 的进程身份和进程树行为尚未真机验证。

wrapper 在准备、运行、首个模型请求及结束时原子写入 `progress.json`，保留两个 PID 和阶段。外层截止时间为请求时限加 45 秒预检/清理余量；到期先终止本任务 wrapper 进程组，再升级并终止其记录的 CLI 进程组。所有阶段均不自动重试。

### 同步持续终端

使用文件编辑工具准备 UTF-8 prompt。POSIX 目录权限 700、文件权限 600；避免在共享临时目录直接放明文文件。推荐使用宿主参数数组 API：

```js
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [
  "/absolute/path/to/zcode/scripts/zcode-chat.js",
  "--prompt-file", "/absolute/private/prompt.txt",
  "--output-dir", "/absolute/private/new-run",
], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
```

Review/Challenge 增加 `--mode review` 或 `--mode challenge`，并传 `--evidence-ids-file`。先明确材料 ID，wrapper 不会给未覆盖材料虚构引用。`ids.json` 必须是非空、无重复的**字符串**数组（如 `["E1","E2"]`）；对象数组会被 `validateIds` 拒绝为 `input_error`。正文置于 JSON 数据边界，避免 `/logout` 等开头被 CLI 当作本地命令。

**MAC-08 附件传输**：从 v1.5.2 起，wrapper 不区分大小阈值；chat/review/challenge 一律以固定短 `--prompt` + `--attach <私有文件>` 发送完整渲染后的 `buildPrompt`（含原文、审核规则、schema 和 evidence IDs），材料存于 `work/attached-material.txt`（父目录 0700、文件 0600）。`launch.json` 分别保存原材料字节数及 SHA256、完整渲染 prompt 字节数及 SHA256，不保存正文；附件写盘后逐字节复核，失败绝不回退为 argv 正文。官方 `v3.17.1` CLI 源码只证明附件路径经 `app.submitPrompt` 转交；本机打包的 `zcode-runtime 0.17.1` 是否完整解码、截断/分片和实际进入模型输入仍是独立验收项。假 CLI 读取完整文件的离线通过 **不是** 真实模型消费证明，未通过 Mac 真实授权验收前只用非敏感材料。

stdout 恰好一个 JSON 对象，包含 `status`、`cli_invoked`、`exit_code`、`signal`、`complete`、`model`、`stop_reason`、`truncated`、`usage`、`review_gate` 和存在时的 `artifacts_dir`。成功时还包含 `text`、`provider`、`model_identity_source`、session/turn/trace 标识；Review 有 `review`。错误保留未知字段为 `null`，不从退出码 1 推断认证或额度；仅结构化错误码 401/403、429 分别归类。

NDJSON 逐行解析并检查唯一末尾 result、匹配的会话/回合和成功 `turn.completed`；模型身份来自 `session.updated` 的实际请求载荷。结束原因来自主回合 `model_complete` 载荷，而不是伪造 MMX 的 `end_turn`。中间 `length` 也保守标记截断；不把自动续写当作完整性证明。未知事件完整保留，非法 JSON、重复 key 和终态后事件拒绝。普通 stdout 成功退出不等于审核通过。

输出流总量超过 64 MiB 会终止，报告 `output_limit`；终止缓冲可能使原始文件略超过该阈值。POSIX 使用独立进程组，先 SIGTERM，再 SIGKILL；`cleanup_confirmed` 不为 true 时如实保留清理缺口。所有运行文件保留，不自动删除。失败不自动重试。

## 分片批量（zcode-batch.js）

`scripts/zcode-batch.js` 在单片契约之上做批量编排，每片仍是完整的 `zcode-chat.js` 调用：

- **stdout 契约**：恰好一个 JSON 对象，字段 `status`（ok|partial|failed）、`gate`（PASS|FAIL|NOT_EVALUATED，内容级）、`transport_gate`（PASS|NOT_EVALUATED）、`batch`（shards/ok/transport_ok/truncated_or_incomplete/retried/review_pass/review_fail/review_not_evaluated/mode/concurrency/wall_seconds）、`shards[]`（每片完整单片回执 + shard/prompt_file/retried/retry_reason/duration_seconds，重试时含 `first_attempt`）。可选 `--receipt-file` 落盘，内容与 stdout 字段一致。
- **双 gate**：`transport_gate` 仅在全部片 `status=ok`、`complete=true`、`truncated!==true` 时为 PASS；内容 `gate` 任一片 `review_gate=FAIL` → FAIL（不被其他片的传输失败掩盖），全 PASS → PASS，其余 NOT_EVALUATED；chat 模式恒 NOT_EVALUATED。退出码只跟 `status`：`ok` → 0（即使内容 FAIL），partial/failed → 1。与单片一致，内容 FAIL 是有效审核结果而非调用故障。
- **重试边界**：仅 `quota_error` / `timeout` 退避 30 秒重发一次（`first_attempt` 完整保留）；`auth_error`、`policy_violation`、schema 类、无法解析的 stdout、内容 FAIL 均不重试。持续失败恰好两次调用。
- **隔离与证据**：不提供批量 `--output-dir`；每片每次尝试由 wrapper 自建 `zcode-text-*` 目录并保留全部证据。错误回执不回显子进程 stderr，明细在各片 `artifacts_dir`。
- **外层超时公式**：`ceil(片数/并发) × (2×(timeout-seconds+45s) + 30s) + 60s`（两次尝试 + 每试监督余量 + 退避 + 批级余量）。
- **测试钩子**：`ZCODE_BATCH_WRAPPER`（替换为假 wrapper）、`ZCODE_BATCH_RETRY_MS`（仅离线缩短退避，生产默认 30000ms，非法值回退默认）。

## Launcher 与平台

- Node.js 18+ wrapper；CLI 自身的 Node 要求以安装版本为准。当前本机 Node 24（macOS）、22.20.0（Windows）。
- 原生可执行文件、Node JS 入口和 Node shebang 可直接使用。默认从 PATH 查找 `zcode`，`--cli-path` 可指定绝对入口。PATH 扫描只接受普通文件：Windows 上与 CLI 同名的应用安装目录（`D:\Program Files (x86)\zcode`）会被跳过，因为目录同样能通过 `accessSync(X_OK)`。
- 本机 `mise` shell launcher 中的 `$HOME/.../zcode.cjs` 在设置隔离用户目录之前解析，然后用当前 `process.execPath` 启动实际 bundle；原 launcher 不会在临时用户目录下运行。`launch.json` 记录实际 Node 路径。
- npm shim 解析：Windows 的 `zcode.cmd` 与 POSIX 的无扩展名 `zcode` 都是 npm 生成的包装脚本。wrapper 从其文本中解析出 `node_modules/<pkg>/bin/<entry>.js`，用 `process.execPath` 启动真实入口，batch 文本从不交给 shell。非 npm 形态的 `.cmd/.bat` 与无法识别的 shell launcher 返回 `unsupported_launcher`。
- 2026-11-17 已在 Windows x64 执行离线检查与真实调用（`zcode-app-cli 3.18.1-46` / `zcode-runtime 0.17.1`，`mode=guarded`）；Linux/WSL 未真机验收。POSIX 权限位不等于 Windows ACL；Windows 进程树终止结果保留实际状态，进程已自然退出时记为清理确认。

## 离线验收

从 skill 根目录执行，不调用真实模型：

```text
node --check scripts/zcode-chat.js
node --check scripts/review.js
node --check scripts/zcode-run.js
node --check scripts/zcode-batch.js
node --check scripts/repin-release.js
node --test tests/zcode-chat.test.js
node --test tests/zcode-batch.test.js
node --test tests/repin-release.test.js
node scripts/zcode-chat.js --version
node scripts/zcode-batch.js --version
```

测试使用独立 fake CLI，覆盖隔离配置、参数数组、UTF-8/BOM/畸形输入、原始流保留、分块中文、大回复、缺失用量、模型与终态缺失、重复/不匹配终态、工具违规、结构化错误、非零退出、超时进程树和 review-v1 语义。

批量测试经 `ZCODE_BATCH_WRAPPER` 注入假 wrapper，覆盖参数拒绝、mode/evidence 组合、透传、双 gate 聚合（含内容 FAIL 与传输失败并存）、quota/timeout 重试与不重试边界、坏 stdout、自然序与落盘一致性，以及实际并发不超过设定值。

监督器测试还覆盖后台成功、超时退出、wrapper 被 SIGKILL 后独立保存退出信号与残留运行阶段，以及冲突目录拒绝。`status` 先查 `execution.json` 再判活；判活结果不是"存活"时会再查一次，所以 supervisor 恰在两步之间写完 `execution.json` 退出，也判为 `finished`，不会误报 `interrupted`（用注入的探针确定性复现）。假 CLI 不访问真实模型；Keychain 适配使用合成数据，监督器测试使用注入的本地 fake driver。

真实验收必须先通过离线检查，使用本次授权的最小材料。保留原始回执、模型、结束原因、工具数、发现和本地处置。认证、额度、超时或协议失败停止，不自动重试。未发起真实调用时不得把 `--version`、`doctor` 或 `/help` 检查称为模型验证。

## 安装和恢复

源码与安装副本分开。新安装到一个不存在的 skill 目录，Codex 入口指向共享副本；逐文件核对 SHA256，在 skill 内创建 `.zcode-release.json`（`format: 1`、`files: {relative_path: sha256}`），不写 AGY/MMX 的发布清单。清单只包括本 skill 的受管文件：`.md`、`.js`、`.cjs`、`.json`、`.yaml`。隐藏条目、`__pycache__`、`node_modules` 和其他类型的文件不入清单，重钉时逐条列在 stderr（`tests/repin-release.test.js`）。存在清单时 wrapper 检查路径、符号链接和哈希；缺少清单允许源码开发调用，因此清单完整性依赖受保护的安装目录。

清单哈希按 **LF 归一化**内容计算（`sha256(content.replace(/\r\n/g, "\n"))`）。仓库在 Windows 上以 CRLF 检出、在 macOS 上以 LF 检出，按原始字节计算会让一端生成的清单在另一端必然失配。归一化后同一份清单在两个平台双向有效。改动任何受管文件后清单按设计失效，用 `node scripts/repin-release.js` 重钉（`--dry-run` 只报告不写入）；**Mac 正本同步 wrapper 变更后同样必须重钉**，否则安装副本报 `install_mismatch`。

安装前记录目标状态与源文件指纹；遇到目录冲突、并发变化或不一致时停止覆盖。运行文件与凭据不得加入安装包。更新先备份当前安装文件再审查逐文件差异；恢复只依据本轮快照处理对应补丁，不批量删除目录或覆盖后续改动。
