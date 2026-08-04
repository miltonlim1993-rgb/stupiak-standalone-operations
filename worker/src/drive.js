import { googleAuthMode, googleFetch } from './google.js'
import { allowedMediaKinds, getMediaRule, mediaKind } from './media-rules.js'
import { assertOutletAccess } from './permissions.js'

const MEDIA_CACHE_PREFIX = 'media:file:'
const DRIVE_BACKUP_STATE_PREFIX = 'media:drive-backup:'
const R2_MEDIA_PREFIX = 'media/r2/'
const MAX_CACHE_BYTES = 20 * 1024 * 1024

function mediaCacheKey(fileId) {
  return `${MEDIA_CACHE_PREFIX}${String(fileId || '').trim()}`
}

function driveBackupStateKey(fileId) {
  return `${DRIVE_BACKUP_STATE_PREFIX}${String(fileId || '').trim()}`
}

function r2ObjectKey(fileId) {
  return `${R2_MEDIA_PREFIX}${String(fileId || '').trim()}`
}

export function mediaPrimaryStorage(env) {
  return env.MEDIA_BUCKET?.put && env.MEDIA_BUCKET?.get ? 'cloudflare-r2' : 'google-drive'
}

function escapeDriveQuery(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

async function findFolder(env, parentId, name) {
  const q = [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${escapeDriveQuery(name)}'`,
    `'${escapeDriveQuery(parentId)}' in parents`,
    'trashed=false',
  ].join(' and ')
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('q', q)
  url.searchParams.set('fields', 'files(id,name)')
  url.searchParams.set('pageSize', '10')
  const response = await googleFetch(env, url.toString())
  const data = await response.json()
  return data.files?.[0] || null
}

async function createFolder(env, parentId, name) {
  const response = await googleFetch(env, 'https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  })
  return response.json()
}

async function ensureFolder(env, parentId, name) {
  return (await findFolder(env, parentId, name)) || createFolder(env, parentId, name)
}

async function findDriveBackup(env, mediaId) {
  if (!mediaId) return null
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('q', `appProperties has { key='chefops_media_id' and value='${escapeDriveQuery(mediaId)}' } and trashed=false`)
  url.searchParams.set('fields', 'files(id,name,mimeType,size,webViewLink)')
  url.searchParams.set('pageSize', '2')
  const response = await googleFetch(env, url.toString())
  const data = await response.json()
  return data.files?.[0] || null
}

async function cacheMedia(env, fileId, bytes, { mimeType = 'application/octet-stream', fileName = '' } = {}) {
  if (!fileId || !env.APP_DATA_PACKS?.put || !bytes || bytes.byteLength > MAX_CACHE_BYTES) return false
  try {
    await env.APP_DATA_PACKS.put(mediaCacheKey(fileId), bytes, {
      metadata: {
        mime_type: String(mimeType || 'application/octet-stream'),
        file_name: String(fileName || ''),
        cached_at: new Date().toISOString(),
      },
    })
    return true
  } catch (error) {
    console.error('Unable to cache media in Cloudflare KV', fileId, error)
    return false
  }
}

async function cachedMedia(env, fileId) {
  if (!fileId || !env.APP_DATA_PACKS) return null
  try {
    if (typeof env.APP_DATA_PACKS.getWithMetadata === 'function') {
      const stored = await env.APP_DATA_PACKS.getWithMetadata(mediaCacheKey(fileId), 'arrayBuffer')
      if (!stored?.value) return null
      const metadata = stored.metadata || {}
      return new Response(stored.value, {
        status: 200,
        headers: {
          'Content-Type': metadata.mime_type || 'application/octet-stream',
          'Content-Disposition': metadata.file_name
            ? `inline; filename*=UTF-8''${encodeURIComponent(metadata.file_name)}`
            : 'inline',
          'Cache-Control': 'private, max-age=86400, stale-while-revalidate=604800',
          'X-ChefOps-Media-Source': 'cloudflare-kv',
        },
      })
    }
    const value = await env.APP_DATA_PACKS.get(mediaCacheKey(fileId), 'arrayBuffer')
    return value ? new Response(value, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400, stale-while-revalidate=604800',
        'X-ChefOps-Media-Source': 'cloudflare-kv',
      },
    }) : null
  } catch (error) {
    console.error('Unable to read cached media from Cloudflare KV', fileId, error)
    return null
  }
}

