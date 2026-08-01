function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
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

function accessState(task, current = new Date()) {
  if (String(task.status || '').toLowerCase() === 'done') return 'DONE'
  const opensAt = Date.parse(task.opens_at || '')
  const dueAt = Date.parse(task.due_at || '')
  const locksAt = Date.parse(task.locks_at || '')
  const currentMs = current.getTime()
  if (Number.isFinite(opensAt) && currentMs < opensAt) return 'NOT_OPEN'
  if (Number.isFinite(locksAt) && currentMs > locksAt) return 'LOCKED'
  if (Number.isFinite(dueAt) && currentMs > dueAt) return 'OVERDUE'
  return 'OPEN'
}

function assembleTask(task, photos, current) {
  const state = parseState(task)
  const config = task.config || {}
  const checklistItems = items(config)
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
    responses: responseRows,
    completion_notes: state.completion_notes || task.completion_notes || '',
    access_state: accessState(task, current),
    checklist_total: checklistItems.length,
    checklist_completed: checklistItems.filter((item) => evaluate(item, state.responses?.[item.id]) !== 'incomplete').length,
    required_photo_count: requirements.filter((group) => group.required)
      .reduce((sum, group) => sum + Number(group.min_photos || 1), 0),
    submitted_photo_count: requirements.filter((group) => group.required)
      .reduce((sum, group) => sum + Math.min(group.uploaded_count, Number(group.min_photos || 1)), 0),
    photo_requirements: requirements,
  }
}

export async function overlayOperationalBootstrapResponse(url, env, response) {
  if (
    url.pathname !== '/api/tasks/operational/bootstrap'
    || response.status < 200
    || response.status >= 300
    || !env.OPS_DB?.prepare
  ) return response

  let data
  try { data = await response.clone().json() } catch { return response }
  const sheetTasks = Array.isArray(data?.tasks) ? data.tasks : []
  const sheetPhotos = Array.isArray(data?.task_photos) ? data.task_photos : []
  const outletId = String(sheetTasks[0]?.outlet_id || sheetPhotos[0]?.outlet_id || '').trim()
  if (!outletId) return response

  const query = await env.OPS_DB.prepare(`
    SELECT * FROM ops_records
    WHERE outlet_id = ? AND entity IN ('Task', 'TaskPhoto') AND deleted_at = ''
    ORDER BY updated_at DESC LIMIT 5000
  `).bind(outletId).all()
  const d1Rows = (query.results || []).map(realtimeRecord)
  const taskMap = new Map(sheetTasks.map((task) => [recordId(task), task]).filter(([id]) => id))
  const photoMap = new Map(sheetPhotos.map((photo) => [recordId(photo), photo]).filter(([id]) => id))

  for (const row of d1Rows) {
    const id = recordId(row)
    if (!id) continue
    if (row.__realtime.entity === 'Task') {
      if (taskMap.has(id)) taskMap.set(id, { ...taskMap.get(id), ...row })
    } else if (row.__realtime.entity === 'TaskPhoto') {
      photoMap.set(id, { ...(photoMap.get(id) || {}), ...row })
    }
  }

  const current = new Date()
  const taskIds = new Set(taskMap.keys())
  const photos = [...photoMap.values()].filter((photo) => taskIds.has(String(photo.task_id || '')))
  const result = {
    ...data,
    tasks: [...taskMap.values()].map((task) => assembleTask(task, photos, current)),
    task_photos: photos,
    source_control: 'MASTER_SHEET_TASKTEMPLATES_D1_STATE',
    server_time: current.toISOString(),
  }
  const headers = new Headers(response.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(result), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
