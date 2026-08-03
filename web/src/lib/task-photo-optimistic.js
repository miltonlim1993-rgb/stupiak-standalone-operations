const STORAGE_KEY = 'chefops.task-photo.optimistic.v1'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const records = new Map()
let hydrated = false

function browserStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return fallback
  }
}

function hydrate() {
  if (hydrated) return
  hydrated = true
  const storage = browserStorage()
  const stored = safeParse(storage?.getItem(STORAGE_KEY), [])
  const now = Date.now()
  for (const entry of Array.isArray(stored) ? stored : []) {
    const savedAt = Number(entry?.client_saved_at || 0)
    if (!entry?.id || !savedAt || now - savedAt > MAX_AGE_MS) continue
    records.set(String(entry.id), entry)
  }
}

function persist() {
  const storage = browserStorage()
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify([...records.values()]))
  } catch {}
}

function announce(state, record, error = '') {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('chefops:task-photo-sync-state', {
    detail: {
      state,
      record,
      error: String(error || ''),
      task_id: String(record?.task_id || ''),
      photo_id: String(record?.id || ''),
    },
  }))
}

function mutationRecord(mutation = {}, state = 'uploading', resultRecord = null) {
  const payload = resultRecord || mutation.payload || {}
  const id = String(payload.id || mutation.entity_id || '').trim()
  if (!id) return null
  const timestamp = Date.now()
  return {
    ...payload,
    id,
    outlet_id: String(payload.outlet_id || mutation.outlet_id || ''),
    task_id: String(payload.task_id || ''),
    deleted_at: payload.deleted_at || '',
    status: payload.status || 'active',
    client_upload_state: state,
    client_saved_at: timestamp,
    __realtime: {
      ...(payload.__realtime || {}),
      mutation_id: String(mutation.mutation_id || payload?.__realtime?.mutation_id || ''),
      outlet_id: String(payload.outlet_id || mutation.outlet_id || ''),
      sync_status: state,
      queued_at: mutation.queued_at || payload?.__realtime?.queued_at || new Date(timestamp).toISOString(),
    },
  }
}

function isTaskPhotoMutation(mutation = {}) {
  return String(mutation.entity || '') === 'TaskPhoto'
}

function storeTaskPhoto(mutation, state, resultRecord = null, error = '') {
  hydrate()
  const operation = String(mutation.operation || 'upsert').toLowerCase()
  const record = mutationRecord(mutation, state, resultRecord)
  if (!record) return null

  if (operation === 'delete') {
    records.delete(record.id)
    persist()
    announce('deleted', record)
    return record
  }

  records.set(record.id, record)
  persist()
  announce(state, record, error)
  return record
}

export function trackOptimisticTaskPhoto(mutation = {}, state = 'uploading', resultRecord = null) {
  if (!isTaskPhotoMutation(mutation)) return null
  return storeTaskPhoto(mutation, state, resultRecord)
}

export function commitOptimisticTaskPhoto(mutation = {}, result = {}) {
  if (!isTaskPhotoMutation(mutation)) return null
  return storeTaskPhoto(mutation, 'committed', result.record || null)
}

export function queueOptimisticTaskPhoto(mutation = {}, error = '') {
  if (!isTaskPhotoMutation(mutation)) return null
  return storeTaskPhoto(mutation, 'queued_offline', null, error)
}

export function rejectOptimisticTaskPhoto(mutation = {}, error = '') {
  if (!isTaskPhotoMutation(mutation)) return
  hydrate()
  const id = String(mutation.entity_id || mutation.payload?.id || '').trim()
  const record = id ? records.get(id) || mutationRecord(mutation, 'rejected') : mutationRecord(mutation, 'rejected')
  if (id) records.delete(id)
  persist()
  announce('rejected', record, error)
}

export function mergeOptimisticTaskPhotos(data = {}, { outletId = '', includeUnconfirmed = true } = {}) {
  hydrate()
  const serverRows = Array.isArray(data?.task_photos) ? data.task_photos : []
  const merged = new Map(serverRows
    .map((row) => [String(row?.id || '').trim(), row])
    .filter(([id]) => id))
  const now = Date.now()
  let changed = false

  for (const [id, record] of records.entries()) {
    if (now - Number(record.client_saved_at || 0) > MAX_AGE_MS) {
      records.delete(id)
      changed = true
      continue
    }
    if (outletId && String(record.outlet_id || '') !== String(outletId)) continue

    const serverRecord = merged.get(id)
    if (serverRecord) {
      records.delete(id)
      changed = true
      merged.set(id, serverRecord)
      continue
    }
    if (!includeUnconfirmed) continue
    if (record.deleted_at || String(record.status || '').toLowerCase() === 'deleted') continue
    merged.set(id, record)
  }

  if (changed) persist()
  const rows = [...merged.values()]
  return {
    ...(data || {}),
    task_photos: rows,
    optimistic_task_photo_count: rows.filter((row) => row.client_upload_state).length,
  }
}

export function clearOptimisticTaskPhotos() {
  records.clear()
  persist()
}
