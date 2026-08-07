import { ensureEntitySheet, listRecords } from './sheets.js'

const TEN_PHOTO_MODULES = new Set(['task', 'urgent_issue'])

export const MEDIA_RULE_SEEDS = [
  {
    id: 'media-rule-task-global',
    module: 'task',
    outlet_id: '',
    max_files: 10,
    allowed_media: 'IMAGE',
    capture_mode: 'CAMERA_ONLY',
    watermark_mode: 'DATE_TIME',
    max_file_mb: 10,
    active: true,
    notes: 'Task photo groups support up to 10 photos. Photograph matching items together in one frame instead of taking separate photos for each item.',
  },
  {
    id: 'media-rule-urgent-issue-global',
    module: 'urgent_issue',
    outlet_id: '',
    max_files: 10,
    allowed_media: 'IMAGE',
    capture_mode: 'CAMERA_AND_GALLERY',
    watermark_mode: 'NONE',
    max_file_mb: 10,
    active: true,
    notes: 'Urgent Issues support up to 10 attachments. Photograph matching or related items together when one frame can show the issue clearly.',
  },
]

function isActive(row) {
  return row && !row.deleted_at && (row.active === true || String(row.active).toLowerCase() === 'true' || row.active === '')
}

function normalizedMediaRule(selected, moduleName) {
  const normalizedModule = String(moduleName || '').toLowerCase()
  const seed = MEDIA_RULE_SEEDS.find((row) => row.module === normalizedModule) || {}
  const source = selected || seed
  return {
    ...seed,
    ...(source || {}),
    max_files: TEN_PHOTO_MODULES.has(normalizedModule)
      ? 10
      : Math.max(1, Number(source?.max_files || seed?.max_files || 10)),
    max_file_mb: Math.max(1, Number(source?.max_file_mb || seed?.max_file_mb || 10)),
    allowed_media: String(source?.allowed_media || seed?.allowed_media || 'IMAGE').toUpperCase(),
    capture_mode: String(source?.capture_mode || seed?.capture_mode || 'CAMERA_AND_GALLERY').toUpperCase(),
    watermark_mode: String(source?.watermark_mode || seed?.watermark_mode || 'NONE').toUpperCase(),
  }
}

export async function ensureMediaRules(env) {
  return ensureEntitySheet(env, 'MediaRule', { seedRecords: MEDIA_RULE_SEEDS })
}

export async function getMediaRule(env, moduleName, outletId = '') {
  const normalizedModule = String(moduleName || '').toLowerCase()
  let rows = []
  try {
    await ensureMediaRules(env)
    rows = await listRecords(env, 'MediaRule', { sort: 'module,outlet_id', limit: 500 })
  } catch (error) {
    // File storage is Cloudflare R2-first. A temporary Master Sheet/MediaRule
    // read failure must not turn a valid on-site photo upload into HTTP 500.
    // TaskPhoto D1 registration still validates the published media rule.
    console.error('MediaRule runtime read unavailable; using built-in media policy', normalizedModule, error)
  }
  const moduleRows = (rows || []).filter((row) => isActive(row) && String(row.module || '').toLowerCase() === normalizedModule)
  const selected = moduleRows.find((row) => String(row.outlet_id || '') === String(outletId || ''))
    || moduleRows.find((row) => !String(row.outlet_id || '').trim())
    || MEDIA_RULE_SEEDS.find((row) => row.module === normalizedModule)
  return normalizedMediaRule(selected, normalizedModule)
}

export function mediaKind(mimeType = '') {
  const value = String(mimeType || '').toLowerCase()
  if (value.startsWith('image/')) return 'IMAGE'
  if (value.startsWith('video/')) return 'VIDEO'
  return 'OTHER'
}

export function allowedMediaKinds(rule) {
  return new Set(String(rule?.allowed_media || 'IMAGE').split(/[;,|]/).map((item) => item.trim().toUpperCase()).filter(Boolean))
}
