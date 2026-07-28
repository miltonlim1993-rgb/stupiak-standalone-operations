#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="miltonlim1993-rgb/stupiak-standalone-operations"
EXPECTED_BRANCH="feature/task-workflow-v3-apk"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
EXPECTED_WORKER_REVISION="direct-print-media-size-fix-v4.6.6"
EXPECTED_SHELL_VERSION="chefops-v4-6-6-direct-print-media-size-fix-shell-v10"
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
  echo "ERROR: Working tree is not clean."
  git status --short
  exit 1
fi

echo "=================================================="
echo "1. Update the release branch"
echo "=================================================="
git fetch origin "$EXPECTED_BRANCH"
git merge --ff-only "origin/$EXPECTED_BRANCH"
COMMIT="$(git rev-parse HEAD)"
echo "Commit: $COMMIT"

echo
echo "=================================================="
echo "2. Confirm production Web/Worker 4.6.6 is already live"
echo "=================================================="
HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?android-resume=4.6.6-$COMMIT")"
SHELL="$(curl -fsS --max-time 20 "$WORKER_URL/sw.js?android-resume=4.6.6-$COMMIT")"
printf '%s\n' "$HEADERS" | grep -Eqi "^x-chefops-worker-revision:[[:space:]]*$EXPECTED_WORKER_REVISION"
printf '%s\n' "$SHELL" | grep -q "$EXPECTED_SHELL_VERSION"
printf '%s\n' "$HEADERS" | grep -Ei '^(HTTP/|x-chefops-worker-revision:)'
printf '%s\n' "$SHELL" | grep 'const VERSION'
curl -fsS "$WORKER_URL/api/health" | python3 -m json.tool

echo
echo "=================================================="
echo "3. Verify GitHub authentication"
echo "=================================================="
gh auth status
gh repo view "$REPOSITORY" --json nameWithOwner --jq '.nameWithOwner' | grep -qx "$REPOSITORY"

echo
echo "=================================================="
echo "4. Trigger the corrected signed Android 4.6.6 build"
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
  echo "ERROR: The Android workflow was dispatched, but the new run ID could not be resolved."
  exit 1
fi

echo "Android workflow run: $ANDROID_RUN_ID"
gh run watch "$ANDROID_RUN_ID" --repo "$REPOSITORY" --exit-status

echo
echo "=================================================="
echo "5. Verify signed release files"
echo "=================================================="
RELEASE_ASSETS="$(gh release view "$ANDROID_RELEASE_TAG" \
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
echo "SUCCESS: Signed Android 4.6.6 release completed"
echo "=================================================="
echo "Commit: $COMMIT"
echo "Android workflow run: $ANDROID_RUN_ID"
echo "Release tag: $ANDROID_RELEASE_TAG"
echo "Production Web/Worker was only verified; it was not redeployed."
echo "No Sheet, KV, Data Package, Ops Control, Recruitment KV or R2 mutation command was run."
