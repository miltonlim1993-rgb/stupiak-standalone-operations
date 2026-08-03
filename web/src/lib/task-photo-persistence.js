function clean(value) {
  return String(value || '').trim()
}

export function taskPhotoEntityId(payload = {}, fallback = '') {
  const driveFileId = clean(payload.drive_file_id)
  if (driveFileId) return `task-photo:${driveFileId}`
  return clean(payload.id || fallback)
}

export function serverConfirmedTaskPhoto(photos = [], photoId = '') {
  const expected = clean(photoId)
  if (!expected) return null
  return (photos || []).find((photo) => (
    clean(photo?.id) === expected
    && !photo?.client_upload_state
    && clean(photo?.__realtime?.entity) === 'TaskPhoto'
    && Number(photo?.__realtime?.version || 0) > 0
  )) || null
}

export function unconfirmedLocalTaskPhotos(localPhotos = [], serverPhotos = []) {
  const confirmedIds = new Set((serverPhotos || [])
    .filter((photo) => serverConfirmedTaskPhoto([photo], photo?.id))
    .map((photo) => clean(photo.id)))
  return (localPhotos || []).filter((photo) => (
    !photo?.serverId || !confirmedIds.has(clean(photo.serverId))
  ))
}

export async function ensureTaskPhotoPersisted({
  payload,
  checkExisting = false,
  createTaskPhoto,
  readBootstrap,
} = {}) {
  if (typeof createTaskPhoto !== 'function') throw new TypeError('createTaskPhoto is required')
  if (typeof readBootstrap !== 'function') throw new TypeError('readBootstrap is required')

  const entityId = taskPhotoEntityId(payload)
  if (!entityId) throw new Error('TaskPhoto requires a stable server ID')
  const canonicalPayload = { ...(payload || {}), id: entityId }

  const confirm = async () => {
    const bootstrap = await readBootstrap()
    const record = serverConfirmedTaskPhoto(bootstrap?.task_photos || [], entityId)
    return record ? { record, bootstrap } : null
  }

  if (checkExisting) {
    const existing = await confirm()
    if (existing) return { ...existing, entityId, created: false, replayed: true }
  }

  let createdRecord = null
  try {
    createdRecord = await createTaskPhoto(canonicalPayload)
  } catch (createError) {
    let recovered = null
    try { recovered = await confirm() } catch {}
    if (recovered) return { ...recovered, entityId, created: false, replayed: true }
    throw createError
  }

  const confirmed = await confirm()
  if (!confirmed) {
    const error = new Error('照片登记后未能从服务器重新确认')
    error.code = 'task_photo_bootstrap_unconfirmed'
    error.entity_id = entityId
    error.created_record = createdRecord
    throw error
  }

  return { ...confirmed, entityId, created: true, replayed: false }
}
