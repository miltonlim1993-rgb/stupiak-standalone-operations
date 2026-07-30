import { getCurrentUser } from './auth.js'
import { readJson } from './http.js'
import { assignedOutletIds, assertOutletAccess } from './permissions.js'
import { appendRecord, ensureEntitySheet, findRecord, listRecords, updateRecord } from './sheets.js'

const ISSUE_TYPES = new Set([
  'insufficient_stock',
  'equipment_problem',
  'hygiene_issue',
  'item_not_found',
  'other',
])

const TERMINAL_OUTCOMES = new Set(['issue', 'unable'])
const NOTIFY_ROLES = new Set(['leader', 'supervisor', 'manager', 'owner'])

function timestamp() {
  return new Date().toISOString()
}

function text(value, max = 3000) {
  return String(value || '').trim().slice(0, max)
}

function bool(value) {
  return value === true || String(value || '').toLowerCase() === 'true'
}

function error(message, status, code, details = undefined) {
  const next = new Error(message)
  next.status = status
  next.code = code
  if (details !== undefined) next.details = details
  return next
}

function dateText(value) {
  const next = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) throw error('Task date must use YYYY-MM-DD', 400, 'invalid_task_date')
  return next
}

function outletForUser(user, requested = '') {
  const requestedValue = String(requested || '').trim()
  if (['manager', 'owner'].includes(String(user?.role || ''))) {
    return requestedValue || String(user?.outlet_id || assignedOutletIds(user)[0] || '').trim()
  }
  const outletId = requestedValue || String(user?.outlet_id || assignedOutletIds(user)[0] || '').trim()
  if (outletId) assertOutletAccess(user, outletId)
  return outletId
}

function requestWithJson(request, pathname, body) {
  const url = new URL(request.url)
  url.pathname = pathname
  url.search = ''
  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  return new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  })
}

async function delegateJson(legacyApp, request, env, ctx, pathname, body) {
  const response = await legacyApp.fetch(requestWithJson(request, pathname, body), env, ctx)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw error(
    payload?.error || payload?.message || `Task request failed (${response.status})`,
    response.status,
    payload?.code || 'task_request_failed',
    payload?.details,
  )
  return payload
}

export function parseTaskWorkflowV3(task) {
  try {
    const parsed = JSON.parse(String(task?.notes || ''))
    const workflow = parsed?.workflow_v3 && typeof parsed.workflow_v3 === 'object' ? parsed.workflow_v3 : {}
    return {
      state: parsed && typeof parsed === 'object' ? parsed : {},
      workflow,
    }
  } catch {
    return { state: {}, workflow: {} }
  }
}

function workflowNotes(task, workflow) {
  const { state } = parseTaskWorkflowV3(task)
  return JSON.stringify({
    schema: state.schema || 'operational-checklist-v1',
    responses: state.responses || {},
    started_at: state.started_at || '',
    completion_notes: state.completion_notes || task?.completion_notes || '',
    workflow_v3: workflow || {},
  })
}

function languageFields(source = {}, fallbackName = '', fallbackInstruction = '') {
  const nameCn = text(source.name_cn || source.title_cn || source.task_name_cn, 500)
  const nameEn = text(source.name_en || source.title_en || source.task_name_en || fallbackName, 500)
  const instructionCn = text(source.instruction_cn || source.description_cn, 3000)
  const instructionEn = text(source.instruction_en || source.description_en || fallbackInstruction, 3000)
  const completionCn = text(source.completion_standard_cn || source.standard_cn, 3000)
  const completionEn = text(source.completion_standard_en || source.standard_en, 3000)
  return {
    name_cn: nameCn,
    name_en: nameEn,
    instruction_cn: instructionCn,
    instruction_en: instructionEn,
    completion_standard_cn: completionCn,
    completion_standard_en: completionEn,
  }
}

function taskSections(config = {}) {
  return (config.sections || []).map((section) => ({
    ...section,
    ...languageFields(section, section.name || '', section.instruction || ''),
    items: (section.items || []).map((item) => ({
      ...item,
      ...languageFields(item, item.name || '', item.instruction || ''),
      response_type: String(item.response_type || 'STATUS').toUpperCase(),
      required: bool(item.required),
    })),
  }))
}

function taskPhotoRequirement(config = {}) {
  const rules = (config.photo_groups || []).map((group) => String(group.rule || '').toUpperCase())
  if (rules.includes('REQUIRED') || rules.includes('REQUIRED_DAY')) return 'required'
  if (rules.some((rule) => ['ON_FAIL', 'REQUIRED_IF_APPLICABLE'].includes(rule))) return 'issue_only'
  return 'none'
}

