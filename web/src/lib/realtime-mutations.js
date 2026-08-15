import {
  commitOptimisticTaskPhoto,
  queueOptimisticTaskPhoto,
  rejectOptimisticTaskPhoto,
  trackOptimisticTaskPhoto,
} from '@/lib/task-photo-optimistic'
import { taskPhotoEntityId } from '@/lib/task-photo-persistence'

const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')
const DATABASE_NAME = 'chefops-realtime-mutations'
const STORE_NAME = 'pending'
const DATABASE_VERSION = 1
const CACHED_USER_KEY = 'chefops.auth.cached-user'
const NETWORK_BATCH_LIMIT = 50
const SERVER_BATCH_LIMIT = 100
const NETWORK_BATCH_WINDOW_MS = 80
const LOCAL_RETRY_BASE_MS = 30_000
const LOCAL_RETRY_MAX_MS = 15 * 60_000

let databasePromise = null
let flushPromise = null
let installed = false
let networkBatchTimer = null
let networkBatchItems = []
let networkBatchPromise = null

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.resolve(null)
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'mutation_id' })
        store.createIndex('queued_at', 'queued_at')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch((error) => {
    console.warn('Realtime device outbox is unavailable', error)
    return null
  })
  return databasePromise
}

async function withStore(mode, action) {
  const database = await openDatabase()
  if (!database) return null
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)
    let result
    try { result = action(store) } catch (error) { reject(error); return }
    transaction.oncomplete = () => resolve(result?.result ?? result ?? null)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

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
  return Math.min(LOCAL_RETRY_BASE_MS * (2 ** exponent), LOCAL_RETRY_MAX_MS)
}

function retryAt(attempts) {
  return new Date(Date.now() + retryDelayMs(attempts)).toISOString()
}

async function savePending(mutation) {
  const database = await openDatabase()
  if (!database) return false
  await withStore('readwrite', (store) => store.put(mutation))
  window.dispatchEvent(new CustomEvent('chefops:mutation-queued', { detail: mutation }))
  return true
}

async function removePending(mutationId) {
  await withStore('readwrite', (store) => store.delete(mutationId))
}

async function listPending() {
  const database = await openDatabase()
  if (!database) return []
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).index('queued_at').getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  }).catch(() => [])
}

function mutationId(value) {
  const supplied = String(value || '').trim()
  return supplied || crypto.randomUUID()
}

function queuedResult(mutation) {
  const record = {
    ...(mutation.payload || {}),
    id: mutation.entity_id || mutation.payload?.id || '',
    client_upload_state: mutation.entity === 'TaskPhoto' ? 'queued_offline' : undefined,
    __realtime: {
      mutation_id: mutation.mutation_id,
      outlet_id: mutation.outlet_id,
      sync_status: 'queued_device',
      queued_at: mutation.queued_at,
    },
  }
  return {
    ok: true,
    queued_offline: true,
    queued_device: true,
    mutation_id: mutation.mutation_id,
    entity: mutation.entity,
    entity_id: mutation.entity_id,
    outlet_id: mutation.outlet_id,
    record,
    sync_status: 'queued_device',
  }
}

function responseError(data, status, fallbackCode = 'realtime_mutation_failed') {
  const error = new Error(data?.error || data?.message || `Realtime mutation failed (${status})`)
  error.status = status
  error.code = data?.code || fallbackCode
  error.details = data?.details
  error.current_version = data?.current_version
  return error
}

async function postMutation(mutation) {
  const response = await fetch(`${API_BASE_URL}/api/realtime/mutations`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-ChefOps-Mutation-Id': mutation.mutation_id,
    },
    body: JSON.stringify(mutation),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw responseError(data, response.status)
  return data
}

async function postMutationBatch(mutations) {
  if (!mutations.length) return { ok: true, results: [] }
  if (mutations.length > SERVER_BATCH_LIMIT) throw new Error('Realtime mutation batch exceeds server limit')
  const response = await fetch(`${API_BASE_URL}/api/realtime/mutations/batch`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutations }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw responseError(data, response.status, 'realtime_mutation_batch_failed')
  return data
}

