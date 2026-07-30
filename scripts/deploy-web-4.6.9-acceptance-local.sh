#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="miltonlim1993-rgb/stupiak-standalone-operations"
EXPECTED_GITHUB_LOGIN="miltonlim1993-rgb"
EXPECTED_BRANCH="feature/task-workflow-v3-apk"
EXPECTED_ACCOUNT_ID="bb2ac1970975a5018a17c878e61cb88f"
OPS_KV_ID="f62696e1a2f14b8a9e0b84a540c7e997"
RECRUITMENT_KV_ID="ccf52a9b0bb94a4a90889f30a0e623d5"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
LOGIN_CLIENT_ID="460544373229-06mv64nt3e78mtse5sc375cobv13i1ii.apps.googleusercontent.com"
EXPECTED_WORKER_REVISION="native-tspl-food-label-v4.6.9"
EXPECTED_SHELL_VERSION="chefops-v4-6-9-native-tspl-food-label-shell-v10"
ANDROID_WORKFLOW="android-apk.yml"
ANDROID_RELEASE_TAG="android-release-latest"
export GH_HTTP_TIMEOUT="${GH_HTTP_TIMEOUT:-60}"

gh_retry() {
  local attempt=1
  local maximum=6
  local output=""
  local status=0

  while true; do
    if output="$("$@" 2>&1)"; then
      printf '%s' "$output"
      return 0
    fi
    status=$?
    if (( attempt >= maximum )); then
      printf '%s\n' "$output" >&2
      return "$status"
    fi
    printf 'GitHub request failed (attempt %d/%d). Retrying in %d seconds...\n' \
      "$attempt" "$maximum" "$((attempt * 3))" >&2
    sleep "$((attempt * 3))"
    attempt=$((attempt + 1))
  done
}

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
echo "2. Verify Cloudflare and GitHub authentication"
echo "=================================================="
WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1)"
printf '%s\n' "$WHOAMI_OUTPUT"
printf '%s\n' "$WHOAMI_OUTPUT" | grep -q "$EXPECTED_ACCOUNT_ID"
LOGIN="$(gh_retry gh api user --jq '.login')"
[[ "$LOGIN" == "$EXPECTED_GITHUB_LOGIN" ]]
echo "GitHub account: $LOGIN"
REPO_NAME="$(gh_retry gh repo view "$REPOSITORY" --json nameWithOwner --jq '.nameWithOwner')"
[[ "$REPO_NAME" == "$REPOSITORY" ]]
echo "Repository access: $REPO_NAME"

echo
echo "=================================================="
echo "3. Build and test Web 4.6.9"
echo "=================================================="
export CLOUDFLARE_ACCOUNT_ID="$EXPECTED_ACCOUNT_ID"
export CLOUDFLARE_APP_DATA_PACKS_ID="$OPS_KV_ID"
export VITE_API_BASE_URL="$WORKER_URL"
export VITE_GOOGLE_LOGIN_CLIENT_ID="$LOGIN_CLIENT_ID"
unset CLOUDFLARE_MEDIA_BUCKET_NAME || true

npm ci
npm run build
npm run cf:render

grep -q "$EXPECTED_SHELL_VERSION" web/public/sw.js
grep -q "4.6.9-native-tspl-food-label-shell-v10" web/src/main.jsx
grep -q "buildTsplFoodLabelCommand" web/src/lib/native-label-print.js
grep -q "tspl-native-food-label" web/src/lib/tspl-food-label-compat.js
grep -q "REFERENCE 0,0" web/src/lib/tspl-food-label-compat.js
grep -q "BARCODE" web/src/lib/tspl-food-label-compat.js
! grep -q "BITMAP" web/src/lib/tspl-food-label-compat.js
grep -q "rawCommandBase64" scripts/configure-android-tspl-food-label-compat.mjs
grep -q "chefops-native-tspl-food-label" scripts/configure-android-tspl-food-label-compat.mjs
grep -q "@/label-printer-settings-v2.css" web/src/main.jsx
grep -q "@/label-printer-settings-force-mobile.css" web/src/main.jsx

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
echo "5. Verify production 4.6.9"
echo "=================================================="
VERIFIED=""
for attempt in $(seq 1 18); do
  HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?acceptance=4.6.9-$COMMIT-$attempt" || true)"
  SHELL="$(curl -fsS --max-time 20 "$WORKER_URL/sw.js?acceptance=4.6.9-$COMMIT-$attempt" || true)"
  if printf '%s' "$HEADERS" | grep -Eqi "^x-chefops-worker-revision:[[:space:]]*$EXPECTED_WORKER_REVISION" \
    && printf '%s' "$SHELL" | grep -q "$EXPECTED_SHELL_VERSION"; then
    VERIFIED="yes"
    break
  fi
  sleep 5
