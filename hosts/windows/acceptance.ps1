<#
.SYNOPSIS
  Native Windows runtime acceptance and log runner for engine-windows.exe.

.DESCRIPTION
  Runs on a real Windows 10/11 x64 machine with the Evergreen WebView2 runtime.
  Checks the package layout (no third-party DLLs), records the machine, GPU and
  WebView2 runtime, then runs the host self-tests:

    selftest      --selftest                 readback, native menu command, colour change,
                                             isolation/MIME/offline/DPR probe
    lifecycle     --selftest=lifecycle       the above plus minimise/restore visibility,
                                             reload and engine restart
    no-isolation  --selftest --no-isolation  the probe must see no COOP/COEP headers

  Each run's stdout/stderr, exit code and required evidence lines are written to
  a timestamped log directory with summary.json. A run passes only with exit
  code 0 and all evidence present. GPU-unavailable and runtime-missing outcomes
  are reported as "blocked", never as passes.

  Exit status: 0 all passed, 1 any failure, 2 blocked by the machine (no
  WebView2 runtime or no WebGPU adapter) without failures.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File hosts\windows\acceptance.ps1 -Package build
#>
[CmdletBinding()]
param(
  [string]$Package = (Join-Path $PSScriptRoot '..\..\build'),
  [string]$LogDirectory = '',
  [ValidateRange(10, 900)][int]$TimeoutSeconds = 90,
  [switch]$SkipLifecycle,
  [switch]$SkipNoIsolation
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

# Mirrors nt_windows::exit_code in policy.h; verify.test.mjs keeps them identical.
$ExitNames = @{
  0 = 'ok'
  1 = 'config'
  2 = 'runtime-missing'
  3 = 'init-failed'
  4 = 'timeout'
  5 = 'gpu-unavailable'
  6 = 'engine-failed'
  7 = 'webview-failed'
  8 = 'closed'
  9 = 'internal'
  10 = 'policy-failed'
}
$BlockedCodes = @(2, 5)

function Get-ExitName([int]$Code) {
  if ($ExitNames.ContainsKey($Code)) { return $ExitNames[$Code] }
  return "unknown-$Code"
}

function Get-WebView2Runtime {
  $client = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  $keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$client",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$client",
    "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$client"
  )
  foreach ($key in $keys) {
    try { $item = Get-ItemProperty -Path $key -Name pv -ErrorAction Stop } catch { continue }
    if ($item -and $item.pv -and $item.pv -ne '0.0.0.0') { return [string]$item.pv }
  }
  return $null
}

function Get-MachineInfo {
  $os = $null
  $gpus = @()
  try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $gpus = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop | ForEach-Object {
        [ordered]@{ name = $_.Name; driver = $_.DriverVersion; status = $_.Status }
      })
  } catch { Write-Host "machine query unavailable: $($_.Exception.Message)" }
  return [ordered]@{
    computer = $env:COMPUTERNAME
    os = if ($os) { "$($os.Caption) $($os.Version) build $($os.BuildNumber)" } else { [Environment]::OSVersion.VersionString }
    architecture = $env:PROCESSOR_ARCHITECTURE
    is64BitOperatingSystem = [Environment]::Is64BitOperatingSystem
    powershell = $PSVersionTable.PSVersion.ToString()
    gpus = $gpus
  }
}

function Test-Package([string]$Root) {
  $problems = New-Object System.Collections.Generic.List[string]
  $exe = Join-Path $Root 'engine-windows.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { $problems.Add("missing $exe") }
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'engine-assets\engine\page.html') -PathType Leaf)) { $problems.Add('missing engine-assets\engine\page.html') }
  foreach ($dll in @(Get-ChildItem -LiteralPath $Root -Filter '*.dll' -File -ErrorAction SilentlyContinue)) {
    $problems.Add("third-party DLL in package: $($dll.Name)")
  }
  $assets = Join-Path $Root 'engine-assets'
  if (Test-Path -LiteralPath $assets) {
    foreach ($item in @(Get-ChildItem -LiteralPath $assets -Recurse -Force -ErrorAction SilentlyContinue)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $problems.Add("reparse point in engine-assets: $($item.FullName)") }
      if (-not $item.PSIsContainer -and $item.Extension -in @('.dll', '.exe')) { $problems.Add("executable in engine-assets: $($item.FullName)") }
    }
  }
  return $problems.ToArray()
}

