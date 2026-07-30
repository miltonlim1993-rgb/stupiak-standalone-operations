#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_BRANCH="feature/task-workflow-v3-apk"
EXPECTED_ACCOUNT_ID="bb2ac1970975a5018a17c878e61cb88f"
OPS_KV_ID="f62696e1a2f14b8a9e0b84a540c7e997"
RECRUITMENT_KV_ID="ccf52a9b0bb94a4a90889f30a0e623d5"
EXPECTED_WORKER_REVISION="no-delete-task-training-package-v27-v4.6.26"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "ERROR: Run this inside the stupiak-standalone-operations repository."
  exit 1
fi
cd "$ROOT"

if [[ "$(git branch --show-current)" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: Expected branch $EXPECTED_BRANCH."
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree is not clean."
  git status --short
  exit 1
fi

grep -q '"version": "4.6.26"' package.json
grep -q "HOLD_UNTIL_EXPLICIT_APPROVAL" config/android-production-release-baseline.json

HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?publisher-secret=$(date +%s)")"
printf '%s\n' "$HEADERS" | grep -Fqi "x-chefops-worker-revision: $EXPECTED_WORKER_REVISION"

WHOAMI="$(npx wrangler whoami 2>&1)"
printf '%s\n' "$WHOAMI"
printf '%s\n' "$WHOAMI" | grep -Fq "$EXPECTED_ACCOUNT_ID"

export CLOUDFLARE_ACCOUNT_ID="$EXPECTED_ACCOUNT_ID"
export CLOUDFLARE_APP_DATA_PACKS_ID="$OPS_KV_ID"
unset CLOUDFLARE_MEDIA_BUCKET_NAME || true
npm run cf:render

CONFIG="worker/wrangler.production.jsonc"
grep -q '"name": "stupiaks-ops"' "$CONFIG"
grep -q "$OPS_KV_ID" "$CONFIG"
if grep -q "$RECRUITMENT_KV_ID" "$CONFIG"; then
  echo "ERROR: Recruitment KV appeared in Ops config."
  exit 1
fi
if grep -q 'MEDIA_BUCKET' "$CONFIG"; then
  echo "ERROR: R2 binding appeared in Ops config."
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl is required to generate the publisher secret."
  exit 1
fi

PUBLISH_SECRET="$(openssl rand -hex 32)"
TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV"; unset PUBLISH_SECRET' EXIT

if [[ -f .dev.vars ]]; then
  awk '!/^APP_PACK_WEBHOOK_SECRET=/' .dev.vars > "$TMP_ENV"
fi
printf 'APP_PACK_WEBHOOK_SECRET=%s\n' "$PUBLISH_SECRET" >> "$TMP_ENV"
chmod 600 "$TMP_ENV"
mv "$TMP_ENV" .dev.vars
chmod 600 .dev.vars

printf '%s' "$PUBLISH_SECRET" \
  | npx wrangler secret put DATA_PACKAGE_PUBLISH_SECRET --config "$CONFIG"
unset PUBLISH_SECRET

SECRET_LIST="$(npx wrangler secret list --config "$CONFIG")"
printf '%s\n' "$SECRET_LIST" | grep -Fq 'DATA_PACKAGE_PUBLISH_SECRET'

echo
echo "Dedicated Data Package publisher secret is configured."
echo "Existing APP_PACK_WEBHOOK_SECRET in Cloudflare was not read, replaced or rotated."
echo

bash scripts/rebuild-clean-data-package-4.6.26-local.sh
