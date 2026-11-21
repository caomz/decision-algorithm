# MMX 2.3 平台调用与验证

只读取当前平台章节。从本次加载的 `SKILL.md` 绝对路径取得 skill 根目录，替换示例中的占位路径。执行 wrapper 会发起一次真实请求并可能产生费用；测试命令只用假 CLI。

`windows-zmx-validation-20261121` 的当前 Windows 10 / PowerShell 5.1 操作入口与分层验收见 [Windows 10 指南](../../../docs/windows10-zmx.md)。本文历史平台结果不等于当前提交已在目标电脑验收。

## macOS zsh / bash

```bash
MMX_SKILL_DIR='/absolute/path/to/current/mmx'
umask 077
_TMPD=$(mktemp -d "${TMPDIR:-/tmp}/mmx.XXXXXXXX") || exit 1
chmod 700 "$_TMPD" || exit 1
_PROMPT="$_TMPD/prompt.txt"
cat > "$_PROMPT" <<'MMX_PROMPT_END_7E2D'
在这里放入完整 prompt。
MMX_PROMPT_END_7E2D
chmod 600 "$_PROMPT" || exit 1
node "$MMX_SKILL_DIR/scripts/mmx-chat.js" --prompt-file "$_PROMPT"
_RC=$?
if [ -f "$_PROMPT" ]; then rm "$_PROMPT"; fi
if [ -d "$_TMPD" ]; then rmdir "$_TMPD"; fi
exit "$_RC"
```

正文若含独立一行 `MMX_PROMPT_END_7E2D`，先换成不冲突的带引号 delimiter。system prompt 单独写 `system.txt`，加 `--system-file`，结束时逐项核对、逐文件 `rm`，最后 `rmdir`。非空目录保留供检查；操作系统不保证临时文件自动清理。

## Windows PowerShell 5.1 / 7

```powershell
$mmxSkillDir = 'C:\absolute\path\to\current\mmx'
$tmpd = Join-Path ([IO.Path]::GetTempPath()) ('mmx.' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpd -ErrorAction Stop | Out-Null
$promptPath = Join-Path $tmpd 'prompt.txt'
$prompt = @'
在这里放入完整 prompt。
'@
[IO.File]::WriteAllText($promptPath, $prompt, [System.Text.UTF8Encoding]::new($false))
node (Join-Path $mmxSkillDir 'scripts/mmx-chat.js') --prompt-file $promptPath
$rc = $LASTEXITCODE
if (Test-Path -LiteralPath $promptPath -PathType Leaf) { Remove-Item -LiteralPath $promptPath }
if (Test-Path -LiteralPath $tmpd -PathType Container) { Remove-Item -LiteralPath $tmpd }
exit $rc
```

正文若含独立的结束标记 `'@`，使用已有 UTF-8 文件或可靠的文件写入工具；不要改用插值型 here-string。system 用相同编码单独写入并逐文件清理。`Remove-Item` 不加 `-Recurse`。Windows ACL 由所在目录策略决定，`chmod 700` 不是 ACL 安全保证。

## Windows Git Bash + Windows Node.js

先确认 `node.exe -p "process.platform"` 输出 `win32`。Git Bash 的 POSIX 文件路径必须转换给 Windows Node.js：

```bash
MMX_SKILL_DIR='/c/absolute/path/to/current/mmx'
umask 077
_TMPD=$(mktemp -d "${TMPDIR:-/tmp}/mmx.XXXXXXXX") || exit 1
_PROMPT="$_TMPD/prompt.txt"
cat > "$_PROMPT" <<'MMX_PROMPT_END_9B4A'
在这里放入完整 prompt。
MMX_PROMPT_END_9B4A
_SCRIPT_WIN=$(cygpath -w "$MMX_SKILL_DIR/scripts/mmx-chat.js") || exit 1
_PROMPT_WIN=$(cygpath -w "$_PROMPT") || exit 1
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' node.exe "$_SCRIPT_WIN" --prompt-file "$_PROMPT_WIN"
_RC=$?
if [ -f "$_PROMPT" ]; then rm "$_PROMPT"; fi
if [ -d "$_TMPD" ]; then rmdir "$_TMPD"; fi
exit "$_RC"
```

正文若与 delimiter 冲突，先更换 delimiter。system 路径同样用 `cygpath -w`。参数转换关闭后，核对 `node.exe -p "process.env.PATH"` 和 `node.exe -p "require('os').tmpdir()"` 为 Windows Node.js 可读路径。Git Bash 的 `umask` 不保证 Windows ACL。

