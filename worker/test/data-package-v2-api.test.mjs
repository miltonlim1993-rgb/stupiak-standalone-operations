import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compareDataPackageDraft,
  resolveDataPackageOutlet,
} from '../src/data-package-v2-api.js'

test('preview reports changed modules and reuses unchanged modules', () => {
  const current = {
    version: 'release-one',
    modules: {
      core: { hash: 'core-a', bytes: 100, records: 4 },
      tasks: { hash: 'tasks-a', bytes: 200, records: 8 },
      training: { hash: 'training-a', bytes: 300, records: 10 },
    },
  }
  const draft = {
    version: 'release-two',
    modules: {
      core: { hash: 'core-a', bytes: 100, records: 4 },
      tasks: { hash: 'tasks-b', bytes: 230, records: 9 },
      labels: { hash: 'labels-a', bytes: 90, records: 6 },
    },
  }

  const result = compareDataPackageDraft(current, draft, [])

  assert.equal(result.changed, true)
  assert.deepEqual(result.changed_modules, ['labels', 'tasks', 'training'])
  assert.equal(result.download_bytes, 320)
  assert.equal(result.module_changes.find((item) => item.name === 'core').state, 'unchanged')
  assert.equal(result.module_changes.find((item) => item.name === 'tasks').state, 'changed')
  assert.equal(result.module_changes.find((item) => item.name === 'labels').state, 'added')
  assert.equal(result.module_changes.find((item) => item.name === 'training').state, 'removed')
})

test('preview blocks a supposedly complete package while media remains unresolved', () => {
  const manifest = {
    version: 'same-release',
    modules: { tasks: { hash: 'tasks-a', bytes: 100, records: 3 } },
  }
  const media = [{ source_key: 'drive:file-1', packaged: false }]

  const result = compareDataPackageDraft(manifest, manifest, media)

  assert.equal(result.changed, true)
  assert.equal(result.unresolved_media_count, 1)
  assert.equal(result.media_packaging_ready, false)
  assert.deepEqual(result.changed_modules, [])
})

test('preview is unchanged only when modules match and no media is pending', () => {
  const manifest = {
    version: 'same-release',
    modules: { inventory: { hash: 'stock-a', bytes: 120, records: 20 } },
  }

  const result = compareDataPackageDraft(manifest, manifest, [])

  assert.equal(result.changed, false)
  assert.equal(result.download_bytes, 0)
  assert.equal(result.media_packaging_ready, true)
})

test('staff data package access is limited to assigned outlets', () => {
  const user = {
    role: 'staff',
    outlet_id: 'RR-KCH',
    outlet_ids: '["RR-KCH"]',
  }

  assert.equal(resolveDataPackageOutlet(user, ''), 'RR-KCH')
  assert.equal(resolveDataPackageOutlet(user, 'RR-KCH'), 'RR-KCH')
  assert.throws(
    () => resolveDataPackageOutlet(user, 'SKONE-BTU'),
    (error) => error?.code === 'wrong_outlet' && error?.status === 403,
  )
})

test('manager can explicitly select an outlet', () => {
  const user = { role: 'manager', outlet_id: '' }
  assert.equal(resolveDataPackageOutlet(user, 'RR-KCH'), 'RR-KCH')
})

test('unassigned staff cannot fall back to a global package', () => {
  const user = { role: 'staff', outlet_id: '', outlet_ids: '' }
  assert.throws(
    () => resolveDataPackageOutlet(user, ''),
    (error) => error?.code === 'outlet_required' && error?.status === 403,
  )
})
