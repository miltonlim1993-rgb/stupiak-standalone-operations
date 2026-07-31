import { opsClient } from '@/api/opsClient'
import { normalizePositionCode, parseDutySegments } from '@/lib/positions'
import { isScheduledRosterRow, rosterNameMatchesUser } from '@/lib/roster-alert-gate'

export const CASHIER_POSITION_CODES = ['C', 'CA']
export const KITCHEN_POSITION_CODES = ['P', 'G', 'DF']
export const FRONTLINE_POSITION_CODES = [...CASHIER_POSITION_CODES, ...KITCHEN_POSITION_CODES]

const LEADERSHIP_ROLES = new Set(['leader', 'supervisor', 'manager', 'owner'])
const ROSTER_CACHE_TTL_MS = 15_000
const rosterCache = new Map()

let currentUser = null
let installed = false
let originalOperationalBootstrap = null

function normalized(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function isLeadershipRole(value = '') {
  return LEADERSHIP_ROLES.has(normalized(value))
}

function isAssignableRosterRow(row = {}) {
  return isScheduledRosterRow(row) && !isLeadershipRole(row.staff_role)
}

function localDateTime(dateText, timeText, rollover = false) {
  if (!dateText || !timeText) return null
  const date = String(dateText).slice(0, 10)
  const match = String(timeText).match(/^(\d{1,2}):(\d{2})$/)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !match) return null
  const hour = String(Number(match[1])).padStart(2, '0')
  const minute = match[2]
  const value = new Date(`${date}T${hour}:${minute}:00+08:00`)
  if (Number.isNaN(value.getTime())) return null
  return rollover ? new Date(value.getTime() + 86_400_000) : value
}

function taskWindow(task = {}) {
  const opensAt = task.opens_at ? new Date(task.opens_at) : null
  const dueAt = task.due_at ? new Date(task.due_at) : null
  return {
    start: opensAt && !Number.isNaN(opensAt.getTime()) ? opensAt : null,
    end: dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : null,
  }
}

function rangesOverlap(startA, endA, startB, endB) {
  if (!startA || !endA || !startB || !endB) return true
  return startA < endB && endA > startB
}

function segmentOverlapsTask(row, segment, task) {
  const segmentStart = localDateTime(row.date, segment.start)
  let segmentEnd = localDateTime(row.date, segment.end)
  if (segmentStart && segmentEnd && segmentEnd <= segmentStart) {
    segmentEnd = localDateTime(row.date, segment.end, true)
  }
  const window = taskWindow(task)
  return rangesOverlap(segmentStart, segmentEnd, window.start, window.end)
}

function taskPositionCodes(task = {}) {
  const config = task.config || {}
  const explicit = normalized(
    config.assignment_group
      || config.assignmentGroup
      || task.assignment_group
      || task.assigned_to_role,
  )
  if (explicit === 'cashier' || explicit === 'front counter' || explicit === 'counter') {
    return { group: 'cashier', codes: CASHIER_POSITION_CODES }
  }
  if (explicit === 'kitchen') return { group: 'kitchen', codes: KITCHEN_POSITION_CODES }

  const source = normalized([
    task.station,
    task.category,
    task.title,
    task.template_title,
    config.station,
    config.category,
    config.title,
    config.title_en,
    config.title_cn,
    config.checklist_key,
  ].filter(Boolean).join(' '))

  if (/cashier|cash|counter|payment|receipt|front counter|close up|toilet|restroom|washroom|guest area|front of house|foh/.test(source)) {
    return { group: 'cashier', codes: CASHIER_POSITION_CODES }
  }
  if (/kitchen|preparation|prepare|packaging|grill|fryer|food|cooking|opening|whole outlet|daily standards|outlet standards/.test(source)) {
    return { group: 'kitchen', codes: KITCHEN_POSITION_CODES }
  }
  return { group: 'frontline', codes: FRONTLINE_POSITION_CODES }
}

