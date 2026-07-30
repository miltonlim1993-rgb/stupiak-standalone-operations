#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="miltonlim1993-rgb/stupiak-standalone-operations"
EXPECTED_BRANCH="feature/task-workflow-v3-apk"
ANDROID_WORKFLOW="android-apk.yml"
ANDROID_RELEASE_TAG="android-release-latest"

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
echo "1. Pull and verify Android 4.6.21 shared date fit"
echo "=================================================="
git fetch origin "$EXPECTED_BRANCH"
git merge --ff-only "origin/$EXPECTED_BRANCH"
COMMIT="$(git rev-parse HEAD)"
echo "Commit: $COMMIT"

grep -q '"version": "4.6.21"' package.json
grep -q "4.6.21-windows-queue-direct-ip-v23" web/src/main.jsx
grep -q "androidStablePrint: 'v16-date-fit-v22'" web/src/main.jsx
grep -q "STABLE_TSPL_LABEL_VERSION = '4.6.20-stable-tspl-core-v16-date-fit-v22'" web/src/lib/stable-tspl-label-v16.js
grep -q 'function fittedDateCommand' web/src/lib/stable-tspl-label-v16.js
grep -q "date_box_padding_dots: 2" web/src/lib/stable-tspl-label-v16.js
grep -q "date_font: '1x2'" web/src/lib/stable-tspl-label-v16.js
grep -q 'rawCommandBase64: asciiBase64(stable.command)' web/src/lib/stable-label-print-v16.js
grep -q '4.6.21-windows-queue-direct-ip-v23-date-fit-v22' .github/workflows/android-apk.yml

printf '\n==================================================\n'
echo "2. Validate GitHub login and complete build"
echo "=================================================="
gh auth status
gh repo view "$REPOSITORY" --json nameWithOwner --jq '.nameWithOwner' | grep -qx "$REPOSITORY"
npm ci
npm run build

printf '\n==================================================\n'
echo "3. Trigger production-signed Android 4.6.21 build"
echo "=================================================="
PREVIOUS_RUN_ID="$(gh run list \
  --repo "$REPOSITORY" \
  --workflow "$ANDROID_WORKFLOW" \
  --branch "$EXPECTED_BRANCH" \
  --event workflow_dispatch \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId // empty')"

gh workflow run "$ANDROID_WORKFLOW" --repo "$REPOSITORY" --ref "$EXPECTED_BRANCH"

ANDROID_RUN_ID=""
for attempt in $(seq 1 45); do
  CANDIDATE="$(gh run list \
    --repo "$REPOSITORY" \
    --workflow "$ANDROID_WORKFLOW" \
    --branch "$EXPECTED_BRANCH" \
    --event workflow_dispatch \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId // empty')"
  if [[ -n "$CANDIDATE" && "$CANDIDATE" != "$PREVIOUS_RUN_ID" ]]; then
    ANDROID_RUN_ID="$CANDIDATE"
    break
  fi
  sleep 2
done

if [[ -z "$ANDROID_RUN_ID" ]]; then
  echo "ERROR: The Android workflow was dispatched but its new run ID could not be resolved."
  exit 1
fi

echo "Android workflow run: $ANDROID_RUN_ID"
gh run watch "$ANDROID_RUN_ID" --repo "$REPOSITORY" --exit-status

printf '\n==================================================\n'
echo "4. Verify signed Android 4.6.21 release assets"
echo "=================================================="
RELEASE_NAME="$(gh release view "$ANDROID_RELEASE_TAG" --repo "$REPOSITORY" --json name --jq '.name')"
echo "Release: $RELEASE_NAME"
printf '%s\n' "$RELEASE_NAME" | grep -q '4.6.21'

ASSETS="$(gh release view "$ANDROID_RELEASE_TAG" --repo "$REPOSITORY" --json assets --jq '.assets[].name')"
printf '%s\n' "$ASSETS"
printf '%s\n' "$ASSETS" | grep -qx 'stupiaks-ops-release.apk'
printf '%s\n' "$ASSETS" | grep -qx 'stupiaks-ops-stable-tspl-v16.apk'
printf '%s\n' "$ASSETS" | grep -qx 'stupiaks-ops-all-device-print-v12.apk'
printf '%s\n' "$ASSETS" | grep -qx 'stupiaks-ops-direct-print-flow-v10.apk'
printf '%s\n' "$ASSETS" | grep -qx 'stupiaks-ops-release.aab'
printf '%s\n' "$ASSETS" | grep -qx 'SHA256SUMS.txt'

printf '\n==================================================\n'
echo "SUCCESS: Signed Android 4.6.21 date-fit release completed"
echo "=================================================="
echo "Source commit: $COMMIT"
echo "Android workflow run: $ANDROID_RUN_ID"
echo "Stable APK: stupiaks-ops-stable-tspl-v16.apk"
echo "Made/Use By dates: shared narrow 1x2 font, centered, 2-dot safe edge"
echo "Unchanged: Native RAW TSPL, 40x30 mm, 203 dpi, Gap 2 mm, offsets, Wi-Fi/LAN/Bluetooth"
echo "No Cloudflare, Sheet, TaskTemplate, Data Package, Ops Control, Recruitment KV or R2 command was run."
