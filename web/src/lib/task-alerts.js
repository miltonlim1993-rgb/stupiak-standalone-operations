const ALERT_PERMISSION_KEY = 'chefops.task-alerts.permission-enabled'
const ALERT_AUDIO_KEY = 'chefops.task-alerts.audio-enabled'

function asDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function safeText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function taskTitle(task) {
  const config = task?.config || {}
  return safeText(config.title_cn || config.title || task?.title || 'OPS Task')
}

function courseTitle(course) {
  return safeText(course?.title_cn || course?.title || 'SOP / Training')
}

function parsedTaskState(task) {
  try {
    const value = JSON.parse(String(task?.notes || ''))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function isDone(task) {
  return String(task?.status || '').toLowerCase() === 'done'
    || String(task?.access_state || '').toUpperCase() === 'DONE'
}

export function taskWorkHasStarted(task) {
  const status = String(task?.status || '').toLowerCase()
  const state = parsedTaskState(task)
  return status === 'in_progress'
    || Boolean(task?.started_at)
    || Boolean(state?.started_at)
}

export function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function nativePlugin() {
  return window.Capacitor?.Plugins?.TaskAlarm || null
}

async function activeServiceWorker() {
  if (!('serviceWorker' in navigator)) return null
  try {
    const registration = await navigator.serviceWorker.ready
    return registration.active || registration.waiting || registration.installing || null
  } catch {
    return navigator.serviceWorker.controller || null
  }
}

async function postServiceWorker(message) {
  const worker = await activeServiceWorker()
  worker?.postMessage?.(message)
}

export function markAlertAudioEnabled(enabled = true) {
  localStorage.setItem(ALERT_AUDIO_KEY, enabled ? '1' : '0')
}

export function isAlertAudioEnabled() {
  return localStorage.getItem(ALERT_AUDIO_KEY) === '1'
}

export async function getTaskAlertPermissionState() {
  if (isNativeAndroid() && nativePlugin()?.getPermissionState) {
    try {
      const state = await nativePlugin().getPermissionState()
      return {
        platform: 'android',
        notificationsGranted: Boolean(state.notificationsGranted),
        exactAlarmGranted: Boolean(state.exactAlarmGranted),
        fullScreenIntentGranted: state.fullScreenIntentGranted !== false,
        enabled: Boolean(state.notificationsGranted && state.exactAlarmGranted),
        ...state,
      }
    } catch (error) {
      return { platform: 'android', enabled: false, error: error?.message || String(error) }
    }
  }

  const supported = 'Notification' in window
  const permission = supported ? Notification.permission : 'unsupported'
  return {
    platform: 'web',
    supported,
    permission,
    notificationsGranted: permission === 'granted',
    exactAlarmGranted: false,
    fullScreenIntentGranted: false,
    enabled: permission === 'granted' && isAlertAudioEnabled(),
  }
}

export async function enableTaskAlerts() {
  localStorage.setItem(ALERT_PERMISSION_KEY, '1')

  if (isNativeAndroid() && nativePlugin()?.requestPermissions) {
    const result = await nativePlugin().requestPermissions()
    return { platform: 'android', ...result }
  }

  if (!('Notification' in window)) {
    return { platform: 'web', supported: false, notificationsGranted: false }
  }

  const permission = await Notification.requestPermission()
  return { platform: 'web', supported: true, permission, notificationsGranted: permission === 'granted' }
}

export async function openTaskAlertSettings() {
  if (isNativeAndroid() && nativePlugin()?.openSettings) {
    return nativePlugin().openSettings()
  }
  return null
}

export async function stopNativeTaskAlarm(alertId = '') {
  if (isNativeAndroid() && nativePlugin()?.stopAlarm) {
    try { await nativePlugin().stopAlarm({ id: safeText(alertId) }) } catch {}
  }
}

export async function cancelTaskAlertsForTask(taskId = '') {
  const id = safeText(taskId)
  if (!id) return
  await postServiceWorker({ type: 'CANCEL_TASK_ALERTS', taskId: id }).catch(() => undefined)
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.()
    const notifications = await registration?.getNotifications?.()
    for (const notification of notifications || []) {
      if (safeText(notification?.data?.taskId) === id) notification.close()
    }
  } catch {}
}

export async function syncTaskAlertSchedule(alerts = []) {
  const normalized = (alerts || [])
    .filter((alert) => Number(alert?.triggerAt) > Date.now() - 30_000)
    .map((alert) => ({
      id: safeText(alert.id),
      kind: safeText(alert.kind, 'task'),
      title: safeText(alert.title, 'Stupiak’s Ops'),
      message: safeText(alert.message),
      targetPage: safeText(alert.targetPage, '/tasks'),
      triggerAt: Number(alert.triggerAt),
      taskId: safeText(alert.taskId),
      sopId: safeText(alert.sopId),
      outletId: safeText(alert.outletId),
    }))
    .filter((alert) => alert.id && Number.isFinite(alert.triggerAt))

  if (isNativeAndroid() && nativePlugin()?.syncAlarms) {
    await nativePlugin().syncAlarms({ alerts: normalized })
  } else {
    await postServiceWorker({ type: 'SYNC_ALERT_SCHEDULE', alerts: normalized })
  }

  return normalized
}

export async function showWebTaskNotification(alert) {
  const item = {
    id: safeText(alert?.id),
    title: safeText(alert?.title, 'Stupiak’s Ops'),
    message: safeText(alert?.message),
    target_page: safeText(alert?.targetPage, '/tasks'),
    kind: safeText(alert?.kind, 'task'),
    taskId: safeText(alert?.taskId),
    outletId: safeText(alert?.outletId),
  }

  if ('serviceWorker' in navigator) {
    await postServiceWorker({ type: 'SHOW_NOTIFICATION', notification: item })
    return true
  }

  if ('Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(item.title, {
      body: item.message,
      icon: '/stupiaks-ops-192.png',
      badge: '/favicon-32.png',
      tag: item.id || undefined,
      requireInteraction: true,
      silent: false,
      data: { taskId: item.taskId, outletId: item.outletId },
    })
    notification.onclick = () => {
      window.focus()
      window.location.assign(item.target_page)
      notification.close()
    }
    return true
  }

  return false
}

