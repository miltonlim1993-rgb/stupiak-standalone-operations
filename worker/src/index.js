import { loginWithGoogle, getCurrentUser, sessionCookie, expiredSessionCookie, rememberUser, validateActualName, userWithProfileSetup, confirmedActualName } from './auth.js'
import { json, errorResponse, corsHeaders, readJson } from './http.js'
import { appendRecord, appendRecords,
  updateRecordFlexible, ensureEntitySheet, findRecord, listRecords, saveStockCountBatch, updateManyRecords, updateRecord } from './sheets.js'
import { assertCreatePermission, assertDeletePermission, assertReadPermission, assertUpdatePermission, scopeFilter, assignedOutletIds, assertOutletAccess, assertAssignedOutletAccess } from './permissions.js'
import { getSchema } from './schema.js'
import { downloadDriveFile, uploadDriveFile } from './drive.js'
import { configuredOperationYears } from './storage.js'
import { applySourceTraceability, buildAutomaticLabelInput, finishSourceBatchPatch, getLabelCatalog, sourceConsumptionPatch } from './labels.js'
import { OPERATIONAL_TEMPLATE_SEEDS } from './operational-defaults.js'
import { applyOpeningChecklistFeedback } from './opening-checklist-feedback.js'
import { getAppPackModule, getOrBuildAppPack, getPublishedAppPack, markAppPackDirty, POSITION_MASTER_SEEDS, rebuildAllAppPacks } from './app-pack.js'
import { syncCloseUpToSalesTemplate } from './closeup-sync.js'
import { MEDIA_RULE_SEEDS, ensureMediaRules, getMediaRule, mediaKind, allowedMediaKinds } from './media-rules.js'

function now() {
  return new Date().toISOString()
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

function newRecord(entity, input, user) {
  const schema = getSchema(entity)
  const timestamp = now()
  const record = Object.fromEntries(schema.headers.map((field) => [field, '']))
  Object.assign(record, input)

  const idField = schema.idField || 'id'
  record[idField] = input[idField] || input.id || crypto.randomUUID()

  if (schema.headers.includes('outlet_id')) {
    record.outlet_id = resolveOutletId(user, input.outlet_id)
  }
  if (schema.headers.includes('created_date')) record.created_date = timestamp
  if (schema.headers.includes('created_by')) record.created_by = user.email
  if (schema.headers.includes('updated_date')) record.updated_date = timestamp
  if (schema.headers.includes('updated_by')) record.updated_by = user.email
  if (schema.headers.includes('deleted_at')) record.deleted_at = ''
  if (schema.headers.includes('version')) record.version = Number(input.version || 1)
  if (schema.headers.includes('created_at') && !record.created_at) record.created_at = timestamp
  if (schema.headers.includes('updated_at')) record.updated_at = timestamp
  if (schema.headers.includes('assigned_at') && !record.assigned_at) record.assigned_at = timestamp
  if (schema.headers.includes('acknowledged_at') && !record.acknowledged_at) record.acknowledged_at = timestamp
  if (schema.headers.includes('uploaded_at') && !record.uploaded_at) record.uploaded_at = timestamp
  if (schema.headers.includes('started_at') && !record.started_at) record.started_at = timestamp
  if (schema.headers.includes('submitted_at') && !record.submitted_at) record.submitted_at = timestamp

  if (schema.headers.includes('user_email') && !record.user_email) record.user_email = user.email
  if (schema.headers.includes('user_name') && !record.user_name) record.user_name = user.full_name || user.email
  if (schema.headers.includes('uploaded_by_email') && !record.uploaded_by_email) record.uploaded_by_email = user.email
  if (schema.headers.includes('uploaded_by_name') && !record.uploaded_by_name) record.uploaded_by_name = user.full_name || user.email
  if (schema.headers.includes('assigned_by_email') && !record.assigned_by_email) record.assigned_by_email = user.email
  if (schema.headers.includes('assigned_by_name') && !record.assigned_by_name) record.assigned_by_name = user.full_name || user.email

  if (['TrainingProgress', 'TrainingAcknowledgement', 'TrainingAttempt'].includes(entity) && ['staff', 'leader'].includes(user.role)) {
    record.user_email = user.email
    record.user_name = user.full_name || user.email
  }
  if (entity === 'TrainingAssignment') {
    record.assigned_by_email = user.email
    record.assigned_by_name = user.full_name || user.email
  }
  if (entity === 'TaskPhoto') {
    record.uploaded_by_email = user.email
    record.uploaded_by_name = user.full_name || user.email
  }
  if (entity === 'Task') record.created_by_name = user.full_name || user.email

  return record
}

async function audit(env, user, action, entity, entityId, payload = {}) {
  if (entity === 'AuditLog') return
  const timestamp = now()
  await appendRecord(env, 'AuditLog', {
    id: crypto.randomUUID(), outlet_id: typeof payload?.outlet_id === 'string' ? payload.outlet_id : (user.outlet_id || ''), created_date: timestamp,
    created_by: user.email, updated_date: timestamp, updated_by: user.email,
    deleted_at: '', version: 1, actor_sub: user.google_sub, actor_email: user.email,
    action, entity, entity_id: entityId, summary: `${action} ${entity}`,
    payload_json: JSON.stringify(payload), actor_name: user.full_name || user.email,
  })
}


const APP_PACK_ENTITIES = new Set([
  'Outlet', 'InventoryCatalog', 'OutletStockList', 'TaskTemplate',
  'TaskTemplatePhoto', 'PaymentMethod', 'PositionMaster', 'AppSetting', 'MediaRule',
  'SOP', 'SOPStep', 'SOPAsset', 'TrainingCourse', 'TrainingLesson',
  'TrainingQuiz', 'TrainingQuestion',
])

async function updateCloseUpSyncState(env, record, { year } = {}) {
  const syncPatch = await syncCloseUpToSalesTemplate(env, record)
  const updated = await updateRecord(env, 'CloseUp', record.id, {
    ...syncPatch,
    updated_date: now(),
    updated_by: 'sales-template-sync@chefops',
    version: Number(record.version || 0) + 1,
  }, { year })
  return updated
}

async function retryPendingCloseUpSyncs(env, limit = 20) {
  let remaining = Math.max(1, Number(limit || 20))
  const results = []
  for (const year of configuredOperationYears(env).sort((a, b) => b - a)) {
    if (remaining <= 0) break
    let rows = []
    try {
      rows = await listRecords(env, 'CloseUp', {
        filter: { sync_status: 'pending_retry' },
        sort: 'last_sync_at,submitted_at',
        limit: remaining,
        year,
      })
    } catch (error) {
      console.error('Unable to list pending Close Up syncs', year, error)
      continue
    }
    for (const row of rows) {
      if (remaining <= 0) break
      try {
        results.push(await updateCloseUpSyncState(env, row, { year }))
      } catch (error) {
        console.error('Close Up retry failed', row.id, error)
      }
      remaining -= 1
    }
  }
  return results
}

async function handleCloseUpSync(request, env, url) {
  const match = url.pathname.match(/^\/api\/close-up\/([^/]+)\/sync$/)
  if (!match || request.method !== 'POST') return null
  const user = await getCurrentUser(request, env)
  const year = url.searchParams.get('year') || undefined
  const existing = await findRecord(env, 'CloseUp', decodeURIComponent(match[1]), { year })
  if (existing.record.outlet_id) assertOutletAccess(user, existing.record.outlet_id)
  const updated = await updateCloseUpSyncState(env, existing.record, { year })
  await audit(env, user, 'sync_sales_template', 'CloseUp', updated.id, {
    outlet_id: updated.outlet_id,
    sync_status: updated.sync_status,
    last_sync_error: updated.last_sync_error,
  })
  return json(request, env, updated)
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

  input.outlet_id = outletId
  input.shift_name = input.shift_name || (shiftId === 'morning'
    ? 'Morning / Opening'
    : shiftId === 'handover'
      ? 'Cash Handover'
      : 'Night / Closing')
  const isHandover = shiftId === 'handover'
  const year = url.searchParams.get('year') || businessDate.slice(0, 4) || undefined
  await ensureEntitySheet(env, 'CloseUp', { year })

  const datedRows = await listRecords(env, 'CloseUp', {
    filter: scopeFilter(user, 'CloseUp', {
      outlet_id: outletId,
      business_date: businessDate,
    }),
    sort: '-submitted_at,-updated_date',
    limit: 500,
    year,
  })

  const generatedEventKey = isHandover
    ? `handover-${crypto.randomUUID()}`
    : `${outletId}|${businessDate}|${shiftId}`
  input.event_key = String(input.event_key || generatedEventKey).trim()

  let existing = null
  if (requestedRecordId) {
    const found = await findRecord(env, 'CloseUp', requestedRecordId, { year })
    existing = found.record
    if (
      String(existing.outlet_id || '') !== outletId
      || String(existing.business_date || '') !== businessDate
      || String(existing.shift_id || '') !== shiftId
    ) {
      const error = new Error('The selected Close Up record does not match this outlet, date or phase')
      error.status = 409
      error.code = 'close_up_record_mismatch'
      throw error
    }
  } else if (input.event_key) {
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
    if (existing) {
      input.handover_sequence = Number(existing.handover_sequence || 0) || 1
    } else {
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

  const timestamp = now()
  let record
  if (existing) {
    assertUpdatePermission(user, 'CloseUp', existing, input)
    record = await updateRecord(env, 'CloseUp', existing.id, {
      ...input,
      submitted_at: timestamp,
      updated_date: timestamp,
      updated_by: user.email,
      version: Number(existing.version || 0) + 1,
    }, { year })
    await audit(env, user, 'upsert_update', 'CloseUp', record.id, {
      outlet_id: outletId,
      business_date: businessDate,
      shift_id: shiftId,
      handover_sequence: record.handover_sequence || 0,
    })
  } else {
    assertCreatePermission(user, 'CloseUp')
    input.submitted_at = timestamp
    record = newRecord('CloseUp', input, user)
    await appendRecord(env, 'CloseUp', record, { year })
    await audit(env, user, 'upsert_create', 'CloseUp', record.id, {
      outlet_id: outletId,
      business_date: businessDate,
      shift_id: shiftId,
      handover_sequence: record.handover_sequence || 0,
    })
  }

  const synced = await updateCloseUpSyncState(env, record, { year })
  return json(request, env, synced, existing ? 200 : 201)
}

async function handleAuth(request, env, path) {
  if (!path.startsWith('/api/auth/')) return null
  await ensureEntitySheet(env, 'User')

  if (path === '/api/auth/google' && request.method === 'POST') {
    const { credential } = await readJson(request)
    const { user, token } = await loginWithGoogle(credential, env)
    return json(request, env, { user }, 200, { 'Set-Cookie': sessionCookie(token, request) })
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    return json(request, env, { ok: true }, 200, { 'Set-Cookie': expiredSessionCookie(request) })
  }
  if (path === '/api/auth/me' && request.method === 'GET') {
    const user = await getCurrentUser(request, env)
    return json(request, env, userWithProfileSetup(user))
  }
  if (path === '/api/auth/me' && request.method === 'PATCH') {
    const user = await getCurrentUser(request, env)
    const body = await readJson(request)
    const allowed = ['full_name', 'phone', 'department']
    const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)))
    const timestamp = now()

    if (Object.prototype.hasOwnProperty.call(patch, 'full_name')) {
      const actualName = validateActualName(patch.full_name, user.email)
      if (!actualName) {
        const error = new Error('Enter your actual name. Email addresses and generic account names are not accepted.')
        error.status = 400
        error.code = 'invalid_actual_name'
        throw error
      }
      patch.full_name = actualName
      patch.name_confirmed = true
      patch.name_confirmed_at = timestamp
      patch.name_updated_at = timestamp
    }

    patch.updated_date = timestamp
    patch.updated_by = user.email
    patch.version = Number(user.version || 0) + 1
    const updated = await updateRecord(env, 'User', user.id, patch)
    rememberUser(updated)
    await audit(env, user, 'update_profile', 'User', user.id, {
      fields: Object.keys(patch).filter((key) => !['updated_date', 'updated_by', 'version'].includes(key)),
      name_confirmed: Boolean(patch.name_confirmed),
    })
    return json(request, env, userWithProfileSetup(updated))
  }
  return null
}


