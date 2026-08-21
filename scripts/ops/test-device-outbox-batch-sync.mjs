import assert from 'node:assert/strict'
import fs from 'node:fs'

const clientSource = fs.readFileSync('web/src/lib/realtime-mutations.js', 'utf8')
const batchSource = fs.readFileSync('worker/src/realtime-mutation-batch.js', 'utf8')
const entrySource = fs.readFileSync('worker/src/entry.js', 'utf8')
const sheetBackupSource = fs.readFileSync('worker/src/sheet-backup-queue.js', 'utf8')

assert.match(clientSource, /indexedDB\.open\(DATABASE_NAME, DATABASE_VERSION\)/)
assert.match(clientSource, /const NETWORK_BATCH_LIMIT = 50/)
assert.match(clientSource, /const SERVER_BATCH_LIMIT = 100/)
assert.match(clientSource, /\/api\/realtime\/mutations\/batch/)
assert.match(clientSource, /actor_key: String\(input\.actor_key \|\| cachedActorKey\(\)\)/)
assert.match(clientSource, /next_attempt_at: retryAt\(attempts\)/)
assert.match(clientSource, /document\.visibilityState === 'visible'/)
assert.match(clientSource, /mutation\.entity !== 'TaskPhoto'/)

const submitStart = clientSource.indexOf('export async function submitRealtimeMutation')
const submitEnd = clientSource.indexOf('export async function flushRealtimeMutationQueue')
const submitSource = clientSource.slice(submitStart, submitEnd)
assert(submitStart >= 0 && submitEnd > submitStart, 'submitRealtimeMutation block must exist')
assert(
  submitSource.indexOf('await savePending') < submitSource.indexOf('await postMutationBatched'),
  'device outbox must persist the mutation before the Cloudflare batch request',
)

assert.match(batchSource, /const MAX_BATCH_MUTATIONS = 100/)
assert.match(batchSource, /for \(const mutation of mutations\)/)
assert.match(batchSource, /handleRealtimeDataApi\(new Request/)
assert.match(batchSource, /failed \? 207 : 200/)

assert.match(entrySource, /handleRealtimeMutationBatch/)
assert(
  entrySource.indexOf('const realtimeBatchResponse = await handleRealtimeMutationBatch')
    < entrySource.indexOf('const realtimeDataResponse = await handleRealtimeDataApi'),
  'batch router must run before the single-mutation realtime data router',
)
assert.match(entrySource, /const WORKER_REVISION = 'realtime-resilience-v\d+-[^']+'/)

assert.match(sheetBackupSource, /Google Sheets is a downstream backup only/)
assert.match(sheetBackupSource, /retry: \(\) => message\.ack\(\)/)

console.log('DEVICE_OUTBOX_BATCH_SYNC_TEST_OK=true')
console.log('DEVICE_WRITE_AHEAD_OUTBOX=true')
console.log('REALTIME_HTTP_BATCH_MAX=100')
console.log('REALTIME_CLIENT_BATCH_SIZE=50')
console.log('CROSS_USER_OUTBOX_SCOPE=true')
console.log('SHEET_BACKUP_CANONICAL=false')
