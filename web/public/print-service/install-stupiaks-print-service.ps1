param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = "Stupiaks Print Service"
$OldTaskName = "Stupiaks Print Bridge"
$InstallDir = Join-Path $env:LOCALAPPDATA "StupiaksPrintService"
$ServicePath = Join-Path $InstallDir "stupiaks-print-service.ps1"
$StartFile = Join-Path $InstallDir "start.cmd"
$LogFile = Join-Path $InstallDir "service.log"
$StartupFolder = [Environment]::GetFolderPath('Startup')
$StartupFile = Join-Path $StartupFolder "Stupiaks Print Service.cmd"
$ServiceUrl = "https://stupiaks-ops.sporkburger19.workers.dev/print-service/stupiaks-print-service.ps1?v=4.6.23"
$HealthUrl = "http://127.0.0.1:8788/health"
$Origin = "https://stupiaks-ops.sporkburger19.workers.dev"

function Remove-LegacyScheduledTask([string]$Name) {
  try {
    $Task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($Task) {
      Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    }
  } catch {
    # Old tasks are optional. Their absence must never stop installation.
  }
}

function Stop-OldPrintProcesses {
  $ExpectedServicePath = [IO.Path]::GetFullPath($ServicePath)
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $CommandLine = [string]$_.CommandLine
    $_.Name -match '^(node|powershell|pwsh)\.exe$' -and (
      $CommandLine -like '*StupiaksPrintBridge*' -or
      $CommandLine -like '*automatic-local-web-v19*' -or
      $CommandLine.IndexOf($ExpectedServicePath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    )
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

if ($Remove) {
  Remove-LegacyScheduledTask $TaskName
  Remove-LegacyScheduledTask $OldTaskName
  Stop-OldPrintProcesses
  Remove-Item $StartupFile -Force -ErrorAction SilentlyContinue
  Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Stupiak's Print Service was removed."
  exit 0
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri $ServiceUrl -OutFile $ServicePath

$StartContent = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$ServicePath" >> "$LogFile" 2>&1
"@
Set-Content -Path $StartFile -Value $StartContent -Encoding ASCII

Remove-LegacyScheduledTask $TaskName
Remove-LegacyScheduledTask $OldTaskName
Stop-OldPrintProcesses

# Per-user Startup Folder is more reliable than Task Scheduler on outlet PCs and needs no admin rights.
Copy-Item -Path $StartFile -Destination $StartupFile -Force
Start-Process -FilePath $StartFile -WindowStyle Hidden

$Health = $null
$Deadline = (Get-Date).AddSeconds(20)
do {
  Start-Sleep -Milliseconds 500
  try {
    $Health = Invoke-RestMethod -Uri $HealthUrl -Headers @{ Origin = $Origin } -TimeoutSec 2
  } catch {
    $Health = $null
  }
} until ($Health -or (Get-Date) -gt $Deadline)

if (-not $Health) {
  throw "Local Print Service did not start. Check $LogFile"
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "Stupiak's Print Service is installed and running." -ForegroundColor Green
Write-Host "Windows Printer Queue: ready" -ForegroundColor Green
Write-Host "Kitchen Direct IP / RAW TCP: ready" -ForegroundColor Green
Write-Host "Pairing token: NOT REQUIRED" -ForegroundColor Green
Write-Host "Starts automatically from the Windows Startup Folder."
Write-Host "Log: $LogFile"
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "Return to Chrome and press Check again."
Start-Process "https://stupiaks-ops.sporkburger19.workers.dev/labels/settings"
