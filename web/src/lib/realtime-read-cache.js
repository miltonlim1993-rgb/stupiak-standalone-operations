const DATABASE_NAME = 'chefops-realtime-read-cache'
const DATABASE_VERSION = 1
const RECORD_STORE = 'records'
const META_STORE = 'meta'
const CACHED_USER_KEY = 'chefops.auth.cached-user'
const CACHE_FRESH_MS = 60_000
const CACHE_DELTA_LIMIT = 5000

let databasePromise = null
let listenersInstalled = false
const refreshInflight = new Map()

function cachedActorKey() {
  try {
    const user = JSON.parse(localStorage.getItem(CACHED_USER_KEY) || 'null')
    return String(user?.id || user?.google_sub || user?.email || '').trim()
  } catch {
    return ''
  }
}

function scopeKey(entity, outletId) {
  const actorKey = cachedActorKey()
  const normalizedEntity = String(entity || '').trim()
  const normalizedOutlet = String(outletId || '').trim()
  if (!actorKey || !normalizedEntity || !normalizedOutlet) return ''
  return `${actorKey}::${normalizedOutlet}::${normalizedEntity}`
}

function entityId(row = {}) {
  return String(row?.__realtime?.entity_id || row?.id || '').trim()
}

function updatedAt(row = {}) {
  return String(row?.__realtime?.updated_at || row?.updated_at || row?.updated_date || '').trim()
}

function maxCursor(rows = [], fallback = '') {
  let cursor = String(fallback || '')
  for (const row of rows || []) {
    const value = updatedAt(row)
    if (value && (!cursor || value > cursor)) cursor = value
  }
  return cursor
}

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.resolve(null)
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(RECORD_STORE)) {
        const records = database.createObjectStore(RECORD_STORE, { keyPath: 'cache_key' })
        records.createIndex('scope_key', 'scope_key')
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'scope_key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch((error) => {
    console.warn('Realtime device read cache is unavailable', error)
    return null
  })
  return databasePromise
}

async function getMeta(scope) {
  const database = await openDatabase()
  if (!database || !scope) return null
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(META_STORE, 'readonly')
    const request = transaction.objectStore(META_STORE).get(scope)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  }).catch(() => null)
}

async function getRows(scope) {
  const database = await openDatabase()
  if (!database || !scope) return []
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORD_STORE, 'readonly')
    const request = transaction.objectStore(RECORD_STORE).index('scope_key').getAll(scope)
    request.onsuccess = () => resolve((request.result || []).map((entry) => entry.record).filter(Boolean))
    request.onerror = () => reject(request.error)
  }).catch(() => [])
}

