import assert from 'node:assert/strict'
import { refreshAppPacksWhenMasterChanges } from '../../worker/src/master-data-watch.js'

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

let modifiedTime = '2026-08-03T12:00:00.000Z'
let rebuildCount = 0
const dependencies = {
  readModifiedTime: async (_env, spreadsheetId) => {
    assert.equal(spreadsheetId, 'master-sheet-test-id')
    return modifiedTime
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
assert.equal(first.packs.length, 2)

const unchanged = await refreshAppPacksWhenMasterChanges(env, dependencies)
assert.equal(unchanged.changed, false)
assert.equal(rebuildCount, 1)
assert.equal(unchanged.modified_time, modifiedTime)

modifiedTime = '2026-08-03T12:02:00.000Z'
const changed = await refreshAppPacksWhenMasterChanges(env, dependencies)
assert.equal(changed.changed, true)
assert.equal(rebuildCount, 2)
assert.equal(changed.packs.find((pack) => pack.outlet_id === 'RR-KCH')?.version, 'rr-v2')

await assert.rejects(
  () => refreshAppPacksWhenMasterChanges(
    { GOOGLE_MASTER_SPREADSHEET_ID: 'master-sheet-test-id', APP_DATA_PACKS: fakeKv() },
    {
      readModifiedTime: async () => '2026-08-03T12:04:00.000Z',
      rebuildPacks: async () => [],
    },
  ),
  (error) => error?.code === 'master_pack_publish_empty',
)

await assert.rejects(
  () => refreshAppPacksWhenMasterChanges(
    { APP_DATA_PACKS: fakeKv() },
    dependencies,
  ),
  (error) => error?.code === 'master_spreadsheet_not_configured',
)

console.log('Master data watcher tests passed')