WSL 内 `node -p "process.platform"` 为 `linux` 时使用 POSIX 路径；调用 Windows `node.exe` 为 `win32` 时先用 `wslpath -w` 转换路径，并核对 Windows PATH。两种 WSL 路径本次未真机验证。

## 分片批量（mmx-batch.js）

`scripts/mmx-batch.js` 在单片契约之上做批量编排，每片仍是一次完整的 `mmx-chat.js` 调用（预算、超时、错误分类与回执结构原样继承）：

- **stdout 契约**：恰好一个 JSON 对象，字段 `status`（ok|partial|failed，按传输可用性）、`gate`（PASS|NOT_EVALUATED，**传输层**：全片 `status=ok`、`complete=true`、未截断 → PASS）、`batch`（shards/ok/transport_ok/truncated_or_incomplete/retried/concurrency/wall_seconds/effective_max_tokens/retry_max_tokens）、`shards[]`（每片完整单片回执 + shard/prompt_file/retried/retry_reason/duration_seconds，重试时含 `first_attempt` 旧回执）。findings 级 P1/P2 判定仍由宿主完成，批级 gate 不冒充内容判定。可选 `--receipt-file` 落盘，内容与 stdout 字段一致。
- **预算自愈**：片 `thinking_budget_exhausted` 或截断、且调用预算低于 profile 预算时，自动按 profile 预算（默认 524288）重发一次；`quota_error` 退避 30 秒重试一次。两类重试都显式记录（`retried`/`retry_reason`/`first_attempt`），不隐藏内部重试；`auth_error`、`schema_mismatch` 类与其余失败不重试。
- **退出码**：`gate=PASS` → 0，否则 1。
- **调用面**：`--prompt-file`（可重复）与 `--prompts-dir` 互斥（`.txt` 自然序，≤32 片）；`--concurrency` 默认 2、上限 8；`--model`/`--max-tokens`/`--timeout`/`--wrap-timeout`/`--profile-file` 透传给每片。
- **外层超时公式**：`ceil(片数/并发) × (2×wrap-timeout + 30s) + 60s`（两次完整尝试 + 30s 退避 + 批级余量）；漏算重试会把重试中的批次误判为超时。
- **测试钩子**：`MMX_BATCH_WRAPPER`（替换为假 wrapper）、`MMX_BATCH_QUOTA_RETRY_MS`（仅离线缩短退避，生产默认 30000ms，非法值回退默认）。
- **裸 CLI 陷阱**：绕过 wrapper 直接 `mmx text chat` 时 CLI 自身默认 `--max-tokens 4096`，服务端思考计入输出预算，评审类 prompt 必截断；所有评审调用必须经 `mmx-chat.js` / `mmx-batch.js`。

## 契约与来源

