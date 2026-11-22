# ASCII source is intentional: Windows PowerShell 5.1 reads BOM-less scripts
# using the active ANSI code page. Chinese paths are passed as .NET strings.
#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Offline,
    [string]$JobsRoot,
    [string]$ReportPath,
    [ValidateSet('windows10','windows11')][string]$TargetOs = 'windows10'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$helperExit = 2
$hostFile = $null
$oldOutputEncoding = $OutputEncoding
$oldConsoleEncoding = [Console]::OutputEncoding
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This entry point requires native Windows PowerShell; use Node for the offline helper on other platforms.'
    }
    $node = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $repo = Split-Path -Parent $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($JobsRoot)) {
        $JobsRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Zmx\jobs'
    }
    if ([string]::IsNullOrWhiteSpace($ReportPath)) {
        $reportName = 'check-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.json'
        $ReportPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('Zmx\checks\' + $reportName)
    }
    # Resolve relative arguments against the caller's directory, never the script directory.
    $JobsRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($JobsRoot)
    $ReportPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ReportPath)
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
    $hostFile = [IO.Path]::GetTempFileName()
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($hostFile, ($hostMetadata | ConvertTo-Json -Depth 5), $utf8)
    $OutputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $helperArgs = @((Join-Path $repo 'scripts\windows-zmx-check.cjs'), '--host-file', $hostFile, '--jobs-root', $JobsRoot, '--report', $ReportPath)
    $helperArgs += @('--target-os', $TargetOs)
    if ($Offline) { $helperArgs += '--offline' }
    & $node.Source @helperArgs
    $helperExit = $LASTEXITCODE
} catch {
    # Do not serialize exception objects or environment variables into diagnostics.
    Write-Host 'Windows check could not start. Confirm native Windows PowerShell 5.1+, Node.js 22 x64, and writable local paths.'
    $helperExit = 2
} finally {
    if ($hostFile -and [IO.File]::Exists($hostFile)) { [IO.File]::Delete($hostFile) }
    $OutputEncoding = $oldOutputEncoding
    [Console]::OutputEncoding = $oldConsoleEncoding
}
exit $helperExit
