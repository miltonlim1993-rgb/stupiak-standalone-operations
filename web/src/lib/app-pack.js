const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const PACK_API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')

const DB_NAME = 'chefops-data-packs'
const DB_VERSION = 1
const MANIFEST_STORE = 'manifests'
const MODULE_STORE = 'modules'
const STATUS_KEY = 'chefops.data-pack.status'
const BLOCKING_STATES = new Set(['update_required', 'downloading', 'saving', 'cleaning', 'error'])

let dbPromise = null
let activeSync = null
const memoryModules = new Map()
const memoryManifests = new Map()

function openDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(MANIFEST_STORE)) db.createObjectStore(MANIFEST_STORE)
      if (!db.objectStoreNames.contains(MODULE_STORE)) db.createObjectStore(MODULE_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(() => null)
  return dbPromise
}

async function dbGet(storeName, key) {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).get(key)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => resolve(null)
  })
}

async function dbPut(storeName, key, value) {
  const db = await openDb()
  if (!db) return
  await new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(value, key)
    tx.oncomplete = resolve
    tx.onerror = resolve
    tx.onabort = resolve
  })
}

async function dbEntries(storeName) {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    const rows = []
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(rows)
        return
      }
      rows.push([String(cursor.key), cursor.value])
      cursor.continue()
    }
    request.onerror = () => resolve(rows)
  })
}

async function dbDeleteWhere(storeName, predicate) {
  const db = await openDb()
  if (!db) return 0
  return new Promise((resolve) => {
    let deleted = 0
    const tx = db.transaction(storeName, 'readwrite')
    const request = tx.objectStore(storeName).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      if (predicate(String(cursor.key), cursor.value)) {
        cursor.delete()
        deleted += 1
      }
      cursor.continue()
    }
    tx.oncomplete = () => resolve(deleted)
    tx.onerror = () => resolve(deleted)
    tx.onabort = () => resolve(deleted)
  })
}

function outletKey(outletId = '') { return String(outletId || '').trim() || 'global' }
function manifestKey(outletId) { return `manifest:${outletKey(outletId)}` }
function moduleKey(outletId, name, hash) { return `module:${outletKey(outletId)}:${name}:${hash}` }

function setStatus(patch) {
  let current = {}
  try { current = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}') } catch {}
  const next = { ...current, ...patch }
  localStorage.setItem(STATUS_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent('chefops:pack-status', { detail: next }))
  return next
}

export function getAppPackStatus() {
  try { return JSON.parse(localStorage.getItem(STATUS_KEY) || '{}') } catch { return {} }
}

export function hasUsableAppPack(outletId = '') {
  const status = getAppPackStatus()
  const expected = outletKey(outletId)
  const actual = outletKey(status.outlet_id || '')
  return Boolean(status.version) && expected === actual && !BLOCKING_STATES.has(String(status.state || ''))
}

async function hydrate(outletId) {
  const key = manifestKey(outletId)
  let manifest = memoryManifests.get(key)
  if (!manifest) {
    manifest = await dbGet(MANIFEST_STORE, key)
    if (manifest) memoryManifests.set(key, manifest)
  }
  if (!manifest) return null
  for (const [name, info] of Object.entries(manifest.modules || {})) {
    const mKey = moduleKey(outletId, name, info.hash)
    if (memoryModules.has(mKey)) continue
    const module = await dbGet(MODULE_STORE, mKey)
    if (module) memoryModules.set(mKey, module)
  }
  window.__chefopsDataPack = { outlet_id: outletId || '', manifest, modules: moduleSnapshot(outletId, manifest) }
  window.dispatchEvent(new CustomEvent('chefops:data-pack-hydrated', { detail: window.__chefopsDataPack }))
  return manifest
}

function moduleSnapshot(outletId, manifest) {
  const result = {}
  for (const [name, info] of Object.entries(manifest?.modules || {})) {
    result[name] = memoryModules.get(moduleKey(outletId, name, info.hash))?.data || null
  }
  return result
}

