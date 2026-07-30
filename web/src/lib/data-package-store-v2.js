const DB_NAME = 'stupiaks-ops-data-package-v2'
const DB_VERSION = 2
const OBJECT_CACHE = 'stupiaks-ops-data-package-v2-objects-v2'

const RELEASES = 'releases'
const OBJECTS = 'objects'
const POINTERS = 'pointers'
const STAGING = 'staging'

let dbPromise = null
const objectUrls = new Map()

function clean(value = '') {
  return String(value ?? '').trim()
}

function outletKey(value = '') {
  return clean(value) || 'global'
}

function releaseKey(outletId, version) {
  return `${outletKey(outletId)}:${clean(version)}`
}

function pointerKey(outletId) {
  return `active:${outletKey(outletId)}`
}

function objectKey(kind, hash) {
  return `${kind}:${clean(hash).toLowerCase()}`
}

function storageError(message, code, cause, details = {}) {
  const error = new Error(message)
  error.code = code
  error.cause = cause
  error.details = {
    ...details,
    cause_name: clean(cause?.name),
    cause_message: clean(cause?.message),
  }
  return error
}

function closeDb() {
  const current = dbPromise
  dbPromise = null
  if (!current) return
  Promise.resolve(current).then((db) => db?.close?.()).catch(() => undefined)
}

function retryableStorageError(error) {
  return ['AbortError', 'InvalidStateError', 'NotFoundError', 'TransactionInactiveError', 'UnknownError']
    .includes(clean(error?.name || error?.cause?.name))
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function openDb({ reopen = false } = {}) {
  if (!('indexedDB' in window)) {
    throw storageError(
      'Local package storage is unavailable in this browser. Open the app in normal Safari/Chrome mode instead of Private Browsing and retry.',
      'data_package_storage_unavailable',
    )
  }
  if (reopen) closeDb()
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(RELEASES)) db.createObjectStore(RELEASES)
      if (!db.objectStoreNames.contains(OBJECTS)) db.createObjectStore(OBJECTS)
      if (!db.objectStoreNames.contains(POINTERS)) db.createObjectStore(POINTERS)
      if (!db.objectStoreNames.contains(STAGING)) db.createObjectStore(STAGING)
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        if (dbPromise) dbPromise = null
      }
      resolve(db)
    }
    request.onblocked = () => reject(storageError(
      'The local package database is still open in another app tab. Close the other tab and retry.',
      'data_package_storage_blocked',
      request.error,
    ))
    request.onerror = () => reject(storageError(
      'Unable to open local package storage on this device.',
      'data_package_storage_open_failed',
      request.error,
    ))
  }).catch((error) => {
    dbPromise = null
    throw error
  })

  return dbPromise
}

async function requestResult(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => resolve(null)
  })
}

async function dbGet(storeName, key) {
  try {
    const db = await openDb()
    const tx = db.transaction(storeName, 'readonly')
    return await requestResult(tx.objectStore(storeName).get(key))
  } catch {
    return null
  }
}

async function dbWriteOnce(storeName, key, value) {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    let request
    try {
      const tx = db.transaction(storeName, 'readwrite')
      request = tx.objectStore(storeName).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || request?.error || new DOMException(`Unable to write ${storeName}`, 'UnknownError'))
      tx.onabort = () => reject(tx.error || request?.error || new DOMException(`Unable to write ${storeName}`, 'AbortError'))
    } catch (error) {
      reject(error)
    }
  })
}

async function dbPut(storeName, key, value) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await dbWriteOnce(storeName, key, value)
      return
    } catch (error) {
      lastError = error
      closeDb()
      if (attempt >= 2 || !retryableStorageError(error)) break
      await sleep(120 * (attempt + 1))
      await openDb({ reopen: true }).catch(() => undefined)
    }
  }
  throw storageError(
    'Unable to save the downloaded operations package on this device. The current working release was kept. Repair local download storage and retry.',
    'data_package_storage_write_failed',
    lastError,
    { store: storeName, key },
  )
}

