# ASCII source is intentional: Windows PowerShell 5.1 decodes BOM-less
# scripts using the active ANSI page. Chinese paths are .NET string arguments.
#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Offline,
    [switch]$CollectHostOnly,
    [string]$JobsRoot,
    [string]$ReportPath,
    [ValidateSet('windows10','windows11')][string]$TargetOs = 'windows10'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$helperExit = 2
$oldOutputEncoding = $OutputEncoding
$oldConsoleEncoding = [Console]::OutputEncoding
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Native Windows PowerShell is required.'
    }
    if ([string]::IsNullOrWhiteSpace($JobsRoot)) {
        $JobsRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Zmx\jobs'
    }
    $JobsRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($JobsRoot)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    if ($CollectHostOnly) {
        # This branch is an independent, read-only OS/CIM collector. It MUST
        # NEVER invoke Node, look up a provider CLI, or consume a report file.
        if ($Offline -or -not [string]::IsNullOrWhiteSpace($ReportPath)) {
            throw 'Collector accepts no offline mode or report path.'
        }
    $windows = $null
    # Read native host and WOW process machine from the Windows kernel.
    # GetNativeSystemInfo alone is insufficient: on ARM64 under x64 emulation
    # it can report the emulated x64 machine. Fail closed if this probe fails.
    $nativeMachine = $null
    $processMachine = $null
    try {
        if (-not ('ZmxNativeMachineProbe' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ZmxNativeMachineProbe {
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);
    public static int[] Read() {
        ushort processMachine;
        ushort nativeMachine;
        if (!IsWow64Process2(GetCurrentProcess(), out processMachine, out nativeMachine))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return new int[] { (int)processMachine, (int)nativeMachine };
    }
}
'@ -ErrorAction Stop
        }
        $machines = [ZmxNativeMachineProbe]::Read()
        $processMachine = [int]$machines[0]
        $nativeMachine = [int]$machines[1]
    } catch { }
    # Independent WMI processor architecture corroboration (9=x64, 12=ARM64).
    $processorArchitectureCode = $null
    try {
        $cpus = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop)
        $codes = @($cpus | ForEach-Object { [int]$_.Architecture } | Sort-Object -Unique)
        if ($codes.Count -eq 1) { $processorArchitectureCode = [int]$codes[0] }
    } catch { }
    try {
        $osInfo = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $windows = [ordered]@{
            caption = [string]$osInfo.Caption
            version = [string]$osInfo.Version
            build_number = [string]$osInfo.BuildNumber
            product_type = [int]$osInfo.ProductType
            os_architecture = [string]$osInfo.OSArchitecture
            native_machine = $nativeMachine
            process_machine = $processMachine
            processor_architecture_code = $processorArchitectureCode
            operating_system_sku = [int]$osInfo.OperatingSystemSKU
        }
    } catch { }
    $volume = $null
    try {
        $drive = [IO.Path]::GetPathRoot($JobsRoot).TrimEnd('\')
        if ($drive -match '^[A-Za-z]:$') {
            $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='" + $drive + "'") -ErrorAction Stop
            $volume = [ordered]@{ file_system = [string]$disk.FileSystem; drive_type = [int]$disk.DriveType }
        }
    } catch { }
    $hostMetadata = [ordered]@{
        powershell = [ordered]@{ version = $PSVersionTable.PSVersion.ToString(); edition = [string]$PSVersionTable.PSEdition }
        windows = $windows
        jobs_volume = $volume
    }
        [Console]::Out.WriteLine(($hostMetadata | ConvertTo-Json -Depth 5 -Compress))
        $helperExit = 0
    } else {
        # Normal entry delegates host acquisition to the Node helper. It does
        # not create or pass any host JSON file, trusted marker or path.
        $node = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $repo = Split-Path -Parent $PSScriptRoot
        if ([string]::IsNullOrWhiteSpace($ReportPath)) {
            $reportName = 'check-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.json'
            $ReportPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('Zmx\checks\' + $reportName)
        }
        $ReportPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ReportPath)
        $helperArgs = @((Join-Path $repo 'scripts\windows-zmx-check.cjs'), '--jobs-root', $JobsRoot, '--report', $ReportPath, '--target-os', $TargetOs)
        if ($Offline) { $helperArgs += '--offline' }
        & $node.Source @helperArgs
        $helperExit = $LASTEXITCODE
    }
} catch {
    # Neither collector stdout nor diagnostics contain exception messages,
    # API keys, ambient environment, or raw file paths.
    Write-Host 'Windows host collection or ZMX check failed. Inspect the new JSON report if one was created.'
    $helperExit = 2
} finally {
    $OutputEncoding = $oldOutputEncoding
    [Console]::OutputEncoding = $oldConsoleEncoding
}
exit $helperExit
