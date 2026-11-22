# Windows 11：ZCode + MMX 原生验收合同

此文件为新增 Windows 11 验收说明。仅用于明确核准的完整 SHA、独立 checkout 和真实 Windows 11 客户端；不追认旧 Windows 10 报告，也不授权真实收费模型。

## 必须明确的事实

- PowerShell 入口新参数：-TargetOs windows11；Node helper 新参数：--target-os windows11；默认仍为 windows10。
- 新报告独立记录 requested_target、observed_host、target_match、support_status、acceptance_scope。离线 offline_pass 只说明离线诊断成功，不等于平台兼容或安全支持通过。
- 支持周期以 Win32_OperatingSystem.OperatingSystemSKU 与版别 Caption 独立核对：Pro Education 属于 Home/Pro 短周期，不属于 Education 长周期；缺失、SKU/Caption 冲突或 LTSC 渠道均保守阻断，LTSC 不套用年度渠道日期。
- GitHub Windows Server CI 的 target_match 必须为 false；未知未来 Windows build、非客户端、未知版本或非 x64 均不自动放行。
- 截至 2026-11-22，Windows 11 Home 23H2（Build 22631）与 Home/Pro/Pro Education/Pro for Workstations 24H2（Build 26100）已结束更新支持。对可识别但已过支持期的版本，平台身份可以正确匹配，但 CLI preflight 保持 blocked。升级系统需要用户单独授权。
- 保留 Node 22 x64、PowerShell 5.1、ZCode runtime 0.17.1、MMX 安全启动器、本地 NTFS、发布清单、默认禁止收费重试、永久 worker.lock 与真实审核后端关闭等保护。

## 新目录、固定 SHA、严格串行执行

先备份旧报告，核对活动或 unknown Job，勿覆盖它们正在引用的源码、Node 或 CLI。使用独立 Git checkout，确认分支 windows-zmx-validation-20261121、同 SHA 已通过必需 CI、完整 SHA 与干净工作区（包含未跟踪文件）。保留旧 Node 用于单变量复现；安装新补丁或升级 Windows 需另行批准。

在 Windows PowerShell 5.1 中依次执行：

    Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,ProductType,OSArchitecture
    node -p 'JSON.stringify({version:process.version,arch:process.arch,execPath:process.execPath})'
    git rev-parse HEAD
    git branch --show-current
    git status --porcelain --untracked-files=all
    node --test tests/windows-zmx-check.test.cjs
    node --test skills/mmx/tests/mmx-windows-cancel.test.js skills/mmx/tests/mmx-job.test.js
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-zmx-check.ps1 -Offline -TargetOs windows11

各阶段检查退出码；一旦失败停止，不跳过清理 hook、不重跑到绿色。读取报告中的真实 target_match 和 support_status，不把 helper 初始的 real_provider_requests=0 冒充全机网络监测。

只有全部离线测试成功、目标身份匹配、support_status=supported 后，才允许进行只读 CLI --version 预检：

    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-zmx-check.ps1 -TargetOs windows11

preflight_ready 只说明本机 CLI、宿主、安全支持和存储等初步条件，不证明认证、计费、真实供应商完成或后台进程树停止。

## 可选的固定 30 次 Windows MMX 定向回归

经明确授权固定批次后，使用同一个 Node 二进制与核准 SHA 连续执行 30 次以下假后端用例，任一次失败即停止并保留该轮原始 TAP 和运行信息；不能挑最后一次成功：

    for ($i=1; $i -le 30; $i++) {
      node --test --test-reporter=tap --test-name-pattern 'Windows cancel waits for a cooperative batch acknowledgement before force' skills/mmx/tests/mmx-windows-cancel.test.js
      if ($LASTEXITCODE -ne 0) { throw "Trial $i failed. Keep the evidence." }
    }

此批次不调用真实模型，但也不能替代收费请求与持久 Job 生命周期验收。故障日志保存到独立目录，保留 SHA、OS、Node execPath、退出码及原始哈希。

统一真实双模型后端仍关闭；真实 ZCode/MMX 小请求、长任务、取消和重启验证须用户逐项单独授权。

官方支持版本：https://learn.microsoft.com/en-us/windows/release-health/supported-versions-windows-client
