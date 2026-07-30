#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_BRANCH="feature/task-workflow-v3-apk"
EXPECTED_ACCOUNT_ID="bb2ac1970975a5018a17c878e61cb88f"
OPS_KV_ID="f62696e1a2f14b8a9e0b84a540c7e997"
RECRUITMENT_KV_ID="ccf52a9b0bb94a4a90889f30a0e623d5"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
LOGIN_CLIENT_ID="460544373229-06mv64nt3e78mtse5sc375cobv13i1ii.apps.googleusercontent.com"
EXPECTED_WORKER_REVISION="label-source-fifo-v26-v4.6.25"
EXPECTED_SHELL_REVISION="4.6.25-label-source-fifo-v26"
EXPECTED_SW_VERSION="chefops-v4-6-25-label-source-fifo-v26"

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
echo "1. Pull and verify 4.6.25 label source FIFO policy"
echo "=================================================="
git fetch origin "$EXPECTED_BRANCH"
git merge --ff-only "origin/$EXPECTED_BRANCH"
COMMIT="$(git rev-parse HEAD)"
echo "Commit: $COMMIT"

grep -q '"version": "4.6.25"' package.json
grep -q "$EXPECTED_WORKER_REVISION" worker/src/entry-v3.js
grep -q "$EXPECTED_SHELL_REVISION" web/src/main.jsx
grep -q "$EXPECTED_SW_VERSION" web/public/sw.js
grep -q "installLabelFifoPolicyV26" web/src/main.jsx
grep -q "source_capacity: printQuantity" worker/src/label-fifo-v26.js
grep -q "source_remaining_qty: printQuantity" worker/src/label-fifo-v26.js
grep -q "fifo_source_order_violation" worker/src/label-fifo-v26.js
grep -q "fifo_reprint_locked" worker/src/label-fifo-v26.js
grep -q "First-hand and second-hand labels cannot print extra copies" worker/src/label-fifo-v26.js
grep -q "if (isNativeAndroid()) installStableLabelPrintV16()" web/src/main.jsx
grep -q "else installStableLabelPrintV20()" web/src/main.jsx
if grep -q 'BITMAP\|html-raster' web/src/lib/stable-label-print-v20.js; then
  echo "ERROR: Stable Web print contains Raster/BITMAP. Refusing deployment."
  exit 1
fi

printf '\n==================================================\n'
echo "2. Verify Cloudflare authentication"
echo "=================================================="
WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1)"
printf '%s\n' "$WHOAMI_OUTPUT"
printf '%s\n' "$WHOAMI_OUTPUT" | grep -q "$EXPECTED_ACCOUNT_ID"

printf '\n==================================================\n'
echo "3. Build and test Web and Worker"
echo "=================================================="
export CLOUDFLARE_ACCOUNT_ID="$EXPECTED_ACCOUNT_ID"
export CLOUDFLARE_APP_DATA_PACKS_ID="$OPS_KV_ID"
export VITE_API_BASE_URL="$WORKER_URL"
export VITE_GOOGLE_LOGIN_CLIENT_ID="$LOGIN_CLIENT_ID"
unset CLOUDFLARE_MEDIA_BUCKET_NAME || true

npm ci
npm run build
bash -n scripts/deploy-web-4.6.25-label-source-fifo-local.sh
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
echo "5. Verify production 4.6.25"
echo "=================================================="
VERIFIED=""
for attempt in $(seq 1 18); do
  ROOT_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?acceptance=4.6.25-$COMMIT-$attempt" || true)"
  LABEL_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/labels?acceptance=4.6.25-$COMMIT-$attempt" || true)"
  SHELL="$(curl -fsS --max-time 20 "$WORKER_URL/sw.js?acceptance=4.6.25-$COMMIT-$attempt" || true)"
  if printf '%s' "$ROOT_HEADERS" | grep -Fqi "x-chefops-worker-revision: $EXPECTED_WORKER_REVISION" \
    && printf '%s' "$LABEL_HEADERS" | grep -Fqi "x-chefops-shell-revision: $EXPECTED_SHELL_REVISION" \
    && printf '%s' "$LABEL_HEADERS" | grep -Fqi 'cache-control: no-store' \
    && printf '%s' "$SHELL" | grep -Fq "$EXPECTED_SW_VERSION"; then
    VERIFIED="yes"
    break
  fi
  sleep 5
done

if [[ "$VERIFIED" != "yes" ]]; then
  echo "ERROR: Deployment completed but 4.6.25 production markers were not visible."
  printf '%s\n' "$ROOT_HEADERS"
  printf '%s\n' "$LABEL_HEADERS"
  exit 1
fi

printf '%s\n' "$ROOT_HEADERS" | grep -Ei '^(HTTP/|x-chefops-worker-revision:|permissions-policy:)'
printf '%s\n' "$LABEL_HEADERS" | grep -Ei '^(HTTP/|cache-control:|x-chefops-shell-revision:)'
printf '%s\n' "$SHELL" | grep 'const VERSION'
curl -fsS "$WORKER_URL/api/health" | python3 -m json.tool

printf '\n==================================================\n'
echo "SUCCESS: Label source FIFO policy 4.6.25 deployed"
echo "=================================================="
echo "URL: $WORKER_URL/labels"
echo "Commit: $COMMIT"
echo "First hand: Prepare / Freeze / Received; no source; initial print only"
echo "Second hand: Open; first-hand source required; initial print only"
echo "Third hand: Refill / Cooked; second-hand Open source required"
echo "FIFO: oldest eligible source is enforced by the Worker"
echo "Expiry: second and third hand cannot exceed the source expiry"
echo "Android printing: existing Stable TSPL v16 route remains unchanged"
echo "Ops KV: $OPS_KV_ID"
echo "Recruitment KV unchanged: $RECRUITMENT_KV_ID"
echo "R2 remains disabled."
echo "No Sheet, TaskTemplate, Data Package, Ops Control or Android release command was run."