function csvValues(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
}

function truthyValue(value) {
  return value === true || String(value).toLowerCase() === 'true'
}

function templateVisibleForOutlet(template, outletId) {
  if (!truthyValue(template.is_active)) return false
  const outletIds = csvValues(template.outlet_ids)
  return !outletIds.length
    || outletIds.includes(String(outletId || ''))
    || String(template.outlet_id || '') === String(outletId || '')
}

function recurrenceParts(rule) {
  return Object.fromEntries(
    String(rule || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        return index >= 0
          ? [part.slice(0, index).toUpperCase(), part.slice(index + 1).toUpperCase()]
          : ['FREQ', part.toUpperCase()]
      }),
  )
}

function templateAppliesOnDate(template, dateText) {
  const parts = recurrenceParts(template.recurrence_rule)
  const frequency = parts.FREQ || ''
  if (!frequency) return false
  if (frequency === 'DAILY') return true

  const date = new Date(`${dateText}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return false

  if (frequency === 'WEEKLY') {
    const dayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
    const allowed = csvValues(parts.BYDAY)
    return allowed.length ? allowed.includes(dayCodes[date.getUTCDay()]) : date.getUTCDay() === 1
  }

  if (frequency === 'MONTHLY') {
    const day = date.getUTCDate()
    const allowedDays = csvValues(parts.BYMONTHDAY).map(Number).filter(Number.isFinite)
    return allowedDays.length ? allowedDays.includes(day) : day === 1
  }

  return false
}

function taskIdForTemplate(outletId, dateText, templateId) {
  const safe = String(templateId || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `task-${dateText}-${String(outletId || '').replace(/[^a-zA-Z0-9_-]+/g, '-')}-${safe}`
}

function taskRecordFromTemplate(template, outletId, dateText) {
  const schema = getSchema('Task')
  const timestamp = now()
  const record = Object.fromEntries(schema.headers.map((field) => [field, '']))
  Object.assign(record, {
    id: taskIdForTemplate(outletId, dateText, template.id),
    outlet_id: outletId,
    created_date: timestamp,
    created_by: 'system@stupiaks-ops',
    updated_date: timestamp,
    updated_by: 'system@stupiaks-ops',
    deleted_at: '',
    version: 1,
    title: template.title || template.name || 'Operational task',
    description: template.description || template.instructions || '',
    category: template.category || 'general',
    priority: template.priority || 'medium',
    status: 'pending',
    assigned_to_role: template.assigned_to_role || 'staff',
    assigned_to_user_id: template.assigned_to_user_id || '',
    assigned_to_name: '',
    due_date: dateText,
    due_time: template.due_time || '',
    marks: Number(template.marks || 0),
    penalty: Number(template.penalty || 0),
    is_followup: false,
    parent_task_id: '',
    completed_date: '',
    completed_by_name: '',
    notes: '',
    template_id: template.id || '',
    recurrence_rule: template.recurrence_rule || '',
    photo_required: truthyValue(template.photo_required),
    completed_by_email: '',
    created_by_name: 'System',
    station: template.station || '',
    period: template.period || '',
    sop_id: template.sop_id || '',
    template_version: Number(template.version || 1),
  })
  return record
}

async function ensureTasksForDate(env, user, outletId, dateText) {
  const [templates, existing] = await Promise.all([
    listRecords(env, 'TaskTemplate', { sort: 'display_order,title', limit: 1000 }),
    listRecords(env, 'Task', { filter: { outlet_id: outletId, due_date: dateText }, sort: 'category,due_time,priority', limit: 500 }),
  ])

  const existingTemplateIds = new Set(existing.map((row) => String(row.template_id || '')).filter(Boolean))
  const existingIds = new Set(existing.map((row) => String(row.id || '')).filter(Boolean))
  const eligible = templates.filter((template) => (
    templateVisibleForOutlet(template, outletId)
    && templateAppliesOnDate(template, dateText)
  ))

  let created = 0
  for (const template of eligible) {
    const record = taskRecordFromTemplate(template, outletId, dateText)
    if (existingTemplateIds.has(String(template.id || '')) || existingIds.has(record.id)) continue
    await appendRecord(env, 'Task', record, { year: Number(dateText.slice(0, 4)) })
    existingTemplateIds.add(String(template.id || ''))
    existingIds.add(record.id)
    created += 1
  }

  if (created) {
    await audit(env, user, 'generate_recurring_tasks', 'Task', dateText, {
      outlet_id: outletId,
      date: dateText,
      created,
    })
  }

  return { ok: true, outlet_id: outletId, date: dateText, created, total: existing.length + created }
}

async function handleTaskAutomation(request, env, url) {
  if (url.pathname !== '/api/tasks/ensure' || request.method !== 'POST') return null
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

  const result = await ensureTasksForDate(env, user, outletId, dateText)
  return json(request, env, result)
}


const OPERATIONAL_CHECKLIST_PREFIX = 'CHEFOPS_CHECKLIST_V1:'
let operationalTemplateCache = { expiresAt: 0, rows: [] }

function parseOperationalChecklist(template) {
  const raw = String(template?.instructions || '')
  if (!raw.startsWith(OPERATIONAL_CHECKLIST_PREFIX)) return null
  try {
    const config = JSON.parse(raw.slice(OPERATIONAL_CHECKLIST_PREFIX.length))
    return config?.kind === 'operational_checklist' ? applyOpeningChecklistFeedback(template, config) : null
  } catch {
    return null
  }
}

async function seedOperationalTemplates(env, rows) {
  const existingById = new Map((rows || []).map((row) => [String(row.id || ''), row]))
  const deprecatedIds = new Set([
    'tmpl-rr-opening-prep',
    'tmpl-rr-toilet-am',
    'tmpl-rr-safety-stock-am',
    'tmpl-rr-toilet-pm',
    'tmpl-rr-hygiene-equipment-pm',
    'tmpl-rr-opening-checklist',
    'tmpl-rr-toilet-checklist',
    'tmpl-rr-daily-standards',
  ])
  for (const row of rows || []) {
    if (!deprecatedIds.has(String(row.id || ''))) continue
    await updateRecord(env, 'TaskTemplate', row.id, {
      is_active: false,
      status: 'legacy',
      updated_date: now(),
      updated_by: 'system@stupiaks-ops',
      version: Number(row.version || 0) + 1,
    })
  }
  const systemUser = {
    role: 'owner',
    email: 'system@stupiaks-ops',
    full_name: 'System',
    outlet_id: 'RR-KCH',
    outlet_ids: 'RR-KCH',
  }
  for (const seed of OPERATIONAL_TEMPLATE_SEEDS) {
    const existing = existingById.get(String(seed.id))
    if (existing) {
      const patch = cleanPatch('TaskTemplate', seed)
      patch.updated_date = now()
      patch.updated_by = 'system@stupiaks-ops'
      patch.version = Number(existing.version || 0) + 1
      await updateRecord(env, 'TaskTemplate', seed.id, patch)
    } else {
      await appendRecord(env, 'TaskTemplate', newRecord('TaskTemplate', seed, systemUser))
    }
  }
}

async function loadOperationalTemplates(env, outletId, force = false) {
  const current = Date.now()
  if (force || current >= operationalTemplateCache.expiresAt) {
    const manifest = await getOrBuildAppPack(env, outletId, { force })
    const taskModule = await getAppPackModule(env, outletId, 'tasks', manifest.modules?.tasks?.hash)
    let rows = Array.isArray(taskModule?.data?.task_templates) ? taskModule.data.task_templates : []
    let parsed = rows.map((template) => ({ template, config: parseOperationalChecklist(template) })).filter((entry) => entry.config)
    if (!parsed.length) {
      // Seed only when Master has no operational checklist yet, then rebuild the shared pack once.
      const masterRows = await listRecords(env, 'TaskTemplate', { sort: 'display_order,title', limit: 1000 })
      await seedOperationalTemplates(env, masterRows)
      await markAppPackDirty(env, outletId)
      const rebuilt = await getOrBuildAppPack(env, outletId, { force: true })
      const rebuiltModule = await getAppPackModule(env, outletId, 'tasks', rebuilt.modules?.tasks?.hash)
      rows = Array.isArray(rebuiltModule?.data?.task_templates) ? rebuiltModule.data.task_templates : []
      parsed = rows.map((template) => ({ template, config: parseOperationalChecklist(template) })).filter((entry) => entry.config)
    }
    operationalTemplateCache = {
      expiresAt: current + 120000,
      rows: parsed,
    }
  }
  return operationalTemplateCache.rows.filter(({ template }) => templateVisibleForOutlet(template, outletId))
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
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
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
  return taskPhotos.filter((row) => String(row.photo_type || '') === `checklist:${groupId}` && !row.deleted_at && String(row.status || 'active').toLowerCase() !== 'deleted').length
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
    required_photo_count: photoRequirements.filter((group) => group.required).reduce((sum, group) => sum + Number(group.min_photos || 1), 0),
    submitted_photo_count: photoRequirements.filter((group) => group.required).reduce((sum, group) => sum + Math.min(group.uploaded_count, Number(group.min_photos || 1)), 0),
    photo_requirements: photoRequirements,
    icon_key: config.icon_key || '',
    shift_id: config.schedule?.shift_id || '',
    template_title: template.title || template.name || '',
  }
}

function operationalTaskRecord(template, config, outletId, dateText) {
  const record = taskRecordFromTemplate(template, outletId, dateText)
  const state = { schema: 'operational-checklist-v1', responses: {}, started_at: '', completion_notes: '' }
  record.notes = operationalStateText(state)
  record.due_time = config.schedule?.due_time || template.due_time || ''
  record.period = config.schedule?.shift_id || template.period || ''
  record.marks = 0
  record.penalty = 0
  record.sop_id = ''
  return record
}

async function ensureOperationalTasks(env, user, outletId, dateText, entries) {
  const year = Number(dateText.slice(0, 4))
  const existing = await listRecords(env, 'Task', {
    filter: { outlet_id: outletId, due_date: dateText },
    sort: 'due_time,title',
    limit: 500,
    year,
  })
  const byTemplate = new Map(existing.filter((row) => !row.deleted_at).map((row) => [String(row.template_id || ''), row]))
  const records = []
  let created = 0

  for (const { template, config } of entries) {
    let task = byTemplate.get(String(template.id || ''))
    if (!task) {
      task = operationalTaskRecord(template, config, outletId, dateText)
      await appendRecord(env, 'Task', task, { year })
      created += 1
    } else if (parseOperationalState(task).schema !== 'operational-checklist-v1' || !String(task.notes || '').includes('operational-checklist-v1')) {
      const state = parseOperationalState(task)
      task = await updateRecord(env, 'Task', task.id, {
        title: template.title || template.name || task.title,
        description: template.description || task.description,
        category: template.category || task.category,
        priority: template.priority || task.priority,
        assigned_to_role: template.assigned_to_role || task.assigned_to_role,
        due_time: config.schedule?.due_time || task.due_time,
        station: template.station || task.station,
        period: config.schedule?.shift_id || task.period,
        notes: operationalStateText(state),
        marks: 0,
        penalty: 0,
        sop_id: '',
        updated_date: now(),
        updated_by: 'system@stupiaks-ops',
        version: Number(task.version || 0) + 1,
      }, { year })
    }
    records.push(task)
  }

  if (created) await audit(env, user, 'generate_operational_checklists', 'Task', dateText, { outlet_id: outletId, date: dateText, created })
  return records
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
    if (result === 'fail' && item.corrective_action_on_fail && !String(response?.corrective_action || '').trim()) missingActions.push(item.name)
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

async function handleOperationalTasks(request, env, url) {
  if (!url.pathname.startsWith('/api/tasks/operational/')) return null
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

  if (url.pathname === '/api/tasks/operational/bootstrap' && request.method === 'POST') {
    const entries = await loadOperationalTemplates(env, outletId, Boolean(body.refresh))
    if (!entries.length) {
      const error = new Error('No operational checklist configuration found in Master Sheet TaskTemplates')
      error.status = 500
      error.code = 'missing_operational_config'
      throw error
    }
    const tasks = await ensureOperationalTasks(env, user, outletId, dateText, entries)
    const year = Number(dateText.slice(0, 4))
    await ensureEntitySheet(env, 'TaskPhoto', { year })
    const templateIds = new Set(entries.map(({ template }) => String(template.id)))
    const [taskPhotos, templatePhotos] = await Promise.all([
      listRecords(env, 'TaskPhoto', { filter: { outlet_id: outletId }, sort: 'task_id,display_order', limit: 3000, year }),
      listRecords(env, 'TaskTemplatePhoto', { sort: 'template_id,display_order', limit: 3000 }),
    ])
    const byTemplate = new Map(entries.map((entry) => [String(entry.template.id), entry]))
    const current = new Date()
    return json(request, env, {
      tasks: tasks
        .filter((task) => templateIds.has(String(task.template_id || '')))
        .map((task) => {
          const entry = byTemplate.get(String(task.template_id))
          return operationalAssembleTask(task, entry.template, entry.config, taskPhotos.filter((row) => String(row.task_id) === String(task.id)), current)
        }),
      task_photos: taskPhotos.filter((row) => tasks.some((task) => String(task.id) === String(row.task_id))),
      template_photos: templatePhotos.filter((row) => templateIds.has(String(row.template_id || ''))),
      source_control: 'MASTER_SHEET_TASKTEMPLATES',
      server_time: current.toISOString(),
    })
  }

  if (url.pathname === '/api/tasks/operational/action' && request.method === 'POST') {
    const taskId = String(body.task_id || '').trim()
    const action = String(body.action || '').toLowerCase()
    const year = Number(dateText.slice(0, 4))
    const found = await findRecord(env, 'Task', taskId, { year })
    const task = found.record
    assertAssignedOutletAccess(user, task.outlet_id)
    const entries = await loadOperationalTemplates(env, task.outlet_id, false)
    const entry = entries.find(({ template }) => String(template.id) === String(task.template_id))
    if (!entry) {
      const error = new Error('This task is not linked to an active operational checklist')
      error.status = 400
      error.code = 'invalid_operational_task'
      throw error
    }
    const timing = operationalTiming(entry.config, task.due_date)
    const access = operationalAccessState(task, timing, new Date())
    if (['NOT_OPEN', 'LOCKED'].includes(access)) {
      const error = new Error(access === 'NOT_OPEN' ? 'This checklist is not open yet' : 'This checklist is locked')
      error.status = 409
      error.code = access === 'NOT_OPEN' ? 'task_not_open' : 'task_locked'
      throw error
    }

    const taskPhotos = await listRecords(env, 'TaskPhoto', {
      filter: { outlet_id: task.outlet_id, task_id: task.id },
      sort: 'display_order',
      limit: 1000,
      year,
    })
    const state = parseOperationalState(task)
    if (Array.isArray(body.responses)) state.responses = operationalNormalizeResponses(entry.config, body.responses)
    if (body.completion_notes !== undefined) state.completion_notes = String(body.completion_notes || '').slice(0, 3000)
    const patch = {
      notes: operationalStateText(state),
      updated_date: now(),
      updated_by: user.email,
      version: Number(task.version || 0) + 1,
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
      operationalValidateCompletion(entry.config, state, taskPhotos, task.due_date)
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

    const updated = await updateRecord(env, 'Task', task.id, patch, { year })
    await audit(env, user, `operational_${action}`, 'Task', task.id, { outlet_id: task.outlet_id, date: task.due_date })
    return json(request, env, {
      task: operationalAssembleTask(updated, entry.template, entry.config, taskPhotos, new Date()),
      server_time: now(),
    })
  }

  return null
}



const NOTIFICATION_PAGES = new Set(['/', '/tasks', '/stock', '/urgent', '/inventory', '/attendance', '/labels', '/receipts', '/close-up', '/notifications', '/install'])

function requireNotificationManager(user) {
  if (['manager', 'owner'].includes(String(user?.role || ''))) return
  const error = new Error('Manager access required to push notifications')
  error.status = 403
  error.code = 'forbidden'
  throw error
}

function normalizeNotificationPage(value) {
  const target = String(value || '/').trim() || '/'
  return NOTIFICATION_PAGES.has(target) ? target : '/'
}

async function handleNotifications(request, env, url) {
  if (!url.pathname.startsWith('/api/notifications')) return null
  const user = await getCurrentUser(request, env)

  if (url.pathname === '/api/notifications' && request.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200)
    const targetPage = String(url.searchParams.get('target_page') || '').trim()
    const unreadOnly = url.searchParams.get('unread') === '1'
    const rows = await listRecords(env, 'Notification', {
      filter: { recipient_user_id: user.id },
      sort: '-created_date',
      limit: Math.max(limit * 3, 50),
    })
    const current = Date.now()
    const result = (rows || []).filter((row) => {
      if (row.deleted_at) return false
      if (unreadOnly && String(row.status || 'unread') !== 'unread') return false
      if (targetPage && String(row.target_page || '/') !== targetPage) return false
      if (row.expires_at) {
        const expires = Date.parse(row.expires_at)
        if (Number.isFinite(expires) && expires < current) return false
      }
      return true
    }).slice(0, limit)
    return json(request, env, result)
  }

  if (url.pathname === '/api/notifications/push' && request.method === 'POST') {
    requireNotificationManager(user)
    const body = await readJson(request)
    const requestedIds = [...new Set((Array.isArray(body.recipient_user_ids) ? body.recipient_user_ids : [])
      .map((value) => String(value || '').trim()).filter(Boolean))]
    if (!requestedIds.length) {
      const error = new Error('Select at least one recipient user ID')
      error.status = 400
      error.code = 'missing_recipients'
      throw error
    }
    const title = String(body.title || '').trim()
    const message = String(body.message || '').trim()
    if (!title || !message) {
      const error = new Error('Notification title and message are required')
      error.status = 400
      error.code = 'missing_notification_content'
      throw error
    }

    const allUsers = await listRecords(env, 'User', { filter: {}, sort: 'full_name', limit: 2000 })
    const recipients = (allUsers || []).filter((row) => requestedIds.includes(String(row.id || '')))
    if (!recipients.length) {
      const error = new Error('No matching recipient user IDs were found')
      error.status = 404
      error.code = 'recipients_not_found'
      throw error
    }

    const timestamp = now()
    const targetPage = normalizeNotificationPage(body.target_page)
    let created = 0
    for (const recipient of recipients) {
      const record = newRecord('Notification', {
        outlet_id: recipient.outlet_id || '',
        recipient_user_id: recipient.id,
        recipient_email: recipient.email || '',
        recipient_name: recipient.full_name || recipient.email || '',
        title,
        message,
        target_page: targetPage,
        entity_type: String(body.entity_type || ''),
        entity_id: String(body.entity_id || ''),
        status: 'unread',
        read_at: '',
        pushed_by_name: user.full_name || user.email,
        pushed_by_email: user.email,
        expires_at: String(body.expires_at || ''),
        priority: String(body.priority || 'normal'),
        action_label: String(body.action_label || 'Open'),
        metadata_json: JSON.stringify(body.metadata || {}),
      }, user)
      record.created_date = timestamp
      record.updated_date = timestamp
      await appendRecord(env, 'Notification', record)
      created += 1
    }
    await audit(env, user, 'push_notifications', 'Notification', '*', {
      recipient_user_ids: recipients.map((row) => row.id),
      title,
      target_page: targetPage,
      created,
    })
    return json(request, env, { ok: true, created }, 201)
  }

  const readMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/)
  if (readMatch && request.method === 'PATCH') {
    const id = decodeURIComponent(readMatch[1])
    const existing = await findRecord(env, 'Notification', id)
    if (String(existing.record.recipient_user_id || '') !== String(user.id || '')) {
      const error = new Error('This notification does not belong to your user ID')
      error.status = 403
      error.code = 'forbidden'
      throw error
    }
    const updated = await updateRecord(env, 'Notification', id, {
      status: 'read',
      read_at: now(),
      updated_date: now(),
      updated_by: user.email,
      version: Number(existing.record.version || 0) + 1,
    })
    return json(request, env, updated)
  }

  return null
}

async function handleUserAccess(request, env, url) {
  const match = url.pathname.match(/^\/api\/users\/([^/]+)\/access$/)
  if (!match || request.method !== 'POST') return null
  const actor = await getCurrentUser(request, env)
  if (!actor) {
    const error = new Error('Authentication required')
    error.status = 401
    error.code = 'unauthorized'
    throw error
  }
  if (!['manager', 'owner'].includes(String(actor.role || ''))) {
    const error = new Error('Manager access required')
    error.status = 403
    error.code = 'forbidden'
    throw error
  }

  const userId = decodeURIComponent(match[1])
  const body = await readJson(request)
  const role = String(body.role || 'staff').trim().toLowerCase()
  const status = String(body.status || 'pending').trim().toLowerCase()
  const allowedRoles = new Set(['staff', 'leader', 'supervisor', 'manager', 'owner'])
  const allowedStatuses = new Set(['pending', 'active', 'suspended', 'rejected'])
  if (!allowedRoles.has(role) || !allowedStatuses.has(status)) {
    const error = new Error('Invalid role or account status')
    error.status = 400
    error.code = 'invalid_access_values'
    throw error
  }
  if (role === 'owner' && actor.role !== 'owner') {
    const error = new Error('Only an owner can grant the owner role')
    error.status = 403
    error.code = 'forbidden'
    throw error
  }

  const ids = [...new Set((Array.isArray(body.assigned_outlet_ids) ? body.assigned_outlet_ids : [])
    .map((value) => String(value || '').trim()).filter(Boolean))]
  const primary = String(body.primary_outlet_id || '').trim()
  if (!primary || !ids.length || !ids.includes(primary)) {
    const error = new Error('Select at least one assigned outlet and choose one of them as the primary outlet')
    error.status = 400
    error.code = 'invalid_outlet_assignment'
    throw error
  }

  const outlets = await listRecords(env, 'Outlet', { filter: {}, sort: 'name', limit: 1000 })
  const valid = new Set((outlets || []).map((row) => String(row.id || '')).filter(Boolean))
  const unknown = ids.filter((id) => !valid.has(id))
  if (unknown.length) {
    const error = new Error(`Unknown outlet assignment: ${unknown.join(', ')}`)
    error.status = 400
    error.code = 'unknown_outlet'
    throw error
  }

  const existing = await findRecord(env, 'User', userId)
  assertUpdatePermission(actor, 'User', existing.record, { role, status, outlet_id: primary, outlet_ids: JSON.stringify(ids) })
  const patch = {
    role,
    status,
    outlet_id: primary,
    outlet_ids: JSON.stringify(ids),
    updated_date: now(),
    updated_by: actor.email,
    version: Number(existing.record.version || 0) + 1,
  }
  await updateRecordFlexible(env, 'User', userId, patch, { requiredFields: ['outlet_id', 'outlet_ids'] })
  const verified = await findRecord(env, 'User', userId)
  const savedIds = assignedOutletIds(verified.record)
  if (String(verified.record.outlet_id || '') !== primary || ids.some((id) => !savedIds.includes(id))) {
    const error = new Error('User access could not be verified after saving. No silent rollback was accepted.')
    error.status = 409
    error.code = 'access_write_not_verified'
    throw error
  }
  await audit(env, actor, 'update_access', 'User', userId, {
    role, status, primary_outlet_id: primary, assigned_outlet_ids: ids,
  })
  return json(request, env, { ok: true, user: verified.record })
}

function rosterHours(clockIn, clockOut) {
  const minutes = (value) => {
    const [hour, minute] = String(value || '').split(':').map(Number)
    return (Number(hour) || 0) * 60 + (Number(minute) || 0)
  }
  const start = minutes(clockIn)
  let end = minutes(clockOut)
  if (end <= start) end += 24 * 60
  return Math.round(((end - start) / 60) * 100) / 100
}

async function handleAttendanceImport(request, env, url) {
  if (url.pathname !== '/api/attendance/import' || request.method !== 'POST') return null
  const actor = await getCurrentUser(request, env)
  if (!actor) {
    const error = new Error('Authentication required')
    error.status = 401
    error.code = 'unauthorized'
    throw error
  }
  if (!['manager', 'owner'].includes(String(actor.role || ''))) {
    const error = new Error('Manager access required to import a duty roster')
    error.status = 403
    error.code = 'forbidden'
    throw error
  }
  const body = await readJson(request)
  const outletId = String(body.outlet_id || '').trim()
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (!outletId || !rows.length || rows.length > 500) {
    const error = new Error('Choose an outlet and provide between 1 and 500 roster rows')
    error.status = 400
    error.code = 'invalid_roster_import'
    throw error
  }
  const outlet = (await listRecords(env, 'Outlet', { filter: { id: outletId }, limit: 2 }))[0]
  if (!outlet) {
    const error = new Error('The selected outlet was not found')
    error.status = 404
    error.code = 'outlet_not_found'
    throw error
  }

  const dates = [...new Set(rows.map((row) => String(row.date || '').slice(0, 10)).filter((date) => /^20\d{2}-\d{2}-\d{2}$/.test(date)))]
  if (!dates.length || dates.length > 14) {
    const error = new Error('The PDF did not contain a valid weekly date range')
    error.status = 400
    error.code = 'invalid_roster_dates'
    throw error
  }

  let replaced = 0
  if (body.replace_existing !== false) {
    for (const date of dates) {
      const result = await updateManyRecords(env, 'Attendance', { outlet_id: outletId, date }, {
        deleted_at: now(), updated_date: now(), updated_by: actor.email,
      }, { year: Number(date.slice(0, 4)) })
      replaced += Number(result.updated || 0)
    }
  }

  const batchId = crypto.randomUUID()
  const source = body.source || {}
  const records = rows.map((row) => {
    const date = String(row.date || '').slice(0, 10)
    const clockIn = String(row.clock_in || '').trim()
    const clockOut = String(row.clock_out || '').trim()
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(clockIn) || !/^\d{1,2}:\d{2}$/.test(clockOut)) {
      const error = new Error(`Invalid roster row for ${row.staff_name || 'unknown staff'}`)
      error.status = 400
      error.code = 'invalid_roster_row'
      throw error
    }
    const notes = [
      String(row.notes || '').trim(),
      `Imported roster batch: ${batchId}.`,
      source.file_url ? `Source PDF: ${source.file_url}` : '',
      source.file_name ? `Source file: ${source.file_name}` : '',
    ].filter(Boolean).join(' ')
    return newRecord('Attendance', {
      outlet_id: outletId,
      staff_name: String(row.staff_name || '').trim(),
      staff_role: String(row.staff_role || 'staff').trim().toLowerCase(),
      date,
      clock_in: clockIn,
      clock_out: clockOut,
      status: 'scheduled',
      hours_worked: Number(row.hours_worked || rosterHours(clockIn, clockOut)),
      notes,
    }, actor)
  })
  await appendRecords(env, 'Attendance', records)
  await audit(env, actor, 'import_roster_pdf', 'Attendance', batchId, {
    outlet_id: outletId, dates, imported: records.length, replaced,
    source_file_name: source.file_name || '', source_drive_file_id: source.drive_file_id || '',
  })
  return json(request, env, { ok: true, batch_id: batchId, imported: records.length, replaced, dates })
}


const ISSUE_MEDIA_META_PREFIX = 'CHEFOPS_ISSUE_META_V1:'

function parseIssueMediaPayload(value) {
  const raw = String(value || '')
  if (!raw.startsWith(ISSUE_MEDIA_META_PREFIX)) return []
  try {
    const parsed = JSON.parse(raw.slice(ISSUE_MEDIA_META_PREFIX.length))
    if (Array.isArray(parsed?.media)) return parsed.media
    if (Array.isArray(parsed?.photos)) return parsed.photos
  } catch {}
  return []
}

function mediaLimitError(message, code = 'invalid_media') {
  const error = new Error(message)
  error.status = 400
  error.code = code
  throw error
}

function validateMediaRows(rows, rule, label) {
  const media = Array.isArray(rows) ? rows : []
  if (media.length > Number(rule.max_files || 1)) {
    mediaLimitError(`${label} allows a maximum of ${rule.max_files} attachment(s)`, 'media_limit_exceeded')
  }
  const allowed = allowedMediaKinds(rule)
  const maxBytes = Number(rule.max_file_mb || 10) * 1024 * 1024
  for (const row of media) {
    const kind = mediaKind(row?.mime_type)
    if (!allowed.has(kind)) {
      mediaLimitError(`${label} does not allow ${kind === 'VIDEO' ? 'video' : kind === 'IMAGE' ? 'photo' : 'this file type'}`, 'media_type_not_allowed')
    }
    if (Number(row?.file_size || 0) > maxBytes) {
      mediaLimitError(`${row?.file_name || 'Attachment'} is larger than ${rule.max_file_mb} MB`, 'media_too_large')
    }
  }
}

async function validateTaskPhotoCreate(env, user, input, year) {
  const taskId = String(input.task_id || '').trim()
  if (!taskId) mediaLimitError('Task photo must be linked to a task', 'missing_task')
  const found = await findRecord(env, 'Task', taskId, { year })
  const task = found.record
  assertAssignedOutletAccess(user, task.outlet_id)
  const entries = await loadOperationalTemplates(env, task.outlet_id, false)
  const entry = entries.find(({ template }) => String(template.id) === String(task.template_id))
  if (!entry) mediaLimitError('This task is not linked to an active checklist', 'invalid_operational_task')
  const groupId = String(input.photo_type || '').replace(/^checklist:/, '')
  const group = (entry.config.photo_groups || []).find((row) => String(row.id) === groupId)
  if (!group) mediaLimitError('This checklist photo group does not exist', 'invalid_photo_group')
  const access = operationalAccessState(task, operationalTiming(entry.config, task.due_date), new Date())
  if (['NOT_OPEN', 'LOCKED', 'DONE'].includes(access)) {
    mediaLimitError(access === 'NOT_OPEN' ? 'This checklist is not open yet' : 'This checklist no longer accepts photos', 'task_photo_locked')
  }

  const rule = await getMediaRule(env, 'task', task.outlet_id)
  const mime = String(input.mime_type || '').toLowerCase()
  if (!mime.startsWith('image/') || !allowedMediaKinds(rule).has('IMAGE')) {
    mediaLimitError('Task evidence must be an on-site photo', 'task_photo_only')
  }
  const maxBytes = Number(rule.max_file_mb || 10) * 1024 * 1024
  if (Number(input.file_size || 0) > maxBytes) {
    mediaLimitError(`${input.file_name || 'Photo'} is larger than ${rule.max_file_mb} MB`, 'media_too_large')
  }
  if (!String(input.captured_at || '').trim()) mediaLimitError('Task photo capture time is required', 'missing_capture_time')
  if (String(rule.watermark_mode || '').toUpperCase() === 'DATE_TIME' && !String(input.watermark_text || '').trim()) {
    mediaLimitError('Task photo date and time watermark is required', 'missing_watermark')
  }

  const existing = await listRecords(env, 'TaskPhoto', {
    filter: { outlet_id: task.outlet_id, task_id: task.id },
    sort: 'display_order',
    limit: 1000,
    year,
  })
  const currentCount = existing.filter((row) => !row.deleted_at && String(row.photo_type || '') === `checklist:${groupId}`).length
  const groupMax = Math.max(1, Number(group.max_photos || rule.max_files || 1))
  const limit = Math.min(groupMax, Number(rule.max_files || groupMax))
  if (currentCount >= limit) mediaLimitError(`${group.name || 'This group'} already has the maximum ${limit} photo(s)`, 'media_limit_exceeded')

  return {
    ...input,
    outlet_id: task.outlet_id,
    task_id: task.id,
    template_id: task.template_id,
    photo_type: `checklist:${groupId}`,
    display_order: currentCount + 1,
    status: 'active',
  }
}

async function validateUrgentIssueMedia(env, outletId, followupNotes) {
  const rule = await getMediaRule(env, 'urgent_issue', outletId)
  validateMediaRows(parseIssueMediaPayload(followupNotes), rule, 'Urgent Issues')
}

async function handleEntities(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'entities' || !parts[2]) return null
  const entity = decodeURIComponent(parts[2])
  getSchema(entity)
  const actionOrId = parts[3]
  const user = await getCurrentUser(request, env)
  assertReadPermission(user, entity)
  if (entity === 'CloseUp') {
    await ensureEntitySheet(env, 'CloseUp', { year: url.searchParams.get('year') || new Date().getUTCFullYear() })
  }
  if (entity === 'PositionMaster') {
    await ensureEntitySheet(env, 'PositionMaster', { seedRecords: POSITION_MASTER_SEEDS })
  }
  if (entity === 'MediaRule') {
    await ensureEntitySheet(env, 'MediaRule', { seedRecords: MEDIA_RULE_SEEDS })
  }
  if (entity === 'TaskPhoto') {
    await ensureEntitySheet(env, 'TaskPhoto', { year: url.searchParams.get('year') || new Date().getUTCFullYear() })
  }

  if (request.method === 'GET' && !actionOrId) {
    const filter = url.searchParams.get('filter') ? JSON.parse(url.searchParams.get('filter')) : {}
    const sort = url.searchParams.get('sort') || ''
    const limit = url.searchParams.get('limit') || 100
    const year = url.searchParams.get('year') || undefined
    const records = await listRecords(env, entity, { filter: scopeFilter(user, entity, filter), sort, limit, year })
    return json(request, env, records)
  }

  if (request.method === 'POST' && !actionOrId) {
    assertCreatePermission(user, entity)
    let input = cleanPatch(entity, await readJson(request))
    const year = url.searchParams.get('year') || undefined
    if (entity === 'TaskPhoto') input = await validateTaskPhotoCreate(env, user, input, year)
    if (entity === 'UrgentIssue') await validateUrgentIssueMedia(env, input.outlet_id || user.outlet_id || '', input.followup_notes)
    if (entity === 'User' && input.role === 'owner' && user.role !== 'owner') {
      const error = new Error('Only an owner can create another owner')
      error.status = 403
      error.code = 'forbidden'
      throw error
    }
    const record = newRecord(entity, input, user)
    if (['StockCount', 'Task', 'TaskPhoto', 'TaskTemplatePhoto', 'TrainingAssignment', 'TrainingProgress', 'TrainingAcknowledgement', 'TrainingAttempt'].includes(entity) && record.outlet_id) {
      assertAssignedOutletAccess(user, record.outlet_id)
    }
    await appendRecord(env, entity, record)
    const recordId = record[getSchema(entity).idField || 'id']
    await audit(env, user, 'create', entity, recordId, { ...input, outlet_id: record.outlet_id || '' })
    if (APP_PACK_ENTITIES.has(entity)) await markAppPackDirty(env, record.outlet_id || input.outlet_id || '')
    if (entity === 'CloseUp') {
      const closeUpYear = url.searchParams.get('year') || String(record.business_date || '').slice(0, 4) || undefined
      const synced = await updateCloseUpSyncState(env, record, { year: closeUpYear })
      return json(request, env, synced, 201)
    }
    return json(request, env, record, 201)
  }

  if (request.method === 'POST' && actionOrId === 'update-many') {
    const body = await readJson(request)
    const patch = cleanPatch(entity, body.update?.$set || body.update || {})
    const filter = scopeFilter(user, entity, body.filter || {})
    assertUpdatePermission(user, entity, { created_by: user.email }, patch)
    const schema = getSchema(entity)
    if (schema.headers.includes('updated_date')) patch.updated_date = now()
    if (schema.headers.includes('updated_by')) patch.updated_by = user.email
    if (schema.headers.includes('updated_at')) patch.updated_at = now()
    const year = url.searchParams.get('year') || undefined
    const result = await updateManyRecords(env, entity, filter, patch, { year })
    await audit(env, user, 'update_many', entity, '*', { filter, patch, ...result })
    return json(request, env, result)
  }

  if (actionOrId) {
    const id = decodeURIComponent(actionOrId)
    const year = url.searchParams.get('year') || undefined
    const existing = await findRecord(env, entity, id, { year })
    if (['StockCount', 'Task', 'TaskPhoto', 'TaskTemplatePhoto', 'TrainingAssignment', 'TrainingProgress', 'TrainingAcknowledgement', 'TrainingAttempt'].includes(entity) && existing.record.outlet_id) {
      assertAssignedOutletAccess(user, existing.record.outlet_id)
    } else if (user.role !== 'manager' && user.role !== 'owner' && entity !== 'User' && existing.record.outlet_id) {
      assertOutletAccess(user, existing.record.outlet_id)
    }
    if (request.method === 'PATCH') {
      const patch = cleanPatch(entity, await readJson(request))
      assertUpdatePermission(user, entity, existing.record, patch)
      if (entity === 'UrgentIssue' && patch.followup_notes !== undefined) {
        await validateUrgentIssueMedia(env, existing.record.outlet_id || user.outlet_id || '', patch.followup_notes)
      }
      if (entity === 'Task' && String(patch.status || '').toLowerCase() === 'done') {
        patch.completed_date = patch.completed_date || now()
        patch.completed_by_name = user.full_name || user.email
        patch.completed_by_email = user.email
      }
      const schema = getSchema(entity)
      if (schema.headers.includes('updated_date')) patch.updated_date = now()
      if (schema.headers.includes('updated_by')) patch.updated_by = user.email
      if (schema.headers.includes('updated_at')) patch.updated_at = now()
      if (schema.headers.includes('version')) patch.version = Number(existing.record.version || 0) + 1
      const updated = await updateRecord(env, entity, id, patch, { year })
      await audit(env, user, 'update', entity, id, { ...patch, outlet_id: existing.record.outlet_id })
      if (APP_PACK_ENTITIES.has(entity)) await markAppPackDirty(env, updated.outlet_id || existing.record.outlet_id || '')
      if (entity === 'CloseUp') {
        const synced = await updateCloseUpSyncState(env, updated, { year })
        return json(request, env, synced)
      }
      return json(request, env, updated)
    }
    if (request.method === 'DELETE') {
      assertDeletePermission(user, entity, existing.record)
      const schema = getSchema(entity)
      const deletePatch = {}
      if (schema.headers.includes('deleted_at')) deletePatch.deleted_at = now()
      if (schema.headers.includes('updated_date')) deletePatch.updated_date = now()
      if (schema.headers.includes('updated_by')) deletePatch.updated_by = user.email
      if (schema.headers.includes('updated_at')) deletePatch.updated_at = now()
      if (schema.headers.includes('active') && !schema.headers.includes('deleted_at')) deletePatch.active = false
      if (schema.headers.includes('version')) deletePatch.version = Number(existing.record.version || 0) + 1
      const deleted = await updateRecord(env, entity, id, deletePatch, { year })
      await audit(env, user, 'delete', entity, id, { outlet_id: existing.record.outlet_id })
      if (APP_PACK_ENTITIES.has(entity)) await markAppPackDirty(env, existing.record.outlet_id || '')
      return json(request, env, deleted)
    }
  }
  return null
}


function inventoryWriteAllowed(user) {
  return ['supervisor', 'manager', 'owner'].includes(String(user?.role || ''))
}

function requiredInventoryText(value, fieldName) {
  const result = String(value || '').trim()
  if (result) return result
  const error = new Error(`${fieldName} is required`)
  error.status = 400
  error.code = 'invalid_inventory_item'
  throw error
}

function safeInventoryNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

async function handleInventory(request, env, url) {
  if (url.pathname !== '/api/inventory/outlet-stock-list' || request.method !== 'POST') return null

  const user = await getCurrentUser(request, env)
  if (!inventoryWriteAllowed(user)) {
    const error = new Error('Supervisor access required to add outlet inventory items')
    error.status = 403
    error.code = 'forbidden'
    throw error
  }

  const body = await readJson(request)
  const outletId = resolveOutletId(user, body.outlet_id)
  if (!outletId) {
    const error = new Error('Select an outlet before adding an item')
    error.status = 400
    error.code = 'missing_outlet'
    throw error
  }
  assertOutletAccess(user, outletId)

  const itemName = requiredInventoryText(body.item_name, 'Item name')
  const section = requiredInventoryText(body.section || 'Inventory', 'Section')
  const countUom = requiredInventoryText(body.count_uom || 'Unit', 'Count unit')
  const purchaseUom = requiredInventoryText(body.purchase_uom || countUom, 'Purchase unit')
  const timestamp = now()

  const [stockRows, catalogRows] = await Promise.all([
    listRecords(env, 'OutletStockList', {
      filter: { outlet_id: outletId },
      sort: 'section,display_order',
      limit: 5000,
    }),
    listRecords(env, 'InventoryCatalog', { sort: 'item_name', limit: 5000 }),
  ])

  const normalizedName = itemName.toLowerCase()
  const duplicate = (stockRows || []).find((row) => String(row.item_name || '').trim().toLowerCase() === normalizedName)
  if (duplicate && (duplicate.enabled === true || String(duplicate.enabled).toLowerCase() === 'true')) {
    const error = new Error(`${itemName} is already in this outlet's stock list`)
    error.status = 409
    error.code = 'duplicate_inventory_item'
    throw error
  }

  let catalog = (catalogRows || []).find((row) => String(row.item_name || '').trim().toLowerCase() === normalizedName)
  let catalogCreated = false
  if (!catalog) {
    catalog = {
      item_id: `item-${crypto.randomUUID()}`,
      item_name: itemName,
      default_category: String(body.category || '').trim(),
      default_count_uom: countUom,
      default_purchase_uom: purchaseUom,
      default_units_per_purchase_uom: Math.max(safeInventoryNumber(body.units_per_purchase_uom, 1), 0.0001),
      global_enabled: true,
      created_at: timestamp,
      updated_at: timestamp,
      notes: String(body.notes || '').trim(),
    }
    await appendRecord(env, 'InventoryCatalog', catalog)
    catalogCreated = true
  }

  const sectionRows = (stockRows || []).filter((row) => String(row.section || '') === section)
  const displayOrder = sectionRows.reduce((maximum, row) => Math.max(maximum, Number(row.display_order || 0)), 0) + 1
  const stockPatch = {
    outlet_id: outletId,
    item_id: catalog.item_id,
    item_name: itemName,
    enabled: true,
    section,
    display_order: displayOrder,
    category: String(body.category || catalog.default_category || '').trim(),
    count_uom: countUom,
    purchase_uom: purchaseUom,
    units_per_purchase_uom: Math.max(safeInventoryNumber(body.units_per_purchase_uom, 1), 0.0001),
    minimum_qty: safeInventoryNumber(body.minimum_qty, 0),
    target_qty: safeInventoryNumber(body.target_qty, 0),
    minimum_order_qty: safeInventoryNumber(body.minimum_order_qty, 0),
    uom_setup_status: 'complete',
    notes: String(body.notes || '').trim(),
    legacy_inventory_id: duplicate?.legacy_inventory_id || '',
    updated_at: timestamp,
  }

  let item
  let restored = false
  if (duplicate) {
    item = await updateRecord(env, 'OutletStockList', duplicate.stock_list_id, stockPatch)
    restored = true
  } else {
    item = {
      stock_list_id: `stock-${crypto.randomUUID()}`,
      ...stockPatch,
      created_at: timestamp,
    }
    await appendRecord(env, 'OutletStockList', item)
  }

  await audit(env, user, restored ? 'restore_outlet_stock_item' : 'create_outlet_stock_item', 'OutletStockList', item.stock_list_id, {
    outlet_id: outletId,
    item_id: item.item_id,
    item_name: item.item_name,
    catalog_created: catalogCreated,
  })
  await markAppPackDirty(env, outletId)

  return json(request, env, { item, catalog_created: catalogCreated, restored }, 201)
}