done

if [[ "$VERIFIED" != "yes" ]]; then
  echo "ERROR: Deployment completed but the 4.6.9 revision markers were not visible."
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
echo "6. Trigger production-signed Android 4.6.9 build"
echo "=================================================="
PREVIOUS_RUN_ID="$(gh_retry gh run list \
  --repo "$REPOSITORY" \
  --workflow "$ANDROID_WORKFLOW" \
  --branch "$EXPECTED_BRANCH" \
  --event workflow_dispatch \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId // empty')"

gh_retry gh workflow run "$ANDROID_WORKFLOW" \
  --repo "$REPOSITORY" \
  --ref "$EXPECTED_BRANCH"

ANDROID_RUN_ID=""
for attempt in $(seq 1 30); do
  CANDIDATE_RUN_ID="$(gh_retry gh run list \
    --repo "$REPOSITORY" \
    --workflow "$ANDROID_WORKFLOW" \
    --branch "$EXPECTED_BRANCH" \
    --event workflow_dispatch \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId // empty')"
  if [[ -n "$CANDIDATE_RUN_ID" && "$CANDIDATE_RUN_ID" != "$PREVIOUS_RUN_ID" ]]; then
    ANDROID_RUN_ID="$CANDIDATE_RUN_ID"
    break
  fi
  sleep 2
done

if [[ -z "$ANDROID_RUN_ID" ]]; then
  echo "ERROR: Android workflow was dispatched but its new run ID could not be resolved."
  exit 1
fi

echo "Android workflow run: $ANDROID_RUN_ID"
gh_retry gh run watch "$ANDROID_RUN_ID" --repo "$REPOSITORY" --exit-status

echo
echo "=================================================="
echo "7. Verify signed Android release assets"
echo "=================================================="
RELEASE_ASSETS="$(gh_retry gh release view "$ANDROID_RELEASE_TAG" \
  --repo "$REPOSITORY" \
  --json assets \
  --jq '.assets[].name')"
printf '%s\n' "$RELEASE_ASSETS"
printf '%s\n' "$RELEASE_ASSETS" | grep -qx 'stupiaks-ops-release.apk'
printf '%s\n' "$RELEASE_ASSETS" | grep -qx 'stupiaks-ops-direct-print-flow-v10.apk'
printf '%s\n' "$RELEASE_ASSETS" | grep -qx 'stupiaks-ops-release.aab'
printf '%s\n' "$RELEASE_ASSETS" | grep -qx 'SHA256SUMS.txt'

echo
echo "=================================================="
echo "SUCCESS: Web 4.6.9 and signed Android release completed"
echo "=================================================="
echo "URL: $WORKER_URL"
echo "Commit: $COMMIT"
echo "Worker revision: $EXPECTED_WORKER_REVISION"
echo "Ops KV binding: $OPS_KV_ID"
echo "Recruitment KV unchanged: $RECRUITMENT_KV_ID"
echo "R2 remains disabled; existing Google Drive media flow is unchanged."
echo "Android workflow run: $ANDROID_RUN_ID"
echo "Release tag: $ANDROID_RELEASE_TAG"
echo "No Sheet upgrade, task template apply, Data Package publish, or Ops Control publication command was run."
