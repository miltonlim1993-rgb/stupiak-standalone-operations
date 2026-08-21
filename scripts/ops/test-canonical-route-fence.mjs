import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  canonicalFallbackBlockedResponse,
  canonicalOnlyOwner,
} from '../../worker/src/canonical-route-fence.js'

function owner(method, pathname) {
  const request = new Request(`https://ops.invalid${pathname}`, { method })
  return canonicalOnlyOwner(request, new URL(request.url))
}

assert.equal(owner('POST', '/api/close-up/upsert'), 'close_up_d1')
assert.equal(owner('POST', '/api/close-up/closeup-1/sync'), 'close_up_d1')
assert.equal(owner('GET', '/api/close-up/closeup-1/sync-status'), 'close_up_d1')
assert.equal(owner('POST', '/api/tasks/operational/action'), 'task_action_d1')
assert.equal(owner('POST', '/api/attendance/import'), 'attendance_roster_d1')
assert.equal(owner('POST', '/api/stock-counts/batch'), 'stock_count_d1')

for (const [method, pathname] of [
  ['POST', '/api/auth/google'],
  ['POST', '/api/auth/logout'],
  ['GET', '/api/auth/me'],
  ['PATCH', '/api/auth/me'],
]) assert.equal(owner(method, pathname), 'auth_d1')

for (const [method, pathname] of [
  ['GET', '/api/notifications'],
  ['POST', '/api/notifications/push'],
  ['PATCH', '/api/notifications/notification-1/read'],
]) assert.equal(owner(method, pathname), 'notifications_d1')

for (const [method, pathname] of [
  ['GET', '/api/entities/User'],
  ['POST', '/api/entities/User'],
  ['PATCH', '/api/entities/User/user-1'],
  ['DELETE', '/api/entities/User/user-1'],
  ['GET', '/api/entities/Outlet'],
  ['PATCH', '/api/entities/Outlet/RR-KCH'],
  ['POST', '/api/users/user-1/access'],
]) assert.equal(owner(method, pathname), 'directory_d1')

for (const [method, pathname] of [
  ['GET', '/api/labels/catalog'],
  ['POST', '/api/labels/create'],
  ['POST', '/api/labels/label-1/reprint'],
  ['POST', '/api/labels/source/label-1/finish'],
  ['GET', '/api/labels/printer-profile'],
  ['POST', '/api/labels/printer-profile'],
  ['PUT', '/api/labels/printer-profile'],
  ['GET', '/api/entities/PrinterProfile'],
  ['POST', '/api/entities/PrinterProfile'],
  ['POST', '/api/entities/PrinterProfile/update-many'],
  ['PATCH', '/api/entities/PrinterProfile/printer-1'],
  ['DELETE', '/api/entities/PrinterProfile/printer-1'],
]) assert.equal(owner(method, pathname), 'labels_d1')

for (const entity of [
  'Task', 'TaskPhoto', 'UrgentIssue', 'StockCount', 'CloseUp', 'FoodLabel',
  'LabelPrintLog', 'Attendance', 'Receipt', 'Notification', 'TrainingAssignment',
  'TrainingProgress', 'TrainingAcknowledgement', 'TrainingAttempt',
]) {
  assert.equal(owner('POST', `/api/entities/${entity}`), 'realtime_d1')
  assert.equal(owner('PATCH', `/api/entities/${entity}/record-1`), 'realtime_d1')
  assert.equal(owner('DELETE', `/api/entities/${entity}/record-1`), 'realtime_d1')
  assert.equal(owner('GET', `/api/entities/${entity}`), '', `${entity} generic reads remain compatibility-only until migration is proven complete`)
}

// These routes still intentionally use the remaining compatibility runtime.
// Do not fence them until their complete canonical replacements are proven.
assert.equal(owner('POST', '/api/tasks/operational/bootstrap'), '')
assert.equal(owner('GET', '/api/entities/LabelRule'), '')
assert.equal(owner('POST', '/api/entities/InventoryCatalog'), '')

const blockedRequest = new Request('https://ops.invalid/api/stock-counts/batch', { method: 'POST' })
const blocked = canonicalFallbackBlockedResponse(blockedRequest, new URL(blockedRequest.url))
assert.equal(blocked.status, 503)
assert.deepEqual(await blocked.json(), {
  error: 'Canonical route was not handled. Legacy runtime fallback is disabled.',
  code: 'canonical_route_unhandled',
  canonical_owner: 'stock_count_d1',
})

const entry = fs.readFileSync('worker/src/entry.js', 'utf8')
assert.match(entry, /canonicalFallbackBlockedResponse/)
assert(
  entry.indexOf('const canonicalFallbackResponse = canonicalFallbackBlockedResponse')
    < entry.indexOf('const appResponse = await app.fetch'),
  'canonical fallback fence must run before the legacy app fetch',
)
assert.match(entry, /handleD1Notifications/)
assert(
  entry.indexOf('const notificationResponse = await handleD1Notifications')
    < entry.indexOf('const appResponse = await app.fetch'),
  'D1 Notification router must run before the legacy app fetch',
)
assert.doesNotMatch(entry, /handleD1DirectoryBootstrap/)
assert.doesNotMatch(entry, /migrate-once/)
assert.doesNotMatch(entry, /handleRealtimeWorkflowApi/)
assert.doesNotMatch(entry, /from '\.\/realtime-workflows\.js'/)
assert.doesNotMatch(entry, /app\.scheduled\(/)
assert.match(entry, /return flushPendingSheetMirrors\(runEnv, 50\)/)

console.log('CANONICAL_ROUTE_FENCE_TEST_OK=true')
console.log('D1_CANONICAL_ROUTES_CANNOT_FALL_BACK_TO_SHEETS=true')
console.log('NOTIFICATION_DEDICATED_API_D1_ONLY=true')
console.log('GENERIC_REALTIME_SHEET_WRITES_BLOCKED=true')
console.log('GENERIC_REALTIME_COMPAT_READS_REMAIN=true')
console.log('HYBRID_WORKFLOW_ROUTER_ACTIVE=false')
console.log('LEGACY_SCHEDULED_RUNTIME_ACTIVE=false')
console.log('D1_OUTBOX_SCHEDULED_RETRY_OWNER=true')
console.log('UNMIGRATED_ROUTES_REMAIN_UNFENCED=true')
console.log('PRODUCTION_DEPLOY_RUN=false')
console.log('D1_MIGRATION_RUN=false')
