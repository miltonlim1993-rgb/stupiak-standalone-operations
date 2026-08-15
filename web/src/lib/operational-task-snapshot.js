const DATABASE_NAME = 'chefops-operational-task-snapshots'
const DATABASE_VERSION = 1
const STORE_NAME = 'snapshots'
const CACHED_USER_KEY = 'chefops.auth.cached-user'

let databasePromise = null

function actorKey() {
  try {
    const user = JSON.parse(localStorage.getItem(CACHED_USER_KEY) || 'null')
    return String(user?.id || user?.google_sub || user?.email || '').trim()
  } catch {
    return ''
  }
}

function snapshotKey(outletId, date) {
  const actor = actorKey()
  if (!actor || !outletId || !date) return ''
  return `${actor}::${String(outletId)}::${String(date)}`
}

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.resolve(null)
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'snapshot_key' })
        store.createIndex('actor_key', 'actor_key')
        store.createIndex('outlet_id', 'outlet_id')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch((error) => {
    console.warn('Operational Task snapshot cache is unavailable', error)
    return null
  })
  return databasePromise
}

export async function saveOperationalTaskSnapshot(outletId, date, data) {
  const database = await openDatabase()
  const key = snapshotKey(outletId, date)
  const actor = actorKey()
  if (!database || !key || !actor || !data) return false
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put({
      snapshot_key: key,
      actor_key: actor,
      outlet_id: String(outletId),
      date: String(date),
      saved_at: new Date().toISOString(),
      data,
    })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  return true
}

export async function loadOperationalTaskSnapshot(outletId, date) {
  const database = await openDatabase()
  const key = snapshotKey(outletId, date)
  if (!database || !key) return null
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result?.data || null)
    request.onerror = () => reject(request.error)
  }).catch(() => null)
}

export async function updateOperationalTaskSnapshot(outletId, date, task) {
  if (!task?.id) return false
  const current = await loadOperationalTaskSnapshot(outletId, date)
  if (!current) return false
  const tasks = Array.isArray(current.tasks) ? current.tasks : []
  const nextTasks = tasks.some((row) => String(row.id) === String(task.id))
    ? tasks.map((row) => String(row.id) === String(task.id) ? task : row)
    : [task, ...tasks]
  return saveOperationalTaskSnapshot(outletId, date, {
    ...current,
    tasks: nextTasks,
    server_time: current.server_time || new Date().toISOString(),
    device_snapshot_updated_at: new Date().toISOString(),
  })
}

export { DATABASE_NAME as OPERATIONAL_TASK_SNAPSHOT_DATABASE_NAME }
