import { confirmedActualName, getCurrentUser } from './auth.js'
import { json, readJson } from './http.js'
import { assertCreatePermission, assertOutletAccess } from './permissions.js'
import {
  applySourceTraceability,
  buildAutomaticLabelInput,
  finishSourceBatchPatch,
  sourceBatchAvailability,
  sourceConsumptionPatch,
} from './labels.js'
import {
  applyHierarchyToCatalog,
  fifoOrderTimestamp,
  fifoReprintLocked,
  LABEL_FIFO_POLICY_VERSION,
  labelSourceStage,
  labelSourceTier,
  labelTierFromRecord,
} from './label-fifo-policy-v26.js'
import {
  d1LabelCatalog,
  findD1Record,
  listD1Rows,
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

function fail(message, code = 'label_fifo_error', status = 409, details = undefined) {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.details = details
  throw error
}

function positivePrintQuantity(value, label = 'Print quantity') {
  const quantity = Number(value)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    fail(`${label} must be a whole number from 1 to 100`, 'invalid_print_quantity', 400)
  }
  return quantity
}

function recordMeta(record = {}) {
  return parseJson(record.notes, {}) || {}
}

function applyTierMetadata(meta, recordInput, printQuantity) {
  const tier = labelSourceTier(meta.action)
  const stage = labelSourceStage(tier)
  const locked = fifoReprintLocked(tier)

  Object.assign(meta, {
    fifo_policy_version: LABEL_FIFO_POLICY_VERSION,
    source_tier: tier,
    label_source_tier: tier,
    source_stage: stage,
    required_source_tier: tier > 1 ? tier - 1 : 0,
    fifo_reprint_locked: locked,
    fifo_initial_print_limit: locked ? printQuantity : null,
    fifo_total_printed: printQuantity,
    fifo_rule: locked ? 'initial_print_only' : 'audited_reprint',
  })

  if (tier === 1 || tier === 2) {
    Object.assign(meta, {
      source_usage_mode: 'tracked',
      source_capacity: printQuantity,
      source_remaining_qty: printQuantity,
      source_unit: meta.source_unit || 'label',
      source_status: 'active',
      source_total_consumed_qty: 0,
    })
  } else if (tier === 3) {
    Object.assign(meta, {
      source_usage_mode: 'terminal',
      source_capacity: 0,
      source_remaining_qty: null,
    })
  }

  recordInput.notes = JSON.stringify(meta)
  return tier
}

function sourceExpiry(record, meta) {
  const parsed = Date.parse(String(meta.expires_at || record.expiry_date || ''))
  return Number.isFinite(parsed) ? parsed : null
}

function sourceMatchesRule(record, rule, requiredTier, outletId) {
  if (!record || record.deleted_at) return false
  if (outletId && record.outlet_id && String(record.outlet_id) !== String(outletId)) return false
  if (labelTierFromRecord(record) !== requiredTier) return false

  const meta = recordMeta(record)
  if (requiredTier === 2 && !String(meta.source_label_id || '').trim()) return false

  const availability = sourceBatchAvailability(record)
  if (['depleted', 'expired', 'void'].includes(availability.status)) return false
  if (availability.tracked && availability.remaining !== null && availability.remaining <= 0) return false

  const expiry = sourceExpiry(record, meta)
  if (expiry !== null && expiry <= Date.now()) return false

  if (rule.sourceProductId && String(meta.product_id || '') !== String(rule.sourceProductId)) return false
  if (!rule.sourceProductId && rule.sourceProductName) {
    const sourceName = String(record.item_name || meta.product_name || '').toLowerCase()
    if (!sourceName.includes(String(rule.sourceProductName).toLowerCase())) return false
  }
  return true
}

function fifoHead(candidates, rule, requiredTier, outletId) {
  return candidates
    .filter((record) => sourceMatchesRule(record, rule, requiredTier, outletId))
    .sort((left, right) => {
      const timeDifference = fifoOrderTimestamp(left) - fifoOrderTimestamp(right)
      if (timeDifference) return timeDifference
      return String(left.serial_batch || left.id || '').localeCompare(
        String(right.serial_batch || right.id || ''),
        undefined,
        { numeric: true },
      )
    })[0] || null
}

