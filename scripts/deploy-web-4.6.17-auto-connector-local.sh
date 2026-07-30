#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_BRANCH="feature/task-workflow-v3-apk"
EXPECTED_ACCOUNT_ID="bb2ac1970975a5018a17c878e61cb88f"
OPS_KV_ID="f62696e1a2f14b8a9e0b84a540c7e997"
RECRUITMENT_KV_ID="ccf52a9b0bb94a4a90889f30a0e623d5"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
LOGIN_CLIENT_ID="460544373229-06mv64nt3e78mtse5sc375cobv13i1ii.apps.googleusercontent.com"
EXPECTED_WORKER_REVISION="auto-web-direct-lan-stable-tspl-v19-v4.6.17"
EXPECTED_SHELL_REVISION="4.6.17-auto-web-direct-lan-stable-tspl-v19"
EXPECTED_SW_VERSION="chefops-v4-6-17-auto-web-direct-lan-stable-tspl-v19"
LOCAL_CONNECTOR_URL="http://127.0.0.1:8788"
PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "ERROR: Run this inside the stupiak-standalone-operations repository."
  exit 1
fi
cd "$ROOT"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: Current branch is '$CURRENT_BRANCH'. Expected '$EXPECTED_BRANCH'."
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree is not clean. Commit or stash unrelated changes first."
  git status --short
  exit 1
fi

printf '\n==================================================\n'
echo "1. Pull and verify Automatic Web Direct LAN v19"
echo "=================================================="
git fetch origin "$EXPECTED_BRANCH"
git merge --ff-only "origin/$EXPECTED_BRANCH"
COMMIT="$(git rev-parse HEAD)"
echo "Commit: $COMMIT"

grep -q '"version": "4.6.17"' package.json
grep -q "$EXPECTED_WORKER_REVISION" worker/src/entry-v3.js
grep -q "$EXPECTED_SHELL_REVISION" web/src/main.jsx
grep -q "$EXPECTED_SW_VERSION" web/public/sw.js
grep -q 'installStableLabelPrintV19' web/src/main.jsx
grep -q 'LabelPrinterSettingsStableV19' web/src/App.jsx
grep -q 'DEFAULT_LOCAL_PRINT_CONNECTOR_URL' web/src/lib/local-print-connector-v19.js
grep -q 'http://127.0.0.1:8788' web/src/lib/local-print-connector-v19.js
grep -q 'payloadBase64: asciiBase64(stable.command)' web/src/lib/stable-label-print-v19.js
grep -q 'Pairing token: <b>Not required</b>' web/src/pages/LabelPrinterSettingsStableV19.jsx
grep -q 'automatic-local-web-v19.mjs' scripts/install-print-bridge-macos.sh
grep -q 'automatic-local-web-v19.mjs' scripts/install-print-bridge-windows.ps1
grep -q 'Access-Control-Allow-Private-Network' tools/print-bridge/automatic-local-web-v19.mjs
grep -q 'Same-computer Stupiak’s Ops Web requires no pairing token' tools/print-bridge/automatic-local-web-v19.mjs
grep -q "PrinterProfile: LEVEL.staff" worker/src/permissions.js
if grep -q 'BITMAP' web/src/lib/stable-tspl-label-v16.js; then
  echo "ERROR: Stable TSPL content core changed to BITMAP. Refusing deployment."
  exit 1
fi

printf '\n==================================================\n'
echo "2. Verify Cloudflare authentication"
echo "=================================================="
WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1)"
printf '%s\n' "$WHOAMI_OUTPUT"
printf '%s\n' "$WHOAMI_OUTPUT" | grep -q "$EXPECTED_ACCOUNT_ID"

printf '\n==================================================\n'
echo "3. Build and test Web, automatic connector and Stable TSPL"
echo "=================================================="
export CLOUDFLARE_ACCOUNT_ID="$EXPECTED_ACCOUNT_ID"
export CLOUDFLARE_APP_DATA_PACKS_ID="$OPS_KV_ID"
export VITE_API_BASE_URL="$WORKER_URL"
export VITE_GOOGLE_LOGIN_CLIENT_ID="$LOGIN_CLIENT_ID"
unset CLOUDFLARE_MEDIA_BUCKET_NAME || true

