import { getCurrentUser } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import {
  assertAssignedOutletAccess,
  assertCreatePermission,
  assertOutletAccess,
  assertReadPermission,
  assertUpdatePermission,
  assignedOutletIds,
} from './permissions.js'
import { getSchema } from './schema.js'
import { appendRecord, findRecord, listRecords } from './sheets.js'
import { applyOpeningChecklistFeedback } from './opening-checklist-feedback.js'
import { syncCloseUpToSalesTemplate } from './closeup-sync.js'
import { handleRealtimeDataApi } from './realtime-store.js'

const OPERATIONAL_CHECKLIST_PREFIX = 'CHEFOPS_CHECKLIST_V1:'
const WORKFLOW_PATHS = new Set([
  '/api/tasks/operational/action',
  '/api/stock-counts/batch',
  '/api/close-up/upsert',
])

function now() {
  return new Date().toISOString()
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function truthyValue(value) {
  return value === true || String(value).toLowerCase() === 'true'
}

function csvValues(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
}

function templateVisibleForOutlet(template, outletId) {
  if (!truthyValue(template.is_active)) return false
  const outletIds = csvValues(template.outlet_ids)
  return !outletIds.length
    || outletIds.includes(String(outletId || ''))
    || String(template.outlet_id || '') === String(outletId || '')
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

function parseOperationalState(task) {
  try {
    const parsed = JSON.parse(String(task?.notes || ''))
    if (parsed?.schema === 'operational-checklist-v1') return parsed
  } catch {}
  return { schema: 'operational-checklist-v1', responses: {}, started_at: '', completion_notes: '' }
}

function operationalStateText(state) {
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
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
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

function operationalTiming(config, dateText) {
  const schedule = config.schedule || {}
  const zone = config.timezone || 'Asia/Kuala_Lumpur'
  return {
    opensAt: operationalDateTime(dateText, schedule.open_time, schedule.open_day_offset, zone),
    dueAt: operationalDateTime(dateText, schedule.due_time, schedule.due_day_offset, zone),
    locksAt: operationalDateTime(dateText, schedule.lock_time || schedule.due_time, schedule.lock_day_offset ?? schedule.due_day_offset, zone),
  }
}

function operationalAccessState(task, timing, current = new Date()) {
  if (String(task?.status || '').toLowerCase() === 'done') return 'DONE'
  if (current < timing.opensAt) return 'NOT_OPEN'
  if (current > timing.locksAt) return 'LOCKED'
  if (current > timing.dueAt) return 'OVERDUE'
  return 'OPEN'
}

function operationalItems(config) {
  return (config.sections || []).flatMap((section) => section.items || [])
}

function operationalEvaluateItem(item, response) {
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

function operationalDayCode(dateText) {
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${dateText}T00:00:00Z`).getUTCDay()]
}

function operationalPhotoRequirement(group, config, state, dateText) {
  const rule = String(group.rule || '').toUpperCase()
  if (rule === 'REQUIRED') return true
  const items = operationalItems(config).filter((item) => String(item.photo_group_id || '') === String(group.id || ''))
  if (rule === 'ON_FAIL') return items.some((item) => operationalEvaluateItem(item, state.responses?.[item.id]) === 'fail')
  if (rule === 'REQUIRED_IF_APPLICABLE') {
    return items.some((item) => {
      const value = state.responses?.[item.id]?.value
      return value !== undefined && value !== '' && String(value).toUpperCase() !== 'N/A'
    })
  }
  if (rule === 'REQUIRED_DAY') return (group.required_days || []).includes(operationalDayCode(dateText))
  return false
}

function operationalPhotoCount(taskPhotos, groupId) {
  return taskPhotos.filter((row) => (
    String(row.photo_type || '') === `checklist:${groupId}`
    && !row.deleted_at
    && String(row.status || 'active').toLowerCase() !== 'deleted'
  )).length
}

function operationalResponseArray(state) {
  return Object.entries(state.responses || {}).map(([itemId, row]) => ({
    item_id: itemId,
    value: row?.value ?? '',
    remark: row?.remark || '',
    corrective_action: row?.corrective_action || '',
  }))
}

function operationalAssembleTask(task, template, config, taskPhotos, current = new Date()) {
  const state = parseOperationalState(task)
  const timing = operationalTiming(config, task.due_date)
  const items = operationalItems(config)
  const completed = items.filter((item) => operationalEvaluateItem(item, state.responses?.[item.id]) !== 'incomplete').length
  const photoRequirements = (config.photo_groups || []).map((group) => {
    const required = operationalPhotoRequirement(group, config, state, task.due_date)
    const uploadedCount = operationalPhotoCount(taskPhotos, group.id)
    return { ...group, required, uploaded_count: uploadedCount }
  })
  return {
    ...task,
    config,
    responses: operationalResponseArray(state),
    completion_notes: state.completion_notes || task.completion_notes || '',
    opens_at: timing.opensAt.toISOString(),
    due_at: timing.dueAt.toISOString(),
    locks_at: timing.locksAt.toISOString(),
    access_state: operationalAccessState(task, timing, current),
    checklist_total: items.length,
    checklist_completed: completed,
    required_photo_count: photoRequirements.filter((group) => group.required)
      .reduce((sum, group) => sum + Number(group.min_photos || 1), 0),
    submitted_photo_count: photoRequirements.filter((group) => group.required)
      .reduce((sum, group) => sum + Math.min(group.uploaded_count, Number(group.min_photos || 1)), 0),
    photo_requirements: photoRequirements,
    icon_key: config.icon_key || '',
    shift_id: config.schedule?.shift_id || '',
    template_title: template.title || template.name || '',
  }
}

function operationalNormalizeResponses(config, input) {
  const allowed = new Set(operationalItems(config).map((item) => String(item.id)))
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

function operationalValidateCompletion(config, state, taskPhotos, dateText) {
  const missingItems = []
  const missingActions = []
  for (const item of operationalItems(config)) {
    const response = state.responses?.[item.id]
    const result = operationalEvaluateItem(item, response)
    if (item.required && result === 'incomplete') missingItems.push(item.name)
    if (result === 'fail' && item.corrective_action_on_fail && !String(response?.corrective_action || '').trim()) {
      missingActions.push(item.name)
    }
  }
  const missingPhotos = []
  for (const group of config.photo_groups || []) {
    if (!operationalPhotoRequirement(group, config, state, dateText)) continue
    const count = operationalPhotoCount(taskPhotos, group.id)
    if (count < Number(group.min_photos || 1)) missingPhotos.push(group.name)
  }
  if (missingItems.length || missingActions.length || missingPhotos.length) {
    const error = new Error([
      missingItems.length ? `Complete: ${missingItems.slice(0, 4).join(', ')}${missingItems.length > 4 ? '…' : ''}` : '',
      missingActions.length ? `Corrective action required: ${missingActions.slice(0, 3).join(', ')}${missingActions.length > 3 ? '…' : ''}` : '',
      missingPhotos.length ? `Photo required: ${missingPhotos.join(', ')}` : '',
    ].filter(Boolean).join(' | '))
    error.status = 400
    error.code = 'checklist_incomplete'
    throw error
  }
}

function d1Database(env) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('Realtime D1 database is not configured')
    error.status = 503
    error.code = 'realtime_database_unavailable'
    throw error
  }
  return env.OPS_DB
}

function realtimeRecordFromRow(row) {
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
  const row = await d1Database(env).prepare(
    "SELECT * FROM ops_records WHERE entity = ? AND entity_id = ? AND deleted_at = '' LIMIT 1",
  ).bind(entity, entityId).first()
  return realtimeRecordFromRow(row)
}

async function d1Rows(env, entity, outletId, limit = 2000) {
  const response = await d1Database(env).prepare(
    "SELECT * FROM ops_records WHERE entity = ? AND outlet_id = ? AND deleted_at = '' ORDER BY updated_at DESC LIMIT ?",
  ).bind(entity, outletId, Math.max(1, Math.min(Number(limit) || 2000, 5000))).all()
  return (response.results || []).map(realtimeRecordFromRow)
}

function recordId(record) {
  return String(record?.id || record?.__realtime?.entity_id || '').trim()
}

function mergeRows(sheetRows, realtimeRows) {
  const byId = new Map((sheetRows || []).map((row) => [recordId(row), row]).filter(([id]) => id))
  for (const row of realtimeRows || []) {
    const id = recordId(row)
    if (id) byId.set(id, { ...(byId.get(id) || {}), ...row })
  }
  return [...byId.values()]
}

async function mutationResponse(request, env, body) {
  const targetUrl = new URL('/api/realtime/mutations', request.url)
  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.delete('Content-Length')
  const subrequest = new Request(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const response = await handleRealtimeDataApi(subrequest, env, targetUrl)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Realtime mutation failed (${response.status})`)
    error.status = response.status
    error.code = data.code || 'realtime_mutation_failed'
    error.details = data.details
    throw error
  }
  return data
}

function requestMutationId(request, body, prefix) {
  const supplied = String(body?.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '').trim()
  return (supplied || `${prefix}:${crypto.randomUUID()}`).slice(0, 150)
}

function cleanPatch(entity, input) {
  const schema = getSchema(entity)
  const allowed = new Set(schema.headers)
  const serverManaged = new Set([
    'id', 'created_date', 'created_by', 'updated_date', 'updated_by',
    'deleted_at', 'version', 'created_at', 'updated_at', 'assigned_at',
    'acknowledged_at', 'uploaded_at', 'submitted_at', 'sync_status',
    'sync_attempts', 'last_sync_at', 'last_sync_error', 'external_sync_key',
    'external_response_json',
  ])
  return Object.fromEntries(
    Object.entries(input || {}).filter(([key]) => allowed.has(key) && !serverManaged.has(key)),
  )
}

function resolveOutletId(user, requested = '') {
  const value = String(requested || '').trim()
  if (user.role === 'manager' || user.role === 'owner') return value || user.outlet_id || ''
  const allowed = assignedOutletIds(user)
  const target = value || user.outlet_id || allowed[0] || ''
  if (target) assertOutletAccess(user, target)
  return target
}

function scheduleAudit(env, user, action, entity, entityId, payload = {}) {
  const timestamp = now()
  const job = appendRecord(env, 'AuditLog', {
    id: crypto.randomUUID(),
    outlet_id: typeof payload?.outlet_id === 'string' ? payload.outlet_id : (user.outlet_id || ''),
    created_date: timestamp,
    created_by: user.email,
    updated_date: timestamp,
    updated_by: user.email,
    deleted_at: '',
    version: 1,
    actor_sub: user.google_sub || '',
    actor_email: user.email,
    action,
    entity,
    entity_id: entityId,
    summary: `${action} ${entity}`,
    payload_json: JSON.stringify(payload),
    actor_name: user.full_name || user.email,
  }).catch((error) => console.error('Realtime workflow audit failed', action, entityId, error))
  if (env.__CHEFOPS_CTX?.waitUntil) env.__CHEFOPS_CTX.waitUntil(job)
}

async function handleOperationalTaskAction(request, env, url) {
  if (url.pathname !== '/api/tasks/operational/action' || request.method !== 'POST') return null
  const user = await getCurrentUser(request, env)
  const body = await readJson(request)
  const outletId = String(body.outlet_id || user.outlet_id || assignedOutletIds(user)[0] || '').trim()
  const dateText = String(body.date || '').trim()
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

  const taskId = String(body.task_id || '').trim()
  const action = String(body.action || '').toLowerCase()
  const year = Number(dateText.slice(0, 4))
  let task = await d1Record(env, 'Task', taskId)
  if (!task) task = (await findRecord(env, 'Task', taskId, { year })).record
  assertAssignedOutletAccess(user, task.outlet_id)

  const templates = await listRecords(env, 'TaskTemplate', { sort: 'display_order,title', limit: 1000 })
  const template = templates.find((row) => (
    String(row.id || '') === String(task.template_id || '')
    && templateVisibleForOutlet(row, task.outlet_id)
  ))
  const config = template ? parseOperationalChecklist(template) : null
  if (!template || !config) {
    const error = new Error('This task is not linked to an active operational checklist')
    error.status = 400
    error.code = 'invalid_operational_task'
    throw error
  }

  const timing = operationalTiming(config, task.due_date)
  const access = operationalAccessState(task, timing, new Date())
  if (['NOT_OPEN', 'LOCKED'].includes(access)) {
    const error = new Error(access === 'NOT_OPEN' ? 'This checklist is not open yet' : 'This checklist is locked')
    error.status = 409
    error.code = access === 'NOT_OPEN' ? 'task_not_open' : 'task_locked'
    throw error
  }

  const sheetPhotos = await listRecords(env, 'TaskPhoto', {
    filter: { outlet_id: task.outlet_id, task_id: task.id },
    sort: 'display_order',
    limit: 1000,
    year,
  })
  const realtimePhotos = (await d1Rows(env, 'TaskPhoto', task.outlet_id, 3000))
    .filter((row) => String(row.task_id || '') === String(task.id || ''))
  const taskPhotos = mergeRows(sheetPhotos, realtimePhotos)

  const state = parseOperationalState(task)
  if (Array.isArray(body.responses)) state.responses = operationalNormalizeResponses(config, body.responses)
  if (body.completion_notes !== undefined) state.completion_notes = String(body.completion_notes || '').slice(0, 3000)
  const patch = {
    ...task,
    __realtime: undefined,
    notes: operationalStateText(state),
    outlet_id: task.outlet_id,
  }

  if (action === 'start') {
    state.started_at = state.started_at || now()
    patch.notes = operationalStateText(state)
    patch.status = 'in_progress'
  } else if (action === 'save') {
    state.started_at = state.started_at || now()
    patch.notes = operationalStateText(state)
    if (String(task.status || '').toLowerCase() === 'pending') patch.status = 'in_progress'
  } else if (action === 'complete') {
    operationalValidateCompletion(config, state, taskPhotos, task.due_date)
    patch.status = 'done'
    patch.completed_date = now()
    patch.completed_by_name = user.full_name || user.email
    patch.completed_by_email = user.email
    patch.completion_notes = state.completion_notes
  } else {
    const error = new Error('Unsupported task action')
    error.status = 400
    error.code = 'invalid_task_action'
    throw error
  }

  const result = await mutationResponse(request, env, {
    mutation_id: requestMutationId(request, body, `task-${action}`),
    entity: 'Task',
    entity_id: task.id,
    outlet_id: task.outlet_id,
    operation: task.__realtime ? 'update' : 'upsert',
    expected_version: task.__realtime?.version,
    payload: patch,
  })
  scheduleAudit(env, user, `operational_${action}`, 'Task', task.id, {
    outlet_id: task.outlet_id,
    date: task.due_date,
    storage: 'd1',
  })
  return json(request, env, {
    task: operationalAssembleTask(result.record, template, config, taskPhotos, new Date()),
    server_time: now(),
  })
}

function stockAliases(record = {}) {
  const aliases = []
  const stockListId = String(record.stock_list_id ?? '').trim()
  const itemId = String(record.item_id || '').trim()
  const itemName = String(record.item_name || '').trim().toLowerCase()
  if (stockListId) aliases.push(`list:${stockListId}`)
  if (itemId) aliases.push(`item:${itemId}`)
  if (itemName) aliases.push(`name:${itemName}`)
  return aliases
}

function safeKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72)
}

