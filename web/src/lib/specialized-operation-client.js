import { opsClient } from '@/api/opsClient'
import {
  flushSpecializedOperationQueue,
  installSpecializedOperationQueue,
  listSpecializedOperations,
  submitSpecializedOperation,
} from '@/lib/specialized-operation-outbox'
import { stageRealtimeReadCacheMutation } from '@/lib/realtime-read-cache'
import {
  loadOperationalTaskSnapshot,
  saveOperationalTaskSnapshot,
  updateOperationalTaskSnapshot,
} from '@/lib/operational-task-snapshot'

let installed = false
let indicator = null
let hideSuccessTimer = null

function now() {
  return new Date().toISOString()
}

function cachedUser() {
  try { return JSON.parse(localStorage.getItem('chefops.auth.cached-user') || 'null') || {} } catch { return {} }
}

function safeKey(value, limit = 96) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit)
}

function transientFailure(error) {
  const status = Number(error?.status)
  if (!navigator.onLine || !Number.isFinite(status)) return true
  if ([408, 425, 429].includes(status)) return true
  return status >= 500
}

function taskScope(payload, suffix = '') {
  const base = `task:${payload.outlet_id || ''}:${payload.date || ''}:${payload.task_id || ''}`
  return suffix ? `${base}:${suffix}` : base
}

function stockScope(payload) {
  return `stock:${payload.outlet_id || ''}:${payload.count_date || ''}`
}

function closeUpScope(payload) {
  const identity = payload.event_key
    ? `closeup-${safeKey(payload.event_key)}`
    : (payload.record_id || payload.shift_id || 'entry')
  return `closeup:${payload.outlet_id || ''}:${payload.business_date || ''}:${identity}`
}

function cashCloseScope(payload) {
  return `cash-close:${payload.outlet_id || ''}:${payload.business_date || ''}:${payload.shift_id || 'night'}`
}

async function pendingOperation(kind, scopeKey) {
  const rows = await listSpecializedOperations({ kind, scopeKey, status: 'queued_device' })
  return rows.at(-1) || null
}

function mergeTaskResponsePatches(previous = [], incoming = []) {
  const rows = new Map()
  for (const row of previous || []) {
    const id = String(row?.item_id || '')
    if (id) rows.set(id, { ...row })
  }
  for (const row of incoming || []) {
    const id = String(row?.item_id || '')
    if (!id) continue
    rows.set(id, { ...(rows.get(id) || {}), ...row, item_id: id })
  }
  return [...rows.values()]
}

function mergeStockPayload(previous = {}, incoming = {}) {
  const items = new Map()
  for (const row of previous.items || []) {
    const id = String(row?.stock_list_id || '')
    if (id) items.set(id, { ...row })
  }
  for (const row of incoming.items || []) {
    const id = String(row?.stock_list_id || '')
    if (id) items.set(id, { ...row })
  }
  return { ...previous, ...incoming, items: [...items.values()] }
}

function taskResponses(task) {
  return new Map((task?.responses || []).map((row) => [String(row.item_id || ''), { ...row }]))
}

function taskStateText(responses, startedAt, completionNotes) {
  return JSON.stringify({
    schema: 'operational-checklist-v1',
    responses: Object.fromEntries([...responses.entries()].map(([id, row]) => [id, {
      value: row?.value ?? '',
      remark: row?.remark || '',
      corrective_action: row?.corrective_action || '',
    }])),
    started_at: startedAt || '',
    completion_notes: completionNotes || '',
  })
}

function queuedTaskPreview(task, payload, mutationId) {
  if (!task) return null
  const responses = taskResponses(task)
  if (Array.isArray(payload.responses)) {
    responses.clear()
    for (const row of payload.responses) {
      const id = String(row?.item_id || '')
      if (id) responses.set(id, { ...row, item_id: id })
    }
  } else {
    for (const row of payload.response_patches || []) {
      const id = String(row?.item_id || '')
      if (!id) continue
      responses.set(id, { ...(responses.get(id) || { item_id: id }), ...row, item_id: id })
    }
  }

  const timestamp = now()
  const completionNotes = Object.prototype.hasOwnProperty.call(payload, 'completion_notes_patch')
    ? String(payload.completion_notes_patch || '')
    : (payload.completion_notes !== undefined ? String(payload.completion_notes || '') : String(task.completion_notes || ''))
  const startedAt = task.started_at || timestamp
  const action = String(payload.action || 'save').toLowerCase()
  const status = action === 'start' || action === 'save'
    ? (String(task.status || '').toLowerCase() === 'done' ? task.status : 'in_progress')
    : task.status
  const completedCount = [...responses.values()].filter((row) => row?.value !== '' && row?.value !== null && row?.value !== undefined).length

  return {
    ...task,
    status,
    responses: [...responses.values()],
    completion_notes: completionNotes,
    notes: taskStateText(responses, startedAt, completionNotes),
    checklist_completed: completedCount,
    updated_date: timestamp,
    completion_pending_device: action === 'complete',
    __device_sync: {
      phase: 'device_saved',
      action,
      mutation_id: mutationId,
      saved_at: timestamp,
    },
    __realtime: {
      ...(task.__realtime || {}),
      entity: 'Task',
      entity_id: task.id,
      outlet_id: task.outlet_id || payload.outlet_id || '',
      sync_status: 'queued_device',
      mutation_id: mutationId,
    },
  }
}

function queuedCloseUpPreview(payload, mutationId) {
  const timestamp = now()
  const id = String(payload.record_id || '').trim() || `closeup-${safeKey(payload.event_key || `${payload.outlet_id}|${payload.business_date}|${payload.shift_id}`)}`
  return {
    ...payload,
    id,
    created_date: payload.created_date || timestamp,
    updated_date: timestamp,
    submitted_at: payload.submitted_at || timestamp,
    sync_status: 'queued_device',
    __device_sync: { phase: 'device_saved', mutation_id: mutationId, saved_at: timestamp },
    __realtime: {
      entity: 'CloseUp',
      entity_id: id,
      outlet_id: payload.outlet_id || '',
      version: Number(payload?.__realtime?.version || 0),
      updated_at: payload?.__realtime?.updated_at || '',
      deleted_at: '',
      sync_status: 'queued_device',
      mutation_id: mutationId,
    },
  }
}

function queuedStockRecords(payload, mutationId) {
  const user = cachedUser()
  const timestamp = now()
  return (payload.items || []).map((item) => {
    const id = `stock-${safeKey(payload.count_date, 72)}-${safeKey(payload.outlet_id, 72)}-${safeKey(item.stock_list_id, 72)}`
    return {
      id,
      outlet_id: payload.outlet_id || '',
      count_date: payload.count_date || '',
      stock_list_id: item.stock_list_id || '',
      actual_qty: Number(item.actual_qty),
      counted_by: user.full_name || user.email || '',
      counted_by_email: user.email || '',
      status: 'counted',
      updated_date: timestamp,
      __device_sync: { phase: 'device_saved', mutation_id: mutationId, saved_at: timestamp },
    }
  })
}

async function stageQueuedRecord(entity, record, operation) {
  if (!record?.id) return
  await stageRealtimeReadCacheMutation({
    entity,
    entity_id: record.id,
    outlet_id: record.outlet_id || operation.outlet_id,
    operation: 'upsert',
    mutation_id: operation.mutation_id,
    queued_at: operation.queued_at,
    payload: record,
  })
}

async function stageQueuedStock(operation) {
  const records = queuedStockRecords(operation.payload, operation.mutation_id)
  for (const record of records) await stageQueuedRecord('StockCount', record, operation)
  return records
}

async function stageCommittedStock(operation, result) {
  const timestamp = result?.committed_at || now()
  for (const summary of result?.records || []) {
    const id = String(summary?.stock_count_id || '').trim()
    if (!id) continue
    await stageRealtimeReadCacheMutation({
      entity: 'StockCount',
      entity_id: id,
      outlet_id: operation.outlet_id,
      operation: 'upsert',
      mutation_id: operation.mutation_id,
      committed_at: timestamp,
      version: summary.version,
      sync_status: result?.sync_status || 'pending',
      record: {
        id,
        outlet_id: operation.outlet_id,
        count_date: result?.count_date || operation.payload.count_date || '',
        stock_list_id: summary.stock_list_id || '',
        item_id: summary.item_id || '',
        item_name: summary.item_name || '',
        actual_qty: summary.actual_qty,
        expected_qty: summary.expected_qty,
        variance: summary.variance,
        status: 'counted',
      },
    }, { committed: true })
  }
}

async function stageQueuedTask(operation, task) {
  if (!task?.id) return
  await updateOperationalTaskSnapshot(operation.outlet_id, operation.payload.date, task).catch(() => undefined)
  await stageQueuedRecord('Task', task, operation)
}

async function updateTaskAfterCommit(operation, result) {
  const task = result?.task
  if (!task?.id) return
  await updateOperationalTaskSnapshot(operation.outlet_id, operation.payload.date, task).catch(() => undefined)
  window.dispatchEvent(new CustomEvent('chefops:realtime', {
    detail: {
      entity: 'Task',
      entity_id: task.id,
      outlet_id: task.outlet_id || operation.outlet_id,
      record: task,
      version: task?.__realtime?.version || 0,
      occurred_at: result?.server_time || task?.__realtime?.updated_at || now(),
      action: 'updated',
    },
  }))
}

function ensureIndicator() {
  if (indicator || !document.body) return indicator
  indicator = document.createElement('div')
  indicator.id = 'chefops-device-sync-state'
  indicator.setAttribute('role', 'status')
  indicator.setAttribute('aria-live', 'polite')
  Object.assign(indicator.style, {
    position: 'fixed',
    left: '50%',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 78px)',
    transform: 'translateX(-50%)',
    zIndex: '2147483000',
    maxWidth: 'calc(100vw - 24px)',
    padding: '8px 12px',
    borderRadius: '999px',
    fontSize: '12px',
    fontWeight: '700',
    lineHeight: '1.25',
    boxShadow: '0 6px 24px rgba(0,0,0,.18)',
    background: '#111827',
    color: '#fff',
    display: 'none',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  })
  document.body.appendChild(indicator)
  return indicator
}

async function refreshIndicator(eventPhase = '', eventDetail = {}) {
  const element = ensureIndicator()
  if (!element) return
  const rows = await listSpecializedOperations()
  const attention = rows.filter((row) => row.status === 'needs_attention')
  const syncing = rows.filter((row) => row.status === 'syncing')
  const pending = rows.filter((row) => row.status !== 'needs_attention' && row.status !== 'syncing')

  window.clearTimeout(hideSuccessTimer)
  if (attention.length) {
    element.style.display = 'block'
    element.style.background = '#7f1d1d'
    element.textContent = `需要处理 · ${attention.length} 项数据仍在设备`
    element.title = attention.at(-1)?.last_error || 'One or more saved device operations need attention'
    return
  }
  if (syncing.length || eventPhase === 'syncing') {
    element.style.display = 'block'
    element.style.background = '#1f2937'
    element.textContent = `正在同步…${pending.length + syncing.length > 1 ? ` · ${pending.length + syncing.length} 项` : ''}`
    element.title = ''
    return
  }
  if (pending.length || eventPhase === 'device_saved') {
    element.style.display = 'block'
    element.style.background = '#92400e'
    element.textContent = `已保存在设备 · 待同步${pending.length > 1 ? ` ${pending.length} 项` : ''}`
    element.title = eventDetail?.error || ''
    return
  }
  if (eventPhase === 'synced') {
    element.style.display = 'block'
    element.style.background = '#065f46'
    element.textContent = '已同步'
    element.title = ''
    hideSuccessTimer = window.setTimeout(() => { element.style.display = 'none' }, 2400)
    return
  }
  element.style.display = 'none'
}

function installOperationEvents() {
  window.addEventListener('chefops:specialized-operation-state', (event) => {
    const detail = event.detail || {}
    void refreshIndicator(detail.phase || '', detail)
  })
  window.addEventListener('chefops:specialized-operation-committed', (event) => {
    const { operation, result } = event.detail || {}
    if (!operation) return
    if (operation.kind === 'stock-count-batch') void stageCommittedStock(operation, result)
    if (operation.kind === 'task-action') void updateTaskAfterCommit(operation, result)
  })
  window.addEventListener('online', () => void refreshIndicator())
  window.addEventListener('load', () => void refreshIndicator(), { once: true })
}

