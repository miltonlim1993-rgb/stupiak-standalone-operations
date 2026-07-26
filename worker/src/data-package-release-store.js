const FORMAT = 'stupiaks-ops-data-package'
const FORMAT_VERSION = 2
const RELEASE_HISTORY_LIMIT = 20
const OBJECT_TTL = 365 * 24 * 60 * 60

const MEMORY = new Map()

function outletKey(value = '') {
  return String(value || '').trim() || 'global'
}

function key(type, outletId, suffix = '') {
  return `chefops:data-package:v2:${type}:${outletKey(outletId)}${suffix ? `:${suffix}` : ''}`
}

async function storeGet(env, storageKey, type = 'text') {
  if (env.APP_DATA_PACKS?.get) {
    const value = await env.APP_DATA_PACKS.get(storageKey, type)
    if (value !== null && value !== undefined) return value
  }
  const value = MEMORY.get(storageKey)
  if (value === undefined) return null
  if (type === 'json') {
    try { return JSON.parse(value) } catch { return null }
  }
  return value
}

async function storePut(env, storageKey, value, { ttl = OBJECT_TTL } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  MEMORY.set(storageKey, text)
  if (env.APP_DATA_PACKS?.put) {
    await env.APP_DATA_PACKS.put(storageKey, text, { expirationTtl: ttl })
  }
}

async function sha256(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((name) => [name, stableValue(value[name])]))
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value))
}

function recordCount(value) {
  if (Array.isArray(value)) return value.length
  if (!value || typeof value !== 'object') return 0
  return Object.values(value).reduce((sum, item) => sum + (Array.isArray(item) ? item.length : 0), 0)
}

function cleanMediaEntry(id, value = {}) {
  const hash = String(value.hash || id || '').replace(/^sha256:/, '').trim().toLowerCase()
  return {
    id: String(id || value.id || hash),
    hash,
    kind: String(value.kind || value.asset_type || 'file'),
    mime_type: String(value.mime_type || value.content_type || 'application/octet-stream'),
    bytes: Number(value.bytes || value.file_size || 0),
    file_name: String(value.file_name || ''),
    source_provider: String(value.source_provider || 'google_drive'),
    source_id: String(value.source_id || value.drive_file_id || ''),
    path: String(value.path || ''),
  }
}

function normalizeMedia(media = {}) {
  const files = {}
  const source = media.files && typeof media.files === 'object' ? media.files : media
  for (const [id, value] of Object.entries(source || {})) {
    const entry = cleanMediaEntry(id, value)
    if (!entry.hash || !entry.path) continue
    files[entry.id] = entry
  }
  return {
    files,
    total_bytes: Object.values(files).reduce((sum, item) => sum + Number(item.bytes || 0), 0),
  }
}

export async function markDataPackageDirty(env, outletId = '', { modules = [], reason = '', actor = '' } = {}) {
  const state = {
    outlet_id: outletKey(outletId),
    dirty: true,
    dirty_at: new Date().toISOString(),
    modules: [...new Set((modules || []).map((item) => String(item || '').trim()).filter(Boolean))],
    reason: String(reason || ''),
    actor: String(actor || ''),
  }
  await storePut(env, key('dirty', outletId), state, { ttl: 90 * 24 * 60 * 60 })
  return state
}

export async function getDataPackageDirtyState(env, outletId = '') {
  return await storeGet(env, key('dirty', outletId), 'json') || {
    outlet_id: outletKey(outletId),
    dirty: false,
    dirty_at: '',
    modules: [],
  }
}

export async function buildDataPackageDraft({
  env,
  outletId = '',
  modules = {},
  media = {},
  generatedBy = '',
  sourceVersion = '',
} = {}) {
  const target = outletKey(outletId)
  const moduleEntries = {}
  const moduleBodies = {}

  for (const [name, data] of Object.entries(modules || {})) {
    const stableBody = stableStringify({ name, data })
    const hash = await sha256(stableBody)
    const body = JSON.stringify({
      format: FORMAT,
      format_version: FORMAT_VERSION,
      kind: 'module',
      name,
      hash,
      data,
    })
    moduleBodies[name] = body
    moduleEntries[name] = {
      hash,
      bytes: new TextEncoder().encode(body).length,
      records: recordCount(data),
      path: `/api/app/v4/pack/module/${encodeURIComponent(name)}?outlet_id=${encodeURIComponent(target === 'global' ? '' : target)}&hash=${hash}`,
    }
  }

  const normalizedMedia = normalizeMedia(media)
  const versionBasis = stableStringify({
    outlet_id: target,
    modules: Object.fromEntries(Object.entries(moduleEntries).map(([name, info]) => [name, info.hash])),
    media: Object.fromEntries(Object.entries(normalizedMedia.files).map(([id, info]) => [id, info.hash])),
  })
  const version = await sha256(versionBasis)
  const previous = await getLatestDataPackageManifest(env, target)
  const generatedAt = new Date().toISOString()

  const manifest = {
    ok: true,
    format: FORMAT,
    format_version: FORMAT_VERSION,
    schema_version: FORMAT_VERSION,
    release_id: `${target}-${generatedAt.replace(/[-:.]/g, '')}-${version.slice(0, 8)}`,
    version,
    data_version: sourceVersion || version,
    outlet_id: target === 'global' ? '' : target,
    generated_at: generatedAt,
    generated_by: String(generatedBy || ''),
    published_at: '',
    published_by: '',
    previous_version: previous?.version || '',
    total_bytes: Object.values(moduleEntries).reduce((sum, item) => sum + Number(item.bytes || 0), 0) + normalizedMedia.total_bytes,
    modules: moduleEntries,
    media: normalizedMedia,
    storage: {
      metadata: env.APP_DATA_PACKS?.get ? 'cloudflare-kv' : 'worker-memory',
      media: 'published-drive-package',
    },
  }

  return { manifest, moduleBodies }
}