async function handleStockCountBatch(request, env, url) {
  if (url.pathname !== '/api/stock-counts/batch' || request.method !== 'POST') return null
  const user = await getCurrentUser(request, env)
  const body = await readJson(request)
  const countDate = String(body.count_date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(countDate)) {
    const error = new Error('count_date must use YYYY-MM-DD')
    error.status = 400
    error.code = 'invalid_count_date'
    throw error
  }
  const items = Array.isArray(body.items) ? body.items.slice(0, 500) : []
  if (!items.length) {
    const error = new Error('No stock quantities were supplied')
    error.status = 400
    error.code = 'empty_stock_count'
    throw error
  }
  const outletId = String(body.outlet_id || user.outlet_id || assignedOutletIds(user)[0] || '').trim()
  if (!outletId) {
    const error = new Error('Your account is not assigned to an outlet')
    error.status = 400
    error.code = 'missing_outlet'
    throw error
  }
  assertAssignedOutletAccess(user, outletId)

  const year = Number(countDate.slice(0, 4))
  const [stockListRows, sheetCounts, realtimeCounts] = await Promise.all([
    listRecords(env, 'OutletStockList', { filter: { outlet_id: outletId }, sort: 'section,display_order', limit: 5000 }),
    listRecords(env, 'StockCount', { filter: { outlet_id: outletId, count_date: { $lte: countDate } }, sort: '-count_date', limit: 5000, year }),
    d1Rows(env, 'StockCount', outletId, 5000),
  ])
  const stockListById = new Map(stockListRows
    .filter((record) => truthyValue(record.enabled))
    .map((record) => [String(record.stock_list_id || ''), record]))
  const allCounts = mergeRows(sheetCounts, realtimeCounts)
  const sameDateByAlias = new Map()
  const previousByAlias = new Map()
  for (const record of allCounts) {
    const date = String(record.count_date || '')
    if (!date || date > countDate) continue
    for (const alias of stockAliases(record)) {
      if (date === countDate) sameDateByAlias.set(alias, record)
      if (date < countDate) {
        const previous = previousByAlias.get(alias)
        if (!previous || String(previous.count_date || '') < date) previousByAlias.set(alias, record)
      }
    }
  }

  const baseMutationId = requestMutationId(request, body, 'stock-batch')
  const timestamp = now()
  const savedRecords = []
  let created = 0
  let updated = 0
  for (const input of items) {
    const stockList = stockListById.get(String(input.stock_list_id || ''))
    if (!stockList) continue
    const actualQty = Number(input.actual_qty)
    if (!Number.isFinite(actualQty) || actualQty < 0) continue
    const aliases = stockAliases(stockList)
    const existing = aliases.map((alias) => sameDateByAlias.get(alias)).find(Boolean) || null
    const previous = aliases.map((alias) => previousByAlias.get(alias)).find(Boolean) || null
    const expectedQty = existing
      ? existing.expected_qty
      : (previous ? Number(previous.actual_qty) : '')
    const variance = expectedQty === '' || expectedQty == null ? '' : actualQty - Number(expectedQty)
    const id = existing?.id || `stock-${safeKey(countDate)}-${safeKey(outletId)}-${safeKey(stockList.stock_list_id)}`
    const payload = existing
      ? {
          ...existing,
          __realtime: undefined,
          item_name: stockList.item_name || existing.item_name || '',
          category: stockList.category || existing.category || '',
          expected_qty: expectedQty,
          actual_qty: actualQty,
          unit: stockList.count_uom || existing.unit || '',
          variance,
          counted_by: user.full_name || user.email,
          counted_by_email: user.email,
          status: 'counted',
          stock_list_id: stockList.stock_list_id || '',
          item_id: stockList.item_id || '',
          outlet_id: outletId,
          count_date: countDate,
        }
      : {
          id,
          outlet_id: outletId,
          item_name: stockList.item_name || '',
          category: stockList.category || '',
          expected_qty: expectedQty,
          actual_qty: actualQty,
          unit: stockList.count_uom || '',
          variance,
          count_date: countDate,
          counted_by: user.full_name || user.email,
          counted_by_email: user.email,
          status: 'counted',
          submitted_to_whatsapp: false,
          submitted_to_erp: false,
          notes: '',
          stock_list_id: stockList.stock_list_id || '',
          item_id: stockList.item_id || '',
        }
    const result = await mutationResponse(request, env, {
      mutation_id: `${baseMutationId}:${safeKey(stockList.stock_list_id)}`.slice(0, 160),
      entity: 'StockCount',
      entity_id: id,
      outlet_id: outletId,
      operation: existing?.__realtime ? 'update' : 'upsert',
      expected_version: existing?.__realtime?.version,
      requested_at: timestamp,
      payload,
    })
    if (existing) updated += 1
    else created += 1
    sameDateByAlias.set(`list:${stockList.stock_list_id}`, result.record)
    savedRecords.push({
      stock_list_id: stockList.stock_list_id,
      item_id: stockList.item_id,
      stock_count_id: result.record.id,
      item_name: stockList.item_name,
      actual_qty: actualQty,
      expected_qty: expectedQty,
      variance,
    })
  }
  scheduleAudit(env, user, 'save_batch', 'StockCount', countDate, {
    outlet_id: outletId,
    saved: savedRecords.length,
    created,
    updated,
    storage: 'd1',
  })
  return json(request, env, {
    saved: savedRecords.length,
    created,
    updated,
    list_items: stockListById.size,
    records: savedRecords,
  })
}

