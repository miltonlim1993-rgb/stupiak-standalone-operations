const RETAINED_TEMPLATE_ID = 'tmpl-rr-opening-checklist-v3'
const RETIRED_TEMPLATE_IDS = new Set(['tmpl-rr-daily-standards-v4'])
const TASK_PHOTO_LIMIT = 10
const GUIDANCE_CN = '同类物品请放在同一张照片一起拍摄，不要逐件分开拍；每组最多可上传 10 张。'
const GUIDANCE_EN = 'Photograph matching items together in one frame instead of taking separate photos for each item; each group supports up to 10 photos.'

function templateId(task) {
  return String(task?.template_id || task?.config?.template_id || '').trim()
}

function withPhotoLimit(group = {}) {
  return {
    ...group,
    max_photos: TASK_PHOTO_LIMIT,
    grouping_guidance_cn: GUIDANCE_CN,
    grouping_guidance_en: GUIDANCE_EN,
  }
}

function normalizeTask(task = {}) {
  return {
    ...task,
    config: task?.config && typeof task.config === 'object'
      ? {
          ...task.config,
          photo_groups: Array.isArray(task.config.photo_groups)
            ? task.config.photo_groups.map(withPhotoLimit)
            : [],
        }
      : task.config,
    photo_requirements: Array.isArray(task.photo_requirements)
      ? task.photo_requirements.map(withPhotoLimit)
      : task.photo_requirements,
    photo_policy: {
      max_photos_per_group: TASK_PHOTO_LIMIT,
      grouping_guidance_cn: GUIDANCE_CN,
      grouping_guidance_en: GUIDANCE_EN,
    },
  }
}

export function applyOperationalTaskPayloadPolicy(payload = {}) {
  const tasks = (Array.isArray(payload.tasks) ? payload.tasks : [])
    .filter((task) => !RETIRED_TEMPLATE_IDS.has(templateId(task)))
    .map(normalizeTask)
  const taskIds = new Set(tasks.map((task) => String(task?.id || '')).filter(Boolean))

  return {
    ...payload,
    tasks,
    task_photos: Array.isArray(payload.task_photos)
      ? payload.task_photos.filter((photo) => !photo?.task_id || taskIds.has(String(photo.task_id)))
      : payload.task_photos,
    template_photos: Array.isArray(payload.template_photos)
      ? payload.template_photos.filter((photo) => !RETIRED_TEMPLATE_IDS.has(String(photo?.template_id || '')))
      : payload.template_photos,
    operational_task_policy: {
      retained_template_id: RETAINED_TEMPLATE_ID,
      retired_template_ids: [...RETIRED_TEMPLATE_IDS],
      max_photos_per_group: TASK_PHOTO_LIMIT,
      grouping_guidance_cn: GUIDANCE_CN,
      grouping_guidance_en: GUIDANCE_EN,
    },
  }
}

function responseUrl(input) {
  try {
    if (input instanceof Request) return new URL(input.url, window.location.origin)
    return new URL(String(input || ''), window.location.origin)
  } catch {
    return null
  }
}

function installBootstrapPolicy() {
  if (window.__chefopsOperationalTaskFetchPolicy) return
  window.__chefopsOperationalTaskFetchPolicy = true
  const baseFetch = window.fetch.bind(window)

  window.fetch = async (input, init) => {
    const response = await baseFetch(input, init)
    const url = responseUrl(input)
    if (
      url?.pathname !== '/api/tasks/operational/bootstrap'
      || response.status < 200
      || response.status >= 300
    ) return response

    try {
      const payload = await response.clone().json()
      const headers = new Headers(response.headers)
      headers.set('Content-Type', 'application/json; charset=utf-8')
      headers.set('Cache-Control', 'no-store')
      headers.set('X-ChefOps-Client-Task-Policy', 'opening-only-photo10-v1')
      return new Response(JSON.stringify(applyOperationalTaskPayloadPolicy(payload)), {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return response
    }
  }
}

function guidanceText(pathname) {
  if (pathname === '/tasks') {
    return {
      title: '任务照片：同类物品一起拍',
      body: `${GUIDANCE_CN} ${GUIDANCE_EN}`,
      heading: '今日任务',
    }
  }
  if (pathname === '/urgent') {
    return {
      title: 'Issue 照片：相关物品一起拍',
      body: '相关或同类物品可放在同一张照片中清楚呈现，不需要逐件分开拍；最多可上传 10 张。 Related or matching items may be shown clearly in the same photo; up to 10 photos are supported.',
      heading: 'Urgent Issues',
    }
  }
  return null
}

function pageRootForGuidance(guidance) {
  const main = document.getElementById('chefops-mobile-main')
  if (!main) return null
  const heading = [...main.querySelectorAll('h1')]
    .find((node) => String(node.textContent || '').trim().includes(guidance.heading))
  if (!heading) return null

  let current = heading.parentElement
  while (current && current !== main) {
    if (
      current.classList.contains('chefops-page')
      || current.classList.contains('urgent-page')
      || current.classList.contains('max-w-lg')
    ) return current
    current = current.parentElement
  }
  return null
}

function installPageGuidance() {
  let scheduled = false
  const render = () => {
    scheduled = false
    const pathname = window.location.pathname
    const guidance = guidanceText(pathname)
    document.querySelectorAll('[data-chefops-photo-policy-guidance]').forEach((node) => {
      if (!guidance || node.dataset.chefopsPhotoPolicyGuidance !== pathname) node.remove()
    })
    if (!guidance) return

    const page = pageRootForGuidance(guidance)
    if (!page || page.querySelector(`[data-chefops-photo-policy-guidance="${pathname}"]`)) return

    const notice = document.createElement('aside')
    notice.className = 'chefops-photo-policy-guidance'
    notice.dataset.chefopsPhotoPolicyGuidance = pathname
    notice.setAttribute('role', 'note')
    const title = document.createElement('strong')
    title.textContent = guidance.title
    const body = document.createElement('span')
    body.textContent = guidance.body
    notice.append(title, body)

    const firstSection = page.firstElementChild
    if (firstSection?.nextSibling) page.insertBefore(notice, firstSection.nextSibling)
    else page.appendChild(notice)
  }

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(render)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('popstate', schedule)
  window.addEventListener('hashchange', schedule)
  window.addEventListener('chefops:viewport-changed', schedule)
  schedule()
}

export function installOperationalTaskPolicy() {
  if (window.__chefopsOperationalTaskPolicyInstalled) return
  window.__chefopsOperationalTaskPolicyInstalled = true
  installBootstrapPolicy()
  installPageGuidance()
}

export const OPERATIONAL_TASK_POLICY = Object.freeze({
  retained_template_id: RETAINED_TEMPLATE_ID,
  retired_template_ids: [...RETIRED_TEMPLATE_IDS],
  max_photos_per_group: TASK_PHOTO_LIMIT,
  grouping_guidance_cn: GUIDANCE_CN,
  grouping_guidance_en: GUIDANCE_EN,
})
