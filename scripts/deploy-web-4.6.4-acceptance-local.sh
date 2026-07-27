#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_BRANCH="feature/task-workflow-v3-apk"
EXPECTED_ACCOUNT_ID="bb2ac1970975a5018a17c878e61cb88f"
OPS_KV_ID="f62696e1a2f14b8a9e0b84a540c7e997"
RECRUITMENT_KV_ID="ccf52a9b0bb94a4a90889f30a0e623d5"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
LOGIN_CLIENT_ID="460544373229-06mv64nt3e78mtse5sc375cobv13i1ii.apps.googleusercontent.com"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "ERROR: Run this inside the stupiak-standalone-operations repository."
  exit 1
fi
cd "$ROOT"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: Current branch is '$CURRENT_BRANCH'. Expected '$EXPECTED_BRANCH'."
  echo "Run: git fetch origin && git switch '$EXPECTED_BRANCH' && git pull --ff-only origin '$EXPECTED_BRANCH'"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree is not clean. Commit or stash unrelated changes first."
  git status --short
  exit 1
fi

echo "=================================================="
echo "1. Verify exact branch and latest remote commit"
echo "=================================================="
git fetch origin "$EXPECTED_BRANCH"
git merge --ff-only "origin/$EXPECTED_BRANCH"
COMMIT="$(git rev-parse HEAD)"
echo "Commit: $COMMIT"

echo
echo "=================================================="
echo "2. Verify local Wrangler OAuth login"
echo "=================================================="
WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1)"
printf '%s\n' "$WHOAMI_OUTPUT"
printf '%s\n' "$WHOAMI_OUTPUT" | grep -q "$EXPECTED_ACCOUNT_ID"

echo
echo "=================================================="
echo "3. Build and test Web 4.6.4"
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
  echo "ERROR: Recruitment KV appeared in the Ops production config. Refusing deployment."
  exit 1
fi
if grep -q 'MEDIA_BUCKET' "$CONFIG"; then
  echo "ERROR: R2 binding is unexpectedly enabled. Refusing deployment."
  exit 1
fi

echo
echo "=================================================="
echo "4. Deploy Worker plus Web assets only"
echo "=================================================="
npx wrangler deploy --config "$CONFIG"

echo
echo "=================================================="
echo "5. Verify production 4.6.4"
echo "=================================================="
VERIFIED=""
for attempt in $(seq 1 18); do
  HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?acceptance=4.6.4-$COMMIT-$attempt" || true)"
  SHELL="$(curl -fsS --max-time 20 "$WORKER_URL/sw.js?acceptance=4.6.4-$COMMIT-$attempt" || true)"
  if printf '%s' "$HEADERS" | grep -Eqi '^x-chefops-worker-revision:[[:space:]]*printer-profiles-v4\.6\.4' \
    && printf '%s' "$SHELL" | grep -q 'chefops-v4-6-4-printer-profiles-direct-print-flow-shell-v10'; then
    VERIFIED="yes"
    break
  fi
  sleep 5
done

if [[ "$VERIFIED" != "yes" ]]; then
  echo "ERROR: Deployment completed but the 4.6.4 revision markers were not visible."
  printf '%s\n' "$HEADERS"
  exit 1
fi

printf '%s\n' "$HEADERS" | grep -Ei '^(HTTP/|x-chefops-worker-revision:)'
printf '%s\n' "$SHELL" | grep 'const VERSION'

echo
echo "API health:"
curl -fsS "$WORKER_URL/api/health" | python3 -m json.tool

echo
echo "=================================================="
echo "SUCCESS: Web 4.6.4 acceptance deployment completed"
echo "=================================================="
echo "URL: $WORKER_URL"
echo "Commit: $COMMIT"
echo "Worker revision: printer-profiles-v4.6.4"
echo "Ops KV binding: $OPS_KV_ID"
echo "Recruitment KV unchanged: $RECRUITMENT_KV_ID"
echo "R2 remains disabled; existing Google Drive media flow is unchanged."
echo "No Sheet upgrade, task template apply, Data Package publish, or Ops Control publication command was run."
