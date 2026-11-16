# MMX 2.3 平台调用与验证

只读取当前平台章节。从本次加载的 `SKILL.md` 绝对路径取得 skill 根目录，替换示例中的占位路径。执行 wrapper 会发起一次真实请求并可能产生费用；测试命令只用假 CLI。

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

## 契约与来源

- Node.js `>=18`：本机 `mmx-cli 1.0.26` 的 `package.json` 与[官方仓库](https://github.com/MiniMax-AI/cli/blob/main/package.json)。本机 Node.js `v24.15.0`。
- Windows `.cmd/.bat` 需命令解释器或解析到 JS 入口，见 [Node.js 文档](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)。wrapper 优先将标准 npm shim 解析到 `mmx.mjs`，通过 `process.execPath` 启动；其他 batch 入口仅在 CLI 路径和全部动态参数通过严格检查后使用 shell。`.exe` 和 POSIX 可执行入口直接启动。
- `code 3 = AUTH`：本机 `mmx-cli 1.0.26` 的 `dist/sdk.mjs` 与[官方错误表](https://github.com/MiniMax-AI/cli/blob/main/ERRORS.md)。wrapper 不调用 `auth status`，只按真实 chat 结果分类。
- 默认读取 `profiles/local.json`。本机配置包含 524288 输出预算、21600 秒 request 超时和 21630 秒 wrapper 超时。模型为 `null` 时沿用 CLI 配置。显式 `--model`、`--max-tokens` 和既有 `MMX_CHAT_REQ_TIMEOUT` / `MMX_CHAT_WRAP_TIMEOUT` 覆盖对应值。`--profile-file` 可指定另一份同结构的非秘密配置文件。
- 完整传递 UTF-8 prompt/system（兼容 BOM），拒绝 UTF-16 和畸形 UTF-8。stdout 与 stderr 在运行期间写入私有文件，按完整结果解码。传输预算由 MMX API 决定。POSIX 子进程组先收到终止信号再升级为强制结束；Windows 使用 taskkill 树终止。无法确认清理时在回执注明。
- chat stdout 恰好一个 JSON 对象；`--version` 例外。`requested_model` 记录传参，`model` 来自成功回复。`cli_invoked` 表示 chat 子进程已启动，账单以服务端为准。缺失模型、未知终态、工具调用和错误码类型异常返回 `schema_mismatch`。
- 错误只报告分类、数值码和固定提示。官方[错误表](https://github.com/MiniMax-AI/cli/blob/main/ERRORS.md)列出认证、额度和超时退出码，以及 HTTP 429 / 1028 / 1030 等额度错误。观察值与文档不同时保留原退出码和分类。
- Review/Challenge 保存包装结果，以同级协调器的 `validate-review` 校验共同协议。聊天展示结论与原文链接。复核报告的原始正文、执行状态和本地处置各自留存。

## 验证层级

从目标 skill 根目录执行：

```text
node --check scripts/mmx-chat.js
node --test tests/mmx-chat.test.js
node scripts/mmx-chat.js --version
```

| 层级 | macOS | Windows PowerShell 5.1 / 7 | Git Bash + Windows Node | Linux / WSL |
|---|---|---|---|---|
| 静态检查 | 本次已执行 | 未验证 | 未验证 | 未验证 |
| Windows 分支 mock | 本次已执行 | 不能代替真机 | 不能代替真机 | 不适用 |
| 假 CLI 集成 | 本次已执行 | 未验证，执行上述命令 | 未验证，执行上述命令 | 未验证，执行上述命令 |
| 真实 API | 未运行 | 未运行 | 未运行 | 未运行 |

Windows：在 PowerShell 中 `Set-Location 'C:\absolute\path\to\current\mmx'` 后执行三条 `node` 命令。Git Bash：`cd '/c/absolute/path/to/current/mmx'` 后执行三条 `node` 命令，并按上面示例核对 `cygpath` 与 MSYS 参数转换。真实 API 冒烟会消耗 quota，必须经用户明确授权后进行。2026-09-04 的 macOS + `mmx-cli 1.0.19` Chat/Review/Challenge smoke 3/3 是历史文档声明，不代表当前版本或其他平台。