async function uploadToDrive(env, file, folderType, outletName, { sourceMediaId = '' } = {}) {
  if (sourceMediaId) {
    const existing = await findDriveBackup(env, sourceMediaId)
    if (existing) return existing
  }

  const year = String(new Date().getFullYear())
  const yearFolder = await ensureFolder(env, env.GOOGLE_DRIVE_FOLDER_ID, year)
  const outletFolder = await ensureFolder(env, yearFolder.id, outletName)
  const typeFolder = await ensureFolder(env, outletFolder.id, folderType)

  const boundary = `chefops_${crypto.randomUUID()}`
  const metadata = JSON.stringify({
    name: file.name,
    parents: [typeFolder.id],
    ...(sourceMediaId ? { appProperties: { chefops_media_id: sourceMediaId } } : {}),
  })
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
    file,
    `\r\n--${boundary}--`,
  ])
  const response = await googleFetch(
    env,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink',
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
  )
  return response.json()
}

async function writeDriveBackupState(env, mediaId, state) {
  if (!env.APP_DATA_PACKS?.put) return
  await env.APP_DATA_PACKS.put(driveBackupStateKey(mediaId), JSON.stringify({
    media_id: mediaId,
    ...state,
  }), { expirationTtl: 90 * 24 * 60 * 60 })
}

async function readDriveBackupState(env, mediaId) {
  if (!env.APP_DATA_PACKS?.get) return null
  return env.APP_DATA_PACKS.get(driveBackupStateKey(mediaId), 'json')
}

async function putR2Media(env, mediaId, bytes, metadata) {
  if (!env.MEDIA_BUCKET?.put) {
    const error = new Error('Cloudflare R2 media binding is not configured')
    error.status = 503
    error.code = 'r2_media_not_configured'
    throw error
  }
  await env.MEDIA_BUCKET.put(r2ObjectKey(mediaId), bytes, {
    httpMetadata: {
      contentType: metadata.mime_type || 'application/octet-stream',
      contentDisposition: metadata.file_name
        ? `inline; filename*=UTF-8''${encodeURIComponent(metadata.file_name)}`
        : 'inline',
    },
    customMetadata: {
      file_name: String(metadata.file_name || ''),
      mime_type: String(metadata.mime_type || 'application/octet-stream'),
      folder_type: String(metadata.folder_type || 'Attachments'),
      outlet_name: String(metadata.outlet_name || 'General'),
      outlet_id: String(metadata.outlet_id || ''),
      uploaded_at: new Date().toISOString(),
    },
  })
}

async function r2Media(env, mediaId) {
  if (!env.MEDIA_BUCKET?.get) return null
  const object = await env.MEDIA_BUCKET.get(r2ObjectKey(mediaId))
  if (!object) return null
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('ETag', object.httpEtag)
  headers.set('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800')
  headers.set('X-ChefOps-Media-Source', 'cloudflare-r2')
  if (!headers.get('Content-Type')) {
    headers.set('Content-Type', object.customMetadata?.mime_type || 'application/octet-stream')
  }
  return new Response(object.body, { status: 200, headers })
}

export async function backupR2MediaToDrive(env, mediaId) {
  if (googleAuthMode(env, 'drive') === 'disabled' || googleAuthMode(env, 'drive') === 'unconfigured') {
    await writeDriveBackupState(env, mediaId, {
      status: 'disabled',
      updated_at: new Date().toISOString(),
      last_error: '',
    })
    return { media_id: mediaId, status: 'disabled' }
  }

  const object = await env.MEDIA_BUCKET?.get?.(r2ObjectKey(mediaId))
  if (!object) {
    const error = new Error('R2 media object was not found for Drive backup')
    error.code = 'r2_media_not_found'
    throw error
  }

  const metadata = object.customMetadata || {}
  const bytes = await object.arrayBuffer()
  const file = new File(
    [bytes],
    metadata.file_name || `${mediaId}.bin`,
    { type: metadata.mime_type || 'application/octet-stream' },
  )

  try {
    const uploaded = await uploadToDrive(
      env,
      file,
      metadata.folder_type || 'Attachments',
      metadata.outlet_name || metadata.outlet_id || 'General',
      { sourceMediaId: mediaId },
    )
    const state = {
      status: 'synced',
      drive_file_id: String(uploaded?.id || ''),
      drive_view_url: String(uploaded?.webViewLink || ''),
      updated_at: new Date().toISOString(),
      last_error: '',
    }
    await writeDriveBackupState(env, mediaId, state)
    return { media_id: mediaId, ...state }
  } catch (error) {
    await writeDriveBackupState(env, mediaId, {
      status: 'pending_retry',
      updated_at: new Date().toISOString(),
      last_error: String(error?.message || error).slice(0, 500),
    })
    throw error
  }
}

