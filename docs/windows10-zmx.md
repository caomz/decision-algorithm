# Windows 10：ZCode + MMX 操作与验收

本指南针对 `windows-zmx-validation-20261121` 分支。目标是 **Windows 10 x64、Node.js 22 x64、Windows PowerShell 5.1 或 PowerShell 7**。仓库内直接调用只需要 Node；不需要 WSL、Python、管理员终端或修改全局执行策略。Git 用于同步分支。

当前可用入口是 ZCode/MMX 各自的单次 wrapper、批处理和持久任务。`zcode-mmx-review/review-run.js` 的统一真实后端仍未开放，`--backend real` 会拒绝；离线分片覆盖 PASS 不能代替真实双模型审查。

## 1. 同步当前分支

在自己的仓库路径打开 Windows PowerShell。以下路径仅为示例：

```powershell
Set-Location 'D:\GitHub\decision-algorithm-win'
& {
    $changes = git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw 'Git repository check failed.' }
    if ($changes) { throw 'Keep or commit local changes before updating this checkout.' }
    git fetch origin windows-zmx-validation-20261121
    if ($LASTEXITCODE -ne 0) { throw 'Fetch failed; stopped before switching branches.' }
    git switch windows-zmx-validation-20261121
    if ($LASTEXITCODE -ne 0) { throw 'Branch switch failed; no pull was attempted.' }
    git pull --ff-only origin windows-zmx-validation-20261121
    if ($LASTEXITCODE -ne 0) { throw 'Fast-forward update failed; inspect the local branch.' }
    git rev-parse HEAD
}
```

若有本地修改，先保留这些修改；不要使用 `reset --hard`、`clean -fd` 或强制切换。仅 Windows checkout 更新；不需要同步 Mac 安装位或 `main`。

## 2. 在目标电脑做离线验收

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-zmx-check.ps1 -Offline
$LASTEXITCODE
```

`-ExecutionPolicy Bypass` 只影响这一个子进程，不会运行 `Set-ExecutionPolicy`、修改注册表或用户配置。若组织策略禁止脚本执行，请遵守本机策略，不要全局降低策略。

此命令不启动已安装的 ZCode/MMX，不发送模型请求。它会检查发布清单、review 协议，并用假 CLI 运行三个目录下的离线测试。测试文件由 Node 显式枚举，不依赖 PowerShell 展开 `*.test.js`。它还会记录实际 Windows 版本/build/架构、PowerShell、Node/npm，并在 Job 根目录内验证 UTF-8 写入、硬链接和禁止覆盖已有发布文件的行为；探测后只删除本次创建的临时文件。

默认 Job 根目录为 `%LOCALAPPDATA%\Zmx\jobs`；报告和测试日志写入 `%LOCALAPPDATA%\Zmx\checks`。每次使用新文件，旧报告不会被覆盖。可显式指定实际打算使用的位置：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-zmx-check.ps1 -Offline -JobsRoot 'D:\Zmx Jobs' -ReportPath 'D:\Zmx Checks\offline-001.json'
```

持久 Job 使用本地 NTFS。不要把 Job 目录放在 FAT/exFAT、网络共享、OneDrive 或其他同步目录。硬链接探测成功只能证明被探测的目录支持所需操作；不能替其他盘符或目录作保证。

