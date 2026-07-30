#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="miltonlim1993-rgb/stupiak-standalone-operations"
EXPECTED_BRANCH="feature/task-workflow-v3-apk"
EXPECTED_ACCOUNT_ID="bb2ac1970975a5018a17c878e61cb88f"
OPS_KV_ID="f62696e1a2f14b8a9e0b84a540c7e997"
RECRUITMENT_KV_ID="ccf52a9b0bb94a4a90889f30a0e623d5"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
LOGIN_CLIENT_ID="460544373229-06mv64nt3e78mtse5sc375cobv13i1ii.apps.googleusercontent.com"
ANDROID_WORKFLOW="android-apk.yml"
ANDROID_RELEASE_TAG="android-release-latest"
EXPECTED_WORKER_REVISION="cross-device-storage-scroll-v15-printer-v12-size-v14-v4.6.13"
EXPECTED_SW_VERSION="chefops-v4-6-13-cross-device-storage-scroll-v15-printer-v12-size-v14"

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

printf '\n==================================================\n'
echo "1. Pull and verify 4.6.13 cross-device storage and scroll release"
echo "=================================================="
git fetch origin "$EXPECTED_BRANCH"
git merge --ff-only "origin/$EXPECTED_BRANCH"
COMMIT="$(git rev-parse HEAD)"
echo "Commit: $COMMIT"

grep -q '"version": "4.6.13"' package.json
grep -q "$EXPECTED_WORKER_REVISION" worker/src/entry-v3.js
grep -q "$EXPECTED_SW_VERSION" web/public/sw.js
grep -q '4.6.13-cross-device-storage-scroll-v15-printer-v12-size-v14' web/src/main.jsx
grep -q 'installDeviceViewportV15' web/src/main.jsx
grep -q 'cross-device-v15.css' web/src/main.jsx
grep -q 'window.visualViewport' web/src/lib/device-viewport-v15.js
grep -q "data-chefops-ios='true'" web/src/cross-device-v15.css
grep -q 'chefops-data-pack-gate' web/src/components/DataPackGate.jsx
grep -q 'Repair local download storage & retry' web/src/components/DataPackGate.jsx
grep -q "OBJECT_CACHE = 'stupiaks-ops-data-package-v2-objects-v2'" web/src/lib/data-package-store-v2.js
grep -q "storage_backend: 'cache-v2'" web/src/lib/data-package-store-v2.js
grep -q 'indexeddb-arraybuffer-v2' web/src/lib/data-package-store-v2.js
grep -q 'repairLocalDataPackageStorage' web/src/lib/data-package-store-v2.js
grep -q 'PACKAGE_OBJECT_CACHE_PREFIX' web/public/sw.js
grep -q 'currentInstallPlatform' web/src/pages/InstallApp.jsx
grep -q 'Android APK files cannot be installed on iPhone' web/src/pages/InstallApp.jsx
grep -q 'installCreatedLabelSizeContractV14' web/src/main.jsx
grep -q '320x240dots' worker/test/label-size-contract-v14.test.mjs
grep -q 'PRINTER_TRANSPORT_VERSION' web/src/lib/printer-transport-v12.js
grep -q 'driver_bridge' web/src/lib/printer-transport-v12.js
grep -q 'stupiaks-print-bridge-v12' tools/print-bridge/server.mjs
grep -q '4.6.13-cross-device-storage-scroll-v15' .github/workflows/android-apk.yml

printf '\n==================================================\n'
echo "2. Verify Cloudflare and GitHub authentication"
echo "=================================================="
WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1)"
printf '%s\n' "$WHOAMI_OUTPUT"
printf '%s\n' "$WHOAMI_OUTPUT" | grep -q "$EXPECTED_ACCOUNT_ID"
gh auth status
gh repo view "$REPOSITORY" --json nameWithOwner --jq '.nameWithOwner' | grep -qx "$REPOSITORY"

printf '\n==================================================\n'
echo "3. Build and test Web, Worker, storage, scroll, printer and Android source"
echo "=================================================="
export CLOUDFLARE_ACCOUNT_ID="$EXPECTED_ACCOUNT_ID"
export CLOUDFLARE_APP_DATA_PACKS_ID="$OPS_KV_ID"
export VITE_API_BASE_URL="$WORKER_URL"
export VITE_GOOGLE_LOGIN_CLIENT_ID="$LOGIN_CLIENT_ID"
unset CLOUDFLARE_MEDIA_BUCKET_NAME || true

npm ci
npm run build
node --check tools/print-bridge/server.mjs
node --check scripts/configure-android-all-device-print-v12.mjs
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

