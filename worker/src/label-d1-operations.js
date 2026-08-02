import { confirmedActualName, getCurrentUser } from './auth.js'
import { json, readJson } from './http.js'
import { assertCreatePermission, assertOutletAccess } from './permissions.js'
import {
  applySourceTraceability,
  buildAutomaticLabelInput,
  finishSourceBatchPatch,
  sourceConsumptionPatch,
} from './labels.js'
import {
  d1LabelCatalog,
  findD1Record,
  mutateLabelRecord,
  now,
  parseJson,
  requestMutationId,
  resolveOutletId,
  withoutRealtime,
} from './label-d1-store.js'

const REPRINT_REASONS = new Set([
  'Label damaged', 'Printer jam', 'Print unclear',
  'Label lost', 'Wrong placement', 'Other',
])

function positivePrintQuantity(value, label = 'Print quantity') {
  const quantity = Number(value)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    const error = new Error(`${label} must be a whole number from 1 to 100`)
    error.status = 400
    error.code = 'invalid_print_quantity'
    throw error
  }
  return quantity
}

async function createPrintLog(request, env, user, label, {
  action, quantity, reason = '', note = '', printerName = '',
  printedAt = now(), sourceDeductionQty = 0, baseMutationId = '',
}) {
  const id = crypto.randomUUID()
  const record = {
    id, outlet_id: label.outlet_id || user.outlet_id || '',
    label_id: label.id, original_label_id: label.id,
    batch_code: label.serial_batch || '', barcode: label.barcode || '',
    print_action: action, print_quantity: quantity,
    reprint_reason: reason, reprint_note: note, printer_name: printerName,
    printed_at: printedAt, printed_by_user_id: user.id || '',
    printed_by_name: confirmedActualName(user), printed_by_email: user.email || '',
    source_deduction_qty: sourceDeductionQty, approval_status: 'not_required',
  }
  const result = await mutateLabelRecord(request, env, user, {
    entity: 'LabelPrintLog', entityId: id, outletId: record.outlet_id,
    operation: 'create', payload: record,
    mutationId: `${baseMutationId || 'label-print'}:log:${id}`,
  })
  return result.record
}

export async function handleD1LabelCatalog(request, env, url) {
  if (url.pathname !== '/api/labels/catalog' || request.method !== 'GET') return null
  await getCurrentUser(request, env)
  return json(request, env, await d1LabelCatalog(env, {
    summaryOnly: url.searchParams.get('summary') === '1',
  }))
}

export async function handleD1CreateLabel(request, env, url) {
  if (url.pathname !== '/api/labels/create' || request.method !== 'POST') return null
  const user = await getCurrentUser(request, env)
  assertCreatePermission(user, 'FoodLabel')
  const operatorName = confirmedActualName(user)
  const input = await readJson(request)
  const printQuantity = positivePrintQuantity(input.print_quantity || 1)
  const preparedAt = new Date()
  const catalog = await d1LabelCatalog(env)
  const { recordInput, meta } = buildAutomaticLabelInput(
    catalog, { ...input, print_quantity: printQuantity }, preparedAt,
  )
  const timestamp = preparedAt.toISOString()
  const outletId = resolveOutletId(user, input.outlet_id)
  if (!outletId) {
    const error = new Error('Outlet is required to create a label')
    error.status = 400
    error.code = 'label_outlet_required'
    throw error
  }

  Object.assign(meta, {
    initial_print_quantity: printQuantity, total_reprint_quantity: 0, reprint_count: 0,
    printer_name: String(input.printer_name || '').trim().slice(0, 120),
    printed_at: timestamp, printed_by_user_id: user.id || '', printed_by_name: operatorName,
  })
  Object.assign(recordInput, {
    outlet_id: outletId, initial_print_quantity: printQuantity,
    total_reprint_quantity: 0, reprint_count: 0,
    printer_name: String(input.printer_name || '').trim().slice(0, 120),
    printed_at: timestamp, printed_by_user_id: user.id || '', printed_by_name: operatorName,
    notes: JSON.stringify(meta),
  })

  const baseMutationId = requestMutationId(request, input, 'label-create')
  let source = null
  let consumption = null
  let sourceUpdate = null
  if (meta.requires_source && meta.source_label_id) {
    source = await findD1Record(env, 'FoodLabel', meta.source_label_id)
    applySourceTraceability({ catalog, recordInput, meta, sourceRecord: source, currentOutletId: outletId })
    consumption = sourceConsumptionPatch(source, meta)
    if (consumption) {
      meta.source_remaining_after = consumption.remaining
      meta.source_status_after = consumption.status
      recordInput.notes = JSON.stringify(meta)
      sourceUpdate = await mutateLabelRecord(request, env, user, {
        entity: 'FoodLabel', entityId: source.id,
        outletId: source.outlet_id || outletId, operation: 'update',
        expectedVersion: source.__realtime?.version,
        payload: { ...withoutRealtime(source), notes: consumption.nextNotes },
        mutationId: `${baseMutationId}:source-consume`,
      })
    }
  }

  const id = String(input.id || crypto.randomUUID())
  let created
  try {
    created = await mutateLabelRecord(request, env, user, {
      entity: 'FoodLabel', entityId: id, outletId, operation: 'create',
      payload: { ...recordInput, id, outlet_id: outletId },
      mutationId: `${baseMutationId}:label`,
    })
  } catch (error) {
    if (consumption && source && sourceUpdate) {
      await mutateLabelRecord(request, env, user, {
        entity: 'FoodLabel', entityId: source.id,
        outletId: source.outlet_id || outletId, operation: 'update',
        expectedVersion: sourceUpdate.version,
        payload: { ...withoutRealtime(source), notes: consumption.previousNotes },
        mutationId: `${baseMutationId}:source-rollback`,
      }).catch((rollbackError) => console.error('Label source rollback failed', rollbackError))
    }
    throw error
  }

  try {
    await createPrintLog(request, env, user, created.record, {
      action: 'print', quantity: printQuantity, printerName: input.printer_name,
      printedAt: timestamp, sourceDeductionQty: Number(meta.source_consumed_qty || 0),
      baseMutationId,
    })
  } catch (error) {
    console.error('Initial D1 Label print log failed', error)
  }
  return json(request, env, created.record, 201)
}

