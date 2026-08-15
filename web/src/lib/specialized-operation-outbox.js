import { invalidateRealtimeReadCache } from '@/lib/realtime-read-cache'

const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')
const DATABASE_NAME = 'chefops-specialized-operation-outbox'
const DATABASE_VERSION = 1
const STORE_NAME = 'operations'
const CACHED_USER_KEY = 'chefops.auth.cached-user'
const FLUSH_INTERVAL_MS = 60_000
const FLUSH_LIMIT = 50
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 15 * 60_000

let databasePromise = null
let flushPromise = null
let installed = false

function cachedActorKey() {
  try {
    const user = JSON.parse(localStorage.getItem(CACHED_USER_KEY) || 'null')
    return String(user?.id || user?.google_sub || user?.email || '').trim()
  } catch {
    return ''
  }
}

function retryDelayMs(attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 5))
  return Math.min(RETRY_BASE_MS * (2 ** exponent), RETRY_MAX_MS)
}

function retryAt(attempts) {
  return new Date(Date.now() + retryDelayMs(attempts)).toISOString()
}

function operationId(value) {
  const supplied = String(value || '').trim()
  return supplied || crypto.randomUUID()
}

function mutationId(kind, supplied = '') {
  const value = String(supplied || '').trim()
  return (value || `${kind}:${crypto.randomUUID()}`).slice(0, 160)
}

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.resolve(null)
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'operation_id' })
        store.createIndex('actor_key', 'actor_key')
        store.createIndex('queued_at', 'queued_at')
        store.createIndex('attention_key', 'attention_key')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch((error) => {
    console.warn('Specialized operation outbox is unavailable', error)
    return null
  })
  return databasePromise
}

async function putOperation(operation) {
  const database = await openDatabase()
  if (!database) return false
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(operation)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  return true
}

async function removeOperation(id) {
  const database = await openDatabase()
  if (!database) return
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  }).catch(() => undefined)
}

async function actorOperations(actorKey = cachedActorKey()) {
  const database = await openDatabase()
  if (!database || !actorKey) return []
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).index('actor_key').getAll(actorKey)
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  }).catch(() => [])
}

async function clearAttention(operation) {
  if (!operation.attention_key) return
  const rows = await actorOperations(operation.actor_key)
  await Promise.all(rows
    .filter((row) => row.operation_id !== operation.operation_id
      && row.status === 'needs_attention'
      && row.attention_key === operation.attention_key)
    .map((row) => removeOperation(row.operation_id)))
}

function responseError(data, status, fallbackCode = 'specialized_operation_failed') {
  const message = typeof data === 'string'
    ? data
    : (data?.error || data?.message || `Operation failed (${status})`)
  const error = new Error(message)
  error.status = status
  error.code = typeof data === 'object' && data ? (data.code || fallbackCode) : fallbackCode
  error.details = typeof data === 'object' && data ? data.details : undefined
  return error
}

async function sendOperation(operation) {
  const headers = new Headers(operation.headers || {})
  headers.set('Content-Type', 'application/json')
  headers.set('X-ChefOps-Mutation-Id', operation.mutation_id)
  const response = await fetch(`${API_BASE_URL}${operation.path}`, {
    method: operation.method || 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers,
    body: JSON.stringify(operation.payload || {}),
  })
  const contentType = response.headers.get('content-type') || ''
  const data = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => '')
  if (!response.ok) throw responseError(data, response.status)
  return data
}

function shouldQueue(error) {
  const status = Number(error?.status)
  if (!navigator.onLine || !Number.isFinite(status)) return true
  if ([401, 408, 425, 429].includes(status)) return true
  return status >= 500
}

