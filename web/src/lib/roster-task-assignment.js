import { opsClient } from '@/api/opsClient'
import { normalizePositionCode, parseDutySegments } from '@/lib/positions'
import { parseOutletIds } from '@/lib/outlets'
import { isScheduledRosterRow, rosterNameMatchesUser } from '@/lib/roster-alert-gate'

export const CASHIER_POSITION_CODES = ['C', 'CA']
export const KITCHEN_POSITION_CODES = ['P', 'G', 'DF']
export const FRONTLINE_POSITION_CODES = [...CASHIER_POSITION_CODES, ...KITCHEN_POSITION_CODES]

const LEADERSHIP_ROLES = new Set(['leader', 'supervisor', 'manager', 'owner'])
const ROSTER_MEMORY_TTL_MS = 15_000
const ROSTER_STORAGE_PREFIX = 'chefops.roster-task-assignment.roster.v2.'
const TASK_STORAGE_PREFIX = 'chefops.roster-task-assignment.tasks.v2.'
const rosterCache = new Map()
const freshBuilds = new Map()

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

function canReviewAllTasks(user = {}) {
  return ['manager', 'owner'].includes(normalized(user.role))
}

function userIsExcludedLeadership(user = {}) {
  return ['leader', 'supervisor'].includes(normalized(user.role))
}

function decorateTask(task, assignment) {
  const config = { ...(task.config || {}) }
  const originalSubtitle = String(config.title_en || '').replace(/\s*·\s*Assigned:.*$/i, '').replace(/\s*·\s*No .* staff scheduled$/i, '').trim()
  const assignmentText = assignment.names.length
    ? `Assigned: ${assignment.names.join(', ')}`
    : `No ${assignment.group === 'cashier' ? 'Cashier / Cashier Assistant' : assignment.group === 'kitchen' ? 'Packaging / Grill / Deep Fryer' : 'frontline'} staff scheduled`
  config.title_en = originalSubtitle ? `${originalSubtitle} · ${assignmentText}` : assignmentText

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

function storageRemove(key) {
  try { localStorage.removeItem(key) } catch {}
}

function rosterKey(outletId, date) {
  return `${String(outletId || '')}|${String(date || '')}`
}

function rosterStorageKey(outletId, date) {
  return `${ROSTER_STORAGE_PREFIX}${rosterKey(outletId, date)}`
}

function userIdentity(user = {}) {
  return normalized(user.email || user.full_name || user.name || 'anonymous')
}

function taskStorageKey(args = {}, user = {}) {
  return `${TASK_STORAGE_PREFIX}${userIdentity(user)}|${normalized(user.role)}|${String(args.outletId || '')}|${String(args.date || '')}`
}

function readCachedRoster(outletId, date) {
  const key = rosterKey(outletId, date)
  const memory = rosterCache.get(key)
  if (memory?.rows) return memory.rows
  const stored = storageGet(rosterStorageKey(outletId, date))
  if (!Array.isArray(stored?.rows)) return []
  rosterCache.set(key, { rows: stored.rows, expiresAt: 0 })
  return stored.rows
}

async function fetchRoster(outletId, date) {
  const rows = await opsClient.entities.Attendance.filter(
    { outlet_id: outletId, date },
    'clock_in,staff_role,staff_name',
    300,
    { year: Number(String(date).slice(0, 4)) },
  )
  const result = rows || []
  const key = rosterKey(outletId, date)
  rosterCache.set(key, { rows: result, expiresAt: Date.now() + ROSTER_MEMORY_TTL_MS })
  storageSet(rosterStorageKey(outletId, date), { rows: result, savedAt: Date.now() })
  return result
}

function assignmentSignature(result = {}) {
  return JSON.stringify({
    tasks: (result.tasks || []).map((task) => ({
      id: task.id,
      version: task.version,
      updated_date: task.updated_date,
      status: task.status,
      access_state: task.access_state,
      checklist_completed: task.checklist_completed,
      assigned_roster_names: task.assigned_roster_names,
      responses: (task.responses || []).map((row) => [row.item_id, row.value, row.remark, row.updated_date]),
    })),
    photos: (result.task_photos || []).map((photo) => [photo.id, photo.updated_date, photo.status, photo.deleted_at]),
  })
}

function readTaskSnapshot(args, user) {
  const stored = storageGet(taskStorageKey(args, user))
  return stored?.data && Array.isArray(stored.data.tasks) ? stored : null
}

function persistTaskSnapshot(args, user, data) {
  const key = taskStorageKey(args, user)
  const signature = assignmentSignature(data)
  const previous = storageGet(key)
  storageSet(key, { data, signature, savedAt: Date.now() })
  return previous?.signature !== signature
}

function invalidateTaskSnapshot(args = {}, user = currentUser || {}) {
  storageRemove(taskStorageKey({ outletId: args.outlet_id || args.outletId, date: args.date || args.due_date }, user))
}

function composeAssignedData(data, rosterRows, user, extra = {}) {
  const decorated = (data?.tasks || []).map((task) => decorateTask(task, taskRosterAssignment(task, rosterRows, user)))
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
      checked_at: new Date().toISOString(),
      ...extra,
    },
  }
}

