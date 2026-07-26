import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDataPackageDraft,
  getDataPackageDirtyState,
  getDataPackageModuleBody,
  getDataPackageModuleObject,
  getLatestDataPackageManifest,
  listDataPackageReleases,
  markDataPackageDirty,
  publishDataPackageDraft,
  rollbackDataPackage,
} from '../src/data-package-v2-store.js'

function fakeEnv() {
  const values = new Map()
  return {
    APP_DATA_PACKS: {
      async get(key, type) {
        if (!values.has(key)) return null
        const value = values.get(key)
        if (type === 'json') return JSON.parse(value)
        return value
      },
      async put(key, value) {
        values.set(key, String(value))
      },
    },
  }
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

test('publishes immutable modules and moves latest only after objects exist', async () => {
  const env = fakeEnv()
  const outletId = 'TEST-PUBLISH'
  const draft = await buildDataPackageDraft({
    env,
    outletId,
    generatedBy: 'owner@example.com',
    modules: {
      tasks: {
        task_templates: [{ id: 'task-1', title: 'Opening' }],
        lookup: { 10: 'ten', 2: 'two' },
      },
      inventory: { outlet_stock_list: [{ stock_list_id: 'stock-1', item_name: 'Bun' }] },
    },
  })

  assert.equal(draft.manifest.format_version, 2)
  assert.equal(draft.manifest.outlet_id, outletId)
  assert.equal(draft.manifest.modules.tasks.records, 1)
  assert.equal(await getLatestDataPackageManifest(env, outletId), null)
  assert.equal(await sha256(draft.moduleBodies.tasks), draft.manifest.modules.tasks.hash)
  assert.equal(new TextEncoder().encode(draft.moduleBodies.tasks).length, draft.manifest.modules.tasks.bytes)

  const published = await publishDataPackageDraft(env, draft, { publishedBy: 'owner@example.com' })
  const latest = await getLatestDataPackageManifest(env, outletId)
  assert.equal(latest.version, published.version)
  assert.equal(latest.published_by, 'owner@example.com')

  const body = await getDataPackageModuleBody(
    env,
    outletId,
    'tasks',
    latest.modules.tasks.hash,
  )
  assert.equal(body, draft.moduleBodies.tasks)
  assert.equal(await sha256(body), latest.modules.tasks.hash)

  const module = await getDataPackageModuleObject(
    env,
    outletId,
    'tasks',
    latest.modules.tasks.hash,
  )
  assert.equal(module.data.task_templates[0].title, 'Opening')
})

test('source edits mark dirty without replacing the published release', async () => {
  const env = fakeEnv()
  const outletId = 'TEST-DIRTY'
  const first = await buildDataPackageDraft({
    env,
    outletId,
    modules: { tasks: { task_templates: [{ id: 'task-1', title: 'Opening' }] } },
  })
  await publishDataPackageDraft(env, first, { publishedBy: 'owner@example.com' })
  const publishedVersion = first.manifest.version

  await markDataPackageDirty(env, outletId, {
    modules: ['tasks'],
    reason: 'TaskTemplate changed',
    actor: 'owner@example.com',
  })

  const dirty = await getDataPackageDirtyState(env, outletId)
  const latest = await getLatestDataPackageManifest(env, outletId)
  assert.equal(dirty.dirty, true)
  assert.deepEqual(dirty.modules, ['tasks'])
  assert.equal(latest.version, publishedVersion)
})

test('keeps release history and supports pointer rollback', async () => {
  const env = fakeEnv()
  const outletId = 'TEST-ROLLBACK'
  const first = await buildDataPackageDraft({
    env,
    outletId,
    modules: { tasks: { task_templates: [{ id: 'task-1', title: 'Opening' }] } },
  })
  await publishDataPackageDraft(env, first, { publishedBy: 'owner@example.com' })

  const second = await buildDataPackageDraft({
    env,
    outletId,
    modules: { tasks: { task_templates: [{ id: 'task-1', title: 'Opening v2' }] } },
  })
  await publishDataPackageDraft(env, second, { publishedBy: 'owner@example.com' })

  const releases = await listDataPackageReleases(env, outletId)
  assert.equal(releases.releases.length, 2)
  assert.equal(releases.latest.version, second.manifest.version)

  await rollbackDataPackage(env, outletId, first.manifest.version, { actor: 'owner@example.com' })
  const latest = await getLatestDataPackageManifest(env, outletId)
  assert.equal(latest.version, first.manifest.version)
})