npm ci
npm run build
node --check tools/print-bridge/server.mjs
node --check tools/print-bridge/automatic-local-web-v19.mjs
bash -n scripts/install-print-bridge-macos.sh
npm run cf:render

CONFIG="worker/wrangler.production.jsonc"
grep -q '"name": "stupiaks-ops"' "$CONFIG"
grep -q "$OPS_KV_ID" "$CONFIG"
if grep -q "$RECRUITMENT_KV_ID" "$CONFIG"; then
  echo "ERROR: Recruitment KV appeared in the Ops config. Refusing deployment."
  exit 1
fi
if grep -q 'MEDIA_BUCKET' "$CONFIG"; then
  echo "ERROR: R2 binding appeared in the Ops config. Refusing deployment."
  exit 1
fi

printf '\n==================================================\n'
echo "4. Install/update the same-computer Local Print Connector"
echo "=================================================="
if [[ "$(uname -s)" == "Darwin" ]]; then
  bash scripts/install-print-bridge-macos.sh
  curl -fsS -H "Origin: $PRODUCTION_ORIGIN" "$LOCAL_CONNECTOR_URL/health" | python3 -m json.tool
else
  echo "Non-macOS machine detected. Install scripts/install-print-bridge-windows.ps1 on Windows after deployment."
fi

printf '\n==================================================\n'
echo "5. Deploy Web and Ops Worker only"
echo "=================================================="
npx wrangler deploy --config "$CONFIG"

printf '\n==================================================\n'
echo "6. Verify production and fresh Label Settings"
echo "=================================================="
VERIFIED=""
for attempt in $(seq 1 18); do
  ROOT_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?acceptance=4.6.17-$COMMIT-$attempt" || true)"
  SETTINGS_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/labels/settings?acceptance=4.6.17-$COMMIT-$attempt" || true)"
  SHELL="$(curl -fsS --max-time 20 "$WORKER_URL/sw.js?acceptance=4.6.17-$COMMIT-$attempt" || true)"
  if printf '%s' "$ROOT_HEADERS" | grep -Fqi "x-chefops-worker-revision: $EXPECTED_WORKER_REVISION" \
    && printf '%s' "$SETTINGS_HEADERS" | grep -Fqi "x-chefops-shell-revision: $EXPECTED_SHELL_REVISION" \
    && printf '%s' "$SETTINGS_HEADERS" | grep -Fqi 'cache-control: no-store' \
    && printf '%s' "$SHELL" | grep -Fq "$EXPECTED_SW_VERSION"; then
    VERIFIED="yes"
    break
  fi
  sleep 5
done

if [[ "$VERIFIED" != "yes" ]]; then
  echo "ERROR: Deployment completed but 4.6.17 production markers were not visible."
  printf '%s\n' "$ROOT_HEADERS"
  printf '%s\n' "$SETTINGS_HEADERS"
  exit 1
fi

printf '%s\n' "$ROOT_HEADERS" | grep -Ei '^(HTTP/|x-chefops-worker-revision:)'
printf '%s\n' "$SETTINGS_HEADERS" | grep -Ei '^(HTTP/|cache-control:|x-chefops-shell-revision:)'
printf '%s\n' "$SHELL" | grep 'const VERSION'
curl -fsS "$WORKER_URL/api/health" | python3 -m json.tool

printf '\n==================================================\n'
echo "SUCCESS: Automatic Web Direct LAN v19 deployed"
echo "=================================================="
echo "URL: $WORKER_URL/labels/settings"
echo "Commit: $COMMIT"
echo "Worker: $EXPECTED_WORKER_REVISION"
echo "Shell: $EXPECTED_SHELL_REVISION"
echo "Web staff setup: enter printer IP only"
echo "Local Connector: $LOCAL_CONNECTOR_URL"
echo "Pairing token on this Mac: not required"
echo "Stable payload: identical RAW TSPL content used by Android APK"
echo "Web Food/Test labels: no System Print, browser pagination or Raster fallback"
echo "Android APK: unchanged; accepted native Wi-Fi printing remains untouched"
echo "Ops KV: $OPS_KV_ID"
echo "Recruitment KV unchanged: $RECRUITMENT_KV_ID"
echo "R2 remains disabled."
echo "No Sheet, TaskTemplate, Data Package, Ops Control or Android release command was run."
