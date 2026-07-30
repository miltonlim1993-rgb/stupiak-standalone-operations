#!/usr/bin/env bash
set -euo pipefail

BRIDGE_PORT="${PRINT_BRIDGE_PORT:-8787}"
WEB_PORT="${PRINT_CONNECTOR_WEB_PORT:-8788}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_SOURCE="$ROOT/tools/print-bridge/server.mjs"
AUTO_SOURCE="$ROOT/tools/print-bridge/automatic-local-web-v19.mjs"
INSTALL_DIR="$HOME/Library/Application Support/StupiaksPrintBridge"
SERVER_TARGET="$INSTALL_DIR/server.mjs"
AUTO_TARGET="$INSTALL_DIR/automatic-local-web-v19.mjs"
LOG="$INSTALL_DIR/bridge.log"
PLIST="$HOME/Library/LaunchAgents/com.stupiaks.printbridge.plist"
TOKEN_FILE="$HOME/.stupiaks-print-bridge-token"
NODE="$(command -v node || true)"

if [[ -z "$NODE" ]]; then
  echo "Node.js is required before installing the Local Print Connector." >&2
  exit 1
fi
if [[ ! -f "$SERVER_SOURCE" || ! -f "$AUTO_SOURCE" ]]; then
  echo "Local Print Connector source was not found in this project." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$HOME/Library/LaunchAgents"
cp "$SERVER_SOURCE" "$SERVER_TARGET"
cp "$AUTO_SOURCE" "$AUTO_TARGET"
chmod 700 "$SERVER_TARGET" "$AUTO_TARGET"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.stupiaks.printbridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$AUTO_TARGET</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRINT_BRIDGE_PORT</key><string>$BRIDGE_PORT</string>
    <key>PRINT_CONNECTOR_WEB_PORT</key><string>$WEB_PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/com.stupiaks.printbridge" >/dev/null 2>&1 || true
pkill -f "$SERVER_TARGET" >/dev/null 2>&1 || true
pkill -f "$AUTO_TARGET" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.stupiaks.printbridge"

for _ in {1..30}; do
  if curl -fsS -H 'Origin: https://stupiaks-ops.sporkburger19.workers.dev' "http://127.0.0.1:$WEB_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.4
done
curl -fsS -H 'Origin: https://stupiaks-ops.sporkburger19.workers.dev' "http://127.0.0.1:$WEB_PORT/health" >/dev/null || {
  echo "Local Print Connector did not start. Check $LOG" >&2
  exit 1
}

TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE" 2>/dev/null || true)"

echo "============================================================"
echo "Stupiak's Local Print Connector is installed and running."
echo "Same-computer Web Direct LAN: automatic"
echo "Web Connector URL: http://127.0.0.1:$WEB_PORT"
echo "Pairing token on this Mac: NOT REQUIRED"
echo "Stable RAW TSPL forwarding: ready"
echo "Advanced remote-device token: ${TOKEN:-See $LOG}"
echo "LaunchAgent: $PLIST"
echo "Log: $LOG"
echo "============================================================"