function scheduleDriveBackup(env, mediaId) {
  const task = backupR2MediaToDrive(env, mediaId).catch((error) => {
    console.error('Asynchronous Drive backup failed; R2 remains canonical', mediaId, error)
  })
  if (env.__CHEFOPS_CTX?.waitUntil) env.__CHEFOPS_CTX.waitUntil(task)
}

export async function retryPendingDriveBackups(env, limit = 20) {
  if (!env.MEDIA_BUCKET?.list) return []
  if (googleAuthMode(env, 'drive') === 'disabled' || googleAuthMode(env, 'drive') === 'unconfigured') return []
  const listing = await env.MEDIA_BUCKET.list({
    prefix: R2_MEDIA_PREFIX,
    limit: Math.max(1, Math.min(Number(limit) || 20, 100)),
    include: ['customMetadata'],
  })
  const results = []
  for (const object of listing.objects || []) {
    const mediaId = String(object.key || '').slice(R2_MEDIA_PREFIX.length)
    if (!mediaId) continue
    const state = await readDriveBackupState(env, mediaId)
    if (state?.status === 'synced') continue
    try {
      results.push(await backupR2MediaToDrive(env, mediaId))
    } catch (error) {
      results.push({ media_id: mediaId, status: 'pending_retry', error: String(error?.message || error) })
    }
  }
  return results
}

async function publicDriveMedia(fileId) {
  const id = encodeURIComponent(String(fileId || '').trim())
  const candidates = [
    `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
    `https://lh3.googleusercontent.com/d/${id}=w2400`,
  ]

  let lastError = null
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Accept: 'image/*,video/*,application/pdf,application/octet-stream;q=0.8,*/*;q=0.5',
          'User-Agent': 'Stupiaks-Ops-Media-Proxy/1.0',
        },
      })
      if (!response.ok) {
        lastError = new Error(`Public Drive media request failed (${response.status})`)
        continue
      }

      const contentType = String(response.headers.get('Content-Type') || '').toLowerCase()
      if (contentType.includes('text/html')) {
        lastError = new Error('Public Drive returned an HTML page instead of media')
        continue
      }

      const bytes = await response.arrayBuffer()
      if (!bytes.byteLength) {
        lastError = new Error('Public Drive returned an empty file')
        continue
      }
      return {
        bytes,
        mimeType: contentType || 'application/octet-stream',
        fileName: '',
        source: candidate.includes('googleusercontent.com') ? 'google-public-image' : 'google-public-download',
      }
    } catch (error) {
      lastError = error
    }
  }

  const error = new Error(lastError?.message || 'Public Drive media is unavailable')
  error.status = 502
  error.code = 'public_drive_media_unavailable'
  throw error
}