export function collectTaskAlerts(tasks = []) {
  const alerts = []
  for (const task of tasks || []) {
    // The first person who opens a pending task changes it to in_progress.
    // From that moment the task is owned by active work and no open/due alarm
    // should keep ringing on the rest of the outlet devices.
    if (!task || isDone(task) || taskWorkHasStarted(task)) continue
    const config = task.config || {}
    const title = taskTitle(task)
    const sopId = safeText(task.sop_id || config.sop_id)
    const outletId = safeText(task.outlet_id)
    const taskId = safeText(task.id)
    const openAt = asDate(task.opens_at)
    const dueAt = asDate(task.due_at)

    if (openAt && openAt.getTime() > Date.now() - 30_000) {
      alerts.push({
        id: `task:${taskId}:open:${openAt.toISOString()}`,
        kind: sopId ? 'sop' : 'task-open',
        title: sopId ? `SOP 提醒：${title}` : `任务已开放：${title}`,
        message: sopId ? '请先查看标准做法，再开始执行这项任务。' : '这项任务已经开放，请开始处理。',
        targetPage: sopId ? `/sop/${encodeURIComponent(sopId)}` : '/tasks',
        triggerAt: openAt.getTime(),
        taskId,
        sopId,
        outletId,
      })
    }

    if (dueAt && dueAt.getTime() > Date.now() - 30_000) {
      alerts.push({
        id: `task:${taskId}:due:${dueAt.toISOString()}`,
        kind: 'task-due',
        title: `任务截止提醒：${title}`,
        message: sopId ? '任务已到截止时间。请立即完成，或打开关联 SOP 检查标准。' : '任务已到截止时间，请立即完成并提交。',
        targetPage: '/tasks',
        triggerAt: dueAt.getTime(),
        taskId,
        sopId,
        outletId,
      })
    }
  }
  return alerts
}

export function collectTrainingAlerts({ assignments = [], courses = [], progress = [], userEmail = '' } = {}) {
  const email = safeText(userEmail).toLowerCase()
  if (!email) return []
  const courseById = new Map((courses || []).map((course) => [safeText(course.id), course]))
  const completedCourseIds = new Set((progress || [])
    .filter((row) => safeText(row.user_email).toLowerCase() === email && safeText(row.status).toLowerCase() === 'completed')
    .map((row) => safeText(row.course_id)))

  return (assignments || []).flatMap((assignment) => {
    if (safeText(assignment.user_email).toLowerCase() !== email) return []
    const courseId = safeText(assignment.course_id)
    if (!courseId || completedCourseIds.has(courseId) || !assignment.due_date) return []
    const trigger = asDate(`${safeText(assignment.due_date).slice(0, 10)}T09:00:00+08:00`)
    if (!trigger || trigger.getTime() <= Date.now() - 30_000) return []
    const course = courseById.get(courseId)
    return [{
      id: `training:${safeText(assignment.id || courseId)}:due:${safeText(assignment.due_date).slice(0, 10)}`,
      kind: 'training-due',
      title: `SOP / Training 到期：${courseTitle(course)}`,
      message: '今天需要完成这项培训或 SOP 阅读确认。',
      targetPage: '/training',
      triggerAt: trigger.getTime(),
      taskId: '',
      sopId: '',
      outletId: safeText(assignment.outlet_id),
    }]
  })
}