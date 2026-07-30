param(
  [int]$BridgePort = 8787,
  [int]$WebPort = 8788,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = "Stupiaks Print Bridge"
$InstallDir = Join-Path $env:LOCALAPPDATA "StupiaksPrintBridge"
$Root = Split-Path $PSScriptRoot -Parent
$ServerSource = Join-Path $Root "tools\print-bridge\server.mjs"
$AutoSource = Join-Path $Root "tools\print-bridge\automatic-local-web-v19.mjs"
$ServerTarget = Join-Path $InstallDir "server.mjs"
$AutoTarget = Join-Path $InstallDir "automatic-local-web-v19.mjs"
$StartFile = Join-Path $InstallDir "start.cmd"
$LogFile = Join-Path $InstallDir "bridge.log"
$TokenFile = Join-Path $HOME ".stupiaks-print-bridge-token"

if ($Remove) {
  schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like "*$ServerTarget*" -or $_.CommandLine -like "*$AutoTarget*"
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host "Removed the Stupiak's Local Print Connector startup task."
  exit 0
}

if (-not (Test-Path $ServerSource) -or -not (Test-Path $AutoSource)) {
  throw "Local Print Connector source was not found in this project."
}
$Node = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $ServerSource $ServerTarget -Force
Copy-Item $AutoSource $AutoTarget -Force

$StartContent = @"
@echo off
set PRINT_BRIDGE_PORT=$BridgePort
set PRINT_CONNECTOR_WEB_PORT=$WebPort
"$Node" "$AutoTarget" >> "$LogFile" 2>&1
"@
Set-Content -Path $StartFile -Value $StartContent -Encoding ASCII

schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like "*$ServerTarget*" -or $_.CommandLine -like "*$AutoTarget*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

schtasks.exe /Create /TN $TaskName /SC ONLOGON /RL LIMITED /TR "`"$StartFile`"" /F | Out-Null
Start-Process -FilePath $StartFile -WindowStyle Hidden

$Deadline = (Get-Date).AddSeconds(12)
do {
  Start-Sleep -Milliseconds 400
  try {
    $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/health" -Headers @{ Origin = 'https://stupiaks-ops.sporkburger19.workers.dev' } -TimeoutSec 1
  } catch {
    $Health = $null
  }
} until ($Health -or (Get-Date) -gt $Deadline)
if (-not $Health) { throw "Local Print Connector did not start. Check $LogFile" }

$Token = if (Test-Path $TokenFile) { (Get-Content $TokenFile -Raw).Trim() } else { "See $LogFile" }

Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "Stupiak's Local Print Connector is installed and running." -ForegroundColor Green
Write-Host "Same-computer Web Direct LAN: automatic" -ForegroundColor Green
Write-Host "Web Connector URL: http://127.0.0.1:$WebPort" -ForegroundColor Cyan
Write-Host "Pairing token on this PC: NOT REQUIRED" -ForegroundColor Green
Write-Host "Stable RAW TSPL forwarding: ready"
Write-Host "Advanced remote-device token: $Token"
Write-Host "Startup task: $TaskName"
Write-Host "Log: $LogFile"
Write-Host "============================================================" -ForegroundColor Yellow
