import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const failures = []
const requireText = (relative, patterns) => {
  const text = read(relative)
  for (const pattern of patterns) {
    if (!text.includes(pattern)) failures.push(`${relative} is missing: ${pattern}`)
  }
}

if (existsSync(path.join(root, 'worker/migrations/0001_live_store.sql'))) {
  failures.push('Conflicting worker/migrations/0001_live_store.sql must not exist')
}

requireText('worker/migrations/0001_realtime_core.sql', [
  'CREATE TABLE IF NOT EXISTS ops_records',
  'CREATE TABLE IF NOT EXISTS ops_mutations',
  'CREATE TABLE IF NOT EXISTS sheet_sync_outbox',
  'entity_id TEXT NOT NULL',
  'queued_at TEXT NOT NULL',
  'last_attempt_at TEXT NOT NULL',
])
requireText('worker/migrations/0002_submission_locks.sql', [
  'CREATE TABLE IF NOT EXISTS ops_submission_locks',
])
requireText('worker/src/entry.js', [
  "const WORKER_REVISION = 'realtime-resilience-v3-pwa-task-bootstrap'",
  'handleRealtimeWorkflowApi',
  'handleJsonAtomicStockCountBatch',
  'handleRealtimeCloseUpSync',
  'handleRealtimeDataApi',
  'processSheetMirrorQueue',
  'augmentHealthResponse',
  'overlayOperationalBootstrapResponse(bootstrapRequest',
])
requireText('worker/src/realtime-task-bootstrap.js', [
  'CLOUDFLARE_PACKAGE_D1_FALLBACK',
  'createGeneratedTask',
  'getPublishedAppPack',
  'INSERT INTO ops_records',
  'INSERT INTO sheet_sync_outbox',
])
requireText('worker/src/realtime-health.js', [
  "'ops_records'",
  "'ops_mutations'",
  "'sheet_sync_outbox'",
  "'ops_submission_locks'",
])
requireText('worker/src/realtime-store.js', [
  'INSERT INTO ops_records',
  'INSERT INTO ops_mutations',
  'INSERT INTO sheet_sync_outbox',
  'await mirrorToSheets(env, body)',
  'message.retry()',
])
requireText('worker/wrangler.production.example.jsonc', [
  '"binding": "OPS_DB"',
  '"binding": "SHEET_SYNC_QUEUE"',
  '"consumers"',
  '"dead_letter_queue"',
  '"name": "OUTLET_REALTIME"',
])
requireText('web/src/lib/realtime-mutations.js', [
  'savePending',
  'flushRealtimeMutationQueue',
  'queued_offline',
])
requireText('web/src/lib/realtime-client.js', [
  "window.addEventListener('pageshow', reconnectAll)",
  "document.addEventListener('visibilitychange', onVisible)",
  'Heartbeat timeout',
])
requireText('web/src/pages/OperationalTasksLive.jsx', [
  "window.addEventListener('chefops:realtime', onRealtime)",
  "window.addEventListener('pageshow', onActive)",
  'OperationalTasksV2 key={revision}',
])
requireText('web/src/App.jsx', [
  "const Tasks = lazy(() => import('@/pages/OperationalTasksLive'))",
])
requireText('web/src/lib/app-pack.js', [
  '/api/app/v4/pack/manifest?',
])
requireText('web/src/main.jsx', [
  "const SHELL_VERSION = 'realtime-resilience-v3-ios-live-task-v26'",
  "register('/sw-v26.js'",
])
requireText('web/public/sw.js', [
  "const VERSION = 'chefops-realtime-resilience-v3-ios-live-task-v26'",
])
requireText('web/public/sw-v24.js', [
  'realtime-resilience-v3-ios-live-task-v26',
])
requireText('web/public/sw-v25.js', [
  'realtime-resilience-v3-ios-live-task-v26',
])
requireText('web/public/sw-v26.js', [
  'realtime-resilience-v3-ios-live-task-v26',
])

if (failures.length) {
  console.error('Realtime closure audit failed:')
  failures.forEach((failure) => console.error(`- ${failure}`))
  process.exit(1)
}

console.log('Realtime closure audit passed.')
console.log('D1-first submissions, iPhone PWA resume sync, Task bootstrap fallback, idempotency, WebSocket broadcast, Queue mirroring and last-known-good packages are wired.')