import { getCurrentUser } from './auth.js'
import { errorResponse } from './http.js'
import { assertAssignedOutletAccess, level } from './permissions.js'

const MANAGER_LEVEL = level('manager')
const SHIFT_ALIASES = new Map([
  ['MORNING', 'MORNING'],
  ['AM', 'MORNING'],
  ['OPEN', 'MORNING'],
  ['OPENING', 'MORNING'],
  ['BREAKFAST', 'MORNING'],
  ['DAILY', 'DAILY'],
  ['DAY', 'DAILY'],
  ['DAYTIME', 'DAILY'],
  ['ALL_DAY', 'DAILY'],
  ['ALLDAY', 'DAILY'],
  ['GENERAL', 'DAILY'],
  ['MIDDAY', 'DAILY'],
  ['ANY', 'DAILY'],
  ['NIGHT', 'NIGHT'],
  ['PM', 'NIGHT'],
  ['CLOSE', 'NIGHT'],
  ['CLOSING', 'NIGHT'],
  ['DINNER', 'NIGHT'],
])

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase().replace(/^role_/, '')
}

function identityValues(user = {}) {
  return new Set([
    user.id,
    user.user_id,
    user.google_sub,
    user.email,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))
}

function directAssignee(task = {}) {
  return String(
    task.assigned_to_user_id
    || task.assigned_user_id
    || task.assignee_user_id
    || '',
  ).trim()
}

function assignedRole(task = {}) {
  return normalizeRole(task.assigned_to_role || task.assignee_role || 'staff') || 'staff'
}

export function operationalTaskAssignment(task = {}) {
  const userId = directAssignee(task)
  const role = assignedRole(task)
  const name = String(task.assigned_to_name || task.assignee_name || '').trim()
  return {
    mode: userId ? 'user' : 'role',
    user_id: userId,
    role,
    name,
    label: userId
      ? (name || 'Assigned staff')
      : `${role.charAt(0).toUpperCase()}${role.slice(1)} role`,
  }
}

export function canExecuteOperationalTask(user = {}, task = {}) {
  const userRole = normalizeRole(user.role)
  const userLevel = level(userRole)
  if (userLevel >= MANAGER_LEVEL) return true

  const assignment = operationalTaskAssignment(task)
  if (assignment.mode === 'user') {
    return identityValues(user).has(assignment.user_id.toLowerCase())
  }

  const requiredLevel = level(assignment.role)
  if (!requiredLevel) return true
  return userLevel >= requiredLevel
}

export function canonicalOperationalShift(task = {}) {
  const raw = String(
    task?.config?.schedule?.shift_id
    || task.shift_id
    || task.period
    || '',
  ).trim().toUpperCase().replace(/[\s-]+/g, '_')
  return SHIFT_ALIASES.get(raw) || 'DAILY'
}

export function decorateOperationalTaskForUser(task = {}, user = {}) {
  const canExecute = canExecuteOperationalTask(user, task)
  const assignment = operationalTaskAssignment(task)
  const sourceShift = String(
    task?.config?.schedule?.shift_id
    || task.shift_id
    || task.period
    || '',
  ).trim()
  const shift = canonicalOperationalShift(task)
  const timeAccessState = String(task.access_state || '').toUpperCase() || 'OPEN'
  const accessState = !canExecute && timeAccessState !== 'DONE'
    ? 'LOCKED'
    : timeAccessState

  return {
    ...task,
    period: shift,
    shift_id: shift,
    config: task?.config && typeof task.config === 'object'
      ? {
          ...task.config,
          schedule: {
            ...(task.config.schedule || {}),
            shift_id: shift,
            source_shift_id: sourceShift,
          },
        }
      : task.config,
    can_view: true,
    can_execute: canExecute,
    assignment_read_only: !canExecute,
    assignment_access_state: canExecute ? 'ASSIGNED' : 'VIEW_ONLY',
    time_access_state: timeAccessState,
    access_state: accessState,
    assignment,
    visibility_scope: 'assigned_outlet',
    attendance_required_for_visibility: false,
  }
}

async function mutationAlreadyCommitted(env, mutationId) {
  if (!mutationId || !env.OPS_DB?.prepare) return false
  const row = await env.OPS_DB.prepare(
    'SELECT mutation_id FROM ops_mutations WHERE mutation_id = ? LIMIT 1',
  ).bind(mutationId).first()
  return Boolean(row)
}