printf '\n==================================================\n'
echo "4. Deploy Ops Worker and Web assets"
echo "=================================================="
npx wrangler deploy --config "$CONFIG"

printf '\n==================================================\n'
echo "5. Verify production 4.6.13 cross-device shell"
echo "=================================================="
VERIFIED=""
HEADERS=""
SHELL=""
for attempt in $(seq 1 18); do
  HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?acceptance=4.6.13-$COMMIT-$attempt" || true)"
  SHELL="$(curl -fsS --max-time 20 "$WORKER_URL/sw.js?acceptance=4.6.13-$COMMIT-$attempt" || true)"
  if printf '%s' "$HEADERS" | grep -Fqi "x-chefops-worker-revision: $EXPECTED_WORKER_REVISION" \
    && printf '%s' "$SHELL" | grep -Fq "$EXPECTED_SW_VERSION"; then
    VERIFIED="yes"
    break
  fi
  sleep 5
done

if [[ "$VERIFIED" != "yes" ]]; then
  echo "ERROR: Deployment completed but the 4.6.13 production markers were not visible."
  printf '%s\n' "$HEADERS"
  exit 1
fi

printf '%s\n' "$HEADERS" | grep -Ei '^(HTTP/|x-chefops-worker-revision:)'
printf '%s\n' "$SHELL" | grep 'const VERSION'

echo
echo "API health:"
curl -fsS "$WORKER_URL/api/health" | python3 -m json.tool

printf '\n==================================================\n'
echo "6. Trigger production-signed Android 4.6.13 build"
echo "=================================================="
PREVIOUS_RUN_ID="$(gh run list \
  --repo "$REPOSITORY" \
  --workflow "$ANDROID_WORKFLOW" \
  --branch "$EXPECTED_BRANCH" \
  --event workflow_dispatch \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId // empty')"

gh workflow run "$ANDROID_WORKFLOW" \
  --repo "$REPOSITORY" \
  --ref "$EXPECTED_BRANCH"

ANDROID_RUN_ID=""
for attempt in $(seq 1 30); do
  CANDIDATE_RUN_ID="$(gh run list \
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
gh run watch "$ANDROID_RUN_ID" --repo "$REPOSITORY" --exit-status

printf '\n==================================================\n'
echo "7. Verify signed Android 4.6.13 release assets"
echo "=================================================="
RELEASE_NAME="$(gh release view "$ANDROID_RELEASE_TAG" --repo "$REPOSITORY" --json name --jq '.name')"
echo "Release: $RELEASE_NAME"
printf '%s\n' "$RELEASE_NAME" | grep -q '4.6.13'

RELEASE_ASSETS="$(gh release view "$ANDROID_RELEASE_TAG" --repo "$REPOSITORY" --json assets --jq '.assets[].name')"
printf '%s\n' "$RELEASE_ASSETS"
printf '%s\n' "$RELEASE_ASSETS" | grep -qx 'stupiaks-ops-release.apk'
printf '%s\n' "$RELEASE_ASSETS" | grep -qx 'stupiaks-ops-all-device-print-v12.apk'
printf '%s\n' "$RELEASE_ASSETS" | grep -qx 'stupiaks-ops-direct-print-flow-v10.apk'
printf '%s\n' "$RELEASE_ASSETS" | grep -qx 'stupiaks-ops-release.aab'
printf '%s\n' "$RELEASE_ASSETS" | grep -qx 'SHA256SUMS.txt'

printf '\n==================================================\n'
echo "SUCCESS: Web/Worker and signed Android 4.6.13 completed"
echo "=================================================="
echo "URL: $WORKER_URL"
echo "Commit: $COMMIT"
echo "Worker revision: $EXPECTED_WORKER_REVISION"
echo "Shell version: $EXPECTED_SW_VERSION"
echo "iPhone Safari/PWA: dynamic visual viewport and one momentum scroll owner"
echo "Package storage: Cache Storage bodies + IndexedDB metadata + ArrayBuffer fallback"
echo "Package recovery: transaction reopen/retry + incomplete staging repair"
echo "Printer: Transport v12 + Label Size Contract v14 remain included"
echo "Ops KV binding: $OPS_KV_ID"
echo "Recruitment KV unchanged: $RECRUITMENT_KV_ID"
echo "R2 remains disabled; existing Google Drive media flow is unchanged."
echo "Android workflow run: $ANDROID_RUN_ID"
echo "Release tag: $ANDROID_RELEASE_TAG"
echo "No Sheet upgrade, task-template apply, Data Package publish, or Ops Control publication command was run."
