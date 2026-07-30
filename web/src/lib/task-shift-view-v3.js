const SUMMARY_KEYS = ['total', 'completed', 'pending', 'in_progress', 'locked', 'issue', 'overdue']

function emptySummary(shiftId) {
  return {
    shift_id: shiftId,
    total: 0,
    completed: 0,
    pending: 0,
    in_progress: 0,
    locked: 0,
    issue: 0,
    overdue: 0,
  }
}

function rawTaskShift(task) {
  return String(task?.shift_id || task?.config?.schedule?.shift_id || 'DAILY').toUpperCase()
}

function taskShift(task) {
  const id = rawTaskShift(task)
  return id === 'SHIFT_CONTROLLED' ? 'DAILY' : id
}

function activeWindow(task, now) {
  const opensAt = Date.parse(task?.opens_at || '')
  const locksAt = Date.parse(task?.locks_at || '')
  return Number.isFinite(opensAt) && Number.isFinite(locksAt) && now >= opensAt && now <= locksAt
}

function currentShiftFromTasks(tasks, payload) {
  const supplied = String(payload?.current_shift_id || '').toUpperCase()
  if (['MORNING', 'NIGHT'].includes(supplied)) return supplied

  const now = Date.parse(payload?.server_time || '') || Date.now()
  const shiftTasks = (tasks || []).filter((task) => ['MORNING', 'NIGHT'].includes(taskShift(task)))
  const active = shiftTasks
    .filter((task) => activeWindow(task, now))
    .sort((a, b) => Date.parse(a.due_at || '') - Date.parse(b.due_at || ''))
  if (active.length) return taskShift(active[0])

  const upcoming = shiftTasks
    .filter((task) => Date.parse(task.opens_at || '') > now)
    .sort((a, b) => Date.parse(a.opens_at || '') - Date.parse(b.opens_at || ''))
  if (upcoming.length) return taskShift(upcoming[0])

  const latest = [...shiftTasks].sort((a, b) => Date.parse(b.opens_at || '') - Date.parse(a.opens_at || ''))
  return latest.length ? taskShift(latest[0]) : 'ALL'
}

function summarize(tasks, shiftId) {
  const summary = emptySummary(shiftId)
  for (const task of tasks || []) {
    summary.total += 1
    const status = String(task?.status_key || 'pending').toLowerCase()
    if (SUMMARY_KEYS.includes(status)) summary[status] += 1
    else summary.pending += 1
  }
  return summary
}

export function normalizeTaskWorkflowShiftView(payload = {}) {
  const sourceTasks = Array.isArray(payload.tasks) ? payload.tasks : []
  const currentShiftId = currentShiftFromTasks(sourceTasks, payload)
  const tasks = sourceTasks.map((task) => {
    if (taskShift(task) !== 'DAILY' || !['MORNING', 'NIGHT'].includes(currentShiftId)) return task
    return {
      ...task,
      source_shift_id: rawTaskShift(task),
      shift_id: currentShiftId,
      shift_name_cn: task.shift_name_cn || '当前班次',
      shift_name_en: task.shift_name_en || 'Current Shift',
    }
  })

  const morning = tasks.filter((task) => taskShift(task) === 'MORNING')
  const night = tasks.filter((task) => taskShift(task) === 'NIGHT')
  const daily = sourceTasks.filter((task) => taskShift(task) === 'DAILY')

  return {
    ...payload,
    tasks,
    current_shift_id: currentShiftId,
    progress: {
      ...(payload.progress || {}),
      MORNING: summarize(morning, 'MORNING'),
      NIGHT: summarize(night, 'NIGHT'),
      DAILY: summarize(daily, 'DAILY'),
      ALL: summarize(sourceTasks, 'ALL'),
    },
  }
}