async function handleStockCounts(request, env, url) {
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

  const requestedOutletId = String(body.outlet_id || '').trim()
  const outletId = requestedOutletId || user.outlet_id || assignedOutletIds(user)[0] || ''

  if (!outletId) {
    const error = new Error('Your account is not assigned to an outlet')
    error.status = 400
    error.code = 'missing_outlet'
    throw error
  }

  assertAssignedOutletAccess(user, outletId)

  const result = await saveStockCountBatch(env, {
    user,
    countDate,
    outletId,
    items,
  })
  await audit(env, user, 'save_batch', 'StockCount', countDate, {
    outlet_id: outletId,
    saved: result.saved,
    created: result.created,
    updated: result.updated,
  })
  return json(request, env, result)
}


const REPRINT_REASONS = new Set([
  'Label damaged',
  'Printer jam',
  'Print unclear',
  'Label lost',
  'Wrong placement',
  'Other',
])

function positivePrintQuantity(value, fieldName = 'Print quantity') {
  const quantity = Number(value)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    const error = new Error(`${fieldName} must be a whole number from 1 to 100`)
    error.status = 400
    error.code = 'invalid_print_quantity'
    throw error
  }
  return quantity
}

function foodLabelMeta(record) {
  try {
    const parsed = JSON.parse(record?.notes || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function labelRecordYear(record) {
  return Number(String(record?.prep_date || record?.printed_at || '').slice(0, 4)) || undefined
}

async function appendLabelPrintLog(env, user, label, {
  action,
  quantity,
  reason = '',
  note = '',
  printerName = '',
  printedAt = now(),
  sourceDeductionQty = 0,
}) {
  const log = newRecord('LabelPrintLog', {
    outlet_id: label.outlet_id || user.outlet_id || '',
    label_id: label.id,
    original_label_id: label.id,
    batch_code: label.serial_batch || '',
    barcode: label.barcode || '',
    print_action: action,
    print_quantity: quantity,
    reprint_reason: reason,
    reprint_note: note,
    printer_name: printerName,
    printed_at: printedAt,
    printed_by_user_id: user.id || '',
    printed_by_name: confirmedActualName(user),
    printed_by_email: user.email || '',
    source_deduction_qty: sourceDeductionQty,
    approval_status: 'not_required',
  }, user)
  await appendRecord(env, 'LabelPrintLog', log, { year: labelRecordYear(label) })
  return log
}

async function handleLabels(request, env, url) {
  if (url.pathname === '/api/labels/catalog' && request.method === 'GET') {
    await getCurrentUser(request, env)
    const summaryOnly = url.searchParams.get('summary') === '1'
    const catalog = await getLabelCatalog(env, { summaryOnly })
    return json(request, env, catalog)
  }

  if (url.pathname === '/api/labels/printer-profile' && request.method === 'GET') {
    const user = await getCurrentUser(request, env)
    const requestedOutletId = String(url.searchParams.get('outlet_id') || '').trim()
    const outletId = resolveOutletId(user, requestedOutletId)

    const fallback = {
      id: '', outlet_id: outletId, purpose: 'food_label', profile_name: 'Browser Print',
      connection_type: 'system_print', command_language: 'browser',
      label_width_mm: 40, label_height_mm: 30, dpi: 203,
      default_copies: 1, auto_print: false, standby_enabled: false,
      queue_when_offline: true, is_default: true, enabled: true,
      configured: false,
    }
    if (!outletId) return json(request, env, fallback)

    const profiles = await listRecords(env, 'PrinterProfile', {
      filter: { outlet_id: outletId, purpose: 'food_label' },
      sort: '-is_default,-updated_date',
      limit: 20,
    })
    const enabledProfiles = profiles.filter((row) => !row.deleted_at && (row.enabled === true || String(row.enabled).toLowerCase() === 'true'))
    const profile = enabledProfiles.find((row) => row.is_default === true || String(row.is_default).toLowerCase() === 'true') || enabledProfiles[0]
    if (!profile) return json(request, env, fallback)

    return json(request, env, {
      id: profile.id,
      outlet_id: profile.outlet_id,
      purpose: profile.purpose,
      profile_name: profile.profile_name,
      brand: profile.brand,
      model: profile.model,
      connection_type: profile.connection_type,
      command_language: profile.command_language,
      label_width_mm: Number(profile.label_width_mm || 40),
      label_height_mm: Number(profile.label_height_mm || 30),
      dpi: Number(profile.dpi || 203),
      default_copies: Number(profile.default_copies || 1),
      auto_print: profile.auto_print === true || String(profile.auto_print).toLowerCase() === 'true',
      standby_enabled: profile.standby_enabled === true || String(profile.standby_enabled).toLowerCase() === 'true',
      queue_when_offline: profile.queue_when_offline === true || String(profile.queue_when_offline).toLowerCase() === 'true',
      is_default: profile.is_default === true || String(profile.is_default).toLowerCase() === 'true',
      enabled: true,
      configured: true,
    })
  }

  const finishSourceMatch = url.pathname.match(/^\/api\/labels\/source\/([^/]+)\/finish$/)
  if (finishSourceMatch && request.method === 'POST') {
    const user = await getCurrentUser(request, env)
    assertCreatePermission(user, 'FoodLabel')
    const source = await findRecord(env, 'FoodLabel', decodeURIComponent(finishSourceMatch[1]))
    if (source.record.outlet_id) assertAssignedOutletAccess(user, source.record.outlet_id)
    const patch = finishSourceBatchPatch(source.record)
    const updated = await updateRecord(env, 'FoodLabel', source.record.id, {
      ...patch,
      updated_date: now(), updated_by: user.email,
      version: Number(source.record.version || 0) + 1,
    }, { year: labelRecordYear(source.record) })
    await audit(env, user, 'finish_source_batch', 'FoodLabel', source.record.id, { outlet_id: source.record.outlet_id || '' })
    return json(request, env, updated)
  }

  const reprintMatch = url.pathname.match(/^\/api\/labels\/([^/]+)\/reprint$/)
  if (reprintMatch && request.method === 'POST') {
    const user = await getCurrentUser(request, env)
    assertCreatePermission(user, 'FoodLabel')
    const operatorName = confirmedActualName(user)
    const input = await readJson(request)
    const reprintQuantity = positivePrintQuantity(input.reprint_quantity, 'Reprint quantity')
    const reason = String(input.reprint_reason || '').trim()
    const note = String(input.reprint_note || '').trim().slice(0, 500)
    const printerName = String(input.printer_name || '').trim().slice(0, 120)

    if (!REPRINT_REASONS.has(reason)) {
      const error = new Error('Select a reprint reason')
      error.status = 400
      error.code = 'reprint_reason_required'
      throw error
    }
    if (reason === 'Other' && !note) {
      const error = new Error('Enter a note when the reprint reason is Other')
      error.status = 400
      error.code = 'reprint_note_required'
      throw error
    }

    const found = await findRecord(env, 'FoodLabel', decodeURIComponent(reprintMatch[1]))
    const label = found.record
    if (label.outlet_id) assertOutletAccess(user, label.outlet_id)
    const year = labelRecordYear(label)
    await Promise.all([
      ensureEntitySheet(env, 'FoodLabel', { year }),
      ensureEntitySheet(env, 'LabelPrintLog', { year }),
    ])

    const meta = foodLabelMeta(label)
    const timestamp = now()
    const initialQuantity = Math.max(1, Number(label.initial_print_quantity || meta.initial_print_quantity || 1))
    const previousReprints = Math.max(0, Number(label.total_reprint_quantity || meta.total_reprint_quantity || 0))
    const previousCount = Math.max(0, Number(label.reprint_count || meta.reprint_count || 0))
    const nextMeta = {
      ...meta,
      initial_print_quantity: initialQuantity,
      total_reprint_quantity: previousReprints + reprintQuantity,
      reprint_count: previousCount + 1,
      last_reprint_quantity: reprintQuantity,
      last_reprint_reason: reason,
      last_reprint_note: note,
      last_reprinted_at: timestamp,
      last_reprinted_by_user_id: user.id || '',
      last_reprinted_by_name: operatorName,
    }

    const updated = await updateRecord(env, 'FoodLabel', label.id, {
      notes: JSON.stringify(nextMeta),
      initial_print_quantity: initialQuantity,
      total_reprint_quantity: previousReprints + reprintQuantity,
      reprint_count: previousCount + 1,
      last_reprinted_at: timestamp,
      last_reprinted_by_user_id: user.id || '',
      last_reprinted_by_name: operatorName,
      last_reprint_reason: reason,
      last_reprint_note: note,
      updated_date: timestamp,
      updated_by: user.email,
      version: Number(label.version || 0) + 1,
    }, { year })

    let printLog = null
    try {
      printLog = await appendLabelPrintLog(env, user, updated, {
        action: 'reprint',
        quantity: reprintQuantity,
        reason,
        note,
        printerName,
        printedAt: timestamp,
        sourceDeductionQty: 0,
      })
    } catch (logError) {
      console.error('Label reprint log append failed', logError)
    }

    await audit(env, user, 'reprint', 'FoodLabel', label.id, {
      outlet_id: label.outlet_id || '',
      reprint_quantity: reprintQuantity,
      reprint_reason: reason,
      reprint_note: note,
      reprinted_by_name: operatorName,
      source_deduction_qty: 0,
      print_log_saved: Boolean(printLog),
    })

    return json(request, env, {
      label: updated,
      print_log: printLog,
      print: {
        action: 'reprint',
        quantity: reprintQuantity,
        reason,
        note,
        printed_by_name: operatorName,
        printed_at: timestamp,
      },
    })
  }

  if (url.pathname === '/api/labels/create' && request.method === 'POST') {
    const user = await getCurrentUser(request, env)
    assertCreatePermission(user, 'FoodLabel')
    const operatorName = confirmedActualName(user)
    const input = await readJson(request)
    const printQuantity = positivePrintQuantity(input.print_quantity || 1)
    input.print_quantity = printQuantity
    input.printer_name = String(input.printer_name || '').trim().slice(0, 120)

    const preparedAt = new Date()
    const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric' }).format(preparedAt))
    await Promise.all([
      ensureEntitySheet(env, 'FoodLabel', { year }),
      ensureEntitySheet(env, 'LabelPrintLog', { year }),
    ])

    const catalog = await getLabelCatalog(env)
    const { recordInput, meta } = buildAutomaticLabelInput(catalog, input, preparedAt)
    const timestamp = preparedAt.toISOString()
    Object.assign(meta, {
      initial_print_quantity: printQuantity,
      total_reprint_quantity: 0,
      reprint_count: 0,
      printer_name: input.printer_name,
      printed_at: timestamp,
      printed_by_user_id: user.id || '',
      printed_by_name: operatorName,
    })
    Object.assign(recordInput, {
      initial_print_quantity: printQuantity,
      total_reprint_quantity: 0,
      reprint_count: 0,
      printer_name: input.printer_name,
      printed_at: timestamp,
      printed_by_user_id: user.id || '',
      printed_by_name: operatorName,
      notes: JSON.stringify(meta),
    })

    const requestedOutletId = String(input.outlet_id || '').trim()
    const targetOutletId = resolveOutletId(user, requestedOutletId)
    if (targetOutletId) recordInput.outlet_id = targetOutletId

    let sourceFound = null
    let sourceConsumption = null
    if (meta.requires_source && meta.source_label_id) {
      sourceFound = await findRecord(env, 'FoodLabel', meta.source_label_id)
      applySourceTraceability({
        catalog,
        recordInput,
        meta,
        sourceRecord: sourceFound?.record,
        currentOutletId: targetOutletId,
      })
      sourceConsumption = sourceConsumptionPatch(sourceFound.record, meta)
      if (sourceConsumption) {
        meta.source_remaining_after = sourceConsumption.remaining
        meta.source_status_after = sourceConsumption.status
        recordInput.notes = JSON.stringify(meta)
      }
    }

    const record = newRecord('FoodLabel', recordInput, user)
    if (sourceConsumption && sourceFound?.record) {
      await updateRecord(env, 'FoodLabel', sourceFound.record.id, {
        notes: sourceConsumption.nextNotes,
        updated_date: now(),
        updated_by: user.email,
        version: Number(sourceFound.record.version || 0) + 1,
      }, { year: labelRecordYear(sourceFound.record) })
    }
    try {
      await appendRecord(env, 'FoodLabel', record, { year })
    } catch (appendError) {
      if (sourceConsumption && sourceFound?.record) {
        await updateRecord(env, 'FoodLabel', sourceFound.record.id, {
          notes: sourceConsumption.previousNotes,
          updated_date: now(),
          updated_by: user.email,
          version: Number(sourceFound.record.version || 0) + 2,
        }, { year: labelRecordYear(sourceFound.record) }).catch(() => {})
      }
      throw appendError
    }

    let printLog = null
    try {
      printLog = await appendLabelPrintLog(env, user, record, {
        action: 'print',
        quantity: printQuantity,
        printerName: input.printer_name,
        printedAt: timestamp,
        sourceDeductionQty: Number(meta.source_consumed_qty || 0),
      })
    } catch (logError) {
      console.error('Initial label print log append failed', logError)
    }

    await audit(env, user, 'create_from_rule', 'FoodLabel', record.id, {
      rule_id: meta.rule_id,
      product_id: meta.product_id,
      action: meta.action,
      expires_at: meta.expires_at,
      source_label_id: meta.source_label_id || '',
      source_short_code: meta.source_short_code || '',
      expiry_limited_by_source: Boolean(meta.expiry_limited_by_source),
      outlet_id: record.outlet_id,
      print_quantity: printQuantity,
      printed_by_name: operatorName,
      source_deduction_qty: Number(meta.source_consumed_qty || 0),
      print_log_saved: Boolean(printLog),
    })
    return json(request, env, record, 201)
  }

  return null
}

const APP_VERSION = '4.5.1-task-issue-media-drafts-rules-routes'

const DEFAULT_PAYMENT_METHODS = [
  { id: 'payment-cash', code: 'cash', name: 'Cash', icon: 'banknote', color: 'emerald', category: 'cash', display_order: 10, active: true, requires_reference: false },
  { id: 'payment-card', code: 'card', name: 'Credit / Debit Card', icon: 'credit-card', color: 'blue', category: 'electronic', display_order: 20, active: true, requires_reference: false },
  { id: 'payment-duitnow', code: 'duitnow', name: 'DuitNow QR', icon: 'qr-code', color: 'violet', category: 'electronic', display_order: 30, active: true, requires_reference: false },
  { id: 'payment-tng', code: 'touch_n_go', name: 'Touch ’n Go', icon: 'wallet-cards', color: 'sky', category: 'electronic', display_order: 40, active: true, requires_reference: false },
  { id: 'payment-grabpay', code: 'grabpay', name: 'GrabPay', icon: 'smartphone', color: 'emerald', category: 'electronic', display_order: 50, active: true, requires_reference: false },
  { id: 'payment-grabfood', code: 'grabfood', name: 'GrabFood', icon: 'bike', color: 'green', category: 'delivery', display_order: 60, active: true, requires_reference: false },
  { id: 'payment-foodpanda', code: 'foodpanda', name: 'Foodpanda', icon: 'bike', color: 'pink', category: 'delivery', display_order: 70, active: true, requires_reference: false },
  { id: 'payment-transfer', code: 'bank_transfer', name: 'Bank Transfer', icon: 'landmark', color: 'indigo', category: 'electronic', display_order: 80, active: true, requires_reference: true },
  { id: 'payment-voucher', code: 'voucher', name: 'Voucher', icon: 'ticket', color: 'amber', category: 'adjustment', display_order: 90, active: true, requires_reference: true },
  { id: 'payment-complimentary', code: 'complimentary', name: 'Staff Meal / Complimentary', icon: 'gift', color: 'orange', category: 'adjustment', display_order: 100, active: true, requires_reference: true },
  { id: 'payment-other', code: 'other', name: 'Other', icon: 'circle-dollar-sign', color: 'slate', category: 'other', display_order: 110, active: true, requires_reference: true },
]

function publicAppSettings(rows = []) {
  const allowed = new Set([
    'app_data_version', 'android_apk_url', 'android_apk_version',
    'release_notes', 'production_web_url', 'support_url',
  ])
  return Object.fromEntries(
    rows.filter((row) => allowed.has(String(row.key || ''))).map((row) => [row.key, row.value]),
  )
}

async function handleV4App(request, env, url) {
  if (!url.pathname.startsWith('/api/app/v4')) return null
  const user = await getCurrentUser(request, env)
  const requestedOutlet = String(url.searchParams.get('outlet_id') || user.outlet_id || assignedOutletIds(user)[0] || '').trim()

  if (url.pathname === '/api/app/v4/pack/manifest' && request.method === 'GET') {
    const refreshRequested = url.searchParams.get('refresh') === '1'
    const privilegedForce = refreshRequested && ['manager', 'owner'].includes(user.role)
    // Every client manifest check is stale-aware. Staff never force an
    // unconditional rebuild, but they can no longer be trapped on an old
    // published package after a direct Master Sheet update.
    const manifest = await getOrBuildAppPack(env, requestedOutlet, { force: privilegedForce })
    if (!manifest) {
      const error = new Error('The operational data patch has not been published for this outlet yet. Ask a manager to publish it first.')
      error.status = 503
      error.code = 'pack_not_published'
      throw error
    }
    const etag = `"${manifest.version}"`
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ...corsHeaders(request, env),
          'Cache-Control': 'private, max-age=300, stale-while-revalidate=3600',
          'ETag': etag,
        },
      })
    }
    return json(request, env, manifest, 200, {
      'Cache-Control': 'private, max-age=300, stale-while-revalidate=3600',
      'ETag': etag,
    })
  }

  const moduleMatch = url.pathname.match(/^\/api\/app\/v4\/pack\/module\/([^/]+)$/)
  if (moduleMatch && request.method === 'GET') {
    const name = decodeURIComponent(moduleMatch[1])
    const module = await getAppPackModule(env, requestedOutlet, name, url.searchParams.get('hash') || '')
    if (!module) {
      const error = new Error('Data pack module not found')
      error.status = 404
      error.code = 'pack_module_not_found'
      throw error
    }
    return json(request, env, module, 200, {
      'Cache-Control': 'private, max-age=86400, immutable',
    })
  }

  if (url.pathname === '/api/app/v4/pack/rebuild-all' && request.method === 'POST') {
    if (!['manager', 'owner'].includes(user.role)) {
      const error = new Error('Manager access required')
      error.status = 403
      error.code = 'forbidden'
      throw error
    }
    const manifests = await rebuildAllAppPacks(env)
    return json(request, env, {
      ok: true,
      generated_at: new Date().toISOString(),
      packs: manifests.map((manifest) => ({
        outlet_id: manifest.outlet_id,
        version: manifest.version,
        data_version: manifest.data_version,
        total_bytes: manifest.total_bytes,
      })),
    })
  }

  if (url.pathname === '/api/app/v4/pack/rebuild' && request.method === 'POST') {
    if (!['manager', 'owner'].includes(user.role)) {
      const error = new Error('Manager access required')
      error.status = 403
      error.code = 'forbidden'
      throw error
    }
    const manifest = await getOrBuildAppPack(env, requestedOutlet, { force: true })
    return json(request, env, manifest)
  }

  if (url.pathname === '/api/app/v4/bootstrap' && ['GET', 'POST'].includes(request.method)) {
    const manifest = await getPublishedAppPack(env, requestedOutlet)
    if (!manifest) {
      const error = new Error('The operational data patch has not been published for this outlet yet')
      error.status = 503
      error.code = 'pack_not_published'
      throw error
    }
    const coreModule = await getAppPackModule(env, requestedOutlet, 'core', manifest.modules?.core?.hash)
    const core = coreModule?.data || {}
    return json(request, env, {
      ok: true,
      app_version: APP_VERSION,
      data_version: manifest.data_version || manifest.version,
      data_pack: manifest,
      payment_methods: core.payment_methods || [],
      settings: core.settings || {},
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, outlet_id: user.outlet_id, outlet_ids: user.outlet_ids },
      operation_years: configuredOperationYears(env),
      notification_mode: env.VAPID_PUBLIC_KEY ? 'web-push-ready' : 'in-app-and-local-system',
    })
  }

  if (url.pathname === '/api/app/v4/version' && request.method === 'GET') {
    const manifest = await getPublishedAppPack(env, requestedOutlet)
    if (!manifest) {
      const error = new Error('The operational data patch has not been published for this outlet yet')
      error.status = 503
      error.code = 'pack_not_published'
      throw error
    }
    const coreModule = await getAppPackModule(env, requestedOutlet, 'core', manifest.modules?.core?.hash)
    const settings = coreModule?.data?.settings || {}
    return json(request, env, {
      app_version: APP_VERSION,
      data_version: manifest.data_version || manifest.version,
      data_pack_version: manifest.version,
      data_pack_bytes: manifest.total_bytes || 0,
      apk_url: settings.android_apk_url || '',
      apk_version: settings.android_apk_version || '',
      release_notes: settings.release_notes || '',
      production_web_url: settings.production_web_url || '',
    })
  }

  if (url.pathname === '/api/app/v4/device' && request.method === 'POST') {
    const body = await readJson(request)
    const deviceId = String(body.device_id || '').trim()
    if (!deviceId) {
      const error = new Error('device_id is required')
      error.status = 400
      error.code = 'missing_device_id'
      throw error
    }
    await ensureEntitySheet(env, 'DeviceRegistration')
    const existing = (await listRecords(env, 'DeviceRegistration', {
      filter: { device_id: deviceId, user_id: user.id },
      sort: '-updated_date',
      limit: 1,
    }))[0]
    const patch = {
      outlet_id: user.outlet_id || '',
      user_id: user.id,
      user_email: user.email,
      user_name: user.full_name || user.email,
      device_id: deviceId,
      platform: String(body.platform || ''),
      app_version: String(body.app_version || APP_VERSION),
      notification_permission: String(body.notification_permission || 'default'),
      push_endpoint: String(body.push_endpoint || ''),
      push_subscription_json: body.push_subscription_json ? JSON.stringify(body.push_subscription_json) : '',
      last_active_at: now(),
      status: 'active',
    }
    let record
    if (existing) {
      record = await updateRecord(env, 'DeviceRegistration', existing.id, {
        ...patch,
        updated_date: now(), updated_by: user.email, version: Number(existing.version || 0) + 1,
      })
    } else {
      record = newRecord('DeviceRegistration', patch, user)
      await appendRecord(env, 'DeviceRegistration', record)
    }
    return json(request, env, { ok: true, device: record })
  }

  return null
}