function installOpsClientWrappers() {
  const originalTaskBootstrap = opsClient.tasks.operationalBootstrap.bind(opsClient.tasks)

  opsClient.tasks.operationalBootstrap = async ({ outletId, date, refresh = false } = {}) => {
    try {
      const response = await originalTaskBootstrap({ outletId, date, refresh })
      if (response) await saveOperationalTaskSnapshot(outletId, date, response).catch(() => undefined)
      return response
    } catch (error) {
      if (!transientFailure(error) || [401, 403].includes(Number(error?.status))) throw error
      const snapshot = await loadOperationalTaskSnapshot(outletId, date)
      if (!snapshot) throw error
      return {
        ...snapshot,
        storage: 'device-snapshot',
        device_snapshot: true,
        server_time: snapshot.server_time || snapshot.device_snapshot_updated_at || now(),
      }
    }
  }

  opsClient.tasks.operationalAction = async (rawPayload = {}) => {
    const payload = { ...(rawPayload || {}) }
    const action = String(payload.action || '').toLowerCase()
    const coalesceScope = taskScope(payload, action === 'save' ? 'save' : action)
    const attentionKey = taskScope(payload)
    const pending = action === 'save' ? await pendingOperation('task-action', coalesceScope) : null
    if (pending) {
      payload.response_patches = mergeTaskResponsePatches(pending.payload?.response_patches, payload.response_patches)
      if (!Object.prototype.hasOwnProperty.call(payload, 'completion_notes_patch')
        && Object.prototype.hasOwnProperty.call(pending.payload || {}, 'completion_notes_patch')) {
        payload.completion_notes_patch = pending.payload.completion_notes_patch
      }
    }

    const snapshot = await loadOperationalTaskSnapshot(payload.outlet_id, payload.date)
    const currentTask = (snapshot?.tasks || []).find((row) => String(row.id) === String(payload.task_id)) || null
    if (!currentTask && !navigator.onLine) {
      const error = new Error('This Task has not been cached on this device yet. Reconnect once, refresh Today Tasks, then offline saves can continue.')
      error.code = 'task_device_snapshot_unavailable'
      throw error
    }

    const response = await submitSpecializedOperation({
      kind: 'task-action',
      path: '/api/tasks/operational/action',
      operation_id: pending?.operation_id,
      mutation_id: pending?.mutation_id,
      payload,
      outlet_id: payload.outlet_id,
      entity_hint: 'Task',
      entity_id_hint: payload.task_id,
      scope_key: coalesceScope,
      attention_key: attentionKey,
    }, {
      queuedResult: (operation, base) => ({
        ...base,
        task: queuedTaskPreview(currentTask, operation.payload, operation.mutation_id),
        server_time: now(),
        storage: 'device-outbox',
        sheet_read: false,
        merge_mode: 'device-outbox',
      }),
    })

    if (response?.queued_device && response.task) await stageQueuedTask({
      operation_id: response.operation_id,
      mutation_id: response.mutation_id,
      outlet_id: payload.outlet_id,
      payload,
      queued_at: response.queued_at,
    }, response.task)
    if (response?.task && !response?.queued_device) await updateOperationalTaskSnapshot(payload.outlet_id, payload.date, response.task).catch(() => undefined)
    return response
  }

  opsClient.stockCounts.saveBatch = async (rawPayload = {}) => {
    let payload = { ...(rawPayload || {}) }
    const scopeKey = stockScope(payload)
    const pending = await pendingOperation('stock-count-batch', scopeKey)
    if (pending) payload = mergeStockPayload(pending.payload, payload)

    const response = await submitSpecializedOperation({
      kind: 'stock-count-batch',
      path: '/api/stock-counts/batch',
      operation_id: pending?.operation_id,
      mutation_id: pending?.mutation_id,
      payload,
      outlet_id: payload.outlet_id,
      entity_hint: 'StockCount',
      scope_key: scopeKey,
      attention_key: scopeKey,
    }, {
      queuedResult: (operation, base) => ({
        ...base,
        count_date: operation.payload.count_date,
        saved: (operation.payload.items || []).length,
        created: 0,
        updated: 0,
        list_items: 0,
        records: queuedStockRecords(operation.payload, operation.mutation_id).map((row) => ({
          stock_list_id: row.stock_list_id,
          stock_count_id: row.id,
          actual_qty: row.actual_qty,
        })),
        committed_at: '',
        source: 'device-outbox',
      }),
    })

    if (response?.queued_device) {
      await stageQueuedStock({
        operation_id: response.operation_id,
        mutation_id: response.mutation_id,
        outlet_id: payload.outlet_id,
        payload,
        queued_at: response.queued_at,
      })
    }
    return response
  }

  opsClient.closeUp.upsert = async (rawPayload = {}, { year } = {}) => {
    let payload = { ...(rawPayload || {}) }
    const scopeKey = closeUpScope(payload)
    const pending = await pendingOperation('close-up-upsert', scopeKey)
    if (pending) payload = { ...(pending.payload || {}), ...payload }
    const suffix = year ? `?year=${encodeURIComponent(String(year))}` : ''

    const response = await submitSpecializedOperation({
      kind: 'close-up-upsert',
      path: `/api/close-up/upsert${suffix}`,
      operation_id: pending?.operation_id,
      mutation_id: pending?.mutation_id,
      payload,
      outlet_id: payload.outlet_id,
      entity_hint: 'CloseUp',
      entity_id_hint: payload.record_id || '',
      scope_key: scopeKey,
      attention_key: scopeKey,
    }, {
      queuedResult: (operation, base) => ({
        ...base,
        ...queuedCloseUpPreview(operation.payload, operation.mutation_id),
      }),
    })

    if (response?.sync_status === 'queued_device') {
      await stageQueuedRecord('CloseUp', response, {
        mutation_id: response.mutation_id || response?.__device_sync?.mutation_id || pending?.mutation_id || '',
        outlet_id: payload.outlet_id,
        queued_at: response.queued_at || response?.__device_sync?.saved_at || now(),
      })
    }
    return response
  }

  opsClient.cashClose.submit = async (rawPayload = {}) => {
    const payload = { ...(rawPayload || {}) }
    const scopeKey = cashCloseScope(payload)
    return submitSpecializedOperation({
      kind: 'cash-close-submit',
      path: '/api/cash-close/submit',
      payload,
      outlet_id: payload.outlet_id,
      entity_hint: 'CloseUp',
      scope_key: scopeKey,
      attention_key: scopeKey,
    }, {
      queuedResult: (_operation, base) => ({
        ...base,
        authoritative: false,
        provisional: true,
        status: 'queued_device',
      }),
    })
  }

  opsClient.cashClose.review = async (rawPayload = {}) => {
    const payload = { ...(rawPayload || {}) }
    const scopeKey = `cash-close-review:${payload.close_id || ''}`
    return submitSpecializedOperation({
      kind: 'cash-close-review',
      path: '/api/cash-close/review',
      payload,
      outlet_id: payload.outlet_id,
      entity_hint: 'CloseUp',
      entity_id_hint: payload.close_id,
      scope_key: scopeKey,
      attention_key: scopeKey,
    }, {
      queuedResult: (_operation, base) => ({
        ...base,
        authoritative: false,
        provisional: true,
        status: 'queued_device',
      }),
    })
  }

  opsClient.cashClose.correct = async (rawPayload = {}) => {
    const payload = { ...(rawPayload || {}) }
    const scopeKey = `cash-close-correct:${payload.original_close_id || ''}`
    return submitSpecializedOperation({
      kind: 'cash-close-correct',
      path: '/api/cash-close/correct',
      payload,
      outlet_id: payload.outlet_id,
      entity_hint: 'CloseUp',
      scope_key: scopeKey,
      attention_key: scopeKey,
    }, {
      queuedResult: (_operation, base) => ({
        ...base,
        authoritative: false,
        provisional: true,
        status: 'queued_device',
      }),
    })
  }
}

export function installSpecializedOperationClient() {
  if (installed) return
  installed = true
  installSpecializedOperationQueue()
  installOpsClientWrappers()
  installOperationEvents()
  void refreshIndicator()
  if (navigator.onLine) flushSpecializedOperationQueue().catch(() => undefined)
}
