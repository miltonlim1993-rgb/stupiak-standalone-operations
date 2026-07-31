const DB_NAME = 'stupiaks-ops-data-package-v2'
const DB_VERSION = 1

const RELEASES = 'releases'
const OBJECTS = 'objects'
const POINTERS = 'pointers'
const STAGING = 'staging'

let dbPromise = null
const objectUrls = new Map()

function openDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null)
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
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(() => null)

  return dbPromise
}

function outletKey(value = '') {
  return String(value || '').trim() || 'global'
}

function releaseKey(outletId, version) {
  return `${outletKey(outletId)}:${String(version || '').trim()}`
}

function pointerKey(outletId) {
  return `active:${outletKey(outletId)}`
}

function objectKey(kind, hash) {
  return `${kind}:${String(hash || '').trim().toLowerCase()}`
}

async function requestResult(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => resolve(null)
  })
}

async function dbGet(storeName, key) {
  const db = await openDb()
  if (!db) return null
  const tx = db.transaction(storeName, 'readonly')
  return requestResult(tx.objectStore(storeName).get(key))
}

async function dbPut(storeName, key, value) {
  const db = await openDb()
  if (!db) throw new Error('Persistent package storage is unavailable on this device.')
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(value, key)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error || new Error(`Unable to write ${storeName}`))
    tx.onabort = () => reject(tx.error || new Error(`Unable to write ${storeName}`))
  })
}

async function dbDelete(storeName, key) {
  const db = await openDb()
  if (!db) return
  await new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(key)
    tx.oncomplete = resolve
    tx.onerror = resolve
    tx.onabort = resolve
  })
}

async function dbEntries(storeName) {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
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
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Blob) return value.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
}

async function sha256Hex(value) {
  const bytes = await bytesFrom(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function verifyObject(value, expectedHash, expectedBytes = 0) {
  const bytes = await bytesFrom(value)
  if (Number(expectedBytes || 0) > 0 && bytes.byteLength !== Number(expectedBytes)) {
    throw new Error(`Package object size mismatch: expected ${expectedBytes}, received ${bytes.byteLength}.`)
  }
  const actual = await sha256Hex(bytes)
  const expected = String(expectedHash || '').toLowerCase()
  if (expected && !actual.startsWith(expected)) {
    throw new Error(`Package object hash mismatch: expected ${expected}, received ${actual}.`)
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
    if (item.kind === 'module') return response.text()
    return response.blob()
  }
  return response
}

async function activateStagedRelease(outletId, manifest, objectReferences) {
  const db = await openDb()
  if (!db) throw new Error('Persistent package storage is unavailable on this device.')
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
    tx.onerror = () => reject(tx.error || new Error('Unable to activate data package.'))
    tx.onabort = () => reject(tx.error || new Error('Unable to activate data package.'))
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
      if (existing?.verified) {
        references[`${item.kind}:${item.name}`] = key
        completedBytes += Number(item.bytes || existing.bytes || 0)
        completedObjects += 1
        onProgress({ state: 'downloading', completedBytes, totalBytes, completedObjects, totalObjects: objects.length, item, reused: true })
        continue
      }

      const payload = await fetchPackageObject(item, fetcher)
      const verified = await verifyObject(payload, item.hash, item.bytes)
      const blob = payload instanceof Blob
        ? payload
        : new Blob([verified.bytes], { type: item.mimeType })

      await dbPut(OBJECTS, key, {
        kind: item.kind,
        hash: item.hash,
        actual_hash: verified.actualHash,
        bytes: verified.bytes.byteLength,
        mime_type: item.mimeType,
        blob,
        verified: true,
        stored_at: new Date().toISOString(),
      })

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
      total_bytes: totalBytes,
      completed_bytes: completedBytes,
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
  if (!stored?.verified || !stored.blob) return null
  try {
    return JSON.parse(await stored.blob.text())
  } catch {
    return null
  }
}

export async function getActivePackageMedia(mediaId, outletId = '') {
  const active = await getActiveDataPackage(outletId)
  if (!active) return null
  const key = active.object_references?.[`media:${mediaId}`]
    || active.object_references?.[`media:${String(mediaId || '').replace(/^sha256:/, '')}`]
  if (!key) return null
  const stored = await dbGet(OBJECTS, key)
  return stored?.verified ? stored.blob || null : null
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
  for (const [key] of await dbEntries(OBJECTS)) {
    if (!keepObjectKeys.has(key)) await dbDelete(OBJECTS, key)
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
    if (object?.verified) {
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
