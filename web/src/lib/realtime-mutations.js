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

let databasePromise = null
let flushPromise = null
let installed = false

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
    console.warn('Realtime offline queue is unavailable', error)
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

async function savePending(mutation) {
  await withStore('readwrite', (store) => store.put(mutation))
  window.dispatchEvent(new CustomEvent('chefops:mutation-queued', { detail: mutation }))
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
      sync_status: 'queued_offline',
      queued_at: mutation.queued_at,
    },
  }
  return {
    ok: true,
    queued_offline: true,
    mutation_id: mutation.mutation_id,
    entity: mutation.entity,
    entity_id: mutation.entity_id,
    outlet_id: mutation.outlet_id,
    record,
    sync_status: 'queued_offline',
  }
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
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Realtime mutation failed (${response.status})`)
    error.status = response.status
    error.code = data.code || 'realtime_mutation_failed'
    error.details = data.details
    throw error
  }
  return data
}

function shouldQueue(error) {
  return !navigator.onLine || !Number.isFinite(Number(error?.status)) || Number(error.status) >= 500
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
    payload,
  }
}

export async function submitRealtimeMutation(input, { queueOffline = true } = {}) {
  const mutation = canonicalMutationInput(input)
  const allowOfflineQueue = queueOffline && mutation.entity !== 'TaskPhoto'

  trackOptimisticTaskPhoto(mutation, 'uploading')

  try {
    const result = await postMutation(mutation)
    await removePending(mutation.mutation_id).catch(() => undefined)
    commitOptimisticTaskPhoto(mutation, result)
    window.dispatchEvent(new CustomEvent('chefops:mutation-committed', { detail: result }))
    return result
  } catch (error) {
    if (!allowOfflineQueue || !shouldQueue(error)) {
      rejectOptimisticTaskPhoto(mutation, error.message || String(error))
      throw error
    }
    await savePending({
      ...mutation,
      attempts: Number(input.attempts || 0),
      last_error: error.message || String(error),
    })
    queueOptimisticTaskPhoto(mutation, error.message || String(error))
    return queuedResult(mutation)
  }
}

export async function flushRealtimeMutationQueue() {
  if (flushPromise) return flushPromise
  flushPromise = (async () => {
    if (!navigator.onLine) return { flushed: 0, pending: (await listPending()).length }
    const pending = await listPending()
    let flushed = 0
    for (const mutation of pending) {
      try {
        trackOptimisticTaskPhoto(mutation, 'uploading')
        const result = await postMutation(mutation)
        await removePending(mutation.mutation_id)
        commitOptimisticTaskPhoto(mutation, result)
        flushed += 1
        window.dispatchEvent(new CustomEvent('chefops:mutation-committed', { detail: result }))
      } catch (error) {
        if (!shouldQueue(error)) {
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
          continue
        }
        await savePending({
          ...mutation,
          attempts: Number(mutation.attempts || 0) + 1,
          last_error: error.message || String(error),
          last_attempt_at: new Date().toISOString(),
        })
        queueOptimisticTaskPhoto(mutation, error.message || String(error))
        break
      }
    }
    return { flushed, pending: (await listPending()).length }
  })()
  try { return await flushPromise } finally { flushPromise = null }
}

export function installRealtimeMutationQueue() {
  if (installed) return
  installed = true
  window.addEventListener('online', () => {
    flushRealtimeMutationQueue().catch((error) => console.warn('Realtime mutation flush failed', error))
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
