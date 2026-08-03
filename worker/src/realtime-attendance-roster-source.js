import { getCurrentUser } from './auth.js'
import { uploadDriveFile } from './drive.js'
import { errorResponse, json } from './http.js'

const DUTY_ROSTER_FOLDER = 'Duty Rosters'

function queuedReceipt(request, file) {
  return {
    drive_file_id: '',
    file_name: String(file?.name || 'weekly-duty-roster.pdf'),
    mime_type: String(file?.type || 'application/pdf'),
    file_size: Number(file?.size || 0),
    view_url: '',
    file_url: '',
    storage: 'd1-roster-source-backup',
    drive_sync_status: 'queued',
    upload_blocked_roster_import: false,
    accepted_at: new Date().toISOString(),
    request_origin: new URL(request.url).origin,
  }
}

export async function handleDutyRosterSourceUpload(request, env, url) {
  if (url.pathname !== '/api/files/upload' || request.method !== 'POST') return null

  const uploadRequest = request.clone()
  let form
  try {
    form = await request.clone().formData()
  } catch {
    return null
  }
  if (String(form.get('folderType') || '') !== DUTY_ROSTER_FOLDER) return null

  try {
    const user = await getCurrentUser(request, env)
    const file = form.get('file')
    if (!(file instanceof File)) {
      const error = new Error('Missing Duty Roster PDF')
      error.status = 400
      error.code = 'missing_roster_pdf'
      throw error
    }
    if (!(file.type === 'application/pdf' || String(file.name || '').toLowerCase().endsWith('.pdf'))) {
      const error = new Error('Duty Roster source must be a PDF')
      error.status = 415
      error.code = 'invalid_roster_pdf'
      throw error
    }

    const backgroundUpload = uploadDriveFile(uploadRequest, env, user)
      .then((uploaded) => {
        console.log('Duty Roster PDF backup completed', uploaded?.drive_file_id || uploaded?.file_name || file.name)
        return uploaded
      })
      .catch((error) => {
        console.error('Duty Roster PDF backup failed after source receipt was accepted', error)
      })

    if (env.__CHEFOPS_CTX?.waitUntil) env.__CHEFOPS_CTX.waitUntil(backgroundUpload)
    else backgroundUpload.catch(() => undefined)

    return json(request, env, queuedReceipt(request, file), 202)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
