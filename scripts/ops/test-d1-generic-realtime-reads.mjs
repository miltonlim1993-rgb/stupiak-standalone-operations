import assert from 'node:assert/strict'
import fs from 'node:fs'

const handler = fs.readFileSync('worker/src/realtime-generic-entity-read-d1.js', 'utf8')
const entry = fs.readFileSync('worker/src/entry.js', 'utf8')

for (const entity of [
  'Task',
  'TaskPhoto',
  'UrgentIssue',
  'StockCount',
  'CloseUp',
  'FoodLabel',
  'Attendance',
  'Receipt',
  'TrainingAssignment',
  'TrainingProgress',
  'TrainingAcknowledgement',
  'TrainingAttempt',
]) assert.match(handler, new RegExp(`'${entity}'`))

assert.match(handler, /FROM ops_records/)
assert.match(handler, /scopeFilter\(user, entity, requestedFilter\)/)
assert.match(handler, /assertReadPermission\(user, entity\)/)
assert.match(handler, /X-ChefOps-Entity-Read-Path', 'd1-only-v1'/)
assert.doesNotMatch(handler, /from '\.\/sheets\.js'/)
assert.doesNotMatch(handler, /listRecords\(/)
assert.doesNotMatch(handler, /ensureEntitySheet\(/)
assert.doesNotMatch(handler, /legacy_seed/i)
assert.doesNotMatch(handler, /google/i)

assert.match(entry, /handleD1GenericRealtimeEntityRead/)
assert(
  entry.indexOf('const genericRealtimeReadResponse = await handleD1GenericRealtimeEntityRead')
    < entry.indexOf('let response = await app.fetch'),
  'D1 generic realtime reads must run before the legacy app fallback',
)
assert.match(entry, /X-ChefOps-Entity-Read-Path/)

console.log('D1_GENERIC_REALTIME_READ_TEST_OK=true')
console.log('REALTIME_GENERIC_READ_SOURCE=d1_only')
console.log('REALTIME_GENERIC_READ_SHEET_FALLBACK=false')
console.log('REALTIME_GENERIC_READ_LEGACY_HYDRATION=false')
console.log('PRODUCTION_DEPLOY_RUN=false')
console.log('D1_MIGRATION_RUN=false')
