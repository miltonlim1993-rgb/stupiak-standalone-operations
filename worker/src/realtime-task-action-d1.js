import { getCurrentUser } from './auth.js'
import { getAppPackModule, getPublishedAppPack } from './app-pack.js'
import { errorResponse, json, readJson } from './http.js'
import { applyOpeningChecklistFeedback } from './opening-checklist-feedback.js'
import { assertAssignedOutletAccess, assignedOutletIds } from './permissions.js'
import { handleRealtimeDataApi } from './realtime-store.js'

const OPERATIONAL_CHECKLIST_PREFIX = 'CHEFOPS_CHECKLIST_V1:'

function now() {
  return new Date().toISOString()
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function truthy(value) {
  return value === true || String(value || '').toLowerCase() === 'true'
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
}

function templateVisibleForOutlet(template, outletId) {
  if (!truthy(template?.is_active)) return false
  const outletIds = csv(template?.outlet_ids)
  return !outletIds.length
    || outletIds.includes(String(outletId || ''))
    || String(template?.outlet_id || '') === String(outletId || '')
}

function parseOperationalChecklist(template) {
  const raw = String(template?.instructions || '')
  if (!raw.startsWith(OPERATIONAL_CHECKLIST_PREFIX)) return null
  try {
    const config = JSON.parse(raw.slice(OPERATIONAL_CHECKLIST_PREFIX.length))
    return config?.kind === 'operational_checklist'
      ? applyOpeningChecklistFeedback(template, config)
      : null
  } catch {
    return null
  }
}

function parseState(task) {
  const parsed = parseJson(task?.notes, null)
  if (parsed?.schema === 'operational-checklist-v1') return parsed
  return { schema: 'operational-checklist-v1', responses: {}, started_at: '', completion_notes: '' }
}

function stateText(state) {
  return JSON.stringify({
    schema: 'operational-checklist-v1',
    responses: state.responses || {},
    started_at: state.started_at || '',
    completion_notes: state.completion_notes || '',
  })
}

function timezoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]))
  return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - date.getTime()
}

function operationalDateTime(dateText, timeText, dayOffset = 0, timeZone = 'Asia/Kuala_Lumpur') {
  const [year, month, day] = String(dateText).split('-').map(Number)
  const [hour, minute] = String(timeText || '00:00').split(':').map(Number)
  const localGuess = new Date(Date.UTC(year, month - 1, day + Number(dayOffset || 0), hour || 0, minute || 0, 0))
  let offset = timezoneOffsetMs(localGuess, timeZone)
  let utc = new Date(localGuess.getTime() - offset)
  const corrected = timezoneOffsetMs(utc, timeZone)
  if (corrected !== offset) utc = new Date(localGuess.getTime() - corrected)
  return utc
}

function timing(config, dateText) {
  const schedule = config?.schedule || {}
  const zone = config?.timezone || 'Asia/Kuala_Lumpur'
  return {
    opensAt: operationalDateTime(dateText, schedule.open_time, schedule.open_day_offset, zone),
    dueAt: operationalDateTime(dateText, schedule.due_time, schedule.due_day_offset, zone),
    locksAt: operationalDateTime(dateText, schedule.lock_time || schedule.due_time, schedule.lock_day_offset ?? schedule.due_day_offset, zone),
  }
}

function accessState(task, config, current = new Date()) {
  if (String(task?.status || '').toLowerCase() === 'done') return 'DONE'
  const window = timing(config, task.due_date)
  if (current < window.opensAt) return 'NOT_OPEN'
  if (current > window.locksAt) return 'LOCKED'
  if (current > window.dueAt) return 'OVERDUE'
  return 'OPEN'
}

function items(config) {
  return (config?.sections || []).flatMap((section) => section.items || [])
}

