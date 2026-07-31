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

  // Attendance currently stores staff_name rather than user ID/email. Permit a
  // shortened roster name only when it identifies one unique scheduled row.
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
  for (const group of rosterGroups || []) {
    const scheduledRows = (group.rows || []).filter(isScheduledRosterRow)
    const scheduledNames = scheduledRows.map((row) => row.staff_name)
    const matched = scheduledRows.some((row) => rosterNameMatchesUser(row.staff_name, user, scheduledNames))
    if (matched && group.outletId && group.date) keys.add(`${group.outletId}|${group.date}`)
  }
  return keys
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