async function releaseHistory(env, outletId) {
  return await storeGet(env, key('history', outletId), 'json') || []
}

async function saveReleaseHistory(env, outletId, entry) {
  const current = await releaseHistory(env, outletId)
  const next = [entry, ...current.filter((item) => item.version !== entry.version)].slice(0, RELEASE_HISTORY_LIMIT)
  await storePut(env, key('history', outletId), next)
  return next
}

export async function publishDataPackageDraft(env, draft, { publishedBy = '' } = {}) {
  if (!draft?.manifest?.version || !draft?.moduleBodies) throw new Error('Data package draft is incomplete')
  const target = outletKey(draft.manifest.outlet_id)
  const publishedAt = new Date().toISOString()

  for (const [name, body] of Object.entries(draft.moduleBodies)) {
    const info = draft.manifest.modules?.[name]
    if (!info?.hash) throw new Error(`Missing hash for package module ${name}`)
    await storePut(env, key('object', target, `module:${name}:${info.hash}`), body)
  }

  const manifest = {
    ...draft.manifest,
    published_at: publishedAt,
    published_by: String(publishedBy || ''),
  }

  // Versioned manifest and release history are persisted before latest is moved.
  // A failed write cannot replace the currently active release.
  await storePut(env, key('manifest', target, manifest.version), manifest)
  await saveReleaseHistory(env, target, {
    release_id: manifest.release_id,
    version: manifest.version,
    previous_version: manifest.previous_version || '',
    outlet_id: manifest.outlet_id,
    published_at: manifest.published_at,
    published_by: manifest.published_by,
    total_bytes: manifest.total_bytes,
    module_count: Object.keys(manifest.modules || {}).length,
    media_count: Object.keys(manifest.media?.files || {}).length,
  })
  await storePut(env, key('latest', target), {
    outlet_id: target,
    version: manifest.version,
    release_id: manifest.release_id,
    published_at: manifest.published_at,
  })
  await storePut(env, key('dirty', target), {
    outlet_id: target,
    dirty: false,
    dirty_at: '',
    modules: [],
    published_version: manifest.version,
    published_at: manifest.published_at,
  }, { ttl: 90 * 24 * 60 * 60 })

  return manifest
}

export async function getLatestDataPackageManifest(env, outletId = '') {
  const target = outletKey(outletId)
  const pointer = await storeGet(env, key('latest', target), 'json')
  if (!pointer?.version) return null
  return storeGet(env, key('manifest', target, pointer.version), 'json')
}

export async function getDataPackageManifestVersion(env, outletId = '', version = '') {
  if (!version) return null
  return storeGet(env, key('manifest', outletId, version), 'json')
}

export async function getDataPackageModuleObject(env, outletId, name, hash) {
  if (!name || !hash) return null
  const body = await storeGet(env, key('object', outletId, `module:${name}:${hash}`))
  if (!body) return null
  try { return JSON.parse(body) } catch { return null }
}

export async function listDataPackageReleases(env, outletId = '') {
  const target = outletKey(outletId)
  const [latest, history, dirty] = await Promise.all([
    storeGet(env, key('latest', target), 'json'),
    releaseHistory(env, target),
    getDataPackageDirtyState(env, target),
  ])
  return { outlet_id: target === 'global' ? '' : target, latest, releases: history, dirty }
}

export async function rollbackDataPackage(env, outletId = '', version = '', { actor = '' } = {}) {
  const target = outletKey(outletId)
  const manifest = await getDataPackageManifestVersion(env, target, version)
  if (!manifest?.version) throw new Error('Requested data package release was not found')
  const current = await getLatestDataPackageManifest(env, target)
  const rolledAt = new Date().toISOString()
  await storePut(env, key('latest', target), {
    outlet_id: target,
    version: manifest.version,
    release_id: manifest.release_id,
    published_at: manifest.published_at,
    rolled_back_at: rolledAt,
    rolled_back_by: String(actor || ''),
    replaced_version: current?.version || '',
  })
  return {
    ...manifest,
    rollback: {
      rolled_back_at: rolledAt,
      rolled_back_by: String(actor || ''),
      replaced_version: current?.version || '',
    },
  }
}

export const DATA_PACKAGE_FORMAT = FORMAT
export const DATA_PACKAGE_FORMAT_VERSION = FORMAT_VERSION
