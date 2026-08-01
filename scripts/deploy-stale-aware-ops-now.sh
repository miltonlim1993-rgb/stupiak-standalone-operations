#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
HEALTH_URL="$PRODUCTION_ORIGIN/api/health"
EXPECTED_POLICY="stale-aware-v1"
EXPECTED_MAX_AGE="120000"

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

echo "==> Deploying Worker stupiaks-ops"
npx wrangler deploy --config wrangler.jsonc

echo "==> Verifying production health marker"
response=''
for attempt in $(seq 1 30); do
  response="$(curl -fsS --max-time 20 "$HEALTH_URL" || true)"
  if [[ "$response" == *"$EXPECTED_POLICY"* && "$response" == *"$EXPECTED_MAX_AGE"* ]]; then
    printf '%s\n' "$response"
    echo "DEPLOYMENT_VERIFIED=true"
    echo "FORMAL_TASK_TESTING_READY=true"
    exit 0
  fi
  sleep 5
done

echo "Deployment command completed, but production verification failed." >&2
echo "Last response: $response" >&2
exit 1