function shouldQueue(error) {
  const status = Number(error?.status)
  if (!navigator.onLine || !Number.isFinite(status)) return true
  if (status === 401 || status === 408 || status === 425 || status === 429) return true
  return status >= 500
}

function canonicalMutationInput(input = {}) {
  const entity = String(input.entity || '').trim()
  const operation = String(input.operation || 'upsert').trim().toLowerCase()
  const stablePhotoId = entity === 'TaskPhoto' && operation === 'create'
    ? taskPhotoEntityId(input.payload || {})
    : ''
  const entityId = stablePhotoId
    || String(input.entity_id || input.payload?.id || '').trim()
    || crypto.randomUUID()
  const suppliedMutationId = String(input.mutation_id || '').trim()
  const idempotentPhotoMutationId = stablePhotoId ? `task-photo-create:${stablePhotoId}` : ''
  const payload = entity === 'TaskPhoto' && operation === 'create'
    ? { ...(input.payload || {}), id: entityId }
    : (input.payload || {})

  return {
    mutation_id: mutationId(suppliedMutationId || idempotentPhotoMutationId),
    entity,
    entity_id: entityId,
    outlet_id: String(input.outlet_id || payload?.outlet_id || '').trim(),
    operation,
    expected_version: input.expected_version,
    requested_at: input.requested_at || new Date().toISOString(),
    queued_at: input.queued_at || new Date().toISOString(),
    actor_key: String(input.actor_key || cachedActorKey()),
    payload,
  }
}

async function runNetworkBatch() {
  if (networkBatchPromise) return networkBatchPromise
  if (networkBatchTimer) {
    window.clearTimeout(networkBatchTimer)
    networkBatchTimer = null
  }

  const items = networkBatchItems.splice(0, NETWORK_BATCH_LIMIT)
  if (!items.length) return null

  networkBatchPromise = (async () => {
    try {
      const response = await postMutationBatch(items.map((item) => item.mutation))
      const byId = new Map((response?.results || []).map((item) => [String(item.mutation_id || ''), item]))
      for (const item of items) {
        const result = byId.get(item.mutation.mutation_id)
        if (result?.ok) item.resolve(result.result)
        else item.reject(responseError(result || {}, Number(result?.status || 500)))
      }
    } catch (error) {
      items.forEach((item) => item.reject(error))
    } finally {
      networkBatchPromise = null
      if (networkBatchItems.length) {
        networkBatchTimer = window.setTimeout(() => void runNetworkBatch(), 0)
      }
    }
  })()

  return networkBatchPromise
}

function postMutationBatched(mutation) {
  return new Promise((resolve, reject) => {
    networkBatchItems.push({ mutation, resolve, reject })
    if (networkBatchItems.length >= NETWORK_BATCH_LIMIT) {
      void runNetworkBatch()
      return
    }
    if (!networkBatchTimer) {
      networkBatchTimer = window.setTimeout(() => void runNetworkBatch(), NETWORK_BATCH_WINDOW_MS)
    }
  })
}

async function deferPending(mutation, error) {
  const attempts = Number(mutation.attempts || 0) + 1
  await savePending({
    ...mutation,
    attempts,
    last_error: error?.message || String(error),
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: retryAt(attempts),
  })
}

