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
$ServiceUrl = "https://stupiaks-ops.sporkburger19.workers.dev/print-service/stupiaks-print-service.ps1"
$HealthUrl = "http://127.0.0.1:8788/health"
$Origin = "https://stupiaks-ops.sporkburger19.workers.dev"

function Stop-OldPrintProcesses {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^(node|powershell|pwsh)\.exe$' -and (
      $_.CommandLine -like '*StupiaksPrintBridge*' -or
      $_.CommandLine -like '*automatic-local-web-v19*' -or
      $_.CommandLine -like '*stupiaks-print-service.ps1*'
    )
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

if ($Remove) {
  schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
  schtasks.exe /Delete /TN $OldTaskName /F 2>$null | Out-Null
  Stop-OldPrintProcesses
  Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Stupiak's Print Service was removed."
  exit 0
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -UseBasicParsing -Uri $ServiceUrl -OutFile $ServicePath

$StartContent = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$ServicePath" >> "$LogFile" 2>&1
"@
Set-Content -Path $StartFile -Value $StartContent -Encoding ASCII

schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
schtasks.exe /Delete /TN $OldTaskName /F 2>$null | Out-Null
Stop-OldPrintProcesses

$TaskCommand = "`"$StartFile`""
schtasks.exe /Create /TN $TaskName /SC ONLOGON /RL LIMITED /TR $TaskCommand /F | Out-Null
Start-Process -FilePath $StartFile -WindowStyle Hidden

$Health = $null
$Deadline = (Get-Date).AddSeconds(15)
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
Write-Host "Starts automatically when this Windows user signs in."
Write-Host "Log: $LogFile"
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "Return to Chrome and press Check again."
Start-Process "https://stupiaks-ops.sporkburger19.workers.dev/labels/settings"
