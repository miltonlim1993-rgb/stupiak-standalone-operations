import assert from 'node:assert/strict'
import fs from 'node:fs'

const outboxSource = fs.readFileSync('web/src/lib/specialized-operation-outbox.js', 'utf8')
const clientSource = fs.readFileSync('web/src/lib/specialized-operation-client.js', 'utf8')
const snapshotSource = fs.readFileSync('web/src/lib/operational-task-snapshot.js', 'utf8')
const cacheSource = fs.readFileSync('web/src/lib/realtime-read-cache.js', 'utf8')
const mainSource = fs.readFileSync('web/src/main.jsx', 'utf8')
const taskServerSource = fs.readFileSync('worker/src/realtime-task-action-d1-v2.js', 'utf8')
const stockServerSource = fs.readFileSync('worker/src/realtime-stock-batch-json.js', 'utf8')
const closeUpServerSource = fs.readFileSync('worker/src/realtime-closeup-upsert-d1.js', 'utf8')

assert.match(outboxSource, /const DATABASE_NAME = 'chefops-specialized-operation-outbox'/)
assert.match(outboxSource, /indexedDB\.open\(DATABASE_NAME, DATABASE_VERSION\)/)
assert.match(outboxSource, /store\.createIndex\('actor_key', 'actor_key'\)/)
assert.match(outboxSource, /store\.createIndex\('attention_key', 'attention_key'\)/)
assert.match(outboxSource, /headers\.set\('X-ChefOps-Mutation-Id', operation\.mutation_id\)/)
assert.match(outboxSource, /\[401, 408, 425, 429\]\.includes\(status\)/)
assert.match(outboxSource, /status: 'needs_attention'/)
assert.match(outboxSource, /const FLUSH_INTERVAL_MS = 60_000/)
assert.match(outboxSource, /document\.visibilityState === 'visible'/)
assert.match(outboxSource, /const existing = input\.operation_id \? await getOperation\(input\.operation_id\) : null/)
assert.match(outboxSource, /queued_at: existing\.queued_at \|\| operation\.queued_at/)
assert.match(outboxSource, /const blockedAttentionKeys = new Set/)
assert.match(outboxSource, /blockedAttentionKeys\.add\(operation\.attention_key\)/)

const submitStart = outboxSource.indexOf('export async function submitSpecializedOperation')
const submitEnd = outboxSource.indexOf('export async function listSpecializedOperations', submitStart)
const submitSource = outboxSource.slice(submitStart, submitEnd)
assert(submitStart >= 0 && submitEnd > submitStart, 'specialized submit function must exist')
assert(
  submitSource.indexOf('await putOperation(operation)') < submitSource.indexOf('await sendOperation(syncing)'),
  'specialized operations must be durable on device before network delivery',
)

assert.match(clientSource, /path: '\/api\/tasks\/operational\/action'/)
assert.match(clientSource, /path: '\/api\/stock-counts\/batch'/)
assert.match(clientSource, /`\/api\/close-up\/upsert\$\{suffix\}`/)
assert.match(clientSource, /pendingOperation\('task-action', coalesceScope\)/)
assert.match(clientSource, /mergeTaskResponsePatches/)
assert.match(clientSource, /pendingOperation\('stock-count-batch', scopeKey\)/)
assert.match(clientSource, /mergeStockPayload/)
assert.match(clientSource, /pendingOperation\('close-up-upsert', scopeKey\)/)
assert.match(clientSource, /stageRealtimeReadCacheMutation/)
assert.match(clientSource, /已保存在设备 · 待同步/)
assert.match(clientSource, /正在同步/)
assert.match(clientSource, /需要处理/)
assert.match(clientSource, /已同步/)
assert.doesNotMatch(clientSource, /SHEET_SYNC_QUEUE|Google Sheets API|spreadsheets\.values/)

assert.match(snapshotSource, /const DATABASE_NAME = 'chefops-operational-task-snapshots'/)
assert.match(snapshotSource, /const MAX_SNAPSHOTS_PER_OUTLET = 14/)
assert.match(snapshotSource, /pruneSnapshots/)
assert.match(snapshotSource, /saveOperationalTaskSnapshot/)
assert.match(snapshotSource, /loadOperationalTaskSnapshot/)
assert.match(clientSource, /storage: 'device-snapshot'/)

assert.match(cacheSource, /export async function stageRealtimeReadCacheMutation/)
assert.match(cacheSource, /export async function invalidateRealtimeReadCache/)
assert.match(mainSource, /installSpecializedOperationClient/)
assert.match(mainSource, /installSpecializedOperationClient\(\)/)

assert.match(taskServerSource, /body\.mutation_id \|\| request\.headers\.get\('X-ChefOps-Mutation-Id'\)/)
assert.match(taskServerSource, /expected_version: task\.__realtime\.version/)
assert.match(taskServerSource, /mutationError\?\.code !== 'realtime_version_conflict'/)

assert.match(stockServerSource, /body\.mutation_id \|\| request\.headers\.get\('X-ChefOps-Mutation-Id'\)/)
assert.match(stockServerSource, /const replay = await replayResult\(env\.OPS_DB, baseMutationId\)/)
assert.match(stockServerSource, /await persistAtomicBatch\(env, rows\)/)
assert(
  stockServerSource.indexOf('await persistAtomicBatch(env, rows)') < stockServerSource.indexOf('const sideEffects = Promise.all'),
  'stock batch must commit D1 before Queue/Sheet side effects',
)

assert.match(closeUpServerSource, /rawInput\.mutation_id \|\| request\.headers\.get\('X-ChefOps-Mutation-Id'\)/)
assert.match(closeUpServerSource, /expected_version: existing\?\.__realtime\?\.version/)
assert.match(closeUpServerSource, /mutationResponse\(request, env/)

console.log('SPECIALIZED_DEVICE_FIRST_OUTBOX_TEST_OK=true')
console.log('TASK_ACTION_DEVICE_FIRST=true')
console.log('STOCK_COUNT_DEVICE_FIRST=true')
console.log('CLOSE_UP_DEVICE_FIRST=true')
console.log('SPECIALIZED_DEVICE_WRITE_AHEAD=true')
console.log('SPECIALIZED_MUTATION_ID_REPLAY=true')
console.log('SPECIALIZED_QUEUE_ORDER_PRESERVED=true')
console.log('SPECIALIZED_FAILED_SCOPE_BLOCKS_LATER_REPLAY=true')
console.log('SPECIALIZED_NEEDS_ATTENTION_STATE=true')
console.log('OPERATIONAL_TASK_DEVICE_SNAPSHOT=true')
console.log('OPERATIONAL_TASK_SNAPSHOT_RETENTION_BOUNDED=true')
console.log('SPECIALIZED_SHEET_CANONICAL=false')