function assertSourceHierarchy(sourceRecord, childTier) {
  if (!sourceRecord) {
    fail('The selected source label is no longer available', 'source_label_unavailable', 409)
  }
  const requiredTier = childTier - 1
  const actualTier = labelTierFromRecord(sourceRecord)
  if (actualTier !== requiredTier) {
    fail(
      childTier === 2
        ? 'Open must use a first-hand Prepare, Freeze or Received label.'
        : 'Refill and Cooked must use a second-hand Open label.',
      'source_label_tier_mismatch',
      409,
      { required_tier: requiredTier, actual_tier: actualTier },
    )
  }
  if (childTier === 3 && !String(recordMeta(sourceRecord).source_label_id || '').trim()) {
    fail(
      'This Open label has no first-hand source link. Create a correctly linked Open label first.',
      'source_chain_incomplete',
      409,
    )
  }
}

function assertFifoSelection(selectedRecord, requiredRecord) {
  if (!requiredRecord || String(requiredRecord.id || '') === String(selectedRecord.id || '')) return
  const meta = recordMeta(requiredRecord)
  const batch = String(requiredRecord.serial_batch || meta.source_short_code || requiredRecord.id || '')
  fail(
    `FIFO blocked: use the older batch ${batch} first. The selected source is newer.`,
    'fifo_source_order_violation',
    409,
    {
      required_source_label_id: requiredRecord.id,
      required_source_batch: batch,
      selected_source_label_id: selectedRecord.id,
      selected_source_batch: selectedRecord.serial_batch || '',
    },
  )
}

async function createPrintLog(request, env, user, label, {
  action, quantity, reason = '', note = '', printerName = '',
  printedAt = now(), sourceDeductionQty = 0, baseMutationId = '',
  approvalStatus = 'not_required',
}) {
  const id = crypto.randomUUID()
  const record = {
    id,
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
    approval_status: approvalStatus,
  }
  const result = await mutateLabelRecord(request, env, user, {
    entity: 'LabelPrintLog',
    entityId: id,
    outletId: record.outlet_id,
    operation: 'create',
    payload: record,
    mutationId: `${baseMutationId || 'label-print'}:log:${id}`,
  })
  return result.record
}

async function fifoCatalog(env, options = {}) {
  return applyHierarchyToCatalog(await d1LabelCatalog(env, options))
}