export async function handleD1ReprintLabel(request, env, url) {
  const match = url.pathname.match(/^\/api\/labels\/([^/]+)\/reprint$/)
  if (!match || request.method !== 'POST') return null
  const user = await getCurrentUser(request, env)
  assertCreatePermission(user, 'FoodLabel')
  const operatorName = confirmedActualName(user)
  const input = await readJson(request)
  const quantity = positivePrintQuantity(input.reprint_quantity, 'Reprint quantity')
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

  const label = await findD1Record(env, 'FoodLabel', decodeURIComponent(match[1]))
  if (!label) {
    const error = new Error('Food label was not found in D1')
    error.status = 404
    error.code = 'label_not_found'
    throw error
  }
  if (label.outlet_id) assertOutletAccess(user, label.outlet_id)
  const meta = parseJson(label.notes, {}) || {}
  const timestamp = now()
  const initialQuantity = Math.max(1, Number(label.initial_print_quantity || meta.initial_print_quantity || 1))
  const previousReprints = Math.max(0, Number(label.total_reprint_quantity || meta.total_reprint_quantity || 0))
  const previousCount = Math.max(0, Number(label.reprint_count || meta.reprint_count || 0))
  const nextMeta = {
    ...meta, initial_print_quantity: initialQuantity,
    total_reprint_quantity: previousReprints + quantity,
    reprint_count: previousCount + 1, last_reprint_quantity: quantity,
    last_reprint_reason: reason, last_reprint_note: note,
    last_reprinted_at: timestamp, last_reprinted_by_user_id: user.id || '',
    last_reprinted_by_name: operatorName,
  }
  const baseMutationId = requestMutationId(request, input, 'label-reprint')
  const updated = await mutateLabelRecord(request, env, user, {
    entity: 'FoodLabel', entityId: label.id, outletId: label.outlet_id,
    operation: 'update', expectedVersion: label.__realtime?.version,
    payload: {
      ...withoutRealtime(label), notes: JSON.stringify(nextMeta),
      initial_print_quantity: initialQuantity,
      total_reprint_quantity: previousReprints + quantity,
      reprint_count: previousCount + 1, last_reprinted_at: timestamp,
      last_reprinted_by_user_id: user.id || '', last_reprinted_by_name: operatorName,
      last_reprint_reason: reason, last_reprint_note: note,
    },
    mutationId: `${baseMutationId}:label`,
  })
  let printLog = null
  try {
    printLog = await createPrintLog(request, env, user, updated.record, {
      action: 'reprint', quantity, reason, note, printerName,
      printedAt: timestamp, sourceDeductionQty: 0, baseMutationId,
    })
  } catch (error) {
    console.error('D1 Label reprint log failed', error)
  }
  return json(request, env, {
    label: updated.record, print_log: printLog,
    print: { action: 'reprint', quantity, reason, note, printed_by_name: operatorName, printed_at: timestamp },
  })
}

export async function handleD1FinishSource(request, env, url) {
  const match = url.pathname.match(/^\/api\/labels\/source\/([^/]+)\/finish$/)
  if (!match || request.method !== 'POST') return null
  const user = await getCurrentUser(request, env)
  assertCreatePermission(user, 'FoodLabel')
  const source = await findD1Record(env, 'FoodLabel', decodeURIComponent(match[1]))
  if (!source) {
    const error = new Error('Source label was not found in D1')
    error.status = 404
    error.code = 'source_label_not_found'
    throw error
  }
  if (source.outlet_id) assertOutletAccess(user, source.outlet_id)
  const result = await mutateLabelRecord(request, env, user, {
    entity: 'FoodLabel', entityId: source.id, outletId: source.outlet_id,
    operation: 'update', expectedVersion: source.__realtime?.version,
    payload: { ...withoutRealtime(source), ...finishSourceBatchPatch(source) },
    mutationId: requestMutationId(request, {}, 'label-finish-source'),
  })
  return json(request, env, result.record)
}
