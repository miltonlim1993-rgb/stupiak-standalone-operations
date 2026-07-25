import { googleFetch } from './google.js'
import { allowedMediaKinds, getMediaRule, mediaKind } from './media-rules.js'
import { assertOutletAccess } from './permissions.js'

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
  const year = String(new Date().getFullYear())
  const yearFolder = await ensureFolder(env, env.GOOGLE_DRIVE_FOLDER_ID, year)
  const outletFolder = await ensureFolder(env, yearFolder.id, outletName)
  const typeFolder = await ensureFolder(env, outletFolder.id, folderType)

  const boundary = `chefops_${crypto.randomUUID()}`
  const metadata = JSON.stringify({ name: file.name, parents: [typeFolder.id] })
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
  const uploaded = await response.json()
  const apiOrigin = new URL(request.url).origin
  return {
    drive_file_id: uploaded.id,
    file_name: uploaded.name,
    mime_type: uploaded.mimeType,
    file_size: Number(uploaded.size || file.size),
    view_url: uploaded.webViewLink || '',
    file_url: `${apiOrigin}/api/files/${encodeURIComponent(uploaded.id)}`,
  }
}

export async function downloadDriveFile(env, fileId) {
  return googleFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)
}