async function putMeta(scope, patch = {}) {
  const database = await openDatabase()
  if (!database || !scope) return
  const current = await getMeta(scope)
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(META_STORE, 'readwrite')
    transaction.objectStore(META_STORE).put({
      scope_key: scope,
      cursor: '',
      last_synced_at: 0,
      complete: true,
      ...(current || {}),
      ...(patch || {}),
    })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function mergeRows(scope, rows = []) {
  const database = await openDatabase()
  if (!database || !scope || !rows.length) return
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORD_STORE, 'readwrite')
    const store = transaction.objectStore(RECORD_STORE)
    for (const row of rows) {
      const id = entityId(row)
      if (!id) continue
      store.put({ cache_key: `${scope}::${id}`, scope_key: scope, record: row })
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function replaceRows(scope, rows = []) {
  const database = await openDatabase()
  if (!database || !scope) return
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORD_STORE, 'readwrite')
    const store = transaction.objectStore(RECORD_STORE)
    const index = store.index('scope_key')
    const keysRequest = index.getAllKeys(scope)
    keysRequest.onsuccess = () => {
      for (const key of keysRequest.result || []) store.delete(key)
      for (const row of rows) {
        const id = entityId(row)
        if (!id) continue
        store.put({ cache_key: `${scope}::${id}`, scope_key: scope, record: row })
      }
    }
    keysRequest.onerror = () => reject(keysRequest.error)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function markScopeStale(scope) {
  if (!scope) return
  await putMeta(scope, { last_synced_at: 0 })
}

async function refreshScope({ entity, outletId, fetchRemote }) {
  const scope = scopeKey(entity, outletId)
  if (!scope) {
    const response = await fetchRemote({ since: '', includeDeleted: true, limit: CACHE_DELTA_LIMIT, legacySeed: false })
    return Array.isArray(response?.records) ? response.records : []
  }
  if (refreshInflight.has(scope)) return refreshInflight.get(scope)

  const refresh = (async () => {
    const meta = await getMeta(scope)
    const cursor = String(meta?.cursor || '')
    const response = await fetchRemote({
      since: cursor,
      includeDeleted: true,
      limit: CACHE_DELTA_LIMIT,
      legacySeed: false,
    })
    let rows = Array.isArray(response?.records) ? response.records : []

    if (cursor && rows.length >= CACHE_DELTA_LIMIT) {
      const full = await fetchRemote({
        since: '',
        includeDeleted: true,
        limit: CACHE_DELTA_LIMIT,
        legacySeed: false,
      })
      rows = Array.isArray(full?.records) ? full.records : []
      await replaceRows(scope, rows)
      await putMeta(scope, {
        cursor: maxCursor(rows),
        last_synced_at: Date.now(),
        complete: rows.length < CACHE_DELTA_LIMIT,
        saturated_at: rows.length >= CACHE_DELTA_LIMIT ? Date.now() : 0,
      })
    } else if (cursor) {
      await mergeRows(scope, rows)
      await putMeta(scope, {
        cursor: maxCursor(rows, cursor),
        last_synced_at: Date.now(),
        complete: meta?.complete !== false,
      })
    } else {
      await replaceRows(scope, rows)
      await putMeta(scope, {
        cursor: maxCursor(rows),
        last_synced_at: Date.now(),
        complete: rows.length < CACHE_DELTA_LIMIT,
        saturated_at: rows.length >= CACHE_DELTA_LIMIT ? Date.now() : 0,
      })
    }

    const cached = await getRows(scope)
    window.dispatchEvent(new CustomEvent('chefops:realtime-cache-updated', {
      detail: { entity, outlet_id: outletId, count: cached.length, delta_count: rows.length },
    }))
    return cached
  })()

  refreshInflight.set(scope, refresh)
  try { return await refresh } finally { if (refreshInflight.get(scope) === refresh) refreshInflight.delete(scope) }
}

export async function readRealtimeRowsCached({ entity, outletId, fetchRemote, force = false } = {}) {
  const scope = scopeKey(entity, outletId)
  if (!scope) return refreshScope({ entity, outletId, fetchRemote })

  const [meta, cached] = await Promise.all([getMeta(scope), getRows(scope)])
  const age = meta?.last_synced_at ? Date.now() - Number(meta.last_synced_at) : Number.POSITIVE_INFINITY
  const fresh = !force && meta && meta.complete !== false && age < CACHE_FRESH_MS
  if (fresh) return cached

  if (!meta || meta.complete === false || force || !cached.length) {
    if (!navigator.onLine && meta) return cached
    return refreshScope({ entity, outletId, fetchRemote })
  }

  if (navigator.onLine && document.visibilityState === 'visible') {
    refreshScope({ entity, outletId, fetchRemote }).catch((error) => {
      console.warn(`Realtime ${entity} delta refresh failed`, error)
    })
  }
  return cached
}

async function applyLocalMutation(mutation = {}, committed = false) {
  const entity = String(mutation.entity || '').trim()
  const outletId = String(mutation.outlet_id || '').trim()
  const scope = scopeKey(entity, outletId)
  if (!scope) return
  const operation = String(mutation.operation || (mutation.event?.type?.endsWith('.deleted') ? 'delete' : '')).toLowerCase()
  const timestamp = String(mutation.committed_at || mutation.queued_at || new Date().toISOString())
  const sourceRecord = mutation.record || mutation.payload || {}
  const id = String(mutation.entity_id || entityId(sourceRecord) || '').trim()
  if (!id) return
  const record = {
    ...sourceRecord,
    id: sourceRecord.id || id,
    __realtime: {
      ...(sourceRecord.__realtime || {}),
      entity,
      entity_id: id,
      outlet_id: outletId,
      version: mutation.version ?? sourceRecord.__realtime?.version,
      updated_at: committed ? timestamp : (sourceRecord.__realtime?.updated_at || ''),
      deleted_at: operation === 'delete' ? timestamp : (sourceRecord.__realtime?.deleted_at || ''),
      sync_status: committed ? (mutation.sync_status || 'pending') : 'queued_device',
      mutation_id: mutation.mutation_id || sourceRecord.__realtime?.mutation_id || '',
    },
  }
  await mergeRows(scope, [record])
  await markScopeStale(scope)
}

function installMutationListeners() {
  if (listenersInstalled || typeof window === 'undefined') return
  listenersInstalled = true
  window.addEventListener('chefops:mutation-queued', (event) => {
    applyLocalMutation(event.detail || {}, false).catch(() => undefined)
  })
  window.addEventListener('chefops:mutation-committed', (event) => {
    applyLocalMutation(event.detail || {}, true).catch(() => undefined)
  })
  window.addEventListener('chefops:mutation-rejected', (event) => {
    const mutation = event.detail?.mutation || {}
    markScopeStale(scopeKey(mutation.entity, mutation.outlet_id)).catch(() => undefined)
  })
}

installMutationListeners()

export { CACHE_DELTA_LIMIT, CACHE_FRESH_MS }
