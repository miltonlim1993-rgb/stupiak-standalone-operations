#!/usr/bin/env bash
set -euo pipefail

PORT="${PRINT_BRIDGE_PORT:-8787}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/tools/print-bridge/server.mjs"
INSTALL_DIR="$HOME/Library/Application Support/StupiaksPrintBridge"
TARGET="$INSTALL_DIR/server.mjs"
LOG="$INSTALL_DIR/bridge.log"
PLIST="$HOME/Library/LaunchAgents/com.stupiaks.printbridge.plist"
TOKEN_FILE="$HOME/.stupiaks-print-bridge-token"
NODE="$(command -v node || true)"

if [[ -z "$NODE" ]]; then
  echo "Node.js is required before installing the Print Bridge." >&2
  exit 1
fi
if [[ ! -f "$SOURCE" ]]; then
  echo "Print Bridge server was not found: $SOURCE" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$HOME/Library/LaunchAgents"
cp "$SOURCE" "$TARGET"
chmod 700 "$TARGET"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.stupiaks.printbridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$TARGET</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRINT_BRIDGE_HOST</key><string>0.0.0.0</string>
    <key>PRINT_BRIDGE_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/com.stupiaks.printbridge" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.stupiaks.printbridge"

for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.4
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || {
  echo "Print Bridge did not start. Check $LOG" >&2
  exit 1
}

TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE" 2>/dev/null || true)"
IP_LIST="$(ipconfig getifaddr en0 2>/dev/null || true) $(ipconfig getifaddr en1 2>/dev/null || true)"

echo "============================================================"
echo "Stupiak's Print Bridge is installed and running."
echo "macOS CUPS queue support: ready"
echo "Raw TCP and LPR forwarding: ready"
for ip in $IP_LIST; do
  [[ -n "$ip" ]] && echo "Phone/tablet Bridge URL: http://$ip:$PORT"
done
echo "Pairing token: ${TOKEN:-See $LOG}"
echo "LaunchAgent: $PLIST"
echo "Log: $LOG"
echo "============================================================"
