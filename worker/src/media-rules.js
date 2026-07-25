import { ensureEntitySheet, listRecords } from './sheets.js'

export const MEDIA_RULE_SEEDS = [
  {
    id: 'media-rule-task-global',
    module: 'task',
    outlet_id: '',
    max_files: 8,
    allowed_media: 'IMAGE',
    capture_mode: 'CAMERA_ONLY',
    watermark_mode: 'DATE_TIME',
    max_file_mb: 10,
    active: true,
    notes: 'Task photo groups still use the smaller max_photos value from TaskTemplates. Staff can only use the on-site camera.',
  },
  {
    id: 'media-rule-urgent-issue-global',
    module: 'urgent_issue',
    outlet_id: '',
    max_files: 4,
    allowed_media: 'IMAGE',
    capture_mode: 'CAMERA_AND_GALLERY',
    watermark_mode: 'NONE',
    max_file_mb: 10,
    active: true,
    notes: 'Set allowed_media to IMAGE,VIDEO when issue videos are permitted.',
  },
]

function isActive(row) {
  return row && !row.deleted_at && (row.active === true || String(row.active).toLowerCase() === 'true' || row.active === '')
}

export async function ensureMediaRules(env) {
  return ensureEntitySheet(env, 'MediaRule', { seedRecords: MEDIA_RULE_SEEDS })
}

export async function getMediaRule(env, moduleName, outletId = '') {
  await ensureMediaRules(env)
  const rows = await listRecords(env, 'MediaRule', { sort: 'module,outlet_id', limit: 500 })
  const moduleRows = (rows || []).filter((row) => isActive(row) && String(row.module || '').toLowerCase() === String(moduleName || '').toLowerCase())
  const selected = moduleRows.find((row) => String(row.outlet_id || '') === String(outletId || ''))
    || moduleRows.find((row) => !String(row.outlet_id || '').trim())
    || MEDIA_RULE_SEEDS.find((row) => row.module === moduleName)
  return {
    ...(selected || {}),
    max_files: Math.max(1, Number(selected?.max_files || 4)),
    max_file_mb: Math.max(1, Number(selected?.max_file_mb || 10)),
    allowed_media: String(selected?.allowed_media || 'IMAGE').toUpperCase(),
    capture_mode: String(selected?.capture_mode || 'CAMERA_AND_GALLERY').toUpperCase(),
    watermark_mode: String(selected?.watermark_mode || 'NONE').toUpperCase(),
  }
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
