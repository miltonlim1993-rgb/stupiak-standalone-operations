#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTLET="${1:-RR-KCH}"
PORT="${CHEFOPS_DATA_PACKAGE_RC_PORT:-8792}"
LOG_FILE="${TMPDIR:-/tmp}/stupiaks-data-package-rc-worker-${PORT}.log"
REPORT_DIR="$HOME/.stupiaks-ops-data-packages/reports"
FALLBACK_VARS="$HOME/Projects/chefops-standalone-v1/worker/.dev.vars"
WORKER_VARS="$ROOT/worker/.dev.vars"
WORKER_PID=""
TEMP_VARS=""
PREVIOUS_WORKER_VARS_KIND="missing"
PREVIOUS_WORKER_VARS_LINK=""
PREVIOUS_WORKER_VARS_COPY=""

terminate_tree() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0

  local children=""
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for child in $children; do
    terminate_tree "$child"
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  if [[ -n "$WORKER_PID" ]]; then
    terminate_tree "$WORKER_PID"
    wait "$WORKER_PID" 2>/dev/null || true
  fi

  rm -f "$WORKER_VARS"
  if [[ "$PREVIOUS_WORKER_VARS_KIND" == "symlink" ]]; then
    ln -s "$PREVIOUS_WORKER_VARS_LINK" "$WORKER_VARS"
  elif [[ "$PREVIOUS_WORKER_VARS_KIND" == "file" && -n "$PREVIOUS_WORKER_VARS_COPY" ]]; then
    cp "$PREVIOUS_WORKER_VARS_COPY" "$WORKER_VARS"
  fi

  [[ -n "$TEMP_VARS" ]] && rm -f "$TEMP_VARS"
  [[ -n "$PREVIOUS_WORKER_VARS_COPY" ]] && rm -f "$PREVIOUS_WORKER_VARS_COPY"
}
trap cleanup EXIT INT TERM

cd "$ROOT"

if [[ ! -f .dev.vars ]]; then
  if [[ -f "$FALLBACK_VARS" ]]; then
    cp "$FALLBACK_VARS" .dev.vars
    chmod 600 .dev.vars
    echo "Copied existing private Google Data configuration into this workspace."
  else
    echo "Missing $ROOT/.dev.vars"
    echo "No fallback configuration was found at $FALLBACK_VARS"
    exit 1
  fi
fi

for required_name in \
  GOOGLE_DATA_CLIENT_ID \
  GOOGLE_DATA_CLIENT_SECRET \
  GOOGLE_DATA_REFRESH_TOKEN \
  GOOGLE_PUBLISHED_PACKAGE_FOLDER_ID
do
  if ! grep -q "^${required_name}=" .dev.vars; then
    echo "$required_name is missing from $ROOT/.dev.vars"
    exit 1
  fi
done

SOURCE_REPORT="$(find "$REPORT_DIR" -type f -name "${OUTLET}-prepare-media-*.json" -print0 2>/dev/null | xargs -0 ls -1t 2>/dev/null | head -n 1 || true)"
if [[ -z "$SOURCE_REPORT" ]]; then
  echo "No Prepare Media report was found for $OUTLET in $REPORT_DIR"
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Nothing was started."
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
  exit 1
fi

mkdir -p worker "$REPORT_DIR"

if [[ -L "$WORKER_VARS" ]]; then
  PREVIOUS_WORKER_VARS_KIND="symlink"
  PREVIOUS_WORKER_VARS_LINK="$(readlink "$WORKER_VARS")"
elif [[ -f "$WORKER_VARS" ]]; then
  PREVIOUS_WORKER_VARS_KIND="file"
  PREVIOUS_WORKER_VARS_COPY="$(mktemp "${TMPDIR:-/tmp}/stupiaks-worker-vars-backup.XXXXXX")"
  cp "$WORKER_VARS" "$PREVIOUS_WORKER_VARS_COPY"
fi

TEMP_PACK_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
TEMP_SESSION_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))")"
TEMP_VARS="$(mktemp "${TMPDIR:-/tmp}/stupiaks-data-package-rc-vars.XXXXXX")"

grep -v -E '^(APP_PACK_WEBHOOK_SECRET|SESSION_SECRET)=' .dev.vars > "$TEMP_VARS"
printf '\nAPP_PACK_WEBHOOK_SECRET=%s\nSESSION_SECRET=%s\n' "$TEMP_PACK_SECRET" "$TEMP_SESSION_SECRET" >> "$TEMP_VARS"
chmod 600 "$TEMP_VARS"
rm -f "$WORKER_VARS"
ln -s "$TEMP_VARS" "$WORKER_VARS"

echo "Generated isolated one-time publisher and session secrets."
echo "Production Cloudflare secrets were not read or changed."
echo "Prepare Media source: $SOURCE_REPORT"

printf '\nStarting isolated Release Candidate Worker on port %s...\n' "$PORT"
(
  cd worker
  npx wrangler dev --config wrangler.dev.jsonc --port "$PORT"
) >"$LOG_FILE" 2>&1 &
WORKER_PID=$!

READY=0
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [[ "$READY" != "1" ]]; then
  echo "Local Release Candidate Worker did not become ready. Last log lines:"
  tail -n 100 "$LOG_FILE" || true
  exit 1
fi

TIMESTAMP="$(date -u +%Y-%m-%d_%H-%M-%S)"
REPORT="$REPORT_DIR/${OUTLET}-release-candidate-${TIMESTAMP}.json"

printf '\nRunning authenticated Release Candidate verification for %s...\n' "$OUTLET"
APP_PACK_WEBHOOK_SECRET="$TEMP_PACK_SECRET" \
SESSION_SECRET="$TEMP_SESSION_SECRET" \
node scripts/verify-data-package-release-candidate.mjs \
  --outlet "$OUTLET" \
  --worker-url "http://127.0.0.1:${PORT}" \
  --source-report "$SOURCE_REPORT" \
  --report "$REPORT"

printf '\nRelease Candidate verification finished.\n'
echo "Worker log: $LOG_FILE"
echo "Report: $REPORT"
if command -v open >/dev/null 2>&1; then
  open -R "$REPORT" || true
fi
