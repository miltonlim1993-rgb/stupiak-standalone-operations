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
  "const WORKER_REVISION = 'realtime-resilience-v8-d1-primary'",
  'handleCloudflareAuth',
  'handleD1OperationalTaskAction',
  'handleD1CloseUpUpsert',
  'handleJsonAtomicStockCountBatch',
  'handleRealtimeCloseUpSync',
  'handleRealtimeDataApi',
  'processSheetMirrorQueue',
  'augmentHealthResponse',
  'overlayOperationalBootstrapResponse(bootstrapRequest',
])
requireText('worker/src/cloudflare-auth.js', [
  'handleCloudflareAuth',
  "path === '/api/auth/google'",
  "path === '/api/auth/me'",
  'currentUserFromCloudflare',
  'cachedGoogleLogin',
  'bootstrapOwnerLogin',
  'normalizeUserScope',
  "const DEFAULT_BOOTSTRAP_OWNER_OUTLET_ID = 'RR-KCH'",
  'APP_DATA_PACKS.put',
])
const cloudflareAuth = read('worker/src/cloudflare-auth.js')
if (cloudflareAuth.includes('ensureEntitySheet')) {
  failures.push('worker/src/cloudflare-auth.js must not run a blocking Sheet preflight')
}

requireText('worker/src/realtime-task-action-d1.js', [
  'handleD1OperationalTaskAction',
  'getPublishedAppPack',
  'getAppPackModule',
  "SELECT * FROM ops_records WHERE entity = ? AND entity_id = ?",
  "sheet_read: false",
  "operation: 'update'",
])
const d1TaskAction = read('worker/src/realtime-task-action-d1.js')
if (d1TaskAction.includes("from './sheets.js'") || d1TaskAction.includes('listRecords(') || d1TaskAction.includes('findRecord(')) {
  failures.push('worker/src/realtime-task-action-d1.js must not read Google Sheets')
}

requireText('worker/src/realtime-closeup-upsert-d1.js', [
  'handleD1CloseUpUpsert',
  "WHERE entity = 'CloseUp'",
  "operation: existing?.__realtime ? 'update' : 'upsert'",
  "sync_status: 'pending'",
  'handleRealtimeDataApi',
])
const d1CloseUp = read('worker/src/realtime-closeup-upsert-d1.js')
if (d1CloseUp.includes("from './sheets.js'") || d1CloseUp.includes('listRecords(') || d1CloseUp.includes('findRecord(')) {
  failures.push('worker/src/realtime-closeup-upsert-d1.js must not read Google Sheets')
}

requireText('worker/src/realtime-stock-batch-json.js', [
  'getPublishedAppPack',
  'getAppPackModule',
  'publishedStockList',
  "WHERE entity = 'StockCount'",
  "source: 'cloudflare-package+d1'",
])
const d1StockBatch = read('worker/src/realtime-stock-batch-json.js')
if (d1StockBatch.includes("from './sheets.js'") || d1StockBatch.includes('listRecords(')) {
  failures.push('worker/src/realtime-stock-batch-json.js must not read Google Sheets')
}

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
  'const MAX_READ_LIMIT = 5000',
  'seedLegacyRecords',
  'persistLegacyRows',
  "legacy_seed') !== '0'",
  "source = records.length ? 'd1' : 'd1-empty'",
  'await mirrorToSheets(env, body)',
  "body.entity === 'CloseUp'",
  'syncCloseUpToSalesTemplate',
  'message.retry()',
])
requireText('worker/wrangler.production.example.jsonc', [
  '"binding": "OPS_DB"',
  '"binding": "SHEET_SYNC_QUEUE"',
  '"consumers"',
  '"dead_letter_queue"',
  '"name": "OUTLET_REALTIME"',
])

requireText('web/src/api/opsClient.js', [
  'async function realtimeRows',
  "legacy_seed: legacySeed ? '1' : '0'",
  'visibleRealtimeRows',
  'if (REALTIME_ENTITIES.has(entity) && outletId)',
  'return visibleRealtimeRows(rows, { filter, sort, limit })',
  "if (path === '/api/auth/me') return 0",
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
requireText('web/src/lib/AuthContext.jsx', [
  'CACHED_USER_KEY',
  'AUTH_CHECK_TIMEOUT_MS',
  'readCachedUser',
  'withTimeout',
  'if (status === 401 || status === 403)',
  'applyUser(fallbackUser)',
  'if (nextOutlet)',
  "localStorage.getItem('chefops.data-pack.outlet')",
])
requireText('web/src/pages/Dashboard.jsx', [
  'DEFAULT_OWNER_OUTLET',
  'dashboardOutlet(user)',
  'opsClient.tasks.operationalBootstrap',
  'const safe = async',
  'setLoadWarning',
])
requireText('web/src/components/Layout.jsx', [
  'parseOutletIds',
  'headerOutlet',
  "headerOutlet || 'No assigned outlet'",
])
requireText('web/src/lib/task-alerts.js', [
  'taskWorkHasStarted',
  'cancelTaskAlertsForTask',
  "status === 'in_progress'",
])
requireText('web/src/components/RosterGatedTaskAlarmManager.jsx', [
  'claimedTaskIds',
  'cancelTaskAlertsForTask',
  "window.addEventListener('chefops:realtime'",
])
requireText('web/src/pages/OperationalTasksLive.jsx', [
  "window.addEventListener('chefops:realtime', onRealtime)",
  "window.addEventListener('pageshow', onActive)",
  'OperationalTasksV2 key={revision}',
  'AUTOSAVE_DELAY_MS',
  "buttonWithText(drawer, '保存进度')",
  '草稿已自动保存',
])
requireText('web/src/App.jsx', [
  "const Tasks = lazy(() => import('@/pages/OperationalTasksLive'))",
])
requireText('web/src/lib/app-pack.js', [
  '/api/app/v4/pack/manifest?',
])
requireText('web/src/main.jsx', [
  "const SHELL_VERSION = 'auth-session-stability-pwa-v28'",
  "register('/sw-v27.js'",
])
requireText('web/public/sw.js', [
  "const VERSION = 'chefops-auth-session-stability-pwa-v28'",
  'isAuthApi',
  'networkOnly',
  "code: 'auth_check_timeout'",
  'CANCEL_TASK_ALERTS',
  'cancelTaskAlerts',
])
for (const worker of ['sw-v24.js', 'sw-v25.js', 'sw-v26.js', 'sw-v27.js']) {
  requireText(`web/public/${worker}`, ['auth-session-stability-pwa-v28'])
}

if (failures.length) {
  console.error('Realtime closure audit failed:')
  failures.forEach((failure) => console.error(`- ${failure}`))
  process.exit(1)
}

console.log('Realtime closure audit passed.')
console.log('D1-primary live reads, package plus D1 stock submissions, D1-only Close Up submissions, isolated legacy hydration, stable sessions, draft autosave, WebSocket broadcast and Queue mirroring are wired.')