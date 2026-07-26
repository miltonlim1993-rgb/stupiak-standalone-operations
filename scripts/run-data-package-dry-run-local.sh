#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTLET="${1:-RR-KCH}"
PORT="${CHEFOPS_DATA_PACKAGE_TEST_PORT:-8791}"
LOG_FILE="${TMPDIR:-/tmp}/stupiaks-data-package-worker-${PORT}.log"
REPORT_DIR="$HOME/.stupiaks-ops-data-packages/reports"
WORKER_PID=""

cleanup() {
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

cd "$ROOT"

if [[ ! -f .dev.vars ]]; then
  echo "Missing $ROOT/.dev.vars"
  echo "Copy the existing private .dev.vars into this workspace first."
  exit 1
fi

if ! grep -q '^GOOGLE_PUBLISHED_PACKAGE_FOLDER_ID=' .dev.vars; then
  echo "GOOGLE_PUBLISHED_PACKAGE_FOLDER_ID is missing from .dev.vars"
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Nothing was started."
  exit 1
fi

mkdir -p worker
ln -sfn ../.dev.vars worker/.dev.vars
mkdir -p "$REPORT_DIR"

printf '\nBuilding web assets...\n'
npm run build -w web

printf '\nStarting isolated local Worker on port %s...\n' "$PORT"
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
  echo "Local Worker did not become ready. Last log lines:"
  tail -n 80 "$LOG_FILE" || true
  exit 1
fi

printf '\nRunning read-only Data Package v2 Dry Run for %s...\n' "$OUTLET"
npm run package:publish-drive -- \
  --outlet "$OUTLET" \
  --worker-url "http://127.0.0.1:${PORT}" \
  --dry-run

REPORT="$(find "$REPORT_DIR" -type f -name "${OUTLET}-dry-run-*.json" -print0 2>/dev/null | xargs -0 ls -1t 2>/dev/null | head -n 1 || true)"

printf '\nDry Run finished.\n'
echo "Worker log: $LOG_FILE"
if [[ -n "$REPORT" ]]; then
  echo "Report: $REPORT"
  if command -v open >/dev/null 2>&1; then
    open -R "$REPORT" || true
  fi
else
  echo "Report file was not found in $REPORT_DIR"
  exit 1
fi
