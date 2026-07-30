#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_BRANCH="feature/task-workflow-v3-apk"
EXPECTED_ACCOUNT_ID="bb2ac1970975a5018a17c878e61cb88f"
OPS_KV_ID="f62696e1a2f14b8a9e0b84a540c7e997"
RECRUITMENT_KV_ID="ccf52a9b0bb94a4a90889f30a0e623d5"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
LOGIN_CLIENT_ID="460544373229-06mv64nt3e78mtse5sc375cobv13i1ii.apps.googleusercontent.com"
EXPECTED_WORKER_REVISION="label-settings-staff-v17-stable-tspl-v16-v4.6.15"
EXPECTED_SHELL_REVISION="4.6.15-label-settings-staff-v17-stable-tspl-v16"
EXPECTED_SW_VERSION="chefops-v4-6-15-label-settings-staff-v17-stable-tspl-v16"

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
echo "1. Pull and verify Web Label Settings Staff v17"
echo "=================================================="
git fetch origin "$EXPECTED_BRANCH"
git merge --ff-only "origin/$EXPECTED_BRANCH"
COMMIT="$(git rev-parse HEAD)"
echo "Commit: $COMMIT"

grep -q '"version": "4.6.15"' package.json
grep -q "$EXPECTED_WORKER_REVISION" worker/src/entry-v3.js
grep -q "$EXPECTED_SHELL_REVISION" web/src/main.jsx
grep -q "$EXPECTED_SW_VERSION" web/public/sw.js
grep -q 'installLabelSettingsStaffV17' web/src/main.jsx
grep -q 'installWebShellFreshnessV17' web/src/main.jsx
grep -q "classList.add('max-w-6xl')" web/src/lib/label-settings-staff-v17.js
grep -q 'All staff access · Stable TSPL v16' web/src/lib/label-settings-staff-v17.js
grep -q 'Printer Settings' web/src/lib/label-settings-staff-v17.js
grep -q 'available to all staff' web/src/components/Layout.jsx
grep -q 'All staff can choose, test and tune' web/src/pages/More.jsx
grep -q "PrinterProfile: LEVEL.staff" worker/src/permissions.js
grep -q "entity === 'PrinterProfile'" worker/src/permissions.js
grep -q 'cache: '\''no-store'\''' web/src/lib/web-shell-freshness-v17.js
grep -q "Cache-Control', 'no-store" worker/src/entry-v3.js
grep -q 'STABLE_TSPL_LABEL_VERSION' web/src/lib/stable-tspl-label-v16.js
if grep -q 'BITMAP' web/src/lib/stable-tspl-label-v16.js; then
  echo "ERROR: Stable TSPL core changed to BITMAP. Refusing deployment."
  exit 1
fi

printf '\n==================================================\n'
echo "2. Verify Cloudflare authentication"
echo "=================================================="
WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1)"
printf '%s\n' "$WHOAMI_OUTPUT"
printf '%s\n' "$WHOAMI_OUTPUT" | grep -q "$EXPECTED_ACCOUNT_ID"

printf '\n==================================================\n'
echo "3. Build and test Web, Worker, staff permission and stable printing"
echo "=================================================="
export CLOUDFLARE_ACCOUNT_ID="$EXPECTED_ACCOUNT_ID"
export CLOUDFLARE_APP_DATA_PACKS_ID="$OPS_KV_ID"
export VITE_API_BASE_URL="$WORKER_URL"
export VITE_GOOGLE_LOGIN_CLIENT_ID="$LOGIN_CLIENT_ID"
unset CLOUDFLARE_MEDIA_BUCKET_NAME || true

npm ci
npm run build
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
echo "5. Verify production and no-cache label routes"
echo "=================================================="
VERIFIED=""
for attempt in $(seq 1 18); do
  ROOT_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?acceptance=4.6.15-$COMMIT-$attempt" || true)"
  SETTINGS_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/labels/settings?acceptance=4.6.15-$COMMIT-$attempt" || true)"
  SHELL="$(curl -fsS --max-time 20 "$WORKER_URL/sw.js?acceptance=4.6.15-$COMMIT-$attempt" || true)"
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
  echo "ERROR: Deployment completed but 4.6.15 production markers were not visible."
  printf '%s\n' "$ROOT_HEADERS"
  printf '%s\n' "$SETTINGS_HEADERS"
  exit 1
fi

printf '%s\n' "$ROOT_HEADERS" | grep -Ei '^(HTTP/|x-chefops-worker-revision:)'
printf '%s\n' "$SETTINGS_HEADERS" | grep -Ei '^(HTTP/|cache-control:|x-chefops-shell-revision:)'
printf '%s\n' "$SHELL" | grep 'const VERSION'
curl -fsS "$WORKER_URL/api/health" | python3 -m json.tool

printf '\n==================================================\n'
echo "SUCCESS: Web Label Settings Staff v17 deployed"
echo "=================================================="
echo "URL: $WORKER_URL/labels/settings"
echo "Commit: $COMMIT"
echo "Worker: $EXPECTED_WORKER_REVISION"
echo "Shell: $EXPECTED_SHELL_REVISION"
echo "Staff: read/create/update/delete PrinterProfile within assigned outlet"
echo "Web: latest responsive settings workspace restored"
echo "Web cache: label routes and navigation are no-store"
echo "Android APK: unchanged; Stable TSPL v16 printing remains untouched"
echo "Ops KV: $OPS_KV_ID"
echo "Recruitment KV unchanged: $RECRUITMENT_KV_ID"
echo "R2 remains disabled."
echo "No Sheet, TaskTemplate, Data Package, Ops Control or Android release command was run."