function evaluate(item, response) {
  const raw = response?.value
  if (raw === '' || raw === null || raw === undefined) return 'incomplete'
  if (String(raw).toUpperCase() === 'N/A') return item.allow_na ? 'na' : 'fail'
  if (String(item.response_type || '').toUpperCase() === 'TEMPERATURE') {
    const value = Number(raw)
    if (!Number.isFinite(value)) return 'fail'
    if (item.min_value !== undefined && item.min_value !== null && value < Number(item.min_value)) return 'fail'
    if (item.max_value !== undefined && item.max_value !== null && value > Number(item.max_value)) return 'fail'
    return 'pass'
  }
  return (item.fail_values || []).map(String).includes(String(raw)) ? 'fail' : 'pass'
}

function dayCode(dateText) {
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${dateText}T00:00:00Z`).getUTCDay()]
}

function photoRequired(group, config, state, dateText) {
  const rule = String(group?.rule || '').toUpperCase()
  if (rule === 'REQUIRED') return true
  const linked = items(config).filter((item) => String(item.photo_group_id || '') === String(group.id || ''))
  if (rule === 'ON_FAIL') return linked.some((item) => evaluate(item, state.responses?.[item.id]) === 'fail')
  if (rule === 'REQUIRED_IF_APPLICABLE') {
    return linked.some((item) => {
      const value = state.responses?.[item.id]?.value
      return value !== undefined && value !== '' && String(value).toUpperCase() !== 'N/A'
    })
  }
  if (rule === 'REQUIRED_DAY') return (group.required_days || []).includes(dayCode(dateText))
  return false
}

function normalizeResponses(config, input) {
  const allowed = new Set(items(config).map((item) => String(item.id)))
  const result = {}
  for (const row of Array.isArray(input) ? input : []) {
    const itemId = String(row?.item_id || '')
    if (!allowed.has(itemId)) continue
    result[itemId] = {
      value: row?.value ?? '',
      remark: String(row?.remark || '').slice(0, 1000),
      corrective_action: String(row?.corrective_action || '').slice(0, 2000),
    }
  }
  return result
}

function photoCount(photos, groupId) {
  return photos.filter((photo) => (
    String(photo.task_id || '') === String(photo.task_id || '')
    && String(photo.photo_type || '') === `checklist:${groupId}`
    && !photo.deleted_at
    && String(photo.status || 'active').toLowerCase() !== 'deleted'
  )).length
}

function validateCompletion(config, state, photos, dateText) {
  const missingItems = []
  const missingActions = []
  for (const item of items(config)) {
    const response = state.responses?.[item.id]
    const result = evaluate(item, response)
    if (item.required && result === 'incomplete') missingItems.push(item.name)
    if (result === 'fail' && item.corrective_action_on_fail && !String(response?.corrective_action || '').trim()) {
      missingActions.push(item.name)
    }
  }
  const missingPhotos = []
  for (const group of config.photo_groups || []) {
    if (!photoRequired(group, config, state, dateText)) continue
    if (photoCount(photos, group.id) < Number(group.min_photos || 1)) missingPhotos.push(group.name)
  }
  if (!missingItems.length && !missingActions.length && !missingPhotos.length) return
  const error = new Error([
    missingItems.length ? `Complete: ${missingItems.slice(0, 4).join(', ')}${missingItems.length > 4 ? '…' : ''}` : '',
    missingActions.length ? `Corrective action required: ${missingActions.slice(0, 3).join(', ')}${missingActions.length > 3 ? '…' : ''}` : '',
    missingPhotos.length ? `Photo required: ${missingPhotos.join(', ')}` : '',
  ].filter(Boolean).join(' | '))
  error.status = 400
  error.code = 'checklist_incomplete'
  throw error
}

function realtimeRecord(row) {
  if (!row) return null
  const record = parseJson(row.payload_json, {}) || {}
  return {
    ...record,
    __realtime: {
      entity: row.entity,
      entity_id: row.entity_id,
      outlet_id: row.outlet_id,
      version: Number(row.version || 0),
      updated_at: row.updated_at || '',
      deleted_at: row.deleted_at || '',
    },
  }
}

async function d1Record(env, entity, entityId) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('Realtime D1 database is unavailable')
    error.status = 503
    error.code = 'realtime_database_unavailable'
    throw error
  }
  const row = await env.OPS_DB.prepare(
    "SELECT * FROM ops_records WHERE entity = ? AND entity_id = ? AND deleted_at = '' LIMIT 1",
  ).bind(entity, entityId).first()
  return realtimeRecord(row)
}

async function d1TaskPhotos(env, outletId, taskId) {
  const response = await env.OPS_DB.prepare(`
    SELECT * FROM ops_records
    WHERE entity = 'TaskPhoto' AND outlet_id = ? AND deleted_at = ''
    ORDER BY updated_at DESC LIMIT 3000
  `).bind(outletId).all()
  return (response.results || [])
    .map(realtimeRecord)
    .filter((photo) => String(photo.task_id || '') === String(taskId || ''))
}

async function publishedTaskTemplates(env, outletId) {
  for (const target of [String(outletId || ''), '']) {
    const manifest = await getPublishedAppPack(env, target).catch(() => null)
    const hash = manifest?.modules?.tasks?.hash
    if (!hash) continue
    const module = await getAppPackModule(env, target, 'tasks', hash).catch(() => null)
    const templates = Array.isArray(module?.data?.task_templates) ? module.data.task_templates : []
    if (templates.length) return templates
  }
  return []
}

async function mutate(request, env, body) {
  const url = new URL('/api/realtime/mutations', request.url)
  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.delete('Content-Length')
  const response = await handleRealtimeDataApi(new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }), env, url)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Realtime mutation failed (${response.status})`)
    error.status = response.status
    error.code = data.code || 'realtime_mutation_failed'
    throw error
  }
  return data
}