export function taskStatusKey(task) {
  const { workflow } = parseTaskWorkflowV3(task)
  const outcome = String(workflow.outcome || '').toLowerCase()
  if (TERMINAL_OUTCOMES.has(outcome)) return 'issue'
  const stored = String(task?.status || '').toLowerCase()
  if (stored === 'issue' || stored === 'unable') return 'issue'
  if (stored === 'done') return 'completed'
  const access = String(task?.access_state || '').toUpperCase()
  if (access === 'NOT_OPEN') return 'locked'
  if (access === 'OVERDUE' || access === 'LOCKED') return 'overdue'
  if (stored === 'in_progress') return 'in_progress'
  return 'pending'
}

function shiftId(task) {
  return String(task?.config?.schedule?.shift_id || task?.shift_id || task?.period || 'DAILY').toUpperCase()
}

function timeLabel(value = '') {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}

export function enrichTaskWorkflowV3(task) {
  const config = task?.config || {}
  const schedule = config.schedule || {}
  const status = taskStatusKey(task)
  const { workflow } = parseTaskWorkflowV3(task)
  const taskLanguage = languageFields(config, task?.title || '', task?.description || '')
  const photoGroups = (config.photo_groups || []).map((group) => ({
    ...group,
    ...languageFields(group, group.name || '', group.sample_caption || ''),
    sample_caption_cn: text(group.sample_caption_cn || group.caption_cn, 1000),
    sample_caption_en: text(group.sample_caption_en || group.sample_caption || group.caption_en, 1000),
  }))
  const access = String(task?.access_state || '').toUpperCase()
  const canStart = ['OPEN', 'OVERDUE'].includes(access)
    && !['completed', 'issue'].includes(status)
  return {
    ...task,
    config: {
      ...config,
      sections: taskSections(config),
      photo_groups: photoGroups,
    },
    display: {
      ...taskLanguage,
      task_name_cn: taskLanguage.name_cn,
      task_name_en: taskLanguage.name_en || task?.title || '',
    },
    workflow_v3: workflow,
    status_key: status,
    outcome: String(workflow.outcome || ''),
    issue_type: String(workflow.issue_type || ''),
    issue_reason: String(workflow.reason || ''),
    shift_id: shiftId(task),
    shift_name_cn: text(schedule.shift_name_cn || (shiftId(task) === 'MORNING' ? '早班' : shiftId(task) === 'NIGHT' ? '晚班' : '全天'), 100),
    shift_name_en: text(schedule.shift_name_en || schedule.shift_name || (shiftId(task) === 'MORNING' ? 'Morning Shift' : shiftId(task) === 'NIGHT' ? 'Evening Shift' : 'All Day'), 100),
    timezone: String(config.timezone || 'Asia/Kuching'),
    earliest_start: String(schedule.open_time || ''),
    due_time_config: String(schedule.due_time || ''),
    lock_time_config: String(schedule.lock_time || schedule.due_time || ''),
    can_start: canStart,
    can_submit: canStart,
    lock_reason_cn: access === 'NOT_OPEN' ? `此任务将在 ${schedule.open_time || timeLabel(task?.opens_at)} 开放` : access === 'LOCKED' ? '此任务已超过最终提交时间' : '',
    lock_reason_en: access === 'NOT_OPEN' ? `Available after ${schedule.open_time || timeLabel(task?.opens_at)}` : access === 'LOCKED' ? 'This task has passed its final submission time' : '',
    photo_requirement: taskPhotoRequirement(config),
    issue_photo_required: true,
  }
}

function chooseCurrentShift(tasks, serverTime) {
  const now = Date.parse(serverTime || '') || Date.now()
  const active = tasks
    .filter((task) => {
      const open = Date.parse(task.opens_at || '')
      const lock = Date.parse(task.locks_at || '')
      return Number.isFinite(open) && Number.isFinite(lock) && now >= open && now <= lock
    })
    .sort((a, b) => Date.parse(a.due_at || '') - Date.parse(b.due_at || ''))
  if (active.length) return shiftId(active[0])
  const upcoming = tasks
    .filter((task) => Date.parse(task.opens_at || '') > now)
    .sort((a, b) => Date.parse(a.opens_at || '') - Date.parse(b.opens_at || ''))
  if (upcoming.length) return shiftId(upcoming[0])
  const latest = [...tasks].sort((a, b) => Date.parse(b.opens_at || '') - Date.parse(a.opens_at || ''))
  return latest.length ? shiftId(latest[0]) : 'ALL'
}

export function taskProgressSummary(tasks = []) {
  const result = {}
  for (const task of tasks) {
    const id = shiftId(task)
    const group = result[id] || {
      shift_id: id,
      total: 0,
      completed: 0,
      pending: 0,
      in_progress: 0,
      locked: 0,
      issue: 0,
      overdue: 0,
    }
    group.total += 1
    const status = taskStatusKey(task)
    group[status] = Number(group[status] || 0) + 1
    result[id] = group
  }
  const all = Object.values(result).reduce((summary, group) => {
    for (const key of ['total', 'completed', 'pending', 'in_progress', 'locked', 'issue', 'overdue']) {
      summary[key] += Number(group[key] || 0)
    }
    return summary
  }, { shift_id: 'ALL', total: 0, completed: 0, pending: 0, in_progress: 0, locked: 0, issue: 0, overdue: 0 })
  return { ...result, ALL: all }
}

function userOutletIds(user) {
  return new Set([
    String(user?.outlet_id || '').trim(),
    ...String(user?.outlet_ids || '').split(',').map((value) => value.trim()),
  ].filter(Boolean))
}

function recordBase(user, outletId) {
  const now = timestamp()
  return {
    id: crypto.randomUUID(),
    outlet_id: outletId,
    created_date: now,
    created_by: user.email,
    updated_date: now,
    updated_by: user.email,
    deleted_at: '',
    version: 1,
  }
}

async function createTaskEscalation(env, user, task, outcome, issueType, reason, workflow) {
  const year = Number(String(task.due_date || '').slice(0, 4)) || new Date().getUTCFullYear()
  await Promise.all([
    ensureEntitySheet(env, 'UrgentIssue', { year }),
    ensureEntitySheet(env, 'Notification'),
  ])

  const titlePrefix = outcome === 'unable' ? 'Unable to complete task' : 'Task issue reported'
  const issue = {
    ...recordBase(user, task.outlet_id),
    title: `${titlePrefix}: ${task.title || task.template_id || task.id}`,
    description: reason,
    priority: outcome === 'unable' ? 'high' : issueType === 'hygiene_issue' ? 'urgent' : 'high',
    category: outcome === 'unable' ? 'unable_to_complete' : issueType,
    assigned_to_role: 'manager',
    assigned_to_user_id: '',
    assigned_to_name: '',
    status: 'open',
    resolved_date: '',
    followup_notes: `Task ${task.id} · Reported by ${user.full_name || user.email}`,
    due_date: String(task.due_date || ''),
  }
  await appendRecord(env, 'UrgentIssue', issue, { year })

  const users = await listRecords(env, 'User', { sort: 'role,full_name', limit: 3000 })
  const recipients = users.filter((row) => (
    !row.deleted_at
    && String(row.status || 'active').toLowerCase() !== 'inactive'
    && NOTIFY_ROLES.has(String(row.role || '').toLowerCase())
    && userOutletIds(row).has(String(task.outlet_id || ''))
  ))

  for (const recipient of recipients) {
    const notification = {
      ...recordBase(user, task.outlet_id),
      recipient_user_id: recipient.id,
      recipient_email: recipient.email || '',
      recipient_name: recipient.full_name || recipient.email || '',
      title: titlePrefix,
      message: `${task.title || 'Task'} · ${reason}`.slice(0, 1000),
      target_page: '/tasks',
      entity_type: 'Task',
      entity_id: task.id,
      status: 'unread',
      read_at: '',
      pushed_by_name: user.full_name || user.email,
      pushed_by_email: user.email,
      expires_at: '',
      priority: outcome === 'unable' ? 'high' : 'urgent',
      action_label: 'Review task',
      metadata_json: JSON.stringify({
        task_id: task.id,
        urgent_issue_id: issue.id,
        outcome,
        issue_type: issueType,
        workflow,
      }),
    }
    await appendRecord(env, 'Notification', notification)
  }

  return { issue, notified: recipients.length }
}

async function issuePhotoCount(env, task) {
  const year = Number(String(task.due_date || '').slice(0, 4)) || new Date().getUTCFullYear()
  await ensureEntitySheet(env, 'TaskPhoto', { year })
  const photos = await listRecords(env, 'TaskPhoto', {
    filter: { outlet_id: task.outlet_id, task_id: task.id },
    sort: '-created_date',
    limit: 1000,
    year,
  })
  return photos.filter((row) => (
    !row.deleted_at
    && String(row.status || 'active').toLowerCase() !== 'deleted'
    && (String(row.photo_type || '') === 'issue' || String(row.photo_type || '').startsWith('issue:'))
  )).length
}

async function loadTask(env, body, user) {
  const taskId = text(body.task_id, 300)
  if (!taskId) throw error('task_id is required', 400, 'missing_task_id')
  const date = dateText(body.date)
  const year = Number(date.slice(0, 4))
  const found = await findRecord(env, 'Task', taskId, { year })
  const task = found.record
  const outletId = outletForUser(user, body.outlet_id || task.outlet_id)
  if (!outletId || String(task.outlet_id || '') !== outletId) throw error('Task outlet does not match your assigned outlet', 403, 'wrong_outlet')
  return { task, year, outletId, date }
}

