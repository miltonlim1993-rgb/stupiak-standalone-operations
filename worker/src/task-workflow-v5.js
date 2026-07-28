import { listRecords } from './sheets.js'
import { handleTaskWorkflowV3, taskProgressSummary } from './task-workflow-v3.js'
import {
  attachScheduledTaskAssignees,
  practicalTaskAppliesOnDate,
} from './task-practical-schedule-v5.js'

function timestamp() {
  return new Date().toISOString()
}

function shiftId(task) {
  return String(task?.shift_id || task?.config?.schedule?.shift_id || task?.period || 'ALL').toUpperCase()
}

function chooseVisibleShift(tasks, serverTime, preferred = 'ALL') {
  const wanted = String(preferred || 'ALL').toUpperCase()
  if (wanted !== 'ALL' && tasks.some((task) => shiftId(task) === wanted)) return wanted

  const now = Date.parse(serverTime || '') || Date.now()
  const active = tasks
    .filter((task) => {
      const open = Date.parse(task.opens_at || '')
      const lock = Date.parse(task.locks_at || '')
      return Number.isFinite(open) && Number.isFinite(lock) && now >= open && now <= lock
    })
    .sort((left, right) => Date.parse(left.due_at || '') - Date.parse(right.due_at || ''))
  if (active.length) return shiftId(active[0])

  const upcoming = tasks
    .filter((task) => Date.parse(task.opens_at || '') > now)
    .sort((left, right) => Date.parse(left.opens_at || '') - Date.parse(right.opens_at || ''))
  if (upcoming.length) return shiftId(upcoming[0])

  return tasks.length ? shiftId(tasks[0]) : 'ALL'
}

function withAssignmentLabel(task) {
  const name = String(task?.assigned_to_name || '').trim()
  if (!name || task?.assignment_source !== 'DUTY_ROSTER_SCHEDULE') return task
  const shiftCn = String(task.shift_name_cn || '').replace(/\s*·\s*负责人：.*$/, '')
  const shiftEn = String(task.shift_name_en || '').replace(/\s*·\s*Assigned:.*$/, '')
  return {
    ...task,
    shift_name_cn: `${shiftCn || '当班'} · 负责人：${name}`,
    shift_name_en: `${shiftEn || 'Shift'} · Assigned: ${name}`,
  }
}

async function practicalBootstrap(request, env, url, ctx, legacyApp) {
  const bodyRequest = request.clone()
  const response = await handleTaskWorkflowV3(request, env, url, ctx, legacyApp)
  if (!response || !response.ok) return response

  const body = await bodyRequest.json().catch(() => ({}))
  const payload = await response.json()
  const date = String(body.date || '').trim()
  const outletId = String(body.outlet_id || payload.outlet_id || '').trim()
  const year = Number(date.slice(0, 4)) || new Date().getUTCFullYear()

  const applicable = (payload.tasks || []).filter((task) => practicalTaskAppliesOnDate(task.config, date))
  const rosterRows = outletId && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? await listRecords(env, 'Attendance', {
        filter: { outlet_id: outletId, date },
        sort: 'clock_in,staff_role,staff_name',
        limit: 500,
        year,
      }).catch(() => [])
    : []
  const tasks = attachScheduledTaskAssignees(applicable, rosterRows, date).map(withAssignmentLabel)
  const serverTime = payload.server_time || timestamp()

  return Response.json({
    ...payload,
    schema: 'task-workflow-v5-practical-chain',
    tasks,
    current_shift_id: chooseVisibleShift(tasks, serverTime, payload.current_shift_id),
    progress: taskProgressSummary(tasks),
    assignment_source: 'DUTY_ROSTER_SCHEDULE_ONLY',
  }, {
    status: response.status,
    headers: response.headers,
  })
}

export async function handleTaskWorkflowV5(request, env, url, ctx, legacyApp) {
  if (url.pathname === '/api/tasks/v3/bootstrap' && request.method === 'POST') {
    return practicalBootstrap(request, env, url, ctx, legacyApp)
  }
  return handleTaskWorkflowV3(request, env, url, ctx, legacyApp)
}