function mutationId(request, body, action) {
  const supplied = String(body.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '').trim()
  return (supplied || `task-${action}:${crypto.randomUUID()}`).slice(0, 160)
}

function assembleTask(task, template, config, photos) {
  const state = parseState(task)
  const window = timing(config, task.due_date)
  const requirements = (config.photo_groups || []).map((group) => ({
    ...group,
    required: photoRequired(group, config, state, task.due_date),
    uploaded_count: photoCount(photos, group.id),
  }))
  return {
    ...task,
    config,
    responses: Object.entries(state.responses || {}).map(([itemId, row]) => ({
      item_id: itemId,
      value: row?.value ?? '',
      remark: row?.remark || '',
      corrective_action: row?.corrective_action || '',
    })),
    completion_notes: state.completion_notes || task.completion_notes || '',
    opens_at: window.opensAt.toISOString(),
    due_at: window.dueAt.toISOString(),
    locks_at: window.locksAt.toISOString(),
    access_state: accessState(task, config, new Date()),
    checklist_total: items(config).length,
    checklist_completed: items(config).filter((item) => evaluate(item, state.responses?.[item.id]) !== 'incomplete').length,
    required_photo_count: requirements.filter((group) => group.required)
      .reduce((sum, group) => sum + Number(group.min_photos || 1), 0),
    submitted_photo_count: requirements.filter((group) => group.required)
      .reduce((sum, group) => sum + Math.min(group.uploaded_count, Number(group.min_photos || 1)), 0),
    photo_requirements: requirements,
    icon_key: config.icon_key || '',
    shift_id: config.schedule?.shift_id || '',
    template_title: template.title || template.name || '',
  }
}

export function buildTaskProgressPatch(task, state, action, user, timestamp = now()) {
  const nextState = {
    ...state,
    responses: state.responses || {},
  }
  const patch = {}

  if (action === 'start') {
    nextState.started_at = nextState.started_at || timestamp
    patch.status = 'in_progress'
  } else if (action === 'save') {
    nextState.started_at = nextState.started_at || timestamp
    if (String(task.status || '').toLowerCase() === 'pending') patch.status = 'in_progress'
  } else if (action === 'complete') {
    patch.status = 'done'
    patch.completed_date = timestamp
    patch.completed_by_name = user.full_name || user.email
    patch.completed_by_email = user.email
    patch.completion_notes = nextState.completion_notes || ''
  } else {
    const error = new Error('Unsupported task action')
    error.status = 400
    error.code = 'invalid_task_action'
    throw error
  }

  patch.notes = stateText(nextState)
  return { patch, state: nextState }
}

