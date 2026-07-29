param(
  [int]$Port = 8787,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = "Stupiaks Print Bridge"
$InstallDir = Join-Path $env:LOCALAPPDATA "StupiaksPrintBridge"
$ServerSource = Join-Path (Split-Path $PSScriptRoot -Parent) "tools\print-bridge\server.mjs"
$ServerTarget = Join-Path $InstallDir "server.mjs"
$StartFile = Join-Path $InstallDir "start.cmd"
$LogFile = Join-Path $InstallDir "bridge.log"
$TokenFile = Join-Path $HOME ".stupiaks-print-bridge-token"

if ($Remove) {
  schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$ServerTarget*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host "Removed the Stupiak's Print Bridge startup task."
  exit 0
}

if (-not (Test-Path $ServerSource)) { throw "Print Bridge server was not found: $ServerSource" }
$Node = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $ServerSource $ServerTarget -Force

$StartContent = @"
@echo off
set PRINT_BRIDGE_PORT=$Port
set PRINT_BRIDGE_HOST=0.0.0.0
"$Node" "$ServerTarget" >> "$LogFile" 2>&1
"@
Set-Content -Path $StartFile -Value $StartContent -Encoding ASCII

schtasks.exe /Create /TN $TaskName /SC ONLOGON /RL LIMITED /TR "`"$StartFile`"" /F | Out-Null

$Existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$ServerTarget*" }
if (-not $Existing) {
  Start-Process -FilePath $StartFile -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

$FirewallName = "Stupiaks Print Bridge TCP $Port"
try {
  if (-not (Get-NetFirewallRule -DisplayName $FirewallName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $FirewallName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
  }
  $FirewallStatus = "Private-network firewall rule is ready."
} catch {
  $FirewallStatus = "Firewall rule could not be created without Administrator permission. Run this installer once as Administrator, or allow TCP port $Port on Private networks."
}

$Deadline = (Get-Date).AddSeconds(8)
do {
  Start-Sleep -Milliseconds 400
  try { $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1 } catch { $Health = $null }
} until ($Health -or (Get-Date) -gt $Deadline)
if (-not $Health) { throw "Print Bridge did not start. Check $LogFile" }

$Token = if (Test-Path $TokenFile) { (Get-Content $TokenFile -Raw).Trim() } else { "Token is being generated; reopen this installer if it is not visible in the log." }
$Addresses = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' -and $_.PrefixOrigin -ne 'WellKnown'
} | Select-Object -ExpandProperty IPAddress -Unique

Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "Stupiak's Print Bridge is installed and running." -ForegroundColor Green
Write-Host "Windows queue support: ready"
Write-Host "Raw TCP and LPR forwarding: ready"
foreach ($Address in $Addresses) { Write-Host "Phone/tablet Bridge URL: http://$Address`:$Port" -ForegroundColor Cyan }
Write-Host "Pairing token: $Token" -ForegroundColor Cyan
Write-Host $FirewallStatus
Write-Host "Startup task: $TaskName"
Write-Host "Log: $LogFile"
Write-Host "============================================================" -ForegroundColor Yellow
