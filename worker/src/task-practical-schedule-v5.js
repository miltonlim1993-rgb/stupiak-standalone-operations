const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function clean(value = '') {
  return String(value ?? '').trim()
}

function upper(value = '') {
  return clean(value).toUpperCase()
}

function list(value) {
  if (Array.isArray(value)) return value.map(upper).filter(Boolean)
  return clean(value).split(',').map(upper).filter(Boolean)
}

function dateParts(dateText) {
  const match = clean(dateText).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null
  return {
    year,
    month,
    day,
    weekday: DAY_CODES[date.getUTCDay()],
    weekOfMonth: Math.floor((day - 1) / 7) + 1,
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  }
}

export function practicalTaskAppliesOnDate(config = {}, dateText = '') {
  const parts = dateParts(dateText)
  if (!parts) return false

  const recurrence = config.recurrence || config.schedule?.recurrence || {}
  const frequency = upper(recurrence.frequency || recurrence.freq || 'DAILY')
  if (!frequency || frequency === 'DAILY') return true

  if (frequency === 'WEEKLY') {
    const activeDays = list(recurrence.active_days || recurrence.days || recurrence.byday)
    return !activeDays.length || activeDays.includes(parts.weekday)
  }

  if (frequency === 'MONTHLY_NTH_WEEKDAY') {
    const weekday = upper(recurrence.weekday || recurrence.byday)
    const weekOfMonth = Number(recurrence.week_of_month || recurrence.nth || 1)
    return parts.weekday === weekday && parts.weekOfMonth === weekOfMonth
  }

  if (frequency === 'MONTHLY_LAST_WEEKDAY') {
    const weekday = upper(recurrence.weekday || recurrence.byday)
    return parts.weekday === weekday && parts.day + 7 > parts.daysInMonth
  }

  return true
}

function minutes(value) {
  const match = clean(value).match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null
  if (hour === 24 && minute !== 0) return null
  return hour * 60 + minute
}

function interval(startValue, endValue) {
  const start = minutes(startValue)
  let end = minutes(endValue)
  if (start === null || end === null) return null
  if (end <= start) end += 1440
  return { start, end }
}

function overlapMinutes(left, right) {
  if (!left || !right) return 0
  return Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start))
}

function plannedDutyCodes(notes = '') {
  const source = clean(notes)
  const match = source.match(/planned duties:\s*(.*?)(?:\.\s*Scheduled|\.\s*Imported|$)/i)
  const dutyText = match?.[1] || ''
  return [...dutyText.matchAll(/(?:^|;)\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s+([A-Z]+)/gi)]
    .map((row) => upper(row[1]))
}

function stableIndex(seed, size) {
  if (!size) return 0
  let hash = 2166136261
  for (const character of clean(seed)) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % size
}

function roleRank(row, preferredRoles) {
  const role = clean(row?.staff_role).toLowerCase()
  const index = preferredRoles.indexOf(role)
  return index >= 0 ? index : preferredRoles.length
}

export function pickScheduledTaskAssignee(task = {}, rosterRows = [], dateText = '') {
  const assignment = task?.config?.assignment || {}
  if (upper(assignment.mode) !== 'ROSTER') return null

  const schedule = task?.config?.schedule || {}
  const taskWindow = interval(schedule.open_time, schedule.due_time)
  const minimumOverlap = Math.max(1, Number(assignment.minimum_overlap_minutes || 30))
  const preferredRoles = list(assignment.prefer_roles || ['staff', 'leader']).map((value) => value.toLowerCase())
  const preferredDutyCodes = list(assignment.prefer_duty_codes || assignment.duty_codes)

  const candidates = (rosterRows || [])
    .filter((row) => (
      !row?.deleted_at
      && clean(row?.date) === clean(dateText)
      && clean(row?.staff_name)
      && ['scheduled', 'present', 'working'].includes(clean(row?.status || 'scheduled').toLowerCase())
    ))
    .map((row) => {
      const rosterWindow = interval(row.clock_in, row.clock_out)
      const overlap = taskWindow ? overlapMinutes(taskWindow, rosterWindow) : 1
      const duties = plannedDutyCodes(row.notes)
      const dutyMatch = preferredDutyCodes.length ? duties.some((code) => preferredDutyCodes.includes(code)) : false
      return { row, overlap, duties, dutyMatch }
    })
    .filter((candidate) => candidate.overlap >= minimumOverlap)
    .sort((left, right) => (
      Number(right.dutyMatch) - Number(left.dutyMatch)
      || roleRank(left.row, preferredRoles) - roleRank(right.row, preferredRoles)
      || right.overlap - left.overlap
      || clean(left.row.staff_name).localeCompare(clean(right.row.staff_name))
    ))

  if (!candidates.length) return null
  const bestDutyMatch = candidates[0].dutyMatch
  const bestRoleRank = roleRank(candidates[0].row, preferredRoles)
  const best = candidates.filter((candidate) => (
    candidate.dutyMatch === bestDutyMatch
    && roleRank(candidate.row, preferredRoles) === bestRoleRank
  ))
  const selected = best[stableIndex(`${dateText}|${task.template_id || task.id}`, best.length)]
  return selected?.row || null
}

export function attachScheduledTaskAssignees(tasks = [], rosterRows = [], dateText = '') {
  return (tasks || []).map((task) => {
    const scheduled = pickScheduledTaskAssignee(task, rosterRows, dateText)
    if (!scheduled) return task
    return {
      ...task,
      assigned_to_name: clean(scheduled.staff_name),
      assigned_to_role: clean(scheduled.staff_role || task.assigned_to_role || 'staff'),
      assignment_source: 'DUTY_ROSTER_SCHEDULE',
      assigned_schedule_id: clean(scheduled.id),
      assigned_schedule_time: `${clean(scheduled.clock_in)}–${clean(scheduled.clock_out)}`,
    }
  })
}