export async function submitRealtimeMutation(input, { queueOffline = true } = {}) {
  const mutation = canonicalMutationInput(input)
  const allowDeviceOutbox = queueOffline && mutation.entity !== 'TaskPhoto'

  trackOptimisticTaskPhoto(mutation, 'uploading')

  let stored = false
  if (allowDeviceOutbox) {
    stored = await savePending({
      ...mutation,
      attempts: Number(input.attempts || 0),
      last_error: '',
      next_attempt_at: new Date().toISOString(),
    })
  }

  if (!navigator.onLine && allowDeviceOutbox) {
    if (!stored) {
      const error = new Error('Offline save is unavailable because this device cannot open its local outbox')
      error.code = 'device_outbox_unavailable'
      throw error
    }
    queueOptimisticTaskPhoto(mutation, 'Waiting for network')
    return queuedResult(mutation)
  }

  try {
    const result = allowDeviceOutbox
      ? await postMutationBatched(mutation)
      : await postMutation(mutation)
    if (allowDeviceOutbox) await removePending(mutation.mutation_id).catch(() => undefined)
    commitOptimisticTaskPhoto(mutation, result)
    window.dispatchEvent(new CustomEvent('chefops:mutation-committed', { detail: result }))
    return result
  } catch (error) {
    if (!allowDeviceOutbox || !shouldQueue(error)) {
      if (allowDeviceOutbox) await removePending(mutation.mutation_id).catch(() => undefined)
      rejectOptimisticTaskPhoto(mutation, error.message || String(error))
      throw error
    }
    if (!stored) {
      const saved = await savePending({
        ...mutation,
        attempts: 1,
        last_error: error.message || String(error),
        last_attempt_at: new Date().toISOString(),
        next_attempt_at: retryAt(1),
      })
      if (!saved) throw error
    } else {
      await deferPending(mutation, error)
    }
    queueOptimisticTaskPhoto(mutation, error.message || String(error))
    return queuedResult(mutation)
  }
}

export async function flushRealtimeMutationQueue() {
  if (flushPromise) return flushPromise
  flushPromise = (async () => {
    const allPending = await listPending()
    if (!navigator.onLine) return { flushed: 0, pending: allPending.length }

    const actorKey = cachedActorKey()
    if (!actorKey) return { flushed: 0, pending: allPending.length, blocked_auth: true }

    const nowMs = Date.now()
    const eligible = allPending.filter((mutation) => {
      if (mutation.actor_key && mutation.actor_key !== actorKey) return false
      const nextAttempt = Date.parse(String(mutation.next_attempt_at || mutation.queued_at || ''))
      return !Number.isFinite(nextAttempt) || nextAttempt <= nowMs
    })

    let flushed = 0
    for (let offset = 0; offset < eligible.length; offset += NETWORK_BATCH_LIMIT) {
      const chunk = eligible.slice(offset, offset + NETWORK_BATCH_LIMIT)
      let response
      try {
        response = await postMutationBatch(chunk)
      } catch (error) {
        for (const mutation of chunk) await deferPending(mutation, error)
        break
      }

      const byId = new Map((response?.results || []).map((item) => [String(item.mutation_id || ''), item]))
      let transientFailure = false
      for (const mutation of chunk) {
        const item = byId.get(mutation.mutation_id)
        if (item?.ok) {
          const result = item.result
          await removePending(mutation.mutation_id)
          commitOptimisticTaskPhoto(mutation, result)
          flushed += 1
          window.dispatchEvent(new CustomEvent('chefops:mutation-committed', { detail: result }))
          continue
        }

        const error = responseError(item || {}, Number(item?.status || 500))
        if (shouldQueue(error)) {
          await deferPending(mutation, error)
          queueOptimisticTaskPhoto(mutation, error.message || String(error))
          transientFailure = true
          continue
        }

        await removePending(mutation.mutation_id)
        rejectOptimisticTaskPhoto(mutation, error.message || String(error))
        window.dispatchEvent(new CustomEvent('chefops:mutation-rejected', {
          detail: {
            mutation,
            error: error.message || String(error),
            status: error.status || 0,
            code: error.code || '',
          },
        }))
      }
      if (transientFailure) break
    }

    return { flushed, pending: (await listPending()).length }
  })()
  try { return await flushPromise } finally { flushPromise = null }
}

export function installRealtimeMutationQueue() {
  if (installed) return
  installed = true
  window.addEventListener('online', () => {
    flushRealtimeMutationQueue().catch((error) => console.warn('Realtime device outbox flush failed', error))
  })
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      flushRealtimeMutationQueue().catch(() => undefined)
    }
  })
  window.setInterval(() => {
    if (navigator.onLine && document.visibilityState === 'visible') {
      flushRealtimeMutationQueue().catch(() => undefined)
    }
  }, 30_000)
  window.addEventListener('load', () => {
    flushRealtimeMutationQueue().catch(() => undefined)
  }, { once: true })
}

export async function pendingRealtimeMutationCount() {
  return (await listPending()).length
}