- Node.js `>=18`：本机 `mmx-cli 1.0.29`（macOS，2026-11-19）与 `1.0.28`（Windows）的 `package.json` 与[官方仓库](https://github.com/MiniMax-AI/cli/blob/main/package.json)。本机 Node.js `v24.15.0`（macOS）、`v22.20.0`（Windows）。
- Windows `.cmd/.bat` 需命令解释器或解析到 JS 入口，见 [Node.js 文档](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)。wrapper 优先将标准 npm shim 解析到 `mmx.mjs`，通过 `process.execPath` 启动；其他 batch 入口仅在 CLI 路径和全部动态参数通过严格检查后使用 shell。`.exe` 直接启动。POSIX 上 PATH 里的 `mmx` 若是指向 mmx-cli 包入口的链接，同样用 `process.execPath` 直接运行该入口，以便预加载 fetch 防护；其他可执行文件照原样运行。
- `code 3 = AUTH`：本机 `mmx-cli` 的 `dist/sdk.mjs` 与[官方错误表](https://github.com/MiniMax-AI/cli/blob/main/ERRORS.md)。wrapper 不调用 `auth status`，只按真实 chat 结果分类。
- 默认读取 `profiles/local.json`。本机配置包含 524288 输出预算、600 秒 request 超时和 630 秒 wrapper 超时。模型为 `null` 时沿用 CLI 配置。显式 `--model`、`--max-tokens`、`--timeout`、`--wrap-timeout` 覆盖对应值，其中命令行 flag 优先于环境变量 `MMX_CHAT_REQ_TIMEOUT` / `MMX_CHAT_WRAP_TIMEOUT`，环境变量优先于 profile。`--wrap-timeout` 必须大于 `--timeout`，两者上限 3600 秒。`--profile-file` 可指定另一份同结构的非秘密配置文件。
- prompt 与 system 不设字节上限，也不静默截断——材料范围由宿主负责，超出上下文预算时如实告知并缩小范围。`mcode-verify.js` 另有自己的 256 KiB 上限（`prompt_too_large`），两者互不影响。
- `thinking_budget_exhausted`：`stop_reason=max_tokens`，且响应只有 `thinking` / `redacted_thinking` 块、没有非空 `text`，说明输出预算被服务端思考吃光，**不是**契约漂移；处理方式是省略或加大 `--max-tokens` 重发，而不是核对 CLI schema。其他结束原因下没有正文记 `schema_mismatch`。两种回执都附 `stop_reason`、`truncated`、`complete=false` 与 `content_block_types`。
- 受管发布按**结构**判定，不再依赖某台机器的绝对路径：发布清单 `<skills_root>/.gstack-cross-validation-release.json` 存在时逐文件校验哈希；清单缺失时，若 `<skills_root>` 下同时存在 `agy/` 与 `cross-validation/` 两个同级目录，判定为受管安装并 fail closed（`install_mismatch`），否则视为普通安装放行。普通安装包括本仓库、符号链接安装位与单 skill 安装。
- 受管安装更新 wrapper 后清单哈希必然失配，用 `node scripts/repin-release.js --root <skills_root>` 重钉：脚本按 wrapper 的校验契约重建清单（`format:1`、`state:"active"`、64 位 `release_id`、逐文件 sha256），路径段不符合 `[A-Za-z0-9_.-]+` 的文件跳过并报告，缺 `mmx/scripts/mmx-chat.js`、`mmx/scripts/fetch-timeout-guard.js`、`mmx/profiles/local.json`、`cross-validation/scripts/cross_validate.py` 任一必需项时拒绝写入并列出缺失项；wrapper 校验清单时要求同一组文件。`--dry-run` 只报告不写入。
- 完整传递 UTF-8 prompt/system（兼容 BOM），拒绝 UTF-16 和畸形 UTF-8。stdout 与 stderr 在运行期间写入私有文件，按完整结果解码。传输预算由 MMX API 决定。POSIX 子进程组先收到终止信号再升级为强制结束；Windows 使用 taskkill 树终止。无法确认清理时在回执注明。
- chat stdout 恰好一个 JSON 对象；`--version` 例外。`requested_model` 记录传参，`model` 来自成功回复。`cli_invoked` 表示 chat 子进程已启动，账单以服务端为准。缺失模型、未知终态、工具调用和错误码类型异常返回 `schema_mismatch`。
- `mmx text chat` 走 MiniMax 的 `/v1/messages` 端点，响应为 Anthropic 风格（`model`、`stop_reason`、`content[]`、`usage.input_tokens`/`output_tokens`），与 wrapper 的校验契约一致。wrapper 使用的 `--timeout`（全局 "Request timeout"）、`--no-color`、`--non-interactive`、`--messages-file`、`--max-tokens` 在 `mmx-cli 1.0.28` 中均存在。
- 基址：`mmx-cli` 在基址后拼 `/anthropic/v1/messages`，优先级为 `--base-url` > `MINIMAX_BASE_URL` > CLI 配置 `base_url` > 区域默认。不少工具要求 `MINIMAX_BASE_URL` 以 `/v1` 结尾，原样传给 CLI 必然 404。wrapper 只对子进程环境去掉末尾的 `/v1` 或 `/v1/`（Windows 按变量原来的拼写改写，不分大小写），不改调用者环境与 CLI 配置。HTTP 404 回执附 `http_status`、固定 `hint`，以及只含协议和主机的 `base_url_env_value`（不含账号口令、路径、查询串和片段，有的网关把 token 放在路径里）。
- 300 秒上限：Node 内置 fetch（undici）等待响应头、响应体各有 300 秒默认上限，超时后 CLI 报 `Network request failed.`、退出码 6，不算超时。PATH 解析到 mmx-cli 包入口时（npm shim 或 POSIX 链接），wrapper 以 `node --require scripts/fetch-timeout-guard.js` 启动该入口，用 CLI 包自己能解析到的 undici 设置 `headersTimeout=0`、`bodyTimeout=0` 的全局 dispatcher。请求仍受 CLI `--timeout`、wrapper 时限和进程树终止约束；CLI 的其他 fetch（OAuth 刷新、区域探测）都带 `AbortSignal.timeout`，后台更新检查只在 stderr 是终端时运行。回执 `fetch_timeout_guard` 取值：`preloaded`、`proxy_limited`（代理环境变量非空，或 mmx 配置文件 `MMX_CONFIG_DIR` 下的 `config.json`（未设时 `~/.mmx/config.json`）的 `proxy` 以 `http` 开头；CLI 换用自己的代理 dispatcher。wrapper 按 CLI 的同一规则读配置，只看 `proxy` 一项，不输出配置内容）、`undici_not_found`、`guard_missing`、`custom_launcher`；`preloaded` 需有私有临时文件确认 dispatcher 初始化；初始化异常会在 CLI 入口执行前退出，回执记 `preload_failed` / `guard_error`，不静默继续。此确认不保证 CLI 后续不会替换 dispatcher；代理仍记 `proxy_limited`。退出码 6 且请求持续约 300 秒以上时回执附 `hint`。
- 错误只报告分类、数值码和固定提示，不回显上游原文，因此不会带出凭证。`auth_error` 附带 `mmx auth login` 指引，超时类附加大时限重试提示。官方[错误表](https://github.com/MiniMax-AI/cli/blob/main/ERRORS.md)列出认证、额度和超时退出码，以及 HTTP 429 / 1028 / 1030 等额度错误。观察值与文档不同时保留原退出码和分类。
- Review/Challenge 使用本 skill 的 `references/review-v1.schema.json`，与 ZCode skill 的副本逐字节一致（由 `tests/mmx-chat.test.js` 的漂移用例守住）。宿主按该 schema 校验并据发现种类与严重性计算 gate；同级 `cross-validation` 协调器是可选遗留路径，调用时用平台对应的解释器（POSIX `python3`，Windows `py -3` 或 `python`）。聊天展示结论与原文链接。复核报告的原始正文、执行状态和本地处置各自留存。

- 重钉只收发布文件：`.md`、`.py`、`.js`、`.json`、`.yaml`，后缀集合与受管安装器 `install_release.py` 相同，区分大小写；安装器不排除点开头的文件，重钉会排除。隐藏条目（`.DS_Store`、AppleDouble `._*`、`.git`）、`__pycache__`、`node_modules` 和其他类型的文件不入清单，stderr 逐条列出。清单外的文件之后怎么变，wrapper 都不会因此报 `install_mismatch`；清单内的文件一改照常拒绝。`tests/repin-release.test.js` 守住这条规则，并要求 skill 内每个文件都属于这五类，新增类型要先改白名单。

## 验证层级

从目标 skill 根目录执行：

```text
node --check scripts/mmx-chat.js
node --test tests/mmx-chat.test.js
node scripts/mmx-chat.js --version
```

| 层级 | macOS | Windows PowerShell 5.1 / 7 | Git Bash + Windows Node | Linux / WSL |
|---|---|---|---|---|
| 静态检查 | 本次已执行 | 2026-11-17 已执行 | 2026-11-17 已执行 | 未验证 |
| Windows 分支 mock | 本次已执行 | 不能代替真机 | 不能代替真机 | 不适用 |
| 假 CLI 集成 | 本次已执行 | 2026-11-17 已执行 | 2026-11-17 已执行 | 未验证，执行上述命令 |
| 真实 API | 2026-11-19 已执行（v2.7.0） | 2026-11-17 已执行 | 2026-11-17 已执行 | 未运行 |

v2.7.0 只在 macOS 上运行过。Windows 两列仍是 2026-11-17 对 v2.4.0 的结果，v2.7.0 的 Windows 实测（npm shim 预加载、PowerShell / Git Bash、超过 300 秒的真实请求）待值班机完成。

Windows：在 PowerShell 中 `Set-Location 'C:\absolute\path\to\current\mmx'` 后执行三条 `node` 命令。Git Bash：`cd '/c/absolute/path/to/current/mmx'` 后执行三条 `node` 命令，并按上面示例核对 `cygpath` 与 MSYS 参数转换。真实 API 冒烟会消耗 quota，必须经用户明确授权后进行。2026-09-04 的 macOS + `mmx-cli 1.0.19` Chat/Review/Challenge smoke 3/3 是历史文档声明，不代表当前版本或其他平台。逐路径的实测记录见 [test-matrix.md](test-matrix.md)。