async function handleBootstrap(request, env, ctx, legacyApp, user, body) {
  const outletId = outletForUser(user, body.outlet_id)
  if (!outletId) throw error('Your account is not assigned to an outlet', 400, 'missing_outlet')
  const date = dateText(body.date)
  const legacy = await delegateJson(legacyApp, request, env, ctx, '/api/tasks/operational/bootstrap', {
    outlet_id: outletId,
    date,
    refresh: Boolean(body.refresh),
  })
  const tasks = (legacy.tasks || []).map(enrichTaskWorkflowV3)
  const serverTime = legacy.server_time || timestamp()
  return {
    ...legacy,
    schema: 'task-workflow-v3',
    tasks,
    current_shift_id: chooseCurrentShift(tasks, serverTime),
    progress: taskProgressSummary(tasks),
    issue_types: [...ISSUE_TYPES],
    language_modes: ['bilingual', 'cn', 'en'],
  }
}

async function handleAction(request, env, ctx, legacyApp, user, body) {
  const action = String(body.action || '').trim().toLowerCase()
  if (!['start', 'save', 'complete', 'report_issue', 'unable'].includes(action)) {
    throw error('Unsupported task action', 400, 'invalid_task_action')
  }
  const { task, year, outletId, date } = await loadTask(env, body, user)
  const { workflow: existingWorkflow } = parseTaskWorkflowV3(task)
  if (TERMINAL_OUTCOMES.has(String(existingWorkflow.outcome || '').toLowerCase())) {
    throw error('This task already has a final issue outcome', 409, 'task_outcome_locked')
  }

  if (['start', 'save', 'complete'].includes(action)) {
    const legacy = await delegateJson(legacyApp, request, env, ctx, '/api/tasks/operational/action', {
      ...body,
      outlet_id: outletId,
      date,
      action,
    })
    return {
      ...legacy,
      schema: 'task-workflow-v3',
      task: enrichTaskWorkflowV3(legacy.task),
    }
  }

  const reason = text(body.reason || body.completion_notes, 3000)
  if (reason.length < 3) throw error('A reason is required', 400, 'task_reason_required')
  const issueType = action === 'report_issue' ? String(body.issue_type || '').trim().toLowerCase() : 'unable_to_complete'
  if (action === 'report_issue' && !ISSUE_TYPES.has(issueType)) {
    throw error('Select a valid issue type', 400, 'invalid_issue_type', { allowed: [...ISSUE_TYPES] })
  }
  if (action === 'report_issue' && await issuePhotoCount(env, task) < 1) {
    throw error('Upload at least one issue photo before reporting the issue', 400, 'issue_photo_required')
  }

  const saved = await delegateJson(legacyApp, request, env, ctx, '/api/tasks/operational/action', {
    ...body,
    outlet_id: outletId,
    date,
    action: 'save',
    completion_notes: reason,
  })
  const savedTask = saved.task
  const reportedAt = timestamp()
  const workflow = {
    outcome: action === 'report_issue' ? 'issue' : 'unable',
    issue_type: issueType,
    reason,
    reported_at: reportedAt,
    reported_by_email: user.email,
    reported_by_name: user.full_name || user.email,
  }
  const escalation = await createTaskEscalation(env, user, savedTask, workflow.outcome, issueType, reason, workflow)
  workflow.urgent_issue_id = escalation.issue.id
  workflow.notification_count = escalation.notified

  const updated = await updateRecord(env, 'Task', savedTask.id, {
    status: workflow.outcome,
    completion_notes: reason,
    notes: workflowNotes(savedTask, workflow),
    updated_date: reportedAt,
    updated_by: user.email,
    version: Number(savedTask.version || 0) + 1,
  }, { year })

  const bootstrap = await handleBootstrap(request, env, ctx, legacyApp, user, {
    outlet_id: outletId,
    date,
    refresh: false,
  })
  const assembled = bootstrap.tasks.find((row) => String(row.id) === String(updated.id)) || enrichTaskWorkflowV3(updated)
  return {
    ok: true,
    schema: 'task-workflow-v3',
    task: assembled,
    urgent_issue: escalation.issue,
    notified: escalation.notified,
    server_time: reportedAt,
  }
}

export async function handleTaskWorkflowV3(request, env, url, ctx, legacyApp) {
  if (!url.pathname.startsWith('/api/tasks/v3/')) return null
  if (request.method !== 'POST') throw error('Method not allowed', 405, 'method_not_allowed')
  const user = await getCurrentUser(request, env)
  const body = await readJson(request)
  if (url.pathname === '/api/tasks/v3/bootstrap') return Response.json(await handleBootstrap(request, env, ctx, legacyApp, user, body))
  if (url.pathname === '/api/tasks/v3/action') return Response.json(await handleAction(request, env, ctx, legacyApp, user, body))
  throw error('Task workflow endpoint not found', 404, 'not_found')
}
