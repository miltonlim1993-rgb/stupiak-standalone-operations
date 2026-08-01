#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
HEALTH_URL="$PRODUCTION_ORIGIN/api/health"
EXPECTED_POLICY="stale-aware-v1"
EXPECTED_MAX_AGE="120000"
EXPECTED_WORKER_REVISION="outlet-realtime-hub-v1"
HEADERS_FILE="$(mktemp)"
trap 'rm -f "$HEADERS_FILE"' EXIT

echo "==> Canonical OPS production: $PRODUCTION_ORIGIN"
echo "==> Checking local Wrangler authentication"
npx wrangler whoami

echo "==> Updating main without overwriting local work"
git fetch origin main
git pull --ff-only origin main

echo "==> Installing exact dependencies"
npm ci

echo "==> Building web and Worker"
npm run build

echo "==> Deploying Worker stupiaks-ops with outlet realtime Durable Object"
npx wrangler deploy --config wrangler.jsonc

echo "==> Verifying production health and realtime revision"
response=''
for attempt in $(seq 1 30); do
  : > "$HEADERS_FILE"
  response="$(curl -fsS -D "$HEADERS_FILE" --max-time 20 "$HEALTH_URL" || true)"
  if [[ "$response" == *"$EXPECTED_POLICY"* \
    && "$response" == *"$EXPECTED_MAX_AGE"* \
    && $(grep -ci "^x-chefops-worker-revision: ${EXPECTED_WORKER_REVISION}" "$HEADERS_FILE" || true) -gt 0 ]]; then
    printf '%s\n' "$response"
    grep -i '^x-chefops-worker-revision:' "$HEADERS_FILE" || true
    echo "DEPLOYMENT_VERIFIED=true"
    echo "FORMAL_TASK_TESTING_READY=true"
    echo "REALTIME_MULTI_DEVICE_TESTING_READY=true"
    exit 0
  fi
  sleep 5
done

echo "Deployment command completed, but production verification failed." >&2
echo "Expected Worker revision: $EXPECTED_WORKER_REVISION" >&2
echo "Last headers:" >&2
cat "$HEADERS_FILE" >&2 || true
echo "Last response: $response" >&2
exit 1