function notifyTaskAssignmentUpdated(args = {}) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('chefops:roster-task-assignment-updated', {
    detail: { outletId: String(args.outletId || ''), date: String(args.date || '') },
  }))
  // OperationalTasksV2 already performs a silent sync on focus. Trigger it after
  // the background snapshot is safely stored, without blocking the page spinner.
  window.setTimeout(() => window.dispatchEvent(new Event('focus')), 60)
  window.setTimeout(() => window.dispatchEvent(new Event('focus')), 700)
}

async function buildFreshAssignedData(args = {}, user = currentUser || {}) {
  if (!user || !args.outletId || !args.date || !originalOperationalBootstrap) return null
  const key = taskStorageKey(args, user)
  if (freshBuilds.has(key)) return freshBuilds.get(key)

  const build = Promise.all([
    originalOperationalBootstrap(args),
    fetchRoster(String(args.outletId), String(args.date)),
  ])
    .then(([data, rosterRows]) => {
      const result = composeAssignedData(data, rosterRows, user, { cache_mode: 'fresh', pending: false })
      const changed = persistTaskSnapshot(args, user, result)
      if (changed) notifyTaskAssignmentUpdated(args)
      return result
    })
    .finally(() => freshBuilds.delete(key))

  freshBuilds.set(key, build)
  return build
}

async function assignedOperationalBootstrap(args = {}) {
  const user = currentUser || {}
  if (!user?.email && !user?.full_name && !user?.name) return originalOperationalBootstrap(args)

  const snapshot = readTaskSnapshot(args, user)
  void buildFreshAssignedData(args, user).catch(() => undefined)

  if (snapshot?.data) {
    return {
      ...snapshot.data,
      roster_assignment: {
        ...(snapshot.data.roster_assignment || {}),
        cache_mode: 'instant-local',
        pending: false,
        cached_at: snapshot.savedAt ? new Date(snapshot.savedAt).toISOString() : '',
      },
    }
  }

  const rosterRows = readCachedRoster(args.outletId, args.date)
  if (rosterRows.length) {
    const rawData = await originalOperationalBootstrap({ ...args, refresh: false })
    const result = composeAssignedData(rawData, rosterRows, user, { cache_mode: 'instant-roster', pending: false })
    persistTaskSnapshot(args, user, result)
    return result
  }

  // First use on a device returns immediately instead of blocking the whole Task
  // page on two network requests. The background build dispatches a silent reload.
  return {
    tasks: [],
    task_photos: [],
    server_time: new Date().toISOString(),
    roster_assignment: {
      strict: true,
      leadership_excluded: true,
      cashier_positions: CASHIER_POSITION_CODES,
      kitchen_positions: KITCHEN_POSITION_CODES,
      cache_mode: 'warming',
      pending: true,
      checked_at: new Date().toISOString(),
    },
  }
}

export function warmRosterTaskAssignmentCache(user = currentUser || {}) {
  if (!user || !originalOperationalBootstrap) return
  const outletIds = [...new Set([...parseOutletIds(user), String(user.outlet_id || '')].filter(Boolean))]
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuching', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  for (const outletId of outletIds) {
    void buildFreshAssignedData({ outletId, date: today, refresh: false }, user).catch(() => undefined)
  }
}

export function configureRosterTaskAssignment(user = null) {
  currentUser = user || null
  if (installed) return
  originalOperationalBootstrap = opsClient.tasks.operationalBootstrap.bind(opsClient.tasks)
  originalOperationalAction = opsClient.tasks.operationalAction.bind(opsClient.tasks)
  opsClient.tasks.operationalBootstrap = assignedOperationalBootstrap
  opsClient.tasks.operationalAction = async (args = {}) => {
    const result = await originalOperationalAction(args)
    invalidateTaskSnapshot(args, currentUser || {})
    return result
  }
  installed = true
}
