import {
  getDataPackageDirtyState,
  getDataPackageManifestVersion,
  getDataPackageModuleObject,
  getLatestDataPackageManifest,
  listDataPackageReleases,
  markDataPackageDirty,
  publishDataPackageDraft,
  rollbackDataPackage,
} from './data-package-release-store.js'

const FORMAT = 'stupiaks-ops-data-package'
const FORMAT_VERSION = 2

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

function outletKey(value = '') {
  return String(value || '').trim() || 'global'
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
    const body = stableStringify({
      format: FORMAT,
      format_version: FORMAT_VERSION,
      kind: 'module',
      name,
      data,
    })
    const hash = await sha256(body)
    moduleBodies[name] = body
    moduleEntries[name] = {
      hash,
      bytes: new TextEncoder().encode(body).length,
      records: recordCount(data),
      path: `/api/app/v4/data-package/module/${encodeURIComponent(name)}?outlet_id=${encodeURIComponent(target === 'global' ? '' : target)}&hash=${hash}`,
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

  return {
    manifest: {
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
    },
    moduleBodies,
  }
}

export {
  getDataPackageDirtyState,
  getDataPackageManifestVersion,
  getDataPackageModuleObject,
  getLatestDataPackageManifest,
  listDataPackageReleases,
  markDataPackageDirty,
  publishDataPackageDraft,
  rollbackDataPackage,
}

export const DATA_PACKAGE_FORMAT = FORMAT
export const DATA_PACKAGE_FORMAT_VERSION = FORMAT_VERSION
