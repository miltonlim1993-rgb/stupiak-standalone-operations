@echo off
setlocal
set "INSTALLER=%TEMP%\install-stupiaks-print-service.ps1"
echo Installing Stupiak's Print Service 4.6.23...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing 'https://stupiaks-ops.sporkburger19.workers.dev/print-service/install-stupiaks-print-service.ps1?v=4.6.23' -OutFile '%INSTALLER%'; & '%INSTALLER%'"
if errorlevel 1 (
  echo.
  echo Installation failed. Keep this window open and send a photo to the system administrator.
  echo Installer file: %INSTALLER%
  pause
  exit /b 1
)
echo.
echo Installation completed. Return to Stupiak's Ops and press Check again.
pause
