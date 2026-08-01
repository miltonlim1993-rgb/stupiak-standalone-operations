import { getCurrentUser } from './auth.js'
import { errorResponse } from './http.js'
import { assertAssignedOutletAccess } from './permissions.js'
import { findRecord, listRecords } from './sheets.js'
import { applyOpeningChecklistFeedback } from './opening-checklist-feedback.js'
import { allowedMediaKinds, getMediaRule } from './media-rules.js'
import { handleRealtimeDataApi } from './realtime-store.js'

const PREFIX = 'CHEFOPS_CHECKLIST_V1:'

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function truthy(value) {
  return value === true || String(value).toLowerCase() === 'true'
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
}

function templateVisible(template, outletId) {
  if (!truthy(template.is_active)) return false
  const outletIds = csv(template.outlet_ids)
  return !outletIds.length
    || outletIds.includes(String(outletId || ''))
    || String(template.outlet_id || '') === String(outletId || '')
}

function parseChecklist(template) {
  const raw = String(template?.instructions || '')
  if (!raw.startsWith(PREFIX)) return null
  try {
    const config = JSON.parse(raw.slice(PREFIX.length))
    return config?.kind === 'operational_checklist'
      ? applyOpeningChecklistFeedback(template, config)
      : null
  } catch {
    return null
  }
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

function localDateTime(dateText, timeText, dayOffset = 0, timeZone = 'Asia/Kuala_Lumpur') {
  const [year, month, day] = String(dateText).split('-').map(Number)
  const [hour, minute] = String(timeText || '00:00').split(':').map(Number)
  const localGuess = new Date(Date.UTC(year, month - 1, day + Number(dayOffset || 0), hour || 0, minute || 0, 0))
  let offset = timezoneOffsetMs(localGuess, timeZone)
  let utc = new Date(localGuess.getTime() - offset)
  const corrected = timezoneOffsetMs(utc, timeZone)
  if (corrected !== offset) utc = new Date(localGuess.getTime() - corrected)
  return utc
}

function taskAccess(task, config, current = new Date()) {
  if (String(task.status || '').toLowerCase() === 'done') return 'DONE'
  const schedule = config.schedule || {}
  const zone = config.timezone || 'Asia/Kuala_Lumpur'
  const opensAt = localDateTime(task.due_date, schedule.open_time, schedule.open_day_offset, zone)
  const locksAt = localDateTime(
    task.due_date,
    schedule.lock_time || schedule.due_time,
    schedule.lock_day_offset ?? schedule.due_day_offset,
    zone,
  )
  if (current < opensAt) return 'NOT_OPEN'
  if (current > locksAt) return 'LOCKED'
  return 'OPEN'
}

function invalid(message, code) {
  const error = new Error(message)
  error.status = 400
  error.code = code
  throw error
}

async function d1Task(env, taskId) {
  if (!env.OPS_DB?.prepare) return null
  const row = await env.OPS_DB.prepare(`
    SELECT payload_json, version FROM ops_records
    WHERE entity = 'Task' AND entity_id = ? AND deleted_at = '' LIMIT 1
  `).bind(taskId).first()
  if (!row) return null
  const record = parseJson(row.payload_json, {}) || {}
  return { ...record, __realtime: { version: Number(row.version || 0) } }
}

async function existingPhotoCount(env, task, groupId, year) {
  const sheetRows = await listRecords(env, 'TaskPhoto', {
    filter: { outlet_id: task.outlet_id, task_id: task.id },
    sort: 'display_order',
    limit: 1000,
    year,
  })
  let d1Rows = []
  if (env.OPS_DB?.prepare) {
    const result = await env.OPS_DB.prepare(`
      SELECT payload_json FROM ops_records
      WHERE entity = 'TaskPhoto' AND outlet_id = ? AND deleted_at = ''
      ORDER BY updated_at DESC LIMIT 3000
    `).bind(task.outlet_id).all()
    d1Rows = (result.results || []).map((row) => parseJson(row.payload_json, {}) || {})
  }
  const byId = new Map(sheetRows.map((row) => [String(row.id || ''), row]).filter(([id]) => id))
  for (const row of d1Rows) {
    const id = String(row.id || '')
    if (id) byId.set(id, { ...(byId.get(id) || {}), ...row })
  }
  return [...byId.values()].filter((row) => (
    !row.deleted_at
    && String(row.status || 'active').toLowerCase() !== 'deleted'
    && String(row.task_id || '') === String(task.id || '')
    && String(row.photo_type || '') === `checklist:${groupId}`
  )).length
}

async function validatedMutationRequest(request, env, body) {
  const user = await getCurrentUser(request, env)
  const input = body.payload || {}
  const taskId = String(input.task_id || '').trim()
  if (!taskId) invalid('Task photo must be linked to a task', 'missing_task')

  const dateMatch = taskId.match(/task-(20\d{2}-\d{2}-\d{2})-/)
  const capturedYear = Number(String(input.captured_at || '').slice(0, 4))
  const year = Number.isInteger(capturedYear) && capturedYear >= 2000
    ? capturedYear
    : Number(dateMatch?.[1]?.slice(0, 4)) || new Date().getFullYear()
  let task = await d1Task(env, taskId)
  if (!task) task = (await findRecord(env, 'Task', taskId, { year })).record
  assertAssignedOutletAccess(user, task.outlet_id)

  const templates = await listRecords(env, 'TaskTemplate', { sort: 'display_order,title', limit: 1000 })
  const template = templates.find((row) => (
    String(row.id || '') === String(task.template_id || '')
    && templateVisible(row, task.outlet_id)
  ))
  const config = template ? parseChecklist(template) : null
  if (!template || !config) invalid('This task is not linked to an active checklist', 'invalid_operational_task')

  const groupId = String(input.photo_type || '').replace(/^checklist:/, '')
  const group = (config.photo_groups || []).find((row) => String(row.id) === groupId)
  if (!group) invalid('This checklist photo group does not exist', 'invalid_photo_group')
  const access = taskAccess(task, config)
  if (['NOT_OPEN', 'LOCKED', 'DONE'].includes(access)) {
    invalid(access === 'NOT_OPEN' ? 'This checklist is not open yet' : 'This checklist no longer accepts photos', 'task_photo_locked')
  }

  const rule = await getMediaRule(env, 'task', task.outlet_id)
  const mime = String(input.mime_type || '').toLowerCase()
  if (!mime.startsWith('image/') || !allowedMediaKinds(rule).has('IMAGE')) {
    invalid('Task evidence must be an on-site photo', 'task_photo_only')
  }
  const maxBytes = Number(rule.max_file_mb || 10) * 1024 * 1024
  if (Number(input.file_size || 0) > maxBytes) {
    invalid(`${input.file_name || 'Photo'} is larger than ${rule.max_file_mb} MB`, 'media_too_large')
  }
  if (!String(input.drive_file_id || input.file_url || '').trim()) {
    invalid('Task photo file is required', 'missing_photo_file')
  }
  if (!String(input.captured_at || '').trim()) invalid('Task photo capture time is required', 'missing_capture_time')
  if (String(rule.watermark_mode || '').toUpperCase() === 'DATE_TIME' && !String(input.watermark_text || '').trim()) {
    invalid('Task photo date and time watermark is required', 'missing_watermark')
  }

  const currentCount = await existingPhotoCount(env, task, groupId, year)
  const groupMax = Math.max(1, Number(group.max_photos || rule.max_files || 1))
  const limit = Math.min(groupMax, Number(rule.max_files || groupMax))
  if (currentCount >= limit) {
    invalid(`${group.name || 'This group'} already has the maximum ${limit} photo(s)`, 'media_limit_exceeded')
  }

  const timestamp = new Date().toISOString()
  const entityId = String(body.entity_id || input.id || crypto.randomUUID())
  const payload = {
    ...input,
    id: entityId,
    outlet_id: task.outlet_id,
    task_id: task.id,
    template_id: task.template_id,
    status: input.status || 'active',
    uploaded_by_email: user.email,
    uploaded_by_name: user.full_name || user.email,
    captured_at: input.captured_at,
    uploaded_at: input.uploaded_at || timestamp,
  }
  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.delete('Content-Length')
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify({
      ...body,
      outlet_id: task.outlet_id,
      entity_id: entityId,
      payload,
    }),
  })
}

export async function handleRealtimeTaskPhotoMutation(request, env, url) {
  if (url.pathname !== '/api/realtime/mutations' || request.method !== 'POST') return null
  let body
  try { body = await request.clone().json() } catch { return null }
  if (String(body?.entity || '') !== 'TaskPhoto') return null

  try {
    const mutationId = String(body.mutation_id || '').trim()
    if (mutationId && env.OPS_DB?.prepare) {
      const replay = await env.OPS_DB.prepare(
        'SELECT mutation_id FROM ops_mutations WHERE mutation_id = ? LIMIT 1',
      ).bind(mutationId).first()
      if (replay) return handleRealtimeDataApi(request, env, url)
    }
    const validatedRequest = await validatedMutationRequest(request, env, body)
    return handleRealtimeDataApi(validatedRequest, env, url)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