function normalizeOperation(input = {}) {
  const kind = String(input.kind || '').trim()
  const actorKey = String(input.actor_key || cachedActorKey()).trim()
  if (!kind) throw new Error('Specialized operation kind is required')
  if (!actorKey) {
    const error = new Error('Cannot stage this operation until an authenticated device identity is available')
    error.code = 'device_outbox_auth_unavailable'
    throw error
  }
  const id = operationId(input.operation_id)
  const payload = { ...(input.payload || {}) }
  const stableMutationId = mutationId(kind, payload.mutation_id || input.mutation_id)
  payload.mutation_id = stableMutationId
  return {
    operation_id: id,
    mutation_id: stableMutationId,
    kind,
    path: String(input.path || '').trim(),
    method: String(input.method || 'POST').toUpperCase(),
    headers: input.headers || {},
    payload,
    preview: input.preview || null,
    entity_hint: String(input.entity_hint || '').trim(),
    entity_id_hint: String(input.entity_id_hint || '').trim(),
    outlet_id: String(input.outlet_id || payload.outlet_id || '').trim(),
    scope_key: String(input.scope_key || '').trim(),
    attention_key: String(input.attention_key || input.scope_key || '').trim(),
    actor_key: actorKey,
    queued_at: input.queued_at || new Date().toISOString(),
    requested_at: input.requested_at || new Date().toISOString(),
    attempts: Number(input.attempts || 0),
    last_error: '',
    last_status: 0,
    next_attempt_at: new Date().toISOString(),
    status: 'queued_device',
  }
}

function queuedResult(operation, factory) {
  const base = {
    ok: true,
    queued_offline: true,
    queued_device: true,
    operation_id: operation.operation_id,
    mutation_id: operation.mutation_id,
    kind: operation.kind,
    outlet_id: operation.outlet_id,
    sync_status: 'queued_device',
    queued_at: operation.queued_at,
  }
  return typeof factory === 'function' ? factory(operation, base) : base
}

