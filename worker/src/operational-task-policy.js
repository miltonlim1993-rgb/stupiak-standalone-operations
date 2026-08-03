const RETAINED_TEMPLATE_ID = 'tmpl-rr-opening-checklist-v3'
const RETIRED_TEMPLATE_IDS = new Set(['tmpl-rr-daily-standards-v4'])
const TASK_PHOTO_LIMIT = 10

export const OPERATIONAL_TASK_PHOTO_GUIDANCE_CN = '同类物品请放在同一张照片一起拍摄，不要逐件分开拍；每组最多可上传 10 张。'
export const OPERATIONAL_TASK_PHOTO_GUIDANCE_EN = 'Photograph matching items together in one frame instead of taking separate photos for each item; each group supports up to 10 photos.'

function templateId(task) {
  return String(task?.template_id || task?.config?.template_id || '').trim()
}

function withPhotoPolicy(group = {}) {
  return {
    ...group,
    max_photos: TASK_PHOTO_LIMIT,
    grouping_guidance_cn: OPERATIONAL_TASK_PHOTO_GUIDANCE_CN,
    grouping_guidance_en: OPERATIONAL_TASK_PHOTO_GUIDANCE_EN,
  }
}

function normalizeTask(task = {}) {
  const config = task?.config && typeof task.config === 'object'
    ? {
        ...task.config,
        photo_groups: Array.isArray(task.config.photo_groups)
          ? task.config.photo_groups.map(withPhotoPolicy)
          : [],
      }
    : task.config

  return {
    ...task,
    config,
    photo_requirements: Array.isArray(task.photo_requirements)
      ? task.photo_requirements.map(withPhotoPolicy)
      : task.photo_requirements,
    photo_policy: {
      max_photos_per_group: TASK_PHOTO_LIMIT,
      grouping_guidance_cn: OPERATIONAL_TASK_PHOTO_GUIDANCE_CN,
      grouping_guidance_en: OPERATIONAL_TASK_PHOTO_GUIDANCE_EN,
    },
  }
}

export function applyOperationalTaskPolicyPayload(payload = {}) {
  const sourceTasks = Array.isArray(payload.tasks) ? payload.tasks : []
  const hasRetainedTask = sourceTasks.some((task) => templateId(task) === RETAINED_TEMPLATE_ID)
  const tasks = sourceTasks
    .filter((task) => {
      const id = templateId(task)
      if (!RETIRED_TEMPLATE_IDS.has(id)) return true
      return !hasRetainedTask ? false : false
    })
    .map(normalizeTask)

  const taskIds = new Set(tasks.map((task) => String(task?.id || '')).filter(Boolean))
  const taskPhotos = Array.isArray(payload.task_photos)
    ? payload.task_photos.filter((photo) => !photo?.task_id || taskIds.has(String(photo.task_id)))
    : payload.task_photos
  const templatePhotos = Array.isArray(payload.template_photos)
    ? payload.template_photos.filter((photo) => !RETIRED_TEMPLATE_IDS.has(String(photo?.template_id || '')))
    : payload.template_photos

  return {
    ...payload,
    tasks,
    task_photos: taskPhotos,
    template_photos: templatePhotos,
    operational_task_policy: {
      retained_template_id: RETAINED_TEMPLATE_ID,
      retired_template_ids: [...RETIRED_TEMPLATE_IDS],
      max_photos_per_group: TASK_PHOTO_LIMIT,
      grouping_guidance_cn: OPERATIONAL_TASK_PHOTO_GUIDANCE_CN,
      grouping_guidance_en: OPERATIONAL_TASK_PHOTO_GUIDANCE_EN,
    },
  }
}

export async function applyOperationalTaskPolicyResponse(request, url, response) {
  if (
    url.pathname !== '/api/tasks/operational/bootstrap'
    || request.method !== 'POST'
    || response.status < 200
    || response.status >= 300
  ) return response

  let payload
  try {
    payload = await response.clone().json()
  } catch {
    return response
  }

  const headers = new Headers(response.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  headers.set('X-ChefOps-Task-Policy', 'opening-only-photo10-v1')
  return new Response(JSON.stringify(applyOperationalTaskPolicyPayload(payload)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export const OPERATIONAL_TASK_POLICY = Object.freeze({
  retained_template_id: RETAINED_TEMPLATE_ID,
  retired_template_ids: [...RETIRED_TEMPLATE_IDS],
  max_photos_per_group: TASK_PHOTO_LIMIT,
})