function rowPositionCodesForTask(row = {}, task = {}) {
  const segments = parseDutySegments(row.notes)
  if (segments.length) {
    return [...new Set(segments
      .filter((segment) => segmentOverlapsTask(row, segment, task))
      .map((segment) => normalizePositionCode(segment.code))
      .filter(Boolean))]
  }
  const fallback = normalizePositionCode(row.position_code || row.position || row.staff_role || '')
  return fallback ? [fallback] : []
}

export function taskRosterAssignment(task = {}, rosterRows = [], user = currentUser || {}) {
  const { group, codes } = taskPositionCodes(task)
  const allowed = new Set(codes)
  const eligibleRows = (rosterRows || []).filter((row) => (
    isAssignableRosterRow(row)
      && rowPositionCodesForTask(row, task).some((code) => allowed.has(code))
  ))
  const names = [...new Set(eligibleRows.map((row) => String(row.staff_name || '').trim()).filter(Boolean))]
  const scheduledNames = eligibleRows.map((row) => row.staff_name)
  const assignedToUser = eligibleRows.some((row) => rosterNameMatchesUser(row.staff_name, user, scheduledNames))

  return {
    group,
    codes,
    names,
    eligibleRows,
    assignedToUser,
  }
}

function canReviewAllTasks(user = {}) {
  return ['manager', 'owner'].includes(normalized(user.role))
}

function userIsExcludedLeadership(user = {}) {
  return ['leader', 'supervisor'].includes(normalized(user.role))
}

function decorateTask(task, assignment) {
  const config = { ...(task.config || {}) }
  const originalSubtitle = String(config.title_en || '').trim()
  const assignmentText = assignment.names.length
    ? `Assigned: ${assignment.names.join(', ')}`
    : `No ${assignment.group === 'cashier' ? 'Cashier / Cashier Assistant' : assignment.group === 'kitchen' ? 'Packaging / Grill / Deep Fryer' : 'frontline'} staff scheduled`
  config.title_en = originalSubtitle
    ? `${originalSubtitle} · ${assignmentText}`
    : assignmentText

  return {
    ...task,
    config,
    assignment_group: assignment.group,
    assigned_position_codes: assignment.codes,
    assigned_roster_names: assignment.names,
    assigned_to_name: assignment.names.join(', '),
    assigned_to_current_user: assignment.assignedToUser,
  }
}

async function attendanceRows(outletId, date, force = false) {
  const key = `${outletId}|${date}`
  const cached = rosterCache.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.rows

  const rows = await opsClient.entities.Attendance.filter(
    { outlet_id: outletId, date },
    'clock_in,staff_role,staff_name',
    300,
    { year: Number(String(date).slice(0, 4)) },
  )
  const result = rows || []
  rosterCache.set(key, { rows: result, expiresAt: Date.now() + ROSTER_CACHE_TTL_MS })
  return result
}

async function assignedOperationalBootstrap(args = {}) {
  const data = await originalOperationalBootstrap(args)
  const user = currentUser || {}
  const outletId = String(args.outletId || '')
  const date = String(args.date || '')
  let rosterRows = []
  let rosterError = ''

  try {
    rosterRows = await attendanceRows(outletId, date, Boolean(args.refresh))
  } catch (error) {
    rosterError = error?.message || 'Unable to read Duty Roster'
  }

  const decorated = (data?.tasks || []).map((task) => {
    const assignment = taskRosterAssignment(task, rosterRows, user)
    return decorateTask(task, assignment)
  })

  const tasks = canReviewAllTasks(user)
    ? decorated
    : userIsExcludedLeadership(user)
      ? []
      : decorated.filter((task) => task.assigned_to_current_user)

  return {
    ...(data || {}),
    tasks,
    roster_assignment: {
      strict: true,
      leadership_excluded: true,
      cashier_positions: CASHIER_POSITION_CODES,
      kitchen_positions: KITCHEN_POSITION_CODES,
      roster_error: rosterError,
      checked_at: new Date().toISOString(),
    },
  }
}

export function configureRosterTaskAssignment(user = null) {
  currentUser = user || null
  if (installed) return
  originalOperationalBootstrap = opsClient.tasks.operationalBootstrap.bind(opsClient.tasks)
  opsClient.tasks.operationalBootstrap = assignedOperationalBootstrap
  installed = true
}