function dispatch(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

async function invalidateCanonicalCache(operation, result) {
  if (operation.entity_hint && operation.outlet_id) {
    await invalidateRealtimeReadCache(operation.entity_hint, operation.outlet_id).catch(() => undefined)
  }

  let record = null
  let entity = operation.entity_hint
  if (operation.kind === 'task-action') {
    record = result?.task || null
    entity = 'Task'
  } else if (operation.kind === 'close-up-upsert') {
    record = result?.record || result || null
    entity = 'CloseUp'
  }

  if (!record?.id || !entity) return
  dispatch('chefops:mutation-committed', {
    entity,
    entity_id: record.id,
    outlet_id: record.outlet_id || operation.outlet_id,
    version: Number(record?.__realtime?.version || 0),
    committed_at: record?.__realtime?.updated_at || record.updated_date || new Date().toISOString(),
    record,
    sync_status: record?.__realtime?.sync_status || 'pending',
  })
}

async function commitOperation(operation, result) {
  await removeOperation(operation.operation_id)
  await clearAttention(operation)
  await invalidateCanonicalCache(operation, result)
  dispatch('chefops:specialized-operation-committed', { operation, result })
  dispatch('chefops:specialized-operation-state', { operation, phase: 'synced', result })
  return result
}

async function deferOperation(operation, error) {
  const attempts = Number(operation.attempts || 0) + 1
  const deferred = {
    ...operation,
    attempts,
    last_error: error?.message || String(error),
    last_status: Number(error?.status || 0),
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: retryAt(attempts),
    status: 'queued_device',
  }
  await putOperation(deferred)
  dispatch('chefops:specialized-operation-state', { operation: deferred, phase: 'device_saved', error: deferred.last_error })
  return deferred
}

async function markNeedsAttention(operation, error) {
  const failed = {
    ...operation,
    attempts: Number(operation.attempts || 0) + 1,
    last_error: error?.message || String(error),
    last_status: Number(error?.status || 0),
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: '',
    status: 'needs_attention',
  }
  await putOperation(failed)
  dispatch('chefops:specialized-operation-attention', { operation: failed, error: failed.last_error, status: failed.last_status })
  dispatch('chefops:specialized-operation-state', { operation: failed, phase: 'needs_attention', error: failed.last_error })
  return failed
}

export async function submitSpecializedOperation(input, { queuedResult: queuedFactory } = {}) {
  const operation = normalizeOperation(input)
  await clearAttention(operation)
  const stored = await putOperation(operation)
  if (!stored) {
    const error = new Error('This device cannot open its durable operation outbox')
    error.code = 'device_outbox_unavailable'
    throw error
  }

  dispatch('chefops:specialized-operation-queued', { operation })
  dispatch('chefops:specialized-operation-state', { operation, phase: 'device_saved' })

  if (!navigator.onLine) return queuedResult(operation, queuedFactory)

  try {
    const syncing = { ...operation, status: 'syncing', last_attempt_at: new Date().toISOString() }
    await putOperation(syncing)
    dispatch('chefops:specialized-operation-state', { operation: syncing, phase: 'syncing' })
    const result = await sendOperation(syncing)
    return await commitOperation(syncing, result)
  } catch (error) {
    if (shouldQueue(error)) {
      await deferOperation(operation, error)
      return queuedResult(operation, queuedFactory)
    }
    await markNeedsAttention(operation, error)
    throw error
  }
}

export async function listSpecializedOperations({ kind = '', outletId = '', status = '', scopeKey = '' } = {}) {
  const actorKey = cachedActorKey()
  if (!actorKey) return []
  const statuses = new Set(Array.isArray(status) ? status.map(String) : (status ? [String(status)] : []))
  const rows = await actorOperations(actorKey)
  return rows
    .filter((row) => !kind || row.kind === kind)
    .filter((row) => !outletId || String(row.outlet_id || '') === String(outletId))
    .filter((row) => !scopeKey || row.scope_key === scopeKey)
    .filter((row) => !statuses.size || statuses.has(String(row.status || '')))
    .sort((left, right) => String(left.queued_at || '').localeCompare(String(right.queued_at || '')))
}

export async function flushSpecializedOperationQueue() {
  if (flushPromise) return flushPromise
  flushPromise = (async () => {
    if (!navigator.onLine) return { flushed: 0, pending: (await listSpecializedOperations()).length }
    const actorKey = cachedActorKey()
    if (!actorKey) return { flushed: 0, pending: 0, blocked_auth: true }

    const nowMs = Date.now()
    const rows = (await actorOperations(actorKey))
      .filter((operation) => operation.status !== 'needs_attention')
      .filter((operation) => {
        const nextAttempt = Date.parse(String(operation.next_attempt_at || operation.queued_at || ''))
        return !Number.isFinite(nextAttempt) || nextAttempt <= nowMs
      })
      .sort((left, right) => String(left.queued_at || '').localeCompare(String(right.queued_at || '')))
      .slice(0, FLUSH_LIMIT)

    let flushed = 0
    for (const operation of rows) {
      try {
        const syncing = { ...operation, status: 'syncing', last_attempt_at: new Date().toISOString() }
        await putOperation(syncing)
        dispatch('chefops:specialized-operation-state', { operation: syncing, phase: 'syncing' })
        const result = await sendOperation(syncing)
        await commitOperation(syncing, result)
        flushed += 1
      } catch (error) {
        if (shouldQueue(error)) {
          await deferOperation(operation, error)
          break
        }
        await markNeedsAttention(operation, error)
      }
    }

    const remaining = await listSpecializedOperations()
    return {
      flushed,
      pending: remaining.filter((row) => row.status !== 'needs_attention').length,
      needs_attention: remaining.filter((row) => row.status === 'needs_attention').length,
    }
  })()

  try { return await flushPromise } finally { flushPromise = null }
}

export function installSpecializedOperationQueue() {
  if (installed) return
  installed = true
  window.addEventListener('online', () => {
    flushSpecializedOperationQueue().catch((error) => console.warn('Specialized operation outbox flush failed', error))
  })
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      flushSpecializedOperationQueue().catch(() => undefined)
    }
  })
  window.setInterval(() => {
    if (navigator.onLine && document.visibilityState === 'visible') {
      flushSpecializedOperationQueue().catch(() => undefined)
    }
  }, FLUSH_INTERVAL_MS)
  window.addEventListener('load', () => {
    flushSpecializedOperationQueue().catch(() => undefined)
  }, { once: true })
}

export { DATABASE_NAME as SPECIALIZED_OUTBOX_DATABASE_NAME, FLUSH_INTERVAL_MS as SPECIALIZED_OUTBOX_FLUSH_INTERVAL_MS }
