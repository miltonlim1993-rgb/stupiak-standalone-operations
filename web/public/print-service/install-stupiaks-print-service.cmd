@echo off
setlocal
set "INSTALLER=%TEMP%\install-stupiaks-print-service.ps1"
echo Installing Stupiak's Print Service...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing 'https://stupiaks-ops.sporkburger19.workers.dev/print-service/install-stupiaks-print-service.ps1' -OutFile '%INSTALLER%'; & '%INSTALLER%'"
if errorlevel 1 (
  echo.
  echo Installation failed. Please send a photo of this window to the system administrator.
  pause
  exit /b 1
)
echo.
echo Installation completed. Return to Stupiak's Ops and press Check again.
pause
