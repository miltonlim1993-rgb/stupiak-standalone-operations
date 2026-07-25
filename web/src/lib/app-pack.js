const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const PACK_API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')

const DB_NAME = 'chefops-data-packs'
const DB_VERSION = 1
const MANIFEST_STORE = 'manifests'
const MODULE_STORE = 'modules'
const STATUS_KEY = 'chefops.data-pack.status'

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
  return status.state === 'ready' && Boolean(status.version) && expected === actual
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
  const response = await fetch(`${PACK_API_BASE_URL}${url}`, { credentials: 'include', ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || data.message || `Data pack request failed (${response.status})`)
  return data
}

export async function syncAppPack({ outletId = '', force = false } = {}) {
  if (activeSync && !force) return activeSync
  const run = (async () => {
    const localManifest = await hydrate(outletId)
    setStatus({ state: 'checking', outlet_id: outletId || '', error: '' })
    const params = new URLSearchParams()
    if (outletId) params.set('outlet_id', outletId)
    if (force) { params.set('refresh', '1'); params.set('_', String(Date.now())) }
    const manifest = await fetchJson(`/api/app/v4/pack/manifest?${params}`)
    const changed = []
    for (const [name, info] of Object.entries(manifest.modules || {})) {
      if (localManifest?.modules?.[name]?.hash !== info.hash) changed.push(name)
    }
    if (!changed.length && localManifest?.version === manifest.version) {
      setStatus({ state: 'ready', outlet_id: outletId || '', version: manifest.version, data_version: manifest.data_version, total_bytes: manifest.total_bytes, generated_at: manifest.generated_at, last_checked_at: new Date().toISOString(), changed_modules: [] })
      return manifest
    }

    setStatus({ state: 'downloading', outlet_id: outletId || '', version: manifest.version, total_bytes: manifest.total_bytes, changed_modules: changed })
    for (const name of changed) {
      const info = manifest.modules[name]
      const moduleParams = new URLSearchParams({ hash: info.hash })
      if (outletId) moduleParams.set('outlet_id', outletId)
      const module = await fetchJson(`/api/app/v4/pack/module/${encodeURIComponent(name)}?${moduleParams}`)
      const key = moduleKey(outletId, name, info.hash)
      memoryModules.set(key, module)
      await dbPut(MODULE_STORE, key, module)
    }
    memoryManifests.set(manifestKey(outletId), manifest)
    await dbPut(MANIFEST_STORE, manifestKey(outletId), manifest)
    window.__chefopsDataPack = { outlet_id: outletId || '', manifest, modules: moduleSnapshot(outletId, manifest) }
    setStatus({ state: 'ready', outlet_id: outletId || '', version: manifest.version, data_version: manifest.data_version, total_bytes: manifest.total_bytes, generated_at: manifest.generated_at, last_checked_at: new Date().toISOString(), last_downloaded_at: new Date().toISOString(), changed_modules: changed })
    window.dispatchEvent(new CustomEvent('chefops:data-pack-updated', { detail: window.__chefopsDataPack }))
    return manifest
  })().catch((error) => {
    setStatus({ state: 'error', error: error.message || 'Unable to download data patch', last_checked_at: new Date().toISOString() })
    throw error
  })
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