async function d1Record(env, entity, entityId) {
  if (!env.OPS_DB?.prepare || !entityId) return null
  const row = await env.OPS_DB.prepare(`
    SELECT payload_json FROM ops_records
    WHERE entity = ? AND entity_id = ? AND deleted_at = ''
    LIMIT 1
  `).bind(entity, entityId).first()
  return row ? (parseJson(row.payload_json, {}) || {}) : null
}

function assignmentError(task) {
  const assignment = operationalTaskAssignment(task)
  const error = new Error(
    assignment.mode === 'user'
      ? `This task is assigned to ${assignment.label}. You may view it, but only the assignee or a manager can update it.`
      : `This task is assigned to the ${assignment.role} role. You may view it, but your role cannot update it.`,
  )
  error.status = 403
  error.code = 'task_assignment_view_only'
  return error
}

export async function guardOperationalTaskAssignment(request, env, url) {
  if (url.pathname !== '/api/tasks/operational/action' || request.method !== 'POST') return null
  try {
    const body = await request.clone().json()
    const mutationId = String(
      body?.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '',
    ).trim()
    if (await mutationAlreadyCommitted(env, mutationId)) return null

    const taskId = String(body?.task_id || '').trim()
    if (!taskId) return null
    const task = await d1Record(env, 'Task', taskId)
    if (!task) return null

    const user = await getCurrentUser(request, env)
    if (task.outlet_id) assertAssignedOutletAccess(user, task.outlet_id)
    if (canExecuteOperationalTask(user, task)) return null
    return errorResponse(request, env, assignmentError(task))
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export async function guardOperationalTaskPhotoAssignment(request, env, url) {
  if (url.pathname !== '/api/realtime/mutations' || request.method !== 'POST') return null
  try {
    const body = await request.clone().json()
    if (String(body?.entity || '') !== 'TaskPhoto') return null

    const mutationId = String(
      body?.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '',
    ).trim()
    if (await mutationAlreadyCommitted(env, mutationId)) return null

    const payload = body?.payload || {}
    let taskId = String(payload.task_id || '').trim()
    if (!taskId) {
      const photo = await d1Record(env, 'TaskPhoto', String(body?.entity_id || payload.id || '').trim())
      taskId = String(photo?.task_id || '').trim()
    }
    if (!taskId) return null

    const task = await d1Record(env, 'Task', taskId)
    if (!task) return null
    const user = await getCurrentUser(request, env)
    if (task.outlet_id) assertAssignedOutletAccess(user, task.outlet_id)
    if (canExecuteOperationalTask(user, task)) return null
    return errorResponse(request, env, assignmentError(task))
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export async function applyOperationalTaskAudienceResponse(request, url, env, response) {
  if (
    url.pathname !== '/api/tasks/operational/bootstrap'
    || request.method !== 'POST'
    || response.status < 200
    || response.status >= 300
  ) return response

  let payload
  try { payload = await response.clone().json() } catch { return response }
  const user = await getCurrentUser(request, env).catch(() => null)
  if (!user) return response

  const tasks = (Array.isArray(payload.tasks) ? payload.tasks : [])
    .map((task) => decorateOperationalTaskForUser(task, user))
  const headers = new Headers(response.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  headers.set('X-ChefOps-Task-Audience', 'outlet-visible-assignment-enforced-v1')

  return new Response(JSON.stringify({
    ...payload,
    tasks,
    task_visibility_policy: {
      visibility_scope: 'assigned_outlet_members',
      attendance_required: false,
      assignment_retained: true,
      unassigned_access: 'view_only',
      execution_enforced_by: ['task_action', 'task_photo_mutation'],
      unknown_shift_fallback: 'DAILY',
    },
    task_empty_reason: tasks.length ? '' : 'NO_OPERATIONAL_TASKS_RETURNED',
  }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export const OPERATIONAL_TASK_AUDIENCE_POLICY = Object.freeze({
  attendance_required: false,
  visibility_scope: 'assigned_outlet_members',
  unassigned_access: 'view_only',
  assignment_enforced: true,
  unknown_shift_fallback: 'DAILY',
})