async function fetchJson(url, options) {
  const response = await fetch(`${PACK_API_BASE_URL}${url}`, {
    credentials: 'include',
    cache: 'no-store',
    ...options,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || data.message || `Data pack request failed (${response.status})`)
  return data
}

export async function pruneStaleAppPackData() {
  const manifests = await dbEntries(MANIFEST_STORE)
  const allowedModules = new Set()
  for (const [storedKey, manifest] of manifests) {
    const storedOutlet = storedKey.replace(/^manifest:/, '') || 'global'
    for (const [name, info] of Object.entries(manifest?.modules || {})) {
      if (!info?.hash) continue
      allowedModules.add(`module:${storedOutlet}:${name}:${info.hash}`)
    }
  }

  const deleted = await dbDeleteWhere(MODULE_STORE, (key) => !allowedModules.has(key))
  for (const key of [...memoryModules.keys()]) {
    if (!allowedModules.has(key)) memoryModules.delete(key)
  }
  return deleted
}

async function ensureManifestModules(outletId, manifest) {
  for (const [name, info] of Object.entries(manifest.modules || {})) {
    const key = moduleKey(outletId, name, info.hash)
    if (memoryModules.has(key)) continue
    const module = await dbGet(MODULE_STORE, key)
    if (!module) throw new Error(`Downloaded data pack is incomplete: ${name}`)
    memoryModules.set(key, module)
  }
}

export async function syncAppPack({ outletId = '', force = false } = {}) {
  if (activeSync) return activeSync
  const run = (async () => {
    const localManifest = await hydrate(outletId)
    let updateDetected = false
    if (!localManifest) {
      setStatus({ state: 'checking', outlet_id: outletId || '', error: '', warning: '' })
    } else {
      setStatus({
        state: 'checking',
        outlet_id: outletId || '',
        version: localManifest.version,
        data_version: localManifest.data_version,
        error: '',
        warning: '',
      })
    }

    try {
      const params = new URLSearchParams()
      if (outletId) params.set('outlet_id', outletId)
      if (force) params.set('refresh', '1')
      params.set('_', String(Date.now()))
      const manifest = await fetchJson(`/api/app/v4/pack/manifest?${params}`)
      const changed = []
      const removed = Object.keys(localManifest?.modules || {}).filter((name) => !manifest.modules?.[name])
      for (const [name, info] of Object.entries(manifest.modules || {})) {
        if (localManifest?.modules?.[name]?.hash !== info.hash) changed.push(name)
      }

      if (!changed.length && !removed.length && localManifest?.version === manifest.version) {
        setStatus({
          state: 'ready',
          outlet_id: outletId || '',
          version: manifest.version,
          data_version: manifest.data_version,
          total_bytes: manifest.total_bytes,
          generated_at: manifest.generated_at,
          last_checked_at: new Date().toISOString(),
          changed_modules: [],
          removed_modules: [],
          completed_modules: 0,
          total_modules: 0,
          error: '',
          warning: '',
        })
        return manifest
      }

      updateDetected = true
      setStatus({
        state: 'update_required',
        outlet_id: outletId || '',
        current_version: localManifest?.version || '',
        version: manifest.version,
        data_version: manifest.data_version,
        total_bytes: manifest.total_bytes,
        changed_modules: changed,
        removed_modules: removed,
        completed_modules: 0,
        total_modules: changed.length,
        error: '',
        warning: '',
      })
      window.dispatchEvent(new CustomEvent('chefops:data-pack-update-required', {
        detail: { outlet_id: outletId || '', manifest, changed_modules: changed, removed_modules: removed },
      }))

      setStatus({ state: 'downloading', completed_modules: 0, total_modules: changed.length })
      let completed = 0
      for (const name of changed) {
        const info = manifest.modules[name]
        const moduleParams = new URLSearchParams({ hash: info.hash, _: String(Date.now()) })
        if (outletId) moduleParams.set('outlet_id', outletId)
        const module = await fetchJson(`/api/app/v4/pack/module/${encodeURIComponent(name)}?${moduleParams}`)
        const key = moduleKey(outletId, name, info.hash)
        memoryModules.set(key, module)
        await dbPut(MODULE_STORE, key, module)
        completed += 1
        setStatus({ state: 'downloading', completed_modules: completed, total_modules: changed.length })
      }

      await ensureManifestModules(outletId, manifest)
      setStatus({ state: 'saving', completed_modules: completed, total_modules: changed.length })
      memoryManifests.set(manifestKey(outletId), manifest)
      await dbPut(MANIFEST_STORE, manifestKey(outletId), manifest)

      setStatus({ state: 'cleaning', completed_modules: completed, total_modules: changed.length })
      const deleted_modules = await pruneStaleAppPackData()
      window.__chefopsDataPack = { outlet_id: outletId || '', manifest, modules: moduleSnapshot(outletId, manifest) }
      setStatus({
        state: 'ready',
        outlet_id: outletId || '',
        version: manifest.version,
        data_version: manifest.data_version,
        total_bytes: manifest.total_bytes,
        generated_at: manifest.generated_at,
        last_checked_at: new Date().toISOString(),
        last_downloaded_at: new Date().toISOString(),
        changed_modules: changed,
        removed_modules: removed,
        deleted_modules,
        completed_modules: completed,
        total_modules: changed.length,
        error: '',
        warning: '',
      })
      navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_DATA_CACHE' })
      window.dispatchEvent(new CustomEvent('chefops:data-pack-updated', { detail: window.__chefopsDataPack }))
      return manifest
    } catch (error) {
      if (localManifest && !updateDetected) {
        setStatus({
          state: 'ready',
          outlet_id: outletId || '',
          version: localManifest.version,
          data_version: localManifest.data_version,
          warning: error.message || 'Unable to check for a new data pack',
          last_checked_at: new Date().toISOString(),
          error: '',
        })
        return localManifest
      }
      setStatus({
        state: 'error',
        outlet_id: outletId || '',
        error: error.message || 'Unable to download required data patch',
        last_checked_at: new Date().toISOString(),
      })
      throw error
    }
  })()
  activeSync = run
  try { return await run } finally { if (activeSync === run) activeSync = null }
}

export async function getPackedModule(name, outletId = '') {
  let manifest = memoryManifests.get(manifestKey(outletId))
  if (!manifest) manifest = await hydrate(outletId)
  if (!manifest) return null
  const info = manifest.modules?.[name]
  if (!info) return null
  const key = moduleKey(outletId, name, info.hash)
  let module = memoryModules.get(key)
  if (!module) {
    module = await dbGet(MODULE_STORE, key)
    if (module) memoryModules.set(key, module)
  }
  return module?.data || null
}

function matchesExpected(actual, expected) {
  if (expected === undefined || expected === null || expected === '') return true
  if (typeof expected === 'boolean') return Boolean(actual) === expected
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$in' in expected && !expected.$in.map(String).includes(String(actual ?? ''))) return false
    if ('$ne' in expected && String(actual ?? '') === String(expected.$ne)) return false
    if ('$gte' in expected && String(actual ?? '') < String(expected.$gte)) return false
    if ('$lte' in expected && String(actual ?? '') > String(expected.$lte)) return false
    if ('$gt' in expected && String(actual ?? '') <= String(expected.$gt)) return false
    if ('$lt' in expected && String(actual ?? '') >= String(expected.$lt)) return false
    return true
  }
  return String(actual ?? '') === String(expected)
}