async function closeUpRows(env, outletId, businessDate, year) {
  const [sheetRows, realtimeRows] = await Promise.all([
    listRecords(env, 'CloseUp', {
      filter: { outlet_id: outletId, business_date: businessDate },
      sort: '-submitted_at,-updated_date',
      limit: 500,
      year,
    }),
    d1Rows(env, 'CloseUp', outletId, 2000),
  ])
  return mergeRows(sheetRows, realtimeRows)
    .filter((row) => String(row.business_date || '') === businessDate)
}

async function handleCloseUpUpsert(request, env, url) {
  if (url.pathname !== '/api/close-up/upsert' || request.method !== 'POST') return null
  const user = await getCurrentUser(request, env)
  assertReadPermission(user, 'CloseUp')
  const rawInput = await readJson(request)
  const requestedRecordId = String(rawInput.record_id || '').trim()
  const input = cleanPatch('CloseUp', rawInput)
  const outletId = resolveOutletId(user, input.outlet_id)
  const businessDate = String(input.business_date || '').trim()
  const shiftId = String(input.shift_id || '').trim()
  const allowedPhases = new Set(['morning', 'handover', 'night'])
  if (!outletId || !businessDate || !shiftId) {
    const error = new Error('Outlet, business date and phase are required')
    error.status = 400
    error.code = 'close_up_required_fields'
    throw error
  }
  if (!allowedPhases.has(shiftId)) {
    const error = new Error('Phase must be morning, handover or night')
    error.status = 400
    error.code = 'close_up_invalid_phase'
    throw error
  }
  assertOutletAccess(user, outletId)

  input.outlet_id = outletId
  input.shift_name = input.shift_name || (shiftId === 'morning'
    ? 'Morning / Opening'
    : shiftId === 'handover'
      ? 'Cash Handover'
      : 'Night / Closing')
  const isHandover = shiftId === 'handover'
  const year = url.searchParams.get('year') || businessDate.slice(0, 4) || undefined
  const datedRows = await closeUpRows(env, outletId, businessDate, year)
  const baseMutationId = requestMutationId(request, rawInput, 'close-up')
  const generatedEventKey = isHandover
    ? `handover-${safeKey(rawInput.event_key || requestedRecordId || baseMutationId)}`
    : `${outletId}|${businessDate}|${shiftId}`
  input.event_key = String(input.event_key || generatedEventKey).trim()

  let existing = null
  if (requestedRecordId) {
    existing = await d1Record(env, 'CloseUp', requestedRecordId)
      || datedRows.find((row) => String(row.id || '') === requestedRecordId)
      || null
    if (!existing) {
      try { existing = (await findRecord(env, 'CloseUp', requestedRecordId, { year })).record } catch {}
    }
    if (existing && (
      String(existing.outlet_id || '') !== outletId
      || String(existing.business_date || '') !== businessDate
      || String(existing.shift_id || '') !== shiftId
    )) {
      const error = new Error('The selected Close Up record does not match this outlet, date or phase')
      error.status = 409
      error.code = 'close_up_record_mismatch'
      throw error
    }
  } else {
    existing = datedRows.find((row) => String(row.event_key || '') === input.event_key) || null
  }
  if (!existing && !isHandover) {
    existing = datedRows.find((row) => String(row.shift_id || '') === shiftId) || null
  }

  if (isHandover) {
    if (!String(input.from_staff || '').trim() || !String(input.to_staff || '').trim()) {
      const error = new Error('From staff and to staff are required for a handover')
      error.status = 400
      error.code = 'close_up_handover_staff_required'
      throw error
    }
    if (existing) input.handover_sequence = Number(existing.handover_sequence || 0) || 1
    else {
      const maxSequence = datedRows
        .filter((row) => String(row.shift_id || '') === 'handover')
        .reduce((max, row) => Math.max(max, Number(row.handover_sequence || 0)), 0)
      input.handover_sequence = maxSequence + 1
    }
    input.handover_variance = Number(input.incoming_cash || 0) - Number(input.outgoing_cash || 0)
  } else {
    input.handover_sequence = 0
    input.outgoing_cash = 0
    input.incoming_cash = 0
    input.handover_variance = 0
    input.from_staff = ''
    input.to_staff = ''
    input.outgoing_denominations_json = '{}'
    input.incoming_denominations_json = '{}'
  }

  if (existing) assertUpdatePermission(user, 'CloseUp', existing, input)
  else assertCreatePermission(user, 'CloseUp')
  const timestamp = now()
  const id = existing?.id || requestedRecordId || `closeup-${safeKey(input.event_key)}`
  const payload = {
    ...(existing || {}),
    ...input,
    __realtime: undefined,
    id,
    outlet_id: outletId,
    submitted_at: timestamp,
    submitted_by_email: input.submitted_by_email || user.email,
    submitted_by_name: input.submitted_by_name || user.full_name || user.email,
    sync_status: 'pending',
  }
  const committed = await mutationResponse(request, env, {
    mutation_id: baseMutationId,
    entity: 'CloseUp',
    entity_id: id,
    outlet_id: outletId,
    operation: existing?.__realtime ? 'update' : 'upsert',
    expected_version: existing?.__realtime?.version,
    payload,
  })
  const syncPatch = await syncCloseUpToSalesTemplate(env, committed.record)
  const synced = await mutationResponse(request, env, {
    mutation_id: `${baseMutationId}:sales-sync`.slice(0, 160),
    entity: 'CloseUp',
    entity_id: id,
    outlet_id: outletId,
    operation: 'update',
    expected_version: committed.version,
    payload: { ...committed.record, ...syncPatch },
  })
  scheduleAudit(env, user, existing ? 'upsert_update' : 'upsert_create', 'CloseUp', id, {
    outlet_id: outletId,
    business_date: businessDate,
    shift_id: shiftId,
    handover_sequence: synced.record.handover_sequence || 0,
    sync_status: synced.record.sync_status,
    storage: 'd1',
  })
  return json(request, env, synced.record, existing ? 200 : 201)
}

export async function handleRealtimeWorkflowApi(request, env, url) {
  if (!WORKFLOW_PATHS.has(url.pathname)) return null
  try {
    return await handleOperationalTaskAction(request, env, url)
      || await handleStockCountBatch(request, env, url)
      || await handleCloseUpUpsert(request, env, url)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