export async function handleD1LabelCatalog(request, env, url) {
  if (url.pathname !== '/api/labels/catalog' || request.method !== 'GET') return null
  await getCurrentUser(request, env)
  return json(request, env, await fifoCatalog(env, {
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
  const catalog = await fifoCatalog(env)
  const { recordInput, meta } = buildAutomaticLabelInput(
    catalog,
    { ...input, print_quantity: printQuantity },
    preparedAt,
  )
  const tier = applyTierMetadata(meta, recordInput, printQuantity)
  const timestamp = preparedAt.toISOString()
  const outletId = resolveOutletId(user, input.outlet_id)
  if (!outletId) fail('Outlet is required to create a label', 'label_outlet_required', 400)

  Object.assign(meta, {
    initial_print_quantity: printQuantity,
    total_reprint_quantity: 0,
    reprint_count: 0,
    printer_name: String(input.printer_name || '').trim().slice(0, 120),
    printed_at: timestamp,
    printed_by_user_id: user.id || '',
    printed_by_name: operatorName,
  })
  Object.assign(recordInput, {
    outlet_id: outletId,
    initial_print_quantity: printQuantity,
    total_reprint_quantity: 0,
    reprint_count: 0,
    printer_name: String(input.printer_name || '').trim().slice(0, 120),
    printed_at: timestamp,
    printed_by_user_id: user.id || '',
    printed_by_name: operatorName,
    notes: JSON.stringify(meta),
  })

  const baseMutationId = requestMutationId(request, input, 'label-create-fifo-v26')
  const rule = (catalog.rules || []).find(
    (candidate) => String(candidate.ruleKey || candidate.ruleId) === String(meta.rule_key),
  ) || (catalog.rules || []).find(
    (candidate) => String(candidate.ruleId) === String(meta.rule_id),
  )

  let source = null
  let consumption = null
  let sourceUpdate = null
  if (tier > 1) {
    if (!String(meta.source_label_id || '').trim()) {
      fail(
        tier === 2
          ? 'Open requires a first-hand source label.'
          : 'Refill and Cooked require a second-hand Open label.',
        'source_label_required',
        400,
      )
    }
    source = await findD1Record(env, 'FoodLabel', meta.source_label_id)
    assertSourceHierarchy(source, tier)
    if (source.outlet_id) assertOutletAccess(user, source.outlet_id)

    const candidates = await listD1Rows(env, 'FoodLabel', { outletId, limit: 5000 })
    if (!candidates.some((candidate) => String(candidate.id || '') === String(source.id || ''))) {
      candidates.push(source)
    }
    const requiredSource = fifoHead(candidates, rule || {}, tier - 1, outletId)
    assertFifoSelection(source, requiredSource)

    applySourceTraceability({
      catalog,
      recordInput,
      meta,
      sourceRecord: source,
      currentOutletId: outletId,
    })
    consumption = sourceConsumptionPatch(source, meta)
    if (consumption) {
      meta.source_remaining_after = consumption.remaining
      meta.source_status_after = consumption.status
      recordInput.notes = JSON.stringify(meta)
      sourceUpdate = await mutateLabelRecord(request, env, user, {
        entity: 'FoodLabel',
        entityId: source.id,
        outletId: source.outlet_id || outletId,
        operation: 'update',
        expectedVersion: source.__realtime?.version,
        payload: { ...withoutRealtime(source), notes: consumption.nextNotes },
        mutationId: `${baseMutationId}:source-consume`,
      })
    }
  } else {
    meta.source_label_id = ''
    recordInput.notes = JSON.stringify(meta)
  }

  const id = String(input.id || crypto.randomUUID())
  let created
  try {
    created = await mutateLabelRecord(request, env, user, {
      entity: 'FoodLabel',
      entityId: id,
      outletId,
      operation: 'create',
      payload: { ...recordInput, id, outlet_id: outletId },
      mutationId: `${baseMutationId}:label`,
    })
  } catch (error) {
    if (consumption && source && sourceUpdate) {
      await mutateLabelRecord(request, env, user, {
        entity: 'FoodLabel',
        entityId: source.id,
        outletId: source.outlet_id || outletId,
        operation: 'update',
        expectedVersion: sourceUpdate.version,
        payload: { ...withoutRealtime(source), notes: consumption.previousNotes },
        mutationId: `${baseMutationId}:source-rollback`,
      }).catch((rollbackError) => console.error('Label source rollback failed', rollbackError))
    }
    throw error
  }

  try {
    await createPrintLog(request, env, user, created.record, {
      action: 'print',
      quantity: printQuantity,
      printerName: input.printer_name,
      printedAt: timestamp,
      sourceDeductionQty: Number(meta.source_consumed_qty || 0),
      baseMutationId,
      approvalStatus: fifoReprintLocked(tier) ? 'fifo_locked_at_creation' : 'not_required',
    })
  } catch (error) {
    console.error('Initial D1 FIFO Label print log failed', error)
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

  if (!REPRINT_REASONS.has(reason)) fail('Select a reprint reason', 'reprint_reason_required', 400)
  if (reason === 'Other' && !note) fail('Enter a note when the reprint reason is Other', 'reprint_note_required', 400)

  const label = await findD1Record(env, 'FoodLabel', decodeURIComponent(match[1]))
  if (!label) fail('Food label was not found in D1', 'label_not_found', 404)
  if (label.outlet_id) assertOutletAccess(user, label.outlet_id)

  const tier = labelTierFromRecord(label)
  const meta = recordMeta(label)
  if (fifoReprintLocked(tier)) {
    const initial = Math.max(1, Number(label.initial_print_quantity || meta.initial_print_quantity || 1))
    fail(
      `FIFO lock: this ${labelSourceStage(tier).replace('_', '-')} label was already printed ${initial} time(s). First-hand and second-hand labels cannot print extra copies.`,
      'fifo_reprint_locked',
      409,
      {
        label_id: label.id,
        batch: label.serial_batch || '',
        source_tier: tier,
        initial_print_quantity: initial,
        total_reprint_quantity: Number(label.total_reprint_quantity || meta.total_reprint_quantity || 0),
      },
    )
  }

  const timestamp = now()
  const initialQuantity = Math.max(1, Number(label.initial_print_quantity || meta.initial_print_quantity || 1))
  const previousReprints = Math.max(0, Number(label.total_reprint_quantity || meta.total_reprint_quantity || 0))
  const previousCount = Math.max(0, Number(label.reprint_count || meta.reprint_count || 0))
  const nextMeta = {
    ...meta,
    initial_print_quantity: initialQuantity,
    total_reprint_quantity: previousReprints + quantity,
    reprint_count: previousCount + 1,
    last_reprint_quantity: quantity,
    last_reprint_reason: reason,
    last_reprint_note: note,
    last_reprinted_at: timestamp,
    last_reprinted_by_user_id: user.id || '',
    last_reprinted_by_name: operatorName,
    fifo_total_printed: initialQuantity + previousReprints + quantity,
  }
  const baseMutationId = requestMutationId(request, input, 'label-reprint-fifo-v26')
  const updated = await mutateLabelRecord(request, env, user, {
    entity: 'FoodLabel',
    entityId: label.id,
    outletId: label.outlet_id,
    operation: 'update',
    expectedVersion: label.__realtime?.version,
    payload: {
      ...withoutRealtime(label),
      notes: JSON.stringify(nextMeta),
      initial_print_quantity: initialQuantity,
      total_reprint_quantity: previousReprints + quantity,
      reprint_count: previousCount + 1,
      last_reprinted_at: timestamp,
      last_reprinted_by_user_id: user.id || '',
      last_reprinted_by_name: operatorName,
      last_reprint_reason: reason,
      last_reprint_note: note,
    },
    mutationId: `${baseMutationId}:label`,
  })

  let printLog = null
  try {
    printLog = await createPrintLog(request, env, user, updated.record, {
      action: 'reprint',
      quantity,
      reason,
      note,
      printerName,
      printedAt: timestamp,
      sourceDeductionQty: 0,
      baseMutationId,
    })
  } catch (error) {
    console.error('D1 FIFO Label reprint log failed', error)
  }

  return json(request, env, {
    label: updated.record,
    print_log: printLog,
    print: {
      action: 'reprint',
      quantity,
      reason,
      note,
      printed_by_name: operatorName,
      printed_at: timestamp,
    },
  })
}

export async function handleD1FinishSource(request, env, url) {
  const match = url.pathname.match(/^\/api\/labels\/source\/([^/]+)\/finish$/)
  if (!match || request.method !== 'POST') return null
  const user = await getCurrentUser(request, env)
  assertCreatePermission(user, 'FoodLabel')
  const source = await findD1Record(env, 'FoodLabel', decodeURIComponent(match[1]))
  if (!source) fail('Source label was not found in D1', 'source_label_not_found', 404)
  if (source.outlet_id) assertOutletAccess(user, source.outlet_id)
  const result = await mutateLabelRecord(request, env, user, {
    entity: 'FoodLabel',
    entityId: source.id,
    outletId: source.outlet_id,
    operation: 'update',
    expectedVersion: source.__realtime?.version,
    payload: { ...withoutRealtime(source), ...finishSourceBatchPatch(source) },
    mutationId: requestMutationId(request, {}, 'label-finish-source'),
  })
  return json(request, env, result.record)
}