function Invoke-HostRun([string]$Name, [string[]]$Arguments, [string[]]$Evidence, [string[]]$ErrorEvidence, [string]$Exe, [string]$Root, [string]$Logs) {
  $stdout = Join-Path $Logs "$Name.stdout.log"
  $stderr = Join-Path $Logs "$Name.stderr.log"
  $hostTimeoutMs = [Math]::Max(1000, ($TimeoutSeconds - 10) * 1000)
  $allArguments = @($Arguments) + @("--timeout-ms=$hostTimeoutMs")
  Write-Host "[$Name] $Exe $($allArguments -join ' ')"
  $started = Get-Date
  $process = Start-Process -FilePath $Exe -ArgumentList $allArguments -WorkingDirectory $Root -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $null = $process.Handle  # keeps ExitCode available after exit
  $killed = $false
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $killed = $true
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    $null = $process.WaitForExit(10000)
  }
  $process.WaitForExit()
  $code = if ($killed) { 4 } else { [int]$process.ExitCode }
  $out = if (Test-Path -LiteralPath $stdout) { @(Get-Content -LiteralPath $stdout) } else { @() }
  $err = if (Test-Path -LiteralPath $stderr) { @(Get-Content -LiteralPath $stderr) } else { @() }
  $missing = New-Object System.Collections.Generic.List[string]
  foreach ($pattern in $Evidence) { if (-not ($out | Where-Object { $_ -match $pattern })) { $missing.Add("stdout: $pattern") } }
  foreach ($pattern in $ErrorEvidence) { if (-not ($err | Where-Object { $_ -match $pattern })) { $missing.Add("stderr: $pattern") } }
  $marker = @($out | Where-Object { $_ -match '^ENGINE_WINDOWS_(OK|FAILED|TIMEOUT|UNAVAILABLE|CLOSED)' } | Select-Object -Last 1)
  $status = if ($code -eq 0 -and $missing.Count -eq 0) { 'pass' } elseif ($BlockedCodes -contains $code) { 'blocked' } else { 'fail' }
  $result = [ordered]@{
    name = $Name
    arguments = $allArguments
    status = $status
    exitCode = $code
    exitName = if ($killed) { 'killed-after-timeout' } else { Get-ExitName $code }
    seconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    marker = if ($marker.Count) { $marker[0] } else { $null }
    missingEvidence = @($missing)
    engineMode = @($out | Where-Object { $_ -like 'REPORT ENGINE_MODE *' } | ForEach-Object { $_.Substring(7) })
    webview2 = @($out | Where-Object { $_ -like 'WEBVIEW2_VERSION *' } | Select-Object -First 1)
    dpi = @($out | Where-Object { $_ -like 'WINDOWS_DPI *' })
    probe = @($out | Where-Object { $_ -like 'PROBE *' } | Select-Object -Last 1)
    offlineBlocked = @($err | Where-Object { $_ -like 'OFFLINE_BLOCKED *' }).Count
    processFailures = @($err | Where-Object { $_ -like 'PROCESS_FAILED *' })
    pageExceptions = @($err | Where-Object { $_ -like 'PAGE_EXCEPTION *' }).Count
    stdout = $stdout
    stderr = $stderr
  }
  Write-Host ("[{0}] {1} exit={2} ({3}) {4}" -f $Name, $status.ToUpper(), $code, $result.exitName, ($missing -join '; '))
  return $result
}

if ($env:OS -ne 'Windows_NT') { Write-Host 'acceptance.ps1 must run on Windows'; exit 1 }
$root = (Resolve-Path -LiteralPath $Package).Path
$exe = Join-Path $root 'engine-windows.exe'
if (-not $LogDirectory) { $LogDirectory = Join-Path $root ('windows-acceptance-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$logs = (New-Item -ItemType Directory -Force -Path $LogDirectory).FullName

$summary = [ordered]@{
  started = (Get-Date).ToString('o')
  package = $root
  machine = Get-MachineInfo
  webview2Runtime = Get-WebView2Runtime
  packageProblems = @()
  runs = @()
  status = 'fail'
}
$summary.packageProblems = @(Test-Package $root)
Write-Host "machine: $($summary.machine.os) $($summary.machine.architecture)"
Write-Host "gpus: $(($summary.machine.gpus | ForEach-Object { $_.name }) -join ', ')"
Write-Host "WebView2 runtime: $(if ($summary.webview2Runtime) { $summary.webview2Runtime } else { 'not found in EdgeUpdate registry' })"

if ($summary.packageProblems.Count -gt 0) {
  $summary.packageProblems | ForEach-Object { Write-Host "package: $_" }
} elseif (-not $summary.machine.is64BitOperatingSystem) {
  $summary.packageProblems = @('x64 Windows required')
} else {
  $common = @('^WEBVIEW2_VERSION ', '^WINDOWS_DPI initial ', '^REPORT ENGINE_MODE ', '^REPORT GPU_READBACK_OK 4096$', '^MENU_PRESSED change-colour$',
    '^COMMAND topic=1$', '^REPORT GPU_COLOUR_CHANGED$', '^PROBE ', '^ENGINE_WINDOWS_OK exit=0 ')
  $offline = @('^OFFLINE_BLOCKED https://example\.com/nativetron-offline-probe\.png')
  $runs = @(@{ name = 'selftest'; args = @('--selftest'); evidence = $common })
  if (-not $SkipLifecycle) { $runs += @{ name = 'lifecycle'; args = @('--selftest=lifecycle'); evidence = $common + @('^LIFECYCLE minimise=hidden restore=visible$') } }
  if (-not $SkipNoIsolation) { $runs += @{ name = 'no-isolation'; args = @('--selftest', '--no-isolation'); evidence = $common } }
  foreach ($run in $runs) {
    $summary.runs += Invoke-HostRun -Name $run.name -Arguments $run.args -Evidence $run.evidence -ErrorEvidence $offline -Exe $exe -Root $root -Logs $logs
  }
  $statuses = @($summary.runs | ForEach-Object { $_.status })
  $summary.status = if ($statuses -contains 'fail') { 'fail' } elseif ($statuses -contains 'blocked') { 'blocked' } else { 'pass' }
}

$summary.finished = (Get-Date).ToString('o')
$summaryPath = Join-Path $logs 'summary.json'
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
Write-Host "summary: $($summary.status.ToUpper()) -> $summaryPath"
switch ($summary.status) {
  'pass' { exit 0 }
  'blocked' { exit 2 }
  default { exit 1 }
}
