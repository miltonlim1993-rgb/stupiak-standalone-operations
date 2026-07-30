#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_BRANCH="feature/task-workflow-v3-apk"
EXPECTED_ACCOUNT_ID="bb2ac1970975a5018a17c878e61cb88f"
OPS_KV_ID="f62696e1a2f14b8a9e0b84a540c7e997"
RECRUITMENT_KV_ID="ccf52a9b0bb94a4a90889f30a0e623d5"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
LOGIN_CLIENT_ID="460544373229-06mv64nt3e78mtse5sc375cobv13i1ii.apps.googleusercontent.com"
EXPECTED_WORKER_REVISION="windows-queue-kitchen-ip-service-v24-v4.6.22"
EXPECTED_SHELL_REVISION="4.6.22-windows-queue-kitchen-ip-service-v24"
EXPECTED_SW_VERSION="chefops-v4-6-22-windows-queue-kitchen-ip-service-v24"
WINDOWS_INSTALLER_PATH="/print-service/install-stupiaks-print-service.cmd"
WINDOWS_SERVICE_PATH="/print-service/stupiaks-print-service.ps1"

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
echo "1. Pull and verify 4.6.22 Windows Print Service"
echo "=================================================="
git fetch origin "$EXPECTED_BRANCH"
git merge --ff-only "origin/$EXPECTED_BRANCH"
COMMIT="$(git rev-parse HEAD)"
echo "Commit: $COMMIT"

grep -q '"version": "4.6.22"' package.json
grep -q "$EXPECTED_WORKER_REVISION" worker/src/entry-v3.js
grep -q "$EXPECTED_SHELL_REVISION" web/src/main.jsx
grep -q "$EXPECTED_SW_VERSION" web/public/sw.js
grep -q 'LOCAL_CONNECTOR_INSTALLER' web/src/pages/LabelPrinterSettingsSimpleV20.jsx
grep -q 'Install / Repair Print Service' web/src/pages/LabelPrinterSettingsSimpleV20.jsx
grep -q 'Windows Printer' web/src/pages/LabelPrinterSettingsSimpleV20.jsx
grep -q 'Kitchen Printer · Direct IP' web/src/pages/LabelPrinterSettingsSimpleV20.jsx
grep -q "LOCAL_CONNECTOR_INSTALLER = '$WINDOWS_INSTALLER_PATH'" web/src/lib/device-printer-v20.js
grep -q 'Stupiaks Print Service' web/public/print-service/install-stupiaks-print-service.ps1
grep -q 'StupiaksRawPrinterV24' web/public/print-service/stupiaks-print-service.ps1
grep -q 'Get-PrinterRows' web/public/print-service/stupiaks-print-service.ps1
grep -q 'Send-RawTcp' web/public/print-service/stupiaks-print-service.ps1
grep -q 'if (isNativeAndroid()) installStableLabelPrintV16()' web/src/main.jsx
grep -q 'else installStableLabelPrintV20()' web/src/main.jsx
grep -q "Permissions-Policy', 'local-network=(self), loopback-network=(self)'" worker/src/entry-v3.js
if grep -q 'BITMAP\|html-raster' web/src/lib/stable-label-print-v20.js; then
  echo "ERROR: Web stable print contains Raster/BITMAP. Refusing deployment."
  exit 1
fi

printf '\n==================================================\n'
echo "2. Verify Cloudflare authentication"
echo "=================================================="
WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1)"
printf '%s\n' "$WHOAMI_OUTPUT"
printf '%s\n' "$WHOAMI_OUTPUT" | grep -q "$EXPECTED_ACCOUNT_ID"

printf '\n==================================================\n'
echo "3. Build and test Web, Worker and frozen Android source"
echo "=================================================="
export CLOUDFLARE_ACCOUNT_ID="$EXPECTED_ACCOUNT_ID"
export CLOUDFLARE_APP_DATA_PACKS_ID="$OPS_KV_ID"
export VITE_API_BASE_URL="$WORKER_URL"
export VITE_GOOGLE_LOGIN_CLIENT_ID="$LOGIN_CLIENT_ID"
unset CLOUDFLARE_MEDIA_BUCKET_NAME || true

npm ci
npm run build
bash -n scripts/deploy-web-4.6.22-windows-print-service-local.sh
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
echo "5. Verify production 4.6.22 and Windows installer files"
echo "=================================================="
VERIFIED=""
for attempt in $(seq 1 18); do
  ROOT_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?acceptance=4.6.22-$COMMIT-$attempt" || true)"
  SETTINGS_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/labels/settings?acceptance=4.6.22-$COMMIT-$attempt" || true)"
  SHELL="$(curl -fsS --max-time 20 "$WORKER_URL/sw.js?acceptance=4.6.22-$COMMIT-$attempt" || true)"
  INSTALLER="$(curl -fsS --max-time 20 "$WORKER_URL$WINDOWS_INSTALLER_PATH?acceptance=4.6.22-$COMMIT-$attempt" || true)"
  SERVICE="$(curl -fsS --max-time 20 "$WORKER_URL$WINDOWS_SERVICE_PATH?acceptance=4.6.22-$COMMIT-$attempt" || true)"
  if printf '%s' "$ROOT_HEADERS" | grep -Fqi "x-chefops-worker-revision: $EXPECTED_WORKER_REVISION" \
    && printf '%s' "$ROOT_HEADERS" | grep -Fqi 'permissions-policy: local-network=(self), loopback-network=(self)' \
    && printf '%s' "$SETTINGS_HEADERS" | grep -Fqi "x-chefops-shell-revision: $EXPECTED_SHELL_REVISION" \
    && printf '%s' "$SETTINGS_HEADERS" | grep -Fqi 'cache-control: no-store' \
    && printf '%s' "$SHELL" | grep -Fq "$EXPECTED_SW_VERSION" \
    && printf '%s' "$INSTALLER" | grep -Fq "Installing Stupiak's Print Service" \
    && printf '%s' "$SERVICE" | grep -Fq 'stupiaks-windows-print-service-v24'; then
    VERIFIED="yes"
    break
  fi
  sleep 5
done

if [[ "$VERIFIED" != "yes" ]]; then
  echo "ERROR: Deployment completed but 4.6.22 production markers or Windows installer files were not visible."
  printf '%s\n' "$ROOT_HEADERS"
  printf '%s\n' "$SETTINGS_HEADERS"
  exit 1
fi

printf '%s\n' "$ROOT_HEADERS" | grep -Ei '^(HTTP/|x-chefops-worker-revision:|permissions-policy:)'
printf '%s\n' "$SETTINGS_HEADERS" | grep -Ei '^(HTTP/|cache-control:|x-chefops-shell-revision:)'
printf '%s\n' "$SHELL" | grep 'const VERSION'
curl -fsS "$WORKER_URL/api/health" | python3 -m json.tool

printf '\n==================================================\n'
echo "SUCCESS: Windows Queue + Kitchen Direct IP 4.6.22 deployed"
echo "=================================================="
echo "URL: $WORKER_URL/labels/settings"
echo "Commit: $COMMIT"
echo "Windows: one-click PowerShell Print Service; no Node, GitHub or pairing token required"
echo "Windows Queue: reads installed printers such as Kitchen Label Printer"
echo "Direct IP: sends the same Stable RAW TSPL to printer IP:9100"
echo "Android APK: existing Stable TSPL v16 release remains unchanged"
echo "Ops KV: $OPS_KV_ID"
echo "Recruitment KV unchanged: $RECRUITMENT_KV_ID"
echo "R2 remains disabled."
echo "No Sheet, TaskTemplate, Data Package, Ops Control or Android release command was run."
