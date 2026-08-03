const TEN_PHOTO_MODULES = new Set(['task', 'urgent_issue'])

const FALLBACKS = {
  task: {
    module: 'task', max_files: 10, allowed_media: 'IMAGE', capture_mode: 'CAMERA_ONLY',
    watermark_mode: 'DATE_TIME', max_file_mb: 10, active: true,
    notes: 'Photograph matching items together in one frame instead of taking separate photos for each item.',
  },
  urgent_issue: {
    module: 'urgent_issue', max_files: 10, allowed_media: 'IMAGE', capture_mode: 'CAMERA_AND_GALLERY',
    watermark_mode: 'NONE', max_file_mb: 10, active: true,
    notes: 'Photograph matching or related items together when one frame can show the issue clearly.',
  },
}

function active(row) {
  return row && !row.deleted_at && (row.active === true || String(row.active).toLowerCase() === 'true' || row.active === '')
}

export function resolveMediaRule(rows, module, outletId = '') {
  const normalizedModule = String(module || '').toLowerCase()
  const fallback = FALLBACKS[normalizedModule] || { module: normalizedModule, max_files: 10, allowed_media: 'IMAGE', capture_mode: 'CAMERA_AND_GALLERY', watermark_mode: 'NONE', max_file_mb: 10, active: true }
  const candidates = (rows || []).filter((row) => active(row) && String(row.module || '').toLowerCase() === normalizedModule)
  const selected = candidates.find((row) => String(row.outlet_id || '') === String(outletId || ''))
    || candidates.find((row) => !String(row.outlet_id || '').trim())
  const value = { ...fallback, ...(selected || {}) }
  value.max_files = TEN_PHOTO_MODULES.has(normalizedModule)
    ? 10
    : Math.max(1, Number(value.max_files || fallback.max_files || 10))
  value.max_file_mb = Math.max(1, Number(value.max_file_mb || fallback.max_file_mb || 10))
  value.allowed_media = String(value.allowed_media || fallback.allowed_media || 'IMAGE').toUpperCase()
  value.capture_mode = String(value.capture_mode || fallback.capture_mode || 'CAMERA_AND_GALLERY').toUpperCase()
  value.watermark_mode = String(value.watermark_mode || fallback.watermark_mode || 'NONE').toUpperCase()
  return value
}

export function allowedMedia(rule) {
  return new Set(String(rule?.allowed_media || 'IMAGE').split(/[;,|]/).map((item) => item.trim().toUpperCase()).filter(Boolean))
}

export function acceptsFile(rule, file) {
  const allowed = allowedMedia(rule)
  const type = String(file?.type || '').toLowerCase()
  if (type.startsWith('image/')) return allowed.has('IMAGE')
  if (type.startsWith('video/')) return allowed.has('VIDEO')
  return false
}

export function acceptAttribute(rule) {
  const allowed = allowedMedia(rule)
  return [allowed.has('IMAGE') ? 'image/*' : '', allowed.has('VIDEO') ? 'video/*' : ''].filter(Boolean).join(',') || 'image/*'
}

export function mediaRuleLabel(rule) {
  const allowed = allowedMedia(rule)
  if (allowed.has('IMAGE') && allowed.has('VIDEO')) return 'photos or videos'
  if (allowed.has('VIDEO')) return 'videos'
  return 'photos'
}