export async function handleD1OperationalTaskAction(request, env, url) {
  if (url.pathname !== '/api/tasks/operational/action' || request.method !== 'POST') return null
  try {
    const user = await getCurrentUser(request, env)
    const body = await readJson(request)
    const outletId = String(body.outlet_id || user.outlet_id || assignedOutletIds(user)[0] || '').trim()
    const dateText = String(body.date || '').trim()
    const taskId = String(body.task_id || '').trim()
    const action = String(body.action || '').trim().toLowerCase()

    if (!outletId) {
      const error = new Error('Your account is not assigned to an outlet')
      error.status = 400
      error.code = 'missing_outlet'
      throw error
    }
    assertAssignedOutletAccess(user, outletId)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
      const error = new Error('Task date must use YYYY-MM-DD')
      error.status = 400
      error.code = 'invalid_task_date'
      throw error
    }
    if (!taskId) {
      const error = new Error('Task ID is required')
      error.status = 400
      error.code = 'missing_task_id'
      throw error
    }

    const task = await d1Record(env, 'Task', taskId)
    if (!task) {
      const error = new Error('This Task is not available in the realtime workspace. Refresh the Task page and retry.')
      error.status = 404
      error.code = 'realtime_task_not_found'
      throw error
    }
    if (String(task.outlet_id || '') !== outletId || String(task.due_date || '') !== dateText) {
      const error = new Error('This Task does not match the selected outlet or date')
      error.status = 409
      error.code = 'task_context_mismatch'
      throw error
    }
    assertAssignedOutletAccess(user, task.outlet_id)

    const templates = await publishedTaskTemplates(env, task.outlet_id)
    const template = templates.find((row) => (
      String(row.id || '') === String(task.template_id || '')
      && templateVisibleForOutlet(row, task.outlet_id)
    ))
    const config = template ? parseOperationalChecklist(template) : null
    if (!template || !config) {
      const error = new Error('The published Task package does not contain this checklist. Ask a manager to publish the latest package.')
      error.status = 503
      error.code = 'published_task_config_unavailable'
      throw error
    }

    const access = accessState(task, config, new Date())
    if (['NOT_OPEN', 'LOCKED'].includes(access)) {
      const error = new Error(access === 'NOT_OPEN' ? 'This checklist is not open yet' : 'This checklist is locked')
      error.status = 409
      error.code = access === 'NOT_OPEN' ? 'task_not_open' : 'task_locked'
      throw error
    }

    const photos = await d1TaskPhotos(env, task.outlet_id, task.id)
    let state = parseState(task)
    if (Array.isArray(body.responses)) state.responses = normalizeResponses(config, body.responses)
    if (body.completion_notes !== undefined) state.completion_notes = String(body.completion_notes || '').slice(0, 3000)

    if (action === 'complete') validateCompletion(config, state, photos, task.due_date)
    const progress = buildTaskProgressPatch(task, state, action, user)
    state = progress.state

    const result = await mutate(request, env, {
      mutation_id: mutationId(request, body, action),
      entity: 'Task',
      entity_id: task.id,
      outlet_id: task.outlet_id,
      operation: 'update',
      expected_version: task.__realtime.version,
      payload: progress.patch,
    })

    return json(request, env, {
      task: assembleTask({
        ...result.record,
        __realtime: {
          entity: 'Task',
          entity_id: task.id,
          outlet_id: task.outlet_id,
          version: result.version,
          updated_at: result.committed_at,
          deleted_at: '',
        },
      }, template, config, photos),
      server_time: now(),
      storage: 'd1',
      sheet_read: false,
    })
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
