#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_BRANCH="feature/task-workflow-v3-apk"
EXPECTED_ACCOUNT_ID="bb2ac1970975a5018a17c878e61cb88f"
OPS_KV_ID="f62696e1a2f14b8a9e0b84a540c7e997"
RECRUITMENT_KV_ID="ccf52a9b0bb94a4a90889f30a0e623d5"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
LOGIN_CLIENT_ID="460544373229-06mv64nt3e78mtse5sc375cobv13i1ii.apps.googleusercontent.com"
EXPECTED_WORKER_REVISION="web-direct-lan-stable-tspl-v18-v4.6.16"
EXPECTED_SHELL_REVISION="4.6.16-web-direct-lan-stable-tspl-v18"
EXPECTED_SW_VERSION="chefops-v4-6-16-web-direct-lan-stable-tspl-v18"

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
echo "1. Pull and verify Web Direct LAN Stable TSPL v18"
echo "=================================================="
git fetch origin "$EXPECTED_BRANCH"
git merge --ff-only "origin/$EXPECTED_BRANCH"
COMMIT="$(git rev-parse HEAD)"
echo "Commit: $COMMIT"

grep -q '"version": "4.6.16"' package.json
grep -q "$EXPECTED_WORKER_REVISION" worker/src/entry-v3.js
grep -q "$EXPECTED_SHELL_REVISION" web/src/main.jsx
grep -q "$EXPECTED_SW_VERSION" web/public/sw.js
grep -q 'installStableLabelPrintV18' web/src/main.jsx
grep -q 'LabelPrinterSettingsStableV18' web/src/App.jsx
grep -q 'Web Direct Wi-Fi/LAN via Local Connector' web/src/lib/stable-label-print-v18.js
grep -q 'payloadBase64: asciiBase64(command)' web/src/lib/stable-label-print-v18.js
grep -q 'rawCommandBase64: asciiBase64(stable.command)' web/src/lib/stable-label-print-v18.js
grep -q "html: ''" web/src/lib/stable-label-print-v18.js
if grep -q 'delegateSystemPrint\|html-raster' web/src/lib/stable-label-print-v18.js; then
  echo "ERROR: Web Stable Label Print contains browser/System/Raster fallback. Refusing deployment."
  exit 1
fi
grep -q 'Web Direct LAN connector' web/src/pages/LabelPrinterSettingsStableV18.jsx
grep -q 'All staff' web/src/pages/LabelPrinterSettingsStableV18.jsx
grep -q 'http://127.0.0.1:8787' web/src/pages/LabelPrinterSettingsStableV18.jsx
grep -q 'printStableLabelHtmlV18(testLabelHtml' web/src/pages/LabelPrinterSettingsStableV18.jsx
grep -q 'Web Direct Wi-Fi/LAN requires the Local Print Connector URL' web/src/lib/printer-transport-v12.js
grep -q "PrinterProfile: LEVEL.staff" worker/src/permissions.js
grep -q 'STABLE_TSPL_LABEL_VERSION' web/src/lib/stable-tspl-label-v16.js
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
echo "3. Build and test Web Direct LAN, staff permissions and Stable TSPL"
echo "=================================================="
export CLOUDFLARE_ACCOUNT_ID="$EXPECTED_ACCOUNT_ID"
export CLOUDFLARE_APP_DATA_PACKS_ID="$OPS_KV_ID"
export VITE_API_BASE_URL="$WORKER_URL"
export VITE_GOOGLE_LOGIN_CLIENT_ID="$LOGIN_CLIENT_ID"
unset CLOUDFLARE_MEDIA_BUCKET_NAME || true

npm ci
npm run build
node --check tools/print-bridge/server.mjs
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
echo "4. Deploy Web and Ops Worker only"
echo "=================================================="
npx wrangler deploy --config "$CONFIG"

printf '\n==================================================\n'
echo "5. Verify production and fresh Label Settings"
echo "=================================================="
VERIFIED=""
for attempt in $(seq 1 18); do
  ROOT_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?acceptance=4.6.16-$COMMIT-$attempt" || true)"
  SETTINGS_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/labels/settings?acceptance=4.6.16-$COMMIT-$attempt" || true)"
  SHELL="$(curl -fsS --max-time 20 "$WORKER_URL/sw.js?acceptance=4.6.16-$COMMIT-$attempt" || true)"
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
  echo "ERROR: Deployment completed but 4.6.16 production markers were not visible."
  printf '%s\n' "$ROOT_HEADERS"
  printf '%s\n' "$SETTINGS_HEADERS"
  exit 1
fi

printf '%s\n' "$ROOT_HEADERS" | grep -Ei '^(HTTP/|x-chefops-worker-revision:)'
printf '%s\n' "$SETTINGS_HEADERS" | grep -Ei '^(HTTP/|cache-control:|x-chefops-shell-revision:)'
printf '%s\n' "$SHELL" | grep 'const VERSION'
curl -fsS "$WORKER_URL/api/health" | python3 -m json.tool

printf '\n==================================================\n'
echo "SUCCESS: Web Direct LAN Stable TSPL v18 deployed"
echo "=================================================="
echo "URL: $WORKER_URL/labels/settings"
echo "Commit: $COMMIT"
echo "Worker: $EXPECTED_WORKER_REVISION"
echo "Shell: $EXPECTED_SHELL_REVISION"
echo "Web Direct LAN: printer IP -> Local Connector -> RAW TCP/LPR"
echo "Stable payload: identical TSPL content core used by Android APK"
echo "Web Food/Test labels: no System Print, browser pagination or Raster fallback"
echo "Staff: read/create/update/delete PrinterProfile within assigned outlet"
echo "Android APK: unchanged; accepted native Wi-Fi printing remains untouched"
echo "Ops KV: $OPS_KV_ID"
echo "Recruitment KV unchanged: $RECRUITMENT_KV_ID"
echo "R2 remains disabled."
echo "No Sheet, TaskTemplate, Data Package, Ops Control or Android release command was run."
