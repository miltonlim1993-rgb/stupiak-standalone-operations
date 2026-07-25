const DB_NAME = 'chefops-media-drafts'
const STORE_NAME = 'drafts'
const DB_VERSION = 1

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('module_scope', ['module', 'scope_key'], { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Unable to open media draft storage'))
  })
}

function transaction(mode, callback) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const store = tx.objectStore(STORE_NAME)
    let value
    try { value = callback(store) } catch (error) { reject(error); return }
    tx.oncomplete = () => resolve(value)
    tx.onerror = () => reject(tx.error || new Error('Unable to update media draft storage'))
    tx.onabort = () => reject(tx.error || new Error('Media draft transaction aborted'))
  }))
}

export function createMediaDraftId(prefix = 'media') {
  return `${prefix}-${Date.now()}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`
}

export async function saveMediaDraft({ id, module, scopeKey, file, meta = {} }) {
  const record = {
    id: String(id),
    module: String(module),
    scope_key: String(scopeKey),
    file,
    file_name: file?.name || meta.file_name || 'attachment',
    file_type: file?.type || meta.file_type || 'application/octet-stream',
    file_size: Number(file?.size || meta.file_size || 0),
    last_modified: Number(file?.lastModified || meta.last_modified || Date.now()),
    meta,
    updated_at: new Date().toISOString(),
    created_at: meta.created_at || new Date().toISOString(),
  }
  await transaction('readwrite', (store) => store.put(record))
  return record
}

export async function listMediaDrafts({ module, scopeKey }) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const index = tx.objectStore(STORE_NAME).index('module_scope')
    const request = index.getAll([String(module), String(scopeKey)])
    request.onsuccess = () => {
      const rows = (request.result || []).map((row) => {
        const stored = row.file
        const file = stored instanceof File
          ? stored
          : new File([stored], row.file_name || 'attachment', {
            type: row.file_type || stored?.type || 'application/octet-stream',
            lastModified: Number(row.last_modified || Date.now()),
          })
        return { ...row, file }
      }).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      resolve(rows)
    }
    request.onerror = () => reject(request.error || new Error('Unable to read media drafts'))
  })
}

export async function removeMediaDraft(id) {
  await transaction('readwrite', (store) => store.delete(String(id)))
}

export async function clearMediaDrafts({ module, scopeKey }) {
  const rows = await listMediaDrafts({ module, scopeKey })
  if (!rows.length) return
  await transaction('readwrite', (store) => rows.forEach((row) => store.delete(row.id)))
}