export async function uploadDriveFile(request, env, user) {
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    const error = new Error('Missing upload file')
    error.status = 400
    error.code = 'missing_file'
    throw error
  }
  const folderType = String(form.get('folderType') || 'Attachments')
  const outletName = String(form.get('outletName') || user.outlet_id || 'General')
  const outletId = String(form.get('outletId') || user.outlet_id || '').trim()
  if (outletId) assertOutletAccess(user, outletId)
  const uploadModule = folderType === 'Task Checklist Photos'
    ? 'task'
    : folderType === 'Urgent Issues'
      ? 'urgent_issue'
      : ''
  const mediaRule = uploadModule ? await getMediaRule(env, uploadModule, outletId) : null
  const maxFileMb = Math.max(1, Number(mediaRule?.max_file_mb || 10))
  if (file.size > maxFileMb * 1024 * 1024) {
    const error = new Error(`${file.name || 'File'} is larger than ${maxFileMb} MB`)
    error.status = 413
    error.code = 'file_too_large'
    throw error
  }
  if (mediaRule) {
    const kind = mediaKind(file.type)
    const allowed = allowedMediaKinds(mediaRule)
    if (kind === 'OTHER' || !allowed.has(kind)) {
      const label = [...allowed].join(' or ').toLowerCase() || 'approved media'
      const error = new Error(`${folderType} only accepts ${label}`)
      error.status = 415
      error.code = 'unsupported_media_type'
      throw error
    }
    if (uploadModule === 'task' && kind !== 'IMAGE') {
      const error = new Error('Task evidence only accepts an on-site photo')
      error.status = 415
      error.code = 'task_photo_only'
      throw error
    }
  }

  const apiOrigin = new URL(request.url).origin
  const bytes = await file.arrayBuffer()

  if (env.MEDIA_BUCKET?.put) {
    const mediaId = `r2_${crypto.randomUUID()}`
    await putR2Media(env, mediaId, bytes, {
      file_name: file.name,
      mime_type: file.type || 'application/octet-stream',
      folder_type: folderType,
      outlet_name: outletName,
      outlet_id: outletId,
    })
    await writeDriveBackupState(env, mediaId, {
      status: googleAuthMode(env, 'drive') === 'unconfigured' || googleAuthMode(env, 'drive') === 'disabled'
        ? 'disabled'
        : 'pending',
      updated_at: new Date().toISOString(),
      last_error: '',
    })
    scheduleDriveBackup(env, mediaId)
    return {
      drive_file_id: mediaId,
      file_name: file.name,
      mime_type: file.type || 'application/octet-stream',
      file_size: Number(file.size || bytes.byteLength),
      view_url: '',
      file_url: `${apiOrigin}/api/files/${encodeURIComponent(mediaId)}`,
      storage: 'cloudflare-r2',
      primary_storage: 'cloudflare-r2',
      drive_sync_status: googleAuthMode(env, 'drive') === 'unconfigured' || googleAuthMode(env, 'drive') === 'disabled'
        ? 'disabled'
        : 'pending',
    }
  }

  const fallbackId = `kv_${crypto.randomUUID()}`
  const cacheEligible = String(file.type || '').startsWith('image/')
  const fallbackCached = cacheEligible
    ? await cacheMedia(env, fallbackId, bytes, { mimeType: file.type, fileName: file.name })
    : false

  try {
    const uploaded = await uploadToDrive(env, file, folderType, outletName)
    if (!uploaded?.id) throw new Error('Google Drive did not return a file ID')
    if (cacheEligible) {
      await cacheMedia(env, uploaded.id, bytes, {
        mimeType: uploaded.mimeType || file.type,
        fileName: uploaded.name || file.name,
      })
    }
    return {
      drive_file_id: uploaded.id,
      file_name: uploaded.name || file.name,
      mime_type: uploaded.mimeType || file.type,
      file_size: Number(uploaded.size || file.size),
      view_url: uploaded.webViewLink || '',
      file_url: `${apiOrigin}/api/files/${encodeURIComponent(uploaded.id)}`,
      storage: cacheEligible ? 'drive+cloudflare-kv' : 'drive',
      primary_storage: 'google-drive',
      drive_sync_status: 'synced',
    }
  } catch (error) {
    if (!fallbackCached) throw error
    console.error('Google Drive upload deferred; Cloudflare KV media copy remains active', error)
    return {
      drive_file_id: fallbackId,
      file_name: file.name,
      mime_type: file.type || 'application/octet-stream',
      file_size: Number(file.size || bytes.byteLength),
      view_url: '',
      file_url: `${apiOrigin}/api/files/${encodeURIComponent(fallbackId)}`,
      storage: 'cloudflare-kv',
      primary_storage: 'cloudflare-kv',
      drive_sync_status: 'deferred',
      drive_sync_error: String(error?.message || error).slice(0, 500),
    }
  }
}

export async function downloadDriveFile(env, fileId) {
  const id = String(fileId || '').trim()

  if (id.startsWith('r2_')) {
    const stored = await r2Media(env, id)
    if (stored) return stored
    const error = new Error('R2 media file was not found')
    error.status = 404
    error.code = 'media_not_found'
    throw error
  }

  const cached = await cachedMedia(env, id)
  if (cached) return cached

  if (id.startsWith('kv_')) {
    const error = new Error('Cached media file was not found')
    error.status = 404
    error.code = 'media_not_found'
    throw error
  }

  let bytes = null
  let mimeType = 'application/octet-stream'
  let fileName = ''
  let source = 'google-drive'
  try {
    const upstream = await googleFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`)
    bytes = await upstream.arrayBuffer()
    mimeType = upstream.headers.get('Content-Type') || mimeType
    fileName = upstream.headers.get('X-Goog-Meta-File-Name') || ''
  } catch (googleError) {
    console.error('Authenticated Drive media read failed; trying public delivery', id, googleError)
    const fallback = await publicDriveMedia(id)
    bytes = fallback.bytes
    mimeType = fallback.mimeType
    fileName = fallback.fileName
    source = fallback.source
  }

  if (!bytes?.byteLength) {
    const error = new Error('Media file is empty')
    error.status = 502
    error.code = 'empty_media_file'
    throw error
  }

  await cacheMedia(env, id, bytes, { mimeType, fileName })
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Content-Disposition': fileName
        ? `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`
        : 'inline',
      'Cache-Control': 'private, max-age=86400, stale-while-revalidate=604800',
      'X-ChefOps-Media-Source': source,
    },
  })
}
