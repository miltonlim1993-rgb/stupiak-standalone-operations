import { getCurrentUser } from './auth.js'
import { getAppPackModule, getPublishedAppPack } from './app-pack.js'
import { applyOpeningChecklistFeedback } from './opening-checklist-feedback.js'
import { assertAssignedOutletAccess, assignedOutletIds } from './permissions.js'

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

function recurrenceParts(rule) {
  return Object.fromEntries(String(rule || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=')
    return index >= 0
      ? [part.slice(0, index).toUpperCase(), part.slice(index + 1).toUpperCase()]
      : ['FREQ', part.toUpperCase()]
  }))
}

function templateAppliesOnDate(template, dateText) {
  const parts = recurrenceParts(template?.recurrence_rule)
  const frequency = parts.FREQ || 'DAILY'
  if (frequency === 'DAILY') return true
  const date = new Date(`${dateText}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return false
  if (frequency === 'WEEKLY') {
    const dayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
    const allowed = csv(parts.BYDAY)
    return allowed.length ? allowed.includes(dayCodes[date.getUTCDay()]) : date.getUTCDay() === 1
  }
  if (frequency === 'MONTHLY') {
    const allowed = csv(parts.BYMONTHDAY).map(Number).filter(Number.isFinite)
    return allowed.length ? allowed.includes(date.getUTCDate()) : date.getUTCDate() === 1
  }
  return true
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

function realtimeRecord(row) {
  const record = parseJson(row?.payload_json, {}) || {}
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

function recordId(record) {
  return String(record?.id || record?.__realtime?.entity_id || '').trim()
}

function safe(value, limit = 80) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit)
}

function taskIdForTemplate(outletId, dateText, templateId) {
  return `task-${dateText}-${safe(outletId)}-${safe(templateId)}`
}

function parseState(task) {
  const parsed = parseJson(task?.notes, null)
  if (parsed?.schema === 'operational-checklist-v1') return parsed
  return { schema: 'operational-checklist-v1', responses: {}, started_at: '', completion_notes: '' }
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
  const rule = String(group.rule || '').toUpperCase()
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
  if (String(task.status || '').toLowerCase() === 'done') return 'DONE'
  const window = timing(config, task.due_date)
  if (current < window.opensAt) return 'NOT_OPEN'
  if (current > window.locksAt) return 'LOCKED'
  if (current > window.dueAt) return 'OVERDUE'
  return 'OPEN'
}

function assembleTask(task, template, config, photos, current) {
  const state = parseState(task)
  const checklistItems = items(config)
  const window = timing(config, task.due_date)
  const responseRows = Object.entries(state.responses || {}).map(([itemId, row]) => ({
    item_id: itemId,
    value: row?.value ?? '',
    remark: row?.remark || '',
    corrective_action: row?.corrective_action || '',
  }))
  const requirements = (config.photo_groups || []).map((group) => {
    const uploaded = photos.filter((photo) => (
      String(photo.task_id || '') === String(task.id || '')
      && String(photo.photo_type || '') === `checklist:${group.id}`
      && !photo.deleted_at
      && String(photo.status || 'active').toLowerCase() !== 'deleted'
    )).length
    return {
      ...group,
      required: photoRequired(group, config, state, task.due_date),
      uploaded_count: uploaded,
    }
  })
  return {
    ...task,
    config,
    responses: responseRows,
    completion_notes: state.completion_notes || task.completion_notes || '',
    opens_at: window.opensAt.toISOString(),
    due_at: window.dueAt.toISOString(),
    locks_at: window.locksAt.toISOString(),
    access_state: accessState(task, config, current),
    checklist_total: checklistItems.length,
    checklist_completed: checklistItems.filter((item) => evaluate(item, state.responses?.[item.id]) !== 'incomplete').length,
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

function taskRecord(template, config, outletId, dateText) {
  const timestamp = now()
  const state = { schema: 'operational-checklist-v1', responses: {}, started_at: '', completion_notes: '' }
  return {
    id: taskIdForTemplate(outletId, dateText, template.id),
    outlet_id: outletId,
    created_date: timestamp,
    created_by: 'system@stupiaks-ops',
    updated_date: timestamp,
    updated_by: 'system@stupiaks-ops',
    deleted_at: '',
    version: 1,
    title: template.title || template.name || 'Operational task',
    description: template.description || '',
    category: template.category || 'general',
    priority: template.priority || 'medium',
    status: 'pending',
    assigned_to_role: template.assigned_to_role || 'staff',
    assigned_to_user_id: template.assigned_to_user_id || '',
    assigned_to_name: '',
    due_date: dateText,
    due_time: config.schedule?.due_time || template.due_time || '',
    marks: 0,
    penalty: 0,
    is_followup: false,
    parent_task_id: '',
    completed_date: '',
    completed_by_name: '',
    notes: JSON.stringify(state),
    template_id: template.id || '',
    recurrence_rule: template.recurrence_rule || '',
    photo_required: truthy(template.photo_required),
    completion_notes: '',
    completed_by_email: '',
    created_by_name: 'System',
    station: template.station || '',
    period: config.schedule?.shift_id || template.period || '',
    sop_id: '',
    template_version: Number(template.version || 1),
  }
}

async function publishedTaskData(env, outletId) {
  let target = outletId
  let manifest = await getPublishedAppPack(env, target)
  if (!manifest) {
    target = ''
    manifest = await getPublishedAppPack(env, target)
  }
  if (!manifest?.modules?.tasks?.hash) return null
  const module = await getAppPackModule(env, target, 'tasks', manifest.modules.tasks.hash)
  return module?.data || null
}

async function d1Rows(env, outletId) {
  const result = await env.OPS_DB.prepare(`
    SELECT * FROM ops_records
    WHERE outlet_id = ? AND entity IN ('Task', 'TaskPhoto') AND deleted_at = ''
    ORDER BY updated_at DESC LIMIT 5000
  `).bind(outletId).all()
  return (result.results || []).map(realtimeRecord)
}

async function seedSheetTaskIntoD1(env, task) {
  const id = recordId(task)
  if (!id) return
  const timestamp = String(task.updated_date || task.created_date || now())
  await env.OPS_DB.prepare(`
    INSERT INTO ops_records (
      entity, entity_id, outlet_id, business_date, status, payload_json,
      version, created_at, created_by, updated_at, updated_by, deleted_at
    ) VALUES ('Task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
    ON CONFLICT(entity, entity_id) DO NOTHING
  `).bind(
    id,
    String(task.outlet_id || ''),
    String(task.due_date || ''),
    String(task.status || ''),
    JSON.stringify(task),
    Math.max(1, Number(task.version || 1)),
    String(task.created_date || timestamp),
    String(task.created_by || 'system@stupiaks-ops'),
    timestamp,
    String(task.updated_by || 'system@stupiaks-ops'),
  ).run()
}

async function createGeneratedTask(env, template, config, outletId, dateText) {
  const record = taskRecord(template, config, outletId, dateText)
  const timestamp = now()
  const mutationId = `bootstrap:${outletId}:${dateText}:${template.id}`.slice(0, 160)
  const message = {
    mutation_id: mutationId,
    entity: 'Task',
    entity_id: record.id,
    outlet_id: outletId,
    operation: 'upsert',
    record,
    version: 1,
    committed_at: timestamp,
  }
  const result = {
    ok: true,
    replayed: false,
    mutation_id: mutationId,
    entity: 'Task',
    entity_id: record.id,
    outlet_id: outletId,
    version: 1,
    record,
    sync_status: 'pending',
    committed_at: timestamp,
  }

  await env.OPS_DB.batch([
    env.OPS_DB.prepare(`
      INSERT INTO ops_records (
        entity, entity_id, outlet_id, business_date, status, payload_json,
        version, created_at, created_by, updated_at, updated_by, deleted_at
      ) VALUES ('Task', ?, ?, ?, ?, ?, 1, ?, 'system@stupiaks-ops', ?, 'system@stupiaks-ops', '')
      ON CONFLICT(entity, entity_id) DO NOTHING
    `).bind(record.id, outletId, dateText, 'pending', JSON.stringify(record), timestamp, timestamp),
    env.OPS_DB.prepare(`
      INSERT INTO ops_mutations (
        mutation_id, outlet_id, entity, entity_id, operation, actor_email,
        actor_name, requested_at, committed_at, result_json
      ) VALUES (?, ?, 'Task', ?, 'upsert', 'system@stupiaks-ops', 'System', ?, ?, ?)
      ON CONFLICT(mutation_id) DO NOTHING
    `).bind(mutationId, outletId, record.id, timestamp, timestamp, JSON.stringify(result)),
    env.OPS_DB.prepare(`
      INSERT INTO sheet_sync_outbox (
        mutation_id, entity, entity_id, outlet_id, operation, payload_json,
        status, attempts, next_attempt_at
      ) VALUES (?, 'Task', ?, ?, 'upsert', ?, 'pending', 0, ?)
      ON CONFLICT(mutation_id) DO NOTHING
    `).bind(mutationId, record.id, outletId, JSON.stringify(message), timestamp),
  ])

  if (env.SHEET_SYNC_QUEUE?.send) {
    env.SHEET_SYNC_QUEUE.send(message).catch((error) => {
      console.error('Unable to queue generated Task Sheet mirror', mutationId, error)
    })
  }
  return record
}

export async function overlayOperationalBootstrapResponse(request, url, env, response) {
  if (
    url.pathname !== '/api/tasks/operational/bootstrap'
    || request.method !== 'POST'
    || !env.OPS_DB?.prepare
  ) return response

  let body
  try { body = await request.json() } catch { return response }

  const user = await getCurrentUser(request, env).catch(() => null)
  if (!user) return response
  const outletId = String(body.outlet_id || user.outlet_id || assignedOutletIds(user)[0] || '').trim()
  const dateText = String(body.date || '').trim()
  if (!outletId || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return response
  try { assertAssignedOutletAccess(user, outletId) } catch { return response }

  const published = await publishedTaskData(env, outletId).catch(() => null)
  const templateRows = Array.isArray(published?.task_templates) ? published.task_templates : []
  const entries = templateRows
    .filter((template) => templateVisibleForOutlet(template, outletId) && templateAppliesOnDate(template, dateText))
    .map((template) => ({ template, config: parseOperationalChecklist(template) }))
    .filter((entry) => entry.config)

  let base = {}
  if (response.status >= 200 && response.status < 300) {
    try { base = await response.clone().json() } catch {}
  }
  if (!entries.length && !Array.isArray(base?.tasks)) return response

  const baseTasks = Array.isArray(base?.tasks) ? base.tasks : []
  const basePhotos = Array.isArray(base?.task_photos) ? base.task_photos : []
  await Promise.all(baseTasks.map((task) => seedSheetTaskIntoD1(env, task).catch(() => undefined)))

  let rows = await d1Rows(env, outletId)
  const taskMap = new Map(baseTasks
    .filter((task) => String(task.outlet_id || outletId) === outletId && String(task.due_date || '') === dateText)
    .map((task) => [recordId(task), task])
    .filter(([id]) => id))
  const photoMap = new Map(basePhotos.map((photo) => [recordId(photo), photo]).filter(([id]) => id))

  for (const row of rows) {
    const id = recordId(row)
    if (!id) continue
    if (row.__realtime.entity === 'Task') {
      if (String(row.due_date || '') !== dateText) continue
      taskMap.set(id, { ...(taskMap.get(id) || {}), ...row })
    } else if (row.__realtime.entity === 'TaskPhoto') {
      photoMap.set(id, { ...(photoMap.get(id) || {}), ...row })
    }
  }

  const byTemplate = new Map([...taskMap.values()].map((task) => [String(task.template_id || ''), task]))
  for (const entry of entries) {
    if (byTemplate.has(String(entry.template.id || ''))) continue
    const created = await createGeneratedTask(env, entry.template, entry.config, outletId, dateText)
    taskMap.set(created.id, created)
    byTemplate.set(String(entry.template.id || ''), created)
  }

  rows = [...taskMap.values()]
  const current = new Date()
  const entryByTemplate = new Map(entries.map((entry) => [String(entry.template.id || ''), entry]))
  const taskIds = new Set(rows.map(recordId).filter(Boolean))
  const photos = [...photoMap.values()].filter((photo) => taskIds.has(String(photo.task_id || '')))
  const tasks = rows.map((task) => {
    const entry = entryByTemplate.get(String(task.template_id || ''))
    if (!entry) return task
    return assembleTask(task, entry.template, entry.config, photos, current)
  })

  const result = {
    ...base,
    tasks,
    task_photos: photos,
    template_photos: Array.isArray(published?.task_template_photos)
      ? published.task_template_photos.filter((photo) => entryByTemplate.has(String(photo.template_id || '')))
      : (Array.isArray(base?.template_photos) ? base.template_photos : []),
    source_control: response.ok
      ? 'MASTER_SHEET_WITH_D1_CANONICAL_OVERLAY'
      : 'CLOUDFLARE_PACKAGE_D1_FALLBACK',
    sheet_available: response.ok,
    server_time: current.toISOString(),
  }
  const headers = new Headers(response.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(result), {
    status: 200,
    headers,
  })
}