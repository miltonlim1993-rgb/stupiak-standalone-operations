import { getCurrentUser } from './auth.js'
import { uploadDriveFile } from './drive.js'
import { errorResponse, json } from './http.js'

const UPLOAD_PATH = 'r2-primary-no-sheet-audit-v1'
const TASK_PHOTO_FOLDER = 'Task Checklist Photos'

export async function handlePrimaryMediaUpload(request, env, url) {
  if (url.pathname !== '/api/files/upload' || request.method !== 'POST') return null

  try {
    const probe = await request.clone().formData()
    if (String(probe.get('folderType') || 'Attachments') !== TASK_PHOTO_FOLDER) return null

    const user = await getCurrentUser(request, env)
    const uploaded = await uploadDriveFile(request, env, user)
    return json(request, env, {
      ...uploaded,
      upload_path: UPLOAD_PATH,
    }, 201, {
      'X-ChefOps-Media-Upload-Path': UPLOAD_PATH,
    })
  } catch (error) {
    if (Number(error?.status || 500) >= 500) {
      error.publicMessage = `文件上传失败：${String(error?.message || '服务器无法保存照片').slice(0, 180)}`
    }
    return errorResponse(request, env, error)
  }
}