## 3. 检查真实 CLI 启动条件

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-zmx-check.ps1
$LASTEXITCODE
```

默认模式只执行已解析 CLI 的 `--version`，不登录、不查询账号额度、不发起模型请求。报告会记录实际启动器和 JS 入口，便于确认多个 Node/CLI 安装是否选中了预期版本。npm 版本从已安装包元数据读取。

| 结果 | 含义 | 退出码 |
|---|---|---:|
| `offline_pass` | 此次离线测试及文件系统探测通过；报告中的 `host_class` 才说明运行在哪种系统 | 0 |
| `preflight_ready` | 目标 Windows 10/Node/PowerShell、发布清单及真实 CLI 版本探测通过；可进行下一步小请求 | 0 |
| `blocked` | 存在明确阻断项，查看 JSON 中 `checks` 和 `failed`，测试详情见同名日志 | 2 |

两种通过结果都保留 `real_provider_acceptance: not_run`。报告不会记录 API key、凭据文件或环境变量原值。

常见阻断项：

- `node_22_x64`：请用 Node.js 22 的 64 位版本运行本分支验收。其他版本的单元测试通过不能代替此基线。
- `zcode_runtime`：wrapper 适配 **runtime 0.17.1**；桌面程序的 `zcode-app-cli 3.x` 是另一版本字段。不要为了通过检查而改掉版本约束。
- `mmx_cli`：确认标准 npm 安装的 `mmx-cli` 能被当前 PATH 找到。本地版本会记录在报告中；自定义 `.cmd/.bat` 虽可能被 wrapper 支持，doctor 为避免执行任意 shell 启动链会保守拒绝。使用标准 npm 安装或先单独审查该启动器。
- `release_and_protocol`：同步不完整或受管文件改动。先核对目标提交和文件；不要在来源不明的安装副本上直接重钉清单来消除告警。
- `windows_global_slot_disabled`：Windows 不支持 `MMX_GLOBAL_SLOT=1`。该功能当前明确拒绝请求；普通单次调用按关闭状态运行。
- `job_storage` / `local_ntfs`：改用本地可写 NTFS 目录再探测。原有 Job 证据保留，不自动清理或重发。

`host_class=windows_server` 或 `windows_11_or_newer` 会保留实际宿主身份，不冒充 Windows 10。默认 preflight 针对 Windows 10，因此这些宿主可以执行离线测试，但不会获得本指南的 Windows 10 `preflight_ready`。若系统/卷信息查询失败，相应检查保守失败；不要通过手工改报告解除阻断。

本指南不自动替换现有 Node/CLI 或认证配置。如果 MMX 未安装，可在确认目标终端后用 `npm.cmd install --global mmx-cli@1.0.29` 安装本分支历史适配版本；在 PowerShell 使用 `npm.cmd` 可避免选中 `npm.ps1` 后被执行策略阻拦。ZCode 使用本机既有受信任安装方式，核对 runtime 后再运行。

## 4. 一次真实小请求

这一节会调用供应商并消耗额度。先在目标电脑完成上两步，再分别发一个短请求；不要以批量审查作为首次连通性探测。认证沿用本机 CLI 的登录/凭据配置，不把 key 写进仓库或报告。

```powershell
$repo = (Get-Location).Path
$runRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('Zmx\acceptance\' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -ErrorAction Stop | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$prompt = Join-Path $runRoot 'prompt.txt'
[IO.File]::WriteAllText($prompt, '只回复 WINDOWS10_ZMX_OK，不使用工具。', $utf8)

node (Join-Path $repo 'skills\zcode\scripts\zcode-chat.js') --prompt-file $prompt --output-dir (Join-Path $runRoot 'zcode') --timeout-seconds 600
$zcodeExit = $LASTEXITCODE

$oldEncoding = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = $utf8
    $mmxOutput = & node (Join-Path $repo 'skills\mmx\scripts\mmx-chat.js') --prompt-file $prompt --timeout 600 --wrap-timeout 630
    $mmxExit = $LASTEXITCODE
    [IO.File]::WriteAllText((Join-Path $runRoot 'mmx.receipt.json'), ($mmxOutput -join [Environment]::NewLine), $utf8)
} finally {
    [Console]::OutputEncoding = $oldEncoding
}
Write-Host "ZCode exit=$zcodeExit; MMX exit=$mmxExit; receipts=$runRoot"
```

核对 `zcode\receipt.json` 和 `mmx.receipt.json`：退出码均为 0，`status=ok`、`complete=true`、`truncated=false`，正文符合预期，模型身份来自原生回执。ZCode 还应为 `tool_calls=0`。保留实际模型字段；不要凭正文自称判断 GLM/MiniMax 独立性。

Windows PowerShell 5.1 的 `>` 默认写 UTF-16LE，`Set-Content -Encoding UTF8` 则带 BOM；所以示例用 `.NET WriteAllText` 明确写 UTF-8。wrapper 接受 UTF-8 BOM，UTF-16 会在发起真实请求前拒绝。读取中文 JSON 时使用 `Get-Content -Raw -Encoding UTF8`。

正常响应只证明这次请求成功。Windows 上主进程退出后，ZCode 的 `cleanup_confirmed` 可以为 `null`，表示无法独立证明所有后代已退出；它不会因此伪造完整进程树保证。统一交叉审查中要求已确认清理的判定仍保持保守。

### ZCode Windows 大材料边界

Windows wrapper 在启动模型请求前检查**最终拼接后的 prompt**：最多 24 KiB UTF-8，且完整 Windows 命令行（包含路径和转义开销）不超过 32767 个 UTF-16 代码单元。超过时返回 `input_too_large`、`cli_invoked=false`；不会自动改成尚未验证的零工具附件投递。原始材料还要为 review 指令和证据 ID 留出空间。

大任务先拆成每片约 10–16 KiB、带足够上下文和验收条件的完整证据包，再逐片执行；每片仍以 wrapper 实际检查为准。现有 `shard-coverage` 的字节切片/覆盖账本本身不保证模型理解完整，也没有自动真实双模型执行能力。不要以单片传输成功代表整个任务已经被审查。

## 5. 长任务、取消与恢复

材料文件先写入 UTF-8。以下示例沿用上一节的 `$prompt` 和仓库工作目录；如跳过上一节，先把 `$prompt` 设为自己材料文件的绝对路径。每次 `start` 使用全新 Job 目录；取消或未知状态不通过新建第二个 Job 自动重试。先用最小材料验收后台任务与取消，再开始正式任务。

```powershell
$jobs = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Zmx\jobs'
$mmxJob = Join-Path $jobs ('mmx-' + [Guid]::NewGuid().ToString('N'))
node .\skills\mmx\scripts\mmx-job.js start $mmxJob --prompt-file $prompt --concurrency 1
node .\skills\mmx\scripts\mmx-job.js status $mmxJob
node .\skills\mmx\scripts\mmx-job.js resume $mmxJob
```

只在需要取消这次 MMX 任务时执行下面一条；取消写入后再次 `status`，等待最终执行记录再 `verify`。尚未完成时 `verify` 返回非零，表示证据未齐全。

```powershell
node .\skills\mmx\scripts\mmx-job.js cancel $mmxJob
```

已结束任务的只读核验：

```powershell
node .\skills\mmx\scripts\mmx-job.js verify $mmxJob
```

需要 ZCode 后台任务时使用另一组命令，仍使用新的目录：

```powershell
$zcodeJob = Join-Path $jobs ('zcode-' + [Guid]::NewGuid().ToString('N'))
node .\skills\zcode\scripts\zcode-run.js start $zcodeJob --prompt-file $prompt --timeout-seconds 600
node .\skills\zcode\scripts\zcode-run.js status $zcodeJob
node .\skills\zcode\scripts\zcode-run.js verify $zcodeJob
```

需要取消该 ZCode 任务时：

```powershell
node .\skills\zcode\scripts\zcode-run.js cancel $zcodeJob
```

Job 在独立监督进程中执行，查询与取消使用已有目录。取消标志先阻止新分片/重试，再请求 wrapper 终止 CLI；宽限结束才强制结束进程树。取消后检查最终执行记录与回执。`MMX resume` 只查询，不重发；`unknown`、`termination_confirmed=false` 或缺少最终记录时，先核实原请求，不删目录、不凭保存的 PID 手工终止其他进程。

MMX Windows 监督进程保留约 7 秒协作取消宽限；batch 为 wrapper 预留约 4.5 秒以发布最终回执。前台 batch 的 Ctrl+C 也使用取消标志，保留已完成分片。`--receipt-file` 要使用已有可写目录中的全新文件；已存在或不可写的目标会在启动 wrapper 前拒绝，最终写入失败会返回 `receipt_error` 和非零退出码。

ZCode 的监督进程和 batch 最多预留约 15 秒协作取消宽限，以覆盖最长 10 秒的 CLI 版本预检及清理。准备阶段取消也保留 `cancelled` 回执；不要因为取消没有立即返回，就另开一个相同请求。

更新代码后，可继续只读查看已有 MMX Job；`runtime_code=changed_or_missing` 表示当前脚本与旧任务记录不同，不代表旧任务档案损坏。尚未开始的 worker 仍要求代码匹配，不会用新版脚本偷偷重发旧请求。文件系统不支持原子硬链接发布时，`MMX_JOB_PUBLICATION_UNAVAILABLE` 提示改用本地可写 NTFS。

Windows 会话注销、重启、强制关机和外部终止不是后台任务存活保证；本地进程消失也不能证明供应商停止处理请求。Windows 全局槽仍关闭；正式任务先保持单批、`--concurrency 1`，避免并行打开多个终端重复发送。

## 验收证据边界

CI 会在 Windows hosted runner 上使用 **Windows PowerShell 5.1**，复制代码到含空格和中文的路径，执行同一离线入口并保存 JSON/日志。GitHub 的 hosted Windows runner 是 Server 系列，不能记作用户 Windows 10 真机验收。只有目标 Windows 10 上生成的本机报告和真实请求回执，才可补齐对应层级的证据。

历史 README/测试矩阵中的旧 Windows 结果仅适用于当时记录的代码和环境。新分支、新提交、不同 Node/CLI 版本应重新验证。

官方依据：

- [Microsoft：Windows PowerShell 字符编码](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-5.1)
- [Node.js 22：支持的平台](https://github.com/nodejs/node/blob/v22.x/BUILDING.md#platform-list)
- [GitHub：hosted runner 环境](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [MiniMax 官方 CLI](https://github.com/MiniMax-AI/cli)