function filterRows(rows, filter = {}) {
  return (rows || []).filter((row) => Object.entries(filter || {}).every(([key, expected]) => matchesExpected(row[key], expected)))
}

function sortRows(rows, sort = '') {
  const fields = String(sort || '').split(',').map((value) => value.trim()).filter(Boolean)
  if (!fields.length) return rows
  return [...rows].sort((a, b) => {
    for (const fieldText of fields) {
      const desc = fieldText.startsWith('-')
      const field = desc ? fieldText.slice(1) : fieldText
      const left = a?.[field] ?? ''
      const right = b?.[field] ?? ''
      const result = typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' })
      if (result) return desc ? -result : result
    }
    return 0
  })
}

export async function getPackedEntity(entity, { filter = {}, sort = '', limit = 100, outletId = '' } = {}) {
  if (entity === 'OutletStockList' && filter?.outlet_id && typeof filter.outlet_id === 'object') return null
  const map = {
    Outlet: ['core', 'outlets'],
    PaymentMethod: ['core', 'payment_methods'],
    PositionMaster: ['core', 'positions'],
    MediaRule: ['core', 'media_rules'],
    TaskTemplate: ['tasks', 'task_templates'],
    TaskTemplatePhoto: ['tasks', 'task_template_photos'],
    SOP: ['training', 'sops'],
    SOPStep: ['training', 'sop_steps'],
    SOPAsset: ['training', 'sop_assets'],
    TrainingCourse: ['training', 'training_courses'],
    TrainingLesson: ['training', 'training_lessons'],
    TrainingQuiz: ['training', 'training_quizzes'],
    TrainingQuestion: ['training', 'training_questions'],
    InventoryCatalog: ['inventory', 'inventory_catalog'],
    OutletStockList: ['inventory', 'outlet_stock_list'],
  }
  const target = map[entity]
  if (!target) return null
  let module = await getPackedModule(target[0], outletId)
  if (!module) {
    await Promise.race([
      syncAppPack({ outletId }).catch(() => null),
      new Promise((resolve) => window.setTimeout(resolve, 1800)),
    ])
    module = await getPackedModule(target[0], outletId)
  }
  if (!module) return null
  if (!Array.isArray(module[target[1]])) return null
  const rows = module[target[1]]
  return sortRows(filterRows(rows, filter), sort).slice(0, Number(limit || 100))
}

export async function getPackedLabelCatalog(outletId = '') {
  let module = await getPackedModule('labels', outletId)
  if (!module) {
    await Promise.race([
      syncAppPack({ outletId }).catch(() => null),
      new Promise((resolve) => window.setTimeout(resolve, 1800)),
    ])
    module = await getPackedModule('labels', outletId)
  }
  return module || null
}