async function handleIntegrations(request, env, url) {
  if (url.pathname === '/api/integrations/statvara/status' && request.method === 'GET') {
    await getCurrentUser(request, env)
    const configured = Boolean(env.STATVARA_API_BASE_URL && env.STATVARA_API_TOKEN)
    return json(request, env, {
      configured,
      status: configured ? 'connected' : 'not_configured',
      capabilities: ['receipts', 'sales'],
    })
  }

  if (url.pathname === '/api/integrations/statvara/receipts/sync' && request.method === 'POST') {
    const user = await getCurrentUser(request, env)
    if (!['manager', 'owner'].includes(user.role)) {
      const error = new Error('Manager access required')
      error.status = 403
      error.code = 'forbidden'
      throw error
    }
    if (!env.STATVARA_API_BASE_URL || !env.STATVARA_API_TOKEN) {
      const error = new Error('Statvara API is not configured')
      error.status = 503
      error.code = 'statvara_not_configured'
      throw error
    }
    const error = new Error('Statvara receipt mapping is reserved but not implemented yet')
    error.status = 501
    error.code = 'statvara_sync_reserved'
    throw error
  }
  return null
}

async function handleFiles(request, env, url) {
  if (url.pathname === '/api/files/upload' && request.method === 'POST') {
    const user = await getCurrentUser(request, env)
    const uploaded = await uploadDriveFile(request, env, user)
    await audit(env, user, 'upload', 'DriveFile', uploaded.drive_file_id, uploaded)
    return json(request, env, uploaded, 201)
  }
  const match = url.pathname.match(/^\/api\/files\/([^/]+)$/)
  if (match && request.method === 'GET') {
    await getCurrentUser(request, env)
    const upstream = await downloadDriveFile(env, decodeURIComponent(match[1]))
    const headers = new Headers(upstream.headers)
    Object.entries(corsHeaders(request, env)).forEach(([key, value]) => headers.set(key, value))
    headers.set('Cache-Control', 'private, max-age=300')
    return new Response(upstream.body, { status: upstream.status, headers })
  }
  return null
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) })
    }
    const url = new URL(request.url)
    try {
      if (url.pathname === '/api/health') return json(request, env, {
        ok: true,
        service: 'chefops-api',
        storage: {
          layout: env.GOOGLE_MASTER_SPREADSHEET_ID ? 'master-plus-yearly-operations' : 'legacy-combined',
          masterConfigured: Boolean(env.GOOGLE_MASTER_SPREADSHEET_ID || env.GOOGLE_SPREADSHEET_ID),
          trainingConfigured: Boolean(env.GOOGLE_TRAINING_SPREADSHEET_ID || '1oljGV1NxJyGbFQoxkrzHeVBGCK7zs3r8x3jphe0HQAs'),
          operationYears: configuredOperationYears(env),
        },
      })
      const authResponse = await handleAuth(request, env, url.pathname)
      if (authResponse) return authResponse
      const inventoryResponse = await handleInventory(request, env, url)
      if (inventoryResponse) return inventoryResponse
      const stockCountResponse = await handleStockCounts(request, env, url)
      if (stockCountResponse) return stockCountResponse
      const labelResponse = await handleLabels(request, env, url)
      if (labelResponse) return labelResponse
      const v4Response = await handleV4App(request, env, url)
      if (v4Response) return v4Response
      const integrationResponse = await handleIntegrations(request, env, url)
      if (integrationResponse) return integrationResponse
      const operationalTaskResponse = await handleOperationalTasks(request, env, url)
      if (operationalTaskResponse) return operationalTaskResponse
      const notificationResponse = await handleNotifications(request, env, url)
      if (notificationResponse) return notificationResponse
      const taskAutomationResponse = await handleTaskAutomation(request, env, url)
      if (taskAutomationResponse) return taskAutomationResponse
      const closeUpUpsertResponse = await handleCloseUpUpsert(request, env, url)
      if (closeUpUpsertResponse) return closeUpUpsertResponse
      const closeUpSyncResponse = await handleCloseUpSync(request, env, url)
      if (closeUpSyncResponse) return closeUpSyncResponse
      const userAccessResponse = await handleUserAccess(request, env, url)
      if (userAccessResponse) return userAccessResponse
      const attendanceImportResponse = await handleAttendanceImport(request, env, url)
      if (attendanceImportResponse) return attendanceImportResponse
      const entityResponse = await handleEntities(request, env, url)
      if (entityResponse) return entityResponse
      const fileResponse = await handleFiles(request, env, url)
      if (fileResponse) return fileResponse
      const error = new Error('Endpoint not found')
      error.status = 404
      error.code = 'not_found'
      throw error
    } catch (error) {
      return errorResponse(request, env, error)
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([
      rebuildAllAppPacks(env),
      retryPendingCloseUpSyncs(env, 20),
    ]))
  },
}