async function dbDelete(storeName, key) {
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      const request = tx.objectStore(storeName).delete(key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error || request.error)
      tx.onabort = () => reject(tx.error || request.error)
    })
  } catch {
    // Cleanup is best-effort and must never disable an already active release.
  }
}

async function dbEntries(storeName) {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readonly')
      const store = tx.objectStore(storeName)
      const rows = []
      const request = store.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve(rows)
          return
        }
        rows.push([cursor.key, cursor.value])
        cursor.continue()
      }
      request.onerror = () => resolve(rows)
    })
  } catch {
    return []
  }
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Blob) return value.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
}

function exactArrayBuffer(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
}

async function sha256Hex(value) {
  const bytes = await bytesFrom(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function verifyObject(value, expectedHash, expectedBytes = 0) {
  const bytes = await bytesFrom(value)
  if (Number(expectedBytes || 0) > 0 && bytes.byteLength !== Number(expectedBytes)) {
    throw storageError(
      `Package object size mismatch: expected ${expectedBytes}, received ${bytes.byteLength}.`,
      'data_package_object_size_mismatch',
      null,
      { expected_bytes: Number(expectedBytes), received_bytes: bytes.byteLength },
    )
  }
  const actual = await sha256Hex(bytes)
  const expected = clean(expectedHash).toLowerCase()
  if (expected && !actual.startsWith(expected)) {
    throw storageError(
      `Package object hash mismatch: expected ${expected}, received ${actual}.`,
      'data_package_object_hash_mismatch',
      null,
      { expected_hash: expected, actual_hash: actual },
    )
  }
  return { bytes, actualHash: actual }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Data package manifest is missing.')
  if (!manifest.version) throw new Error('Data package version is missing.')
  const formatVersion = Number(manifest.format_version || manifest.schema_version || 0)
  if (formatVersion < 2) throw new Error('This data package format is not supported.')
  if (!manifest.modules || typeof manifest.modules !== 'object') throw new Error('Data package modules are missing.')
  return manifest
}

function packageObjects(manifest) {
  const objects = []
  for (const [name, info] of Object.entries(manifest.modules || {})) {
    if (!info?.hash || !info?.path) continue
    objects.push({
      kind: 'module',
      name,
      hash: info.hash,
      bytes: Number(info.bytes || 0),
      path: info.path,
      mimeType: 'application/json',
    })
  }
  for (const [id, info] of Object.entries(manifest.media?.files || {})) {
    if (!info?.hash || !info?.path) continue
    objects.push({
      kind: 'media',
      name: id,
      hash: info.hash,
      bytes: Number(info.bytes || 0),
      path: info.path,
      mimeType: info.mime_type || 'application/octet-stream',
    })
  }
  return objects
}

async function fetchPackageObject(item, fetcher) {
  const response = await fetcher(item.path, item)
  if (response instanceof Response) {
    if (!response.ok) throw new Error(`Unable to download package object ${item.name} (${response.status}).`)
    return response.arrayBuffer()
  }
  return response
}

function cacheRequest(key) {
  const base = typeof location !== 'undefined' ? location.origin : 'https://stupiaks-ops.local'
  return new Request(`${base}/__chefops_package_object__/${encodeURIComponent(key)}`)
}

async function openObjectCache() {
  if (!('caches' in window)) return null
  try {
    return await caches.open(OBJECT_CACHE)
  } catch {
    return null
  }
}

async function writeObjectBody(key, bytes, mimeType) {
  const buffer = exactArrayBuffer(bytes)
  const cache = await openObjectCache()
  if (cache) {
    try {
      await cache.put(cacheRequest(key), new Response(buffer, {
        headers: {
          'Content-Type': mimeType || 'application/octet-stream',
          'Content-Length': String(buffer.byteLength),
          'Cache-Control': 'no-store',
        },
      }))
      return { storage_backend: 'cache-v2' }
    } catch {
      // Safari may reject one cache write while IndexedDB still works. Fall back below.
    }
  }
  return { storage_backend: 'indexeddb-arraybuffer-v2', body: buffer }
}

async function readObjectBytes(key, stored) {
  if (!stored?.verified) return null
  if (stored.storage_backend === 'cache-v2') {
    const cache = await openObjectCache()
    const response = await cache?.match(cacheRequest(key))
    if (!response) return null
    return new Uint8Array(await response.arrayBuffer())
  }
  if (stored.body instanceof ArrayBuffer) return new Uint8Array(stored.body)
  if (stored.body instanceof Uint8Array) return stored.body
  if (stored.blob instanceof Blob) return new Uint8Array(await stored.blob.arrayBuffer())
  return null
}

async function deleteObjectBody(key, stored = null) {
  if (!stored || stored.storage_backend === 'cache-v2') {
    try {
      const cache = await openObjectCache()
      await cache?.delete(cacheRequest(key))
    } catch {}
  }
}

async function storedObjectUsable(key, stored) {
  if (!stored?.verified) return false
  const bytes = await readObjectBytes(key, stored)
  return Boolean(bytes && bytes.byteLength === Number(stored.bytes || bytes.byteLength))
}

async function persistVerifiedObject(key, item, verified) {
  const body = await writeObjectBody(key, verified.bytes, item.mimeType)
  try {
    await dbPut(OBJECTS, key, {
      kind: item.kind,
      hash: item.hash,
      actual_hash: verified.actualHash,
      bytes: verified.bytes.byteLength,
      mime_type: item.mimeType,
      ...body,
      verified: true,
      stored_at: new Date().toISOString(),
    })
  } catch (error) {
    if (body.storage_backend === 'cache-v2') await deleteObjectBody(key, body)
    throw error
  }
}

async function activateStagedRelease(outletId, manifest, objectReferences) {
  const db = await openDb()
  const target = releaseKey(outletId, manifest.version)
  const previousPointer = await dbGet(POINTERS, pointerKey(outletId))

  await new Promise((resolve, reject) => {
    const tx = db.transaction([RELEASES, POINTERS, STAGING], 'readwrite')
    tx.objectStore(RELEASES).put({
      manifest,
      object_references: objectReferences,
      installed_at: new Date().toISOString(),
      verified: true,
    }, target)
    tx.objectStore(POINTERS).put({
      outlet_id: outletKey(outletId),
      version: manifest.version,
      release_key: target,
      previous_release_key: previousPointer?.release_key || '',
      activated_at: new Date().toISOString(),
    }, pointerKey(outletId))
    tx.objectStore(STAGING).delete(target)
    tx.oncomplete = resolve
    tx.onerror = () => reject(storageError(
      'Unable to activate the verified operations package. The previous release remains active.',
      'data_package_activation_failed',
      tx.error,
      { release_key: target },
    ))
    tx.onabort = () => reject(storageError(
      'Unable to activate the verified operations package. The previous release remains active.',
      'data_package_activation_failed',
      tx.error,
      { release_key: target },
    ))
  })
}

export async function stageAndActivateDataPackage({
  manifest,
  outletId = manifest?.outlet_id || '',
  fetcher = (path) => fetch(path, { credentials: 'include' }),
  onProgress = () => {},
} = {}) {
  validateManifest(manifest)
  const target = releaseKey(outletId, manifest.version)
  const objects = packageObjects(manifest)
  const totalBytes = objects.reduce((sum, item) => sum + Number(item.bytes || 0), 0)
  let completedBytes = 0
  let completedObjects = 0
  const references = {}

  await dbPut(STAGING, target, {
    outlet_id: outletKey(outletId),
    version: manifest.version,
    started_at: new Date().toISOString(),
    state: 'downloading',
    total_bytes: totalBytes,
    total_objects: objects.length,
  })

  try {
    for (const item of objects) {
      const key = objectKey(item.kind, item.hash)
      const existing = await dbGet(OBJECTS, key)
      if (await storedObjectUsable(key, existing)) {
        references[`${item.kind}:${item.name}`] = key
        completedBytes += Number(item.bytes || existing.bytes || 0)
        completedObjects += 1
        onProgress({ state: 'downloading', completedBytes, totalBytes, completedObjects, totalObjects: objects.length, item, reused: true })
        continue
      }
      if (existing) {
        await deleteObjectBody(key, existing)
        await dbDelete(OBJECTS, key)
      }

      const payload = await fetchPackageObject(item, fetcher)
      const verified = await verifyObject(payload, item.hash, item.bytes)
      await persistVerifiedObject(key, item, verified)

      references[`${item.kind}:${item.name}`] = key
      completedBytes += Number(item.bytes || verified.bytes.byteLength)
      completedObjects += 1
      onProgress({ state: 'downloading', completedBytes, totalBytes, completedObjects, totalObjects: objects.length, item, reused: false })
    }

    await activateStagedRelease(outletId, manifest, references)
    onProgress({ state: 'ready', completedBytes, totalBytes, completedObjects, totalObjects: objects.length, manifest })
    window.dispatchEvent(new CustomEvent('chefops:data-package-v2-activated', { detail: { outlet_id: outletKey(outletId), manifest } }))
    return manifest
  } catch (error) {
    await dbPut(STAGING, target, {
      outlet_id: outletKey(outletId),
      version: manifest.version,
      started_at: new Date().toISOString(),
      failed_at: new Date().toISOString(),
      state: 'error',
      error: error?.message || 'Unable to install data package.',
      error_code: error?.code || '',
      error_details: error?.details || null,
      total_bytes: totalBytes,
      completed_bytes: completedBytes,
      completed_objects: completedObjects,
      total_objects: objects.length,
    }).catch(() => undefined)
    throw error
  }
}

export async function getActiveDataPackage(outletId = '') {
  const pointer = await dbGet(POINTERS, pointerKey(outletId))
  if (!pointer?.release_key) return null
  const release = await dbGet(RELEASES, pointer.release_key)
  if (!release?.verified) return null
  return { pointer, ...release }
}

export async function getActivePackageModule(name, outletId = '') {
  const active = await getActiveDataPackage(outletId)
  if (!active) return null
  const key = active.object_references?.[`module:${name}`]
  if (!key) return null
  const stored = await dbGet(OBJECTS, key)
  const bytes = await readObjectBytes(key, stored)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

export async function getActivePackageMedia(mediaId, outletId = '') {
  const active = await getActiveDataPackage(outletId)
  if (!active) return null
  const key = active.object_references?.[`media:${mediaId}`]
    || active.object_references?.[`media:${clean(mediaId).replace(/^sha256:/, '')}`]
  if (!key) return null
  const stored = await dbGet(OBJECTS, key)
  const bytes = await readObjectBytes(key, stored)
  if (!bytes) return null
  return new Blob([exactArrayBuffer(bytes)], { type: stored?.mime_type || 'application/octet-stream' })
}

export async function getActivePackageMediaUrl(mediaId, outletId = '') {
  const cacheKey = `${outletKey(outletId)}:${mediaId}`
  if (objectUrls.has(cacheKey)) return objectUrls.get(cacheKey)
  const blob = await getActivePackageMedia(mediaId, outletId)
  if (!blob) return ''
  const url = URL.createObjectURL(blob)
  objectUrls.set(cacheKey, url)
  return url
}

export function revokePackageMediaUrls() {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url)
  objectUrls.clear()
}

export async function repairLocalDataPackageStorage(outletId = '') {
  revokePackageMediaUrls()
  closeDb()
  const db = await openDb({ reopen: true })
  const expectedOutlet = outletKey(outletId)
  const stagingRows = await dbEntries(STAGING)
  for (const [key, row] of stagingRows) {
    if (outletKey(row?.outlet_id || String(key).split(':')[0]) === expectedOutlet) {
      await dbDelete(STAGING, key)
    }
  }

  const probeKey = `repair:${expectedOutlet}:${Date.now()}`
  await dbPut(STAGING, probeKey, { repaired_at: new Date().toISOString(), outlet_id: expectedOutlet })
  await dbDelete(STAGING, probeKey)

  const cache = await openObjectCache()
  if (cache) {
    const cacheProbe = cacheRequest(`repair:${expectedOutlet}:${Date.now()}`)
    await cache.put(cacheProbe, new Response('ok'))
    await cache.delete(cacheProbe)
  }

  return { repaired: true, outlet_id: expectedOutlet, db_version: db.version, object_cache: Boolean(cache) }
}

export async function rollbackLocalDataPackage(outletId = '') {
  const pointer = await dbGet(POINTERS, pointerKey(outletId))
  if (!pointer?.previous_release_key) throw new Error('No previous local data package is available.')
  const previous = await dbGet(RELEASES, pointer.previous_release_key)
  if (!previous?.verified) throw new Error('The previous local data package is incomplete.')

  const next = {
    outlet_id: outletKey(outletId),
    version: previous.manifest.version,
    release_key: pointer.previous_release_key,
    previous_release_key: pointer.release_key,
    activated_at: new Date().toISOString(),
    rolled_back: true,
  }
  await dbPut(POINTERS, pointerKey(outletId), next)
  revokePackageMediaUrls()
  window.dispatchEvent(new CustomEvent('chefops:data-package-v2-activated', { detail: { outlet_id: outletKey(outletId), manifest: previous.manifest, rollback: true } }))
  return previous.manifest
}

export async function cleanupUnusedPackageObjects({ keepReleasesPerOutlet = 2 } = {}) {
  const releaseRows = await dbEntries(RELEASES)
  const groups = new Map()
  for (const [key, release] of releaseRows) {
    const outlet = outletKey(release?.manifest?.outlet_id || String(key).split(':')[0])
    if (!groups.has(outlet)) groups.set(outlet, [])
    groups.get(outlet).push([key, release])
  }

  const keepReleaseKeys = new Set()
  const keepObjectKeys = new Set()
  for (const rows of groups.values()) {
    rows.sort((a, b) => String(b[1]?.installed_at || '').localeCompare(String(a[1]?.installed_at || '')))
    for (const [key, release] of rows.slice(0, Math.max(1, keepReleasesPerOutlet))) {
      keepReleaseKeys.add(key)
      Object.values(release?.object_references || {}).forEach((object) => keepObjectKeys.add(object))
    }
  }

  for (const [key] of releaseRows) {
    if (!keepReleaseKeys.has(key)) await dbDelete(RELEASES, key)
  }
  for (const [key, stored] of await dbEntries(OBJECTS)) {
    if (!keepObjectKeys.has(key)) {
      await deleteObjectBody(key, stored)
      await dbDelete(OBJECTS, key)
    }
  }
}

export async function dataPackageStorageSummary(outletId = '') {
  const active = await getActiveDataPackage(outletId)
  if (!active) return { ready: false, outlet_id: outletKey(outletId) }
  const refs = Object.values(active.object_references || {})
  let bytes = 0
  let complete = 0
  for (const key of refs) {
    const object = await dbGet(OBJECTS, key)
    if (await storedObjectUsable(key, object)) {
      complete += 1
      bytes += Number(object.bytes || 0)
    }
  }
  return {
    ready: complete === refs.length,
    outlet_id: outletKey(outletId),
    version: active.manifest.version,
    release_id: active.manifest.release_id || '',
    installed_at: active.installed_at,
    object_count: refs.length,
    complete_objects: complete,
    bytes,
  }
}
