import { opsClient } from '@/api/opsClient'
import { normalizePositionCode, parseDutySegments } from '@/lib/positions'
import { parseOutletIds } from '@/lib/outlets'
import { isScheduledRosterRow, rosterNameMatchesUser } from '@/lib/roster-alert-gate'
import { mergeOptimisticTaskPhotos } from '@/lib/task-photo-optimistic'

export const CASHIER_POSITION_CODES = ['C', 'CA']
export const KITCHEN_POSITION_CODES = ['P', 'G', 'DF']
export const FRONTLINE_POSITION_CODES = [...CASHIER_POSITION_CODES, ...KITCHEN_POSITION_CODES]

const LEADERSHIP_ROLES = new Set(['leader', 'supervisor', 'manager', 'owner'])
const ROSTER_MEMORY_TTL_MS = 15_000
const ROSTER_STORAGE_PREFIX = 'chefops.roster-task-assignment.roster.v3.'
const rosterCache = new Map()
const rosterRefreshes = new Map()

let currentUser = null
let installed = false
let originalOperationalBootstrap = null
let originalOperationalAction = null

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

  return { group, codes, names, eligibleRows, assignedToUser }
}

function decorateTask(task, assignment) {
  const config = { ...(task.config || {}) }
  const originalSubtitle = String(config.title_en || '')
    .replace(/\s*·\s*Scheduled:.*$/i, '')
    .replace(/\s*·\s*No .* staff scheduled$/i, '')
    .replace(/\s*·\s*Assigned:.*$/i, '')
    .trim()
  const scheduleText = assignment.names.length
    ? `Scheduled: ${assignment.names.join(', ')}`
    : `No ${assignment.group === 'cashier' ? 'Cashier / Cashier Assistant' : assignment.group === 'kitchen' ? 'Packaging / Grill / Deep Fryer' : 'frontline'} staff scheduled`
  config.title_en = originalSubtitle ? `${originalSubtitle} · ${scheduleText}` : scheduleText

  return {
    ...task,
    config,
    assignment_group: assignment.group,
    assigned_position_codes: assignment.codes,
    assigned_roster_names: assignment.names,
    roster_assigned_to_current_user: assignment.assignedToUser,
    roster_assignment_mode: 'advisory_only',
    can_view: true,
    attendance_required_for_visibility: false,
  }
}

function storageGet(key) {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

function rosterKey(outletId, date) {
  return `${String(outletId || '')}|${String(date || '')}`
}

function rosterStorageKey(outletId, date) {
  return `${ROSTER_STORAGE_PREFIX}${rosterKey(outletId, date)}`
}

function readCachedRoster(outletId, date) {
  const key = rosterKey(outletId, date)
  const memory = rosterCache.get(key)
  if (memory?.rows && memory.expiresAt > Date.now()) return memory.rows
  const stored = storageGet(rosterStorageKey(outletId, date))
  if (!Array.isArray(stored?.rows)) return memory?.rows || []
  rosterCache.set(key, { rows: stored.rows, expiresAt: 0 })
  return stored.rows
}

async function fetchRoster(outletId, date) {
  const rows = await opsClient.entities.Attendance.filter(
    { outlet_id: outletId, date },
    'clock_in,staff_role,staff_name',
    300,
    { year: Number(String(date).slice(0, 4)), legacySeed: false },
  )
  const result = rows || []
  const key = rosterKey(outletId, date)
  rosterCache.set(key, { rows: result, expiresAt: Date.now() + ROSTER_MEMORY_TTL_MS })
  storageSet(rosterStorageKey(outletId, date), { rows: result, savedAt: Date.now() })
  return result
}

function refreshRosterInBackground(args = {}) {
  const outletId = String(args.outletId || '')
  const date = String(args.date || '')
  if (!outletId || !date) return Promise.resolve([])
  const key = rosterKey(outletId, date)
  if (rosterRefreshes.has(key)) return rosterRefreshes.get(key)

  const refresh = fetchRoster(outletId, date)
    .then((rows) => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('chefops:roster-task-assignment-updated', {
          detail: { outletId, date, advisoryOnly: true },
        }))
      }
      return rows
    })
    .catch(() => readCachedRoster(outletId, date))
    .finally(() => rosterRefreshes.delete(key))
  rosterRefreshes.set(key, refresh)
  return refresh
}

function composeVisibleData(data, rosterRows, user, extra = {}) {
  const merged = mergeOptimisticTaskPhotos(data, { outletId: extra.outletId || '' })
  const tasks = (merged?.tasks || []).map((task) => decorateTask(task, taskRosterAssignment(task, rosterRows, user)))

  return {
    ...(merged || {}),
    tasks,
    roster_assignment: {
      strict: false,
      visibility_scope: 'assigned_outlet_members',
      attendance_required_for_visibility: false,
      assignment_mode: 'advisory_only',
      blocks_task_bootstrap: false,
      cashier_positions: CASHIER_POSITION_CODES,
      kitchen_positions: KITCHEN_POSITION_CODES,
      checked_at: new Date().toISOString(),
      ...extra,
    },
  }
}

async function visibleOperationalBootstrap(args = {}) {
  const data = await originalOperationalBootstrap(args)
  const user = currentUser || {}
  if (!user?.email && !user?.full_name && !user?.name) {
    return mergeOptimisticTaskPhotos(data, { outletId: args.outletId })
  }

  const cachedRoster = readCachedRoster(args.outletId, args.date)
  void refreshRosterInBackground(args)
  return composeVisibleData(data, cachedRoster, user, {
    outletId: String(args.outletId || ''),
    cache_mode: 'live-d1-roster-background',
    pending: false,
  })
}

export function warmRosterTaskAssignmentCache(user = currentUser || {}) {
  if (!user || !originalOperationalBootstrap) return
  const outletIds = [...new Set([...parseOutletIds(user), String(user.outlet_id || '')].filter(Boolean))]
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuching', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  for (const outletId of outletIds) {
    void refreshRosterInBackground({ outletId, date: today })
  }
}

export function configureRosterTaskAssignment(user = null) {
  currentUser = user || null
  if (installed) return
  originalOperationalBootstrap = opsClient.tasks.operationalBootstrap.bind(opsClient.tasks)
  originalOperationalAction = opsClient.tasks.operationalAction.bind(opsClient.tasks)
  opsClient.tasks.operationalBootstrap = visibleOperationalBootstrap
  opsClient.tasks.operationalAction = async (args = {}) => originalOperationalAction(args)
  installed = true
}
