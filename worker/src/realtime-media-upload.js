import { getCurrentUser } from './auth.js'
import { uploadDriveFile } from './drive.js'
import { errorResponse, json } from './http.js'

const UPLOAD_PATH = 'r2-primary-no-sheet-audit-v1'

export async function handlePrimaryMediaUpload(request, env, url) {
  if (url.pathname !== '/api/files/upload' || request.method !== 'POST') return null

  try {
    const user = await getCurrentUser(request, env)
    const uploaded = await uploadDriveFile(request, env, user)
    return json(request, env, {
      ...uploaded,
      upload_path: UPLOAD_PATH,
    }, 201, {
      'X-ChefOps-Media-Upload-Path': UPLOAD_PATH,
    })
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
