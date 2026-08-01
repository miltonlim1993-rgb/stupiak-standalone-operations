import { parseDutySegments } from '@/lib/positions'

const BLOCKED_ROSTER_STATUSES = [
  'off', 'leave', 'annual leave', 'medical leave', 'mc', 'absent',
  'cancelled', 'canceled', 'rest day', 'not scheduled', 'unavailable',
]

const LEADERSHIP_ROSTER_ROLES = new Set(['leader', 'supervisor', 'manager', 'owner'])

function normalized(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function compact(value = '') {
  return normalized(value).replace(/\s+/g, '')
}

function meaningfulTokens(value = '') {
  return normalized(value)
    .split(' ')
    .filter((token) => token.length >= 3)
}

export function isScheduledRosterRow(row = {}) {
  const name = normalized(row.staff_name)
  if (!name) return false
  if (LEADERSHIP_ROSTER_ROLES.has(normalized(row.staff_role))) return false
  const status = normalized(row.status)
  if (BLOCKED_ROSTER_STATUSES.some((blocked) => status === blocked || status.includes(blocked))) return false
  return status === 'scheduled' || Boolean(row.clock_in || row.clock_out || !status)
}

export function rosterNameMatchesUser(staffName, user = {}, scheduledNames = []) {
  const rosterName = normalized(staffName)
  if (!rosterName) return false

  const fullName = normalized(user.full_name || user.name)
  const emailName = normalized(String(user.email || '').split('@')[0])
  const exactAliases = new Set([
    fullName,
    emailName,
    compact(fullName),
    compact(emailName),
  ].filter(Boolean))

  if (exactAliases.has(rosterName) || exactAliases.has(compact(rosterName))) return true

  const rosterTokens = meaningfulTokens(rosterName)
  const identityTokens = new Set([
    ...meaningfulTokens(fullName),
    ...meaningfulTokens(emailName),
  ])
  if (!rosterTokens.length || !rosterTokens.every((token) => identityTokens.has(token))) return false

  const matchingRows = [...new Set((scheduledNames || [])
    .map((name) => normalized(name))
    .filter(Boolean)
    .filter((name) => {
      const tokens = meaningfulTokens(name)
      return tokens.length > 0 && tokens.every((token) => identityTokens.has(token))
    }))]
  return matchingRows.length === 1 && matchingRows[0] === rosterName
}

export function buildScheduledRosterKeys({ rosterGroups = [], user = {} } = {}) {
  const keys = new Set()
  if (LEADERSHIP_ROSTER_ROLES.has(normalized(user.role))) return keys
  for (const group of rosterGroups || []) {
    const scheduledRows = (group.rows || []).filter(isScheduledRosterRow)
    const scheduledNames = scheduledRows.map((row) => row.staff_name)
    const matched = scheduledRows.some((row) => rosterNameMatchesUser(row.staff_name, user, scheduledNames))
    if (matched && group.outletId && group.date) keys.add(`${group.outletId}|${group.date}`)
  }
  return keys
}

function localDateTime(dateText, timeText, rollover = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))) return null
  const match = String(timeText || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const date = new Date(`${dateText}T${String(Number(match[1])).padStart(2, '0')}:${match[2]}:00+08:00`)
  if (Number.isNaN(date.getTime())) return null
  return rollover ? new Date(date.getTime() + 86_400_000) : date
}

function clockMoment(dateText, value) {
  if (!value) return null
  if (/^\d{1,2}:\d{2}$/.test(String(value))) return localDateTime(dateText, value)
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function windowsForRow(group, row) {
  const windows = []
  const segments = parseDutySegments(row.notes)
  for (const segment of segments) {
    const start = localDateTime(group.date, segment.start)
    let end = localDateTime(group.date, segment.end)
    if (start && end && end <= start) end = localDateTime(group.date, segment.end, true)
    if (start && end) windows.push({
      outletId: String(group.outletId || ''),
      date: String(group.date || ''),
      startAt: start.getTime(),
      endAt: end.getTime(),
      positionCode: segment.code || '',
    })
  }

  if (windows.length) return windows
  const start = clockMoment(group.date, row.clock_in)
  let end = clockMoment(group.date, row.clock_out)
  if (start && end && end <= start) end = new Date(end.getTime() + 86_400_000)
  if (start && end) windows.push({
    outletId: String(group.outletId || ''),
    date: String(group.date || ''),
    startAt: start.getTime(),
    endAt: end.getTime(),
    positionCode: '',
  })
  return windows
}

export function buildScheduledRosterWindows({ rosterGroups = [], user = {} } = {}) {
  const windows = []
  if (LEADERSHIP_ROSTER_ROLES.has(normalized(user.role))) return windows
  for (const group of rosterGroups || []) {
    const scheduledRows = (group.rows || []).filter(isScheduledRosterRow)
    const scheduledNames = scheduledRows.map((row) => row.staff_name)
    const matchedRows = scheduledRows.filter((row) => rosterNameMatchesUser(row.staff_name, user, scheduledNames))
    for (const row of matchedRows) windows.push(...windowsForRow(group, row))
  }
  return windows
}

export function kuchingDateForTimestamp(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp)) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuching',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp))
}

export function alertAllowedByRoster(alert = {}, scheduledKeys = new Set()) {
  const date = kuchingDateForTimestamp(alert.triggerAt)
  if (!date) return false
  const outletId = String(alert.outletId || '').trim()
  if (outletId) return scheduledKeys.has(`${outletId}|${date}`)
  for (const key of scheduledKeys) {
    if (String(key).endsWith(`|${date}`)) return true
  }
  return false
}

export function alertAllowedByRosterShift(alert = {}, scheduledKeys = new Set(), scheduledWindows = []) {
  if (!alertAllowedByRoster(alert, scheduledKeys)) return false
  if (!String(alert.taskId || '').trim()) return true

  const triggerAt = Number(alert.triggerAt)
  if (!Number.isFinite(triggerAt)) return false
  const outletId = String(alert.outletId || '').trim()
  return (scheduledWindows || []).some((window) => (
    (!outletId || String(window.outletId || '') === outletId)
      && triggerAt >= Number(window.startAt)
      && triggerAt <= Number(window.endAt)
  ))
}
