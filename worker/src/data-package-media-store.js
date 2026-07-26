const PREFIX = 'chefops:data-package:v2:media:'
const MEDIA_TTL = 365 * 24 * 60 * 60
const MEMORY = new Map()

function clean(value = '') {
  return String(value || '').trim()
}

function normalizeHash(value = '') {
  return clean(value).replace(/^sha256:/i, '').toLowerCase()
}

function mediaKey(hash = '') {
  return `${PREFIX}${normalizeHash(hash)}`
}

async function put(env, key, value) {
  const text = JSON.stringify(value)
  MEMORY.set(key, text)
  if (env.APP_DATA_PACKS?.put) await env.APP_DATA_PACKS.put(key, text, { expirationTtl: MEDIA_TTL })
}

async function get(env, key) {
  if (env.APP_DATA_PACKS?.get) {
    const value = await env.APP_DATA_PACKS.get(key, 'json')
    if (value !== null && value !== undefined) return value
  }
  const text = MEMORY.get(key)
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

export function normalizePublishedMedia(value = {}) {
  const hash = normalizeHash(value.hash || value.id)
  const sourceId = clean(value.published_drive_file_id || value.source_id || value.drive_file_id)
  const bytes = Number(value.bytes || value.file_size || 0)
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Published media requires a full SHA-256 hash')
  if (!sourceId) throw new Error(`Published media ${hash.slice(0, 12)} is missing its Drive file ID`)
  if (!Number.isFinite(bytes) || bytes < 1) throw new Error(`Published media ${hash.slice(0, 12)} has an invalid file size`)
  return {
    id: hash,
    hash,
    bytes,
    mime_type: clean(value.mime_type || value.content_type || 'application/octet-stream'),
    file_name: clean(value.file_name || hash),
    kind: clean(value.kind || value.asset_type || 'file'),
    source_provider: 'published_google_drive',
    source_id: sourceId,
    source_key: clean(value.source_key),
    source_etag: clean(value.source_etag),
    uploaded_at: clean(value.uploaded_at || new Date().toISOString()),
    path: `/api/app/v4/data-package/media/${hash}?hash=${hash}`,
  }
}

export async function savePublishedMedia(env, values = []) {
  const entries = []
  for (const value of values || []) {
    const entry = normalizePublishedMedia(value)
    await put(env, mediaKey(entry.hash), entry)
    entries.push(entry)
  }
  return entries
}

export async function getPublishedMedia(env, hash = '') {
  const normalized = normalizeHash(hash)
  if (!/^[a-f0-9]{64}$/.test(normalized)) return null
  return get(env, mediaKey(normalized))
}

export function publishedMediaManifest(entries = []) {
  const files = {}
  for (const value of entries || []) {
    const entry = normalizePublishedMedia(value)
    files[entry.id] = entry
  }
  return { files }
}
