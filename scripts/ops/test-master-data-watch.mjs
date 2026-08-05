import assert from 'node:assert/strict'
import { refreshAppPacksWhenMasterChanges } from '../../worker/src/master-data-watch.js'

const STATE_KEY = 'chefops:master-data-watch:v1'

function fakeKv() {
  const values = new Map()
  return {
    async get(key, type) {
      const value = values.get(key)
      if (value == null) return null
      return type === 'json' ? JSON.parse(value) : value
    },
    async put(key, value) {
      values.set(key, String(value))
    },
  }
}

const env = {
  GOOGLE_MASTER_SPREADSHEET_ID: 'master-sheet-test-id',
  APP_DATA_PACKS: fakeKv(),
}

let fingerprint = 'task-template-fingerprint-v1'
let rebuildCount = 0
const dependencies = {
  readFingerprint: async (_env, spreadsheetId) => {
    assert.equal(spreadsheetId, 'master-sheet-test-id')
    return { fingerprint, template_count: 29, photo_count: 2 }
  },
  rebuildPacks: async () => {
    rebuildCount += 1
    return [
      { outlet_id: '', version: `global-v${rebuildCount}`, data_version: `data-v${rebuildCount}` },
      { outlet_id: 'RR-KCH', version: `rr-v${rebuildCount}`, data_version: `data-v${rebuildCount}` },
    ]
  },
}

const first = await refreshAppPacksWhenMasterChanges(env, dependencies)
assert.equal(first.changed, true)
assert.equal(rebuildCount, 1)
assert.equal(first.source, 'sheets-task-template-fingerprint-v1')
assert.equal(first.source_fingerprint, fingerprint)
assert.equal(first.template_count, 29)
assert.equal(first.packs.length, 2)

const unchanged = await refreshAppPacksWhenMasterChanges(env, dependencies)
assert.equal(unchanged.changed, false)
assert.equal(rebuildCount, 1)
assert.equal(unchanged.source_fingerprint, fingerprint)
assert.ok(unchanged.checked_at)

fingerprint = 'task-template-fingerprint-v2'
const changed = await refreshAppPacksWhenMasterChanges(env, dependencies)
assert.equal(changed.changed, true)
assert.equal(rebuildCount, 2)
assert.equal(changed.packs.find((pack) => pack.outlet_id === 'RR-KCH')?.version, 'rr-v2')

const forced = await refreshAppPacksWhenMasterChanges(env, { ...dependencies, force: true })
assert.equal(forced.changed, false)
assert.equal(forced.verified_existing_publication, true)
assert.equal(forced.force_verified, true)
assert.equal(rebuildCount, 2, 'duplicate deploy verification must not rewrite an already current publication')
assert.equal(forced.packs.find((pack) => pack.outlet_id === 'RR-KCH')?.version, 'rr-v2')

const failedEnv = {
  GOOGLE_MASTER_SPREADSHEET_ID: 'master-sheet-test-id',
  APP_DATA_PACKS: fakeKv(),
}
await assert.rejects(
  () => refreshAppPacksWhenMasterChanges(failedEnv, {
    readFingerprint: async () => ({ fingerprint: 'failed-publish-fingerprint' }),
    rebuildPacks: async () => [],
  }),
  (error) => error?.code === 'master_pack_publish_empty',
)
const failureState = await failedEnv.APP_DATA_PACKS.get(STATE_KEY, 'json')
assert.equal(failureState.source, 'sheets-task-template-fingerprint-v1')
assert.equal(failureState.last_error, 'master_pack_publish_empty')
assert.ok(failureState.last_error_at)

await assert.rejects(
  () => refreshAppPacksWhenMasterChanges(
    { APP_DATA_PACKS: fakeKv() },
    dependencies,
  ),
  (error) => error?.code === 'master_spreadsheet_not_configured',
)

console.log('MASTER_DATA_WATCH_TEST_OK=true')
console.log('MASTER_DATA_WATCH_SOURCE=sheets-task-template-fingerprint-v1')
console.log('DRIVE_MODIFIED_TIME_REQUIRED=false')
console.log('WATCH_FAILURE_STATE_PERSISTED=true')
console.log('IMMEDIATE_FORCE_PUBLICATION_TESTED=true')
console.log('DUPLICATE_FORCE_REUSES_CURRENT_PUBLICATION=true')
