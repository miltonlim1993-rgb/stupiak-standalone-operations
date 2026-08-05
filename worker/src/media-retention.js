const R2_MEDIA_PREFIX = 'media/r2/'
const KV_MEDIA_PREFIX = 'media:file:'
const DRIVE_BACKUP_STATE_PREFIX = 'media:drive-backup:'
const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_BATCH_LIMIT = 250

function isoNow() {
  return new Date().toISOString()
}

function retentionDays(env) {
  const configured = Number(env.MEDIA_RETENTION_DAYS || DEFAULT_RETENTION_DAYS)
  if (!Number.isFinite(configured)) return DEFAULT_RETENTION_DAYS
  return Math.max(1, Math.min(Math.floor(configured), 3650))
}

function cutoffDate(env, current = new Date()) {
  return new Date(current.getTime() - retentionDays(env) * 24 * 60 * 60 * 1000)
}

function objectUploadedAt(object) {
  const direct = object?.uploaded instanceof Date
    ? object.uploaded
    : new Date(object?.uploaded || '')
  if (Number.isFinite(direct.getTime())) return direct
  const metadata = new Date(object?.customMetadata?.uploaded_at || '')
  return Number.isFinite(metadata.getTime()) ? metadata : null
}

function imageObject(object) {
  return String(object?.customMetadata?.mime_type || '').toLowerCase().startsWith('image/')
}

function mediaIdFromR2Key(key) {
  const value = String(key || '')
  return value.startsWith(R2_MEDIA_PREFIX) ? value.slice(R2_MEDIA_PREFIX.length) : ''
}

async function scrubD1MediaReference(env, mediaId, deletedAt) {
  if (!env.OPS_DB?.prepare || !mediaId) return { changed: 0 }

  const taskPhotos = await env.OPS_DB.prepare(`
    UPDATE ops_records
    SET payload_json = json_set(
          json_set(
            json_set(payload_json, '$.file_url', ''),
            '$.status', 'expired'
          ),
          '$.retention_deleted_at', ?
        ),
        status = 'expired',
        deleted_at = ?,
        updated_at = ?,
        updated_by = 'media-retention@stupiaks-ops',
        version = version + 1
    WHERE entity = 'TaskPhoto'
      AND deleted_at = ''
      AND json_extract(payload_json, '$.drive_file_id') = ?
  `).bind(deletedAt, deletedAt, deletedAt, mediaId).run()

  const otherMedia = await env.OPS_DB.prepare(`
    UPDATE ops_records
    SET payload_json = json_set(
          json_set(
            json_set(payload_json, '$.file_url', ''),
            '$.image_url', ''
          ),
          '$.retention_deleted_at', ?
        ),
        updated_at = ?,
        updated_by = 'media-retention@stupiaks-ops',
        version = version + 1
    WHERE entity <> 'TaskPhoto'
      AND deleted_at = ''
      AND (
        json_extract(payload_json, '$.drive_file_id') = ?
        OR json_extract(payload_json, '$.media_id') = ?
      )
  `).bind(deletedAt, deletedAt, mediaId, mediaId).run()

  return {
    changed: Number(taskPhotos?.meta?.changes || 0) + Number(otherMedia?.meta?.changes || 0),
  }
}

async function deleteR2Photo(env, object) {
  const mediaId = mediaIdFromR2Key(object?.key)
  if (!mediaId) return { deleted: false, reason: 'invalid_media_key' }

  await env.MEDIA_BUCKET.delete(object.key)
  const deletedAt = isoNow()
  const d1 = await scrubD1MediaReference(env, mediaId, deletedAt)

  if (env.APP_DATA_PACKS?.delete) {
    await Promise.allSettled([
      env.APP_DATA_PACKS.delete(`${KV_MEDIA_PREFIX}${mediaId}`),
      env.APP_DATA_PACKS.delete(`${DRIVE_BACKUP_STATE_PREFIX}${mediaId}`),
    ])
  }

  return {
    deleted: true,
    media_id: mediaId,
    d1_records_scrubbed: d1.changed,
    deleted_at: deletedAt,
  }
}

async function purgeR2Photos(env, cutoff, limit) {
  if (!env.MEDIA_BUCKET?.list || !env.MEDIA_BUCKET?.delete) {
    return { configured: false, scanned: 0, deleted: 0, failures: [] }
  }

  let cursor
  let scanned = 0
  const deleted = []
  const failures = []

  do {
    const page = await env.MEDIA_BUCKET.list({
      prefix: R2_MEDIA_PREFIX,
      cursor,
      limit: Math.min(limit, 1000),
      include: ['customMetadata'],
    })

    for (const object of page.objects || []) {
      if (scanned >= limit) break
      scanned += 1
      if (!imageObject(object)) continue
      const uploadedAt = objectUploadedAt(object)
      if (!uploadedAt || uploadedAt >= cutoff) continue

      try {
        const result = await deleteR2Photo(env, object)
        if (result.deleted) deleted.push(result)
      } catch (error) {
        failures.push({
          key: String(object?.key || ''),
          error: String(error?.message || error).slice(0, 500),
        })
      }
    }

    cursor = page.truncated && scanned < limit ? page.cursor : undefined
  } while (cursor)

  return {
    configured: true,
    scanned,
    deleted: deleted.length,
    records_scrubbed: deleted.reduce((sum, row) => sum + Number(row.d1_records_scrubbed || 0), 0),
    failures,
  }
}

async function purgeExpiredKvMedia(env, cutoff, limit) {
  if (!env.APP_DATA_PACKS?.list || !env.APP_DATA_PACKS?.delete) {
    return { configured: false, scanned: 0, deleted: 0 }
  }

  const page = await env.APP_DATA_PACKS.list({ prefix: KV_MEDIA_PREFIX, limit: Math.min(limit, 1000) })
  let scanned = 0
  let deleted = 0

  for (const key of page.keys || []) {
    if (scanned >= limit) break
    scanned += 1
    const cachedAt = new Date(key?.metadata?.cached_at || '')
    if (!Number.isFinite(cachedAt.getTime()) || cachedAt >= cutoff) continue
    await env.APP_DATA_PACKS.delete(key.name)
    deleted += 1
  }

  return { configured: true, scanned, deleted }
}

export function mediaRetentionPolicy(env) {
  return {
    canonical_storage: 'cloudflare-r2',
    google_sheet_role: 'asynchronous_backup_record_only',
    photo_retention_days: retentionDays(env),
    physical_delete: true,
    applies_to: 'image media in Cloudflare R2 and legacy Cloudflare KV cache',
  }
}

export async function purgeExpiredOperationalPhotos(env, {
  limit = DEFAULT_BATCH_LIMIT,
  current = new Date(),
} = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_BATCH_LIMIT, 1000))
  const cutoff = cutoffDate(env, current)
  const [r2, kv] = await Promise.all([
    purgeR2Photos(env, cutoff, safeLimit),
    purgeExpiredKvMedia(env, cutoff, safeLimit),
  ])

  const result = {
    ok: r2.failures.length === 0,
    policy: mediaRetentionPolicy(env),
    cutoff: cutoff.toISOString(),
    checked_at: isoNow(),
    r2,
    kv,
  }

  if (env.APP_DATA_PACKS?.put) {
    await env.APP_DATA_PACKS.put(
      'chefops:media-retention:last-run',
      JSON.stringify(result),
      { expirationTtl: Math.max(7 * 24 * 60 * 60, retentionDays(env) * 24 * 60 * 60) },
    )
  }

  return result
}
