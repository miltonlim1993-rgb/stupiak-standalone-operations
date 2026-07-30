import { confirmedActualName, getCurrentUser } from './auth.js'
import { json, readJson } from './http.js'
import {
  applySourceTraceability,
  buildAutomaticLabelInput,
  getLabelCatalog,
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
  assignedOutletIds,
  assertAssignedOutletAccess,
  assertCreatePermission,
  assertOutletAccess,
} from './permissions.js'
import { getSchema } from './schema.js'
import {
  appendRecord,
  ensureEntitySheet,
  findRecord,
  listRecords,
  updateRecord,
} from './sheets.js'
import { configuredOperationYears } from './storage.js'

function now() {
  return new Date().toISOString()
}

function fail(message, code = 'label_fifo_error', status = 409, details = undefined) {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.details = details
  throw error
}

function parseMeta(record = {}) {
  try {
    const parsed = JSON.parse(record.notes || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function recordYear(record = {}) {
  return Number(String(record.prep_date || record.printed_at || record.created_date || '').slice(0, 4)) || undefined
}

function positiveQuantity(value, fieldName = 'Print quantity') {
  const quantity = Number(value)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    fail(`${fieldName} must be a whole number from 1 to 100`, 'invalid_print_quantity', 400)
  }
  return quantity
}

function resolveOutletId(user, requested = '') {
  const value = String(requested || '').trim()
  if (user.role === 'manager' || user.role === 'owner') {
    return value || user.outlet_id || assignedOutletIds(user)[0] || ''
  }
  const target = value || user.outlet_id || assignedOutletIds(user)[0] || ''
  if (!target) fail('Your account is not assigned to an outlet', 'missing_outlet', 400)
  assertAssignedOutletAccess(user, target)
  return target
}

function newRecord(entity, input, user) {
  const schema = getSchema(entity)
  const timestamp = now()
  const record = Object.fromEntries(schema.headers.map((field) => [field, '']))
  Object.assign(record, input)
  const idField = schema.idField || 'id'
  record[idField] = input[idField] || input.id || crypto.randomUUID()
  if (schema.headers.includes('created_date')) record.created_date = input.created_date || timestamp
  if (schema.headers.includes('created_by')) record.created_by = input.created_by || user.email || ''
  if (schema.headers.includes('updated_date')) record.updated_date = input.updated_date || timestamp
  if (schema.headers.includes('updated_by')) record.updated_by = input.updated_by || user.email || ''
  if (schema.headers.includes('deleted_at')) record.deleted_at = input.deleted_at || ''
  if (schema.headers.includes('version')) record.version = Number(input.version || 1)
  return record
}

async function appendAudit(env, user, action, entity, entityId, payload = {}) {
  const timestamp = now()
  const log = newRecord('AuditLog', {
    outlet_id: typeof payload.outlet_id === 'string' ? payload.outlet_id : (user.outlet_id || ''),
    actor_sub: user.google_sub || '',
    actor_email: user.email || '',
    actor_name: user.full_name || user.email || '',
    action,
    entity,
    entity_id: entityId,
    summary: `${action} ${entity}`,
    payload_json: JSON.stringify(payload),
    created_date: timestamp,
    updated_date: timestamp,
  }, user)
  await appendRecord(env, 'AuditLog', log, { year: Number(timestamp.slice(0, 4)) })
  return log
}

async function appendPrintLog(env, user, label, quantity, printerName, printedAt, tier) {
  const log = newRecord('LabelPrintLog', {
    outlet_id: label.outlet_id || user.outlet_id || '',
    label_id: label.id,
    original_label_id: label.id,
    batch_code: label.serial_batch || '',
    barcode: label.barcode || '',
    print_action: 'print',
    print_quantity: quantity,
    reprint_reason: '',
    reprint_note: '',
    printer_name: printerName,
    printed_at: printedAt,
    printed_by_user_id: user.id || '',
    printed_by_name: confirmedActualName(user),
    printed_by_email: user.email || '',
    source_deduction_qty: Number(parseMeta(label).source_consumed_qty || 0),
    approval_status: fifoReprintLocked(tier) ? 'fifo_locked_at_creation' : 'not_required',
  }, user)
  await appendRecord(env, 'LabelPrintLog', log, { year: recordYear(label) })
  return log
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

  const meta = parseMeta(record)
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

async function loadFifoCandidates(env, outletId, currentYear, selectedRecord) {
  const years = new Set([currentYear, currentYear - 1, recordYear(selectedRecord)])
  try {
    for (const year of configuredOperationYears(env) || []) years.add(Number(year))
  } catch {
    // Current and previous year are sufficient when operation-year settings are unavailable.
  }

  const rows = []
  for (const year of [...years].filter((value) => Number.isInteger(value) && value > 2000).sort((a, b) => a - b)) {
    try {
      rows.push(...await listRecords(env, 'FoodLabel', {
        filter: { outlet_id: outletId },
        sort: 'prep_date,created_date',
        limit: 5000,
        year,
      }))
    } catch (error) {
      console.warn('Unable to inspect FIFO source year', year, error?.message || error)
    }
  }
  if (selectedRecord) rows.push(selectedRecord)
  return [...new Map(rows.map((row) => [String(row.id || ''), row])).values()]
}

function fifoHead(candidates, rule, requiredTier, outletId) {
  return candidates
    .filter((record) => sourceMatchesRule(record, rule, requiredTier, outletId))
    .sort((left, right) => {
      const timeDifference = fifoOrderTimestamp(left) - fifoOrderTimestamp(right)
      if (timeDifference) return timeDifference
      return String(left.serial_batch || left.id || '').localeCompare(String(right.serial_batch || right.id || ''), undefined, { numeric: true })
    })[0] || null
}

function assertSourceHierarchy(sourceRecord, childTier) {
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
  if (childTier === 3 && !String(parseMeta(sourceRecord).source_label_id || '').trim()) {
    fail('This Open label has no first-hand source link. Create a correctly linked Open label first.', 'source_chain_incomplete', 409)
  }
}

function assertFifoSelection(selectedRecord, requiredRecord) {
  if (!requiredRecord || String(requiredRecord.id || '') === String(selectedRecord.id || '')) return
  const meta = parseMeta(requiredRecord)
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

async function createLabel(request, env) {
  const user = await getCurrentUser(request, env)
  assertCreatePermission(user, 'FoodLabel')
  const operatorName = confirmedActualName(user)
  const input = await readJson(request)
  const printQuantity = positiveQuantity(input.print_quantity || 1)
  input.print_quantity = printQuantity
  input.printer_name = String(input.printer_name || '').trim().slice(0, 120)

  const preparedAt = new Date()
  const year = Number(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
  }).format(preparedAt))

  await Promise.all([
    ensureEntitySheet(env, 'FoodLabel', { year }),
    ensureEntitySheet(env, 'LabelPrintLog', { year }),
  ])

  const catalog = applyHierarchyToCatalog(await getLabelCatalog(env))
  const { recordInput, meta } = buildAutomaticLabelInput(catalog, input, preparedAt)
  const tier = applyTierMetadata(meta, recordInput, printQuantity)
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

  const outletId = resolveOutletId(user, input.outlet_id)
  recordInput.outlet_id = outletId
  const rule = (catalog.rules || []).find((candidate) => String(candidate.ruleKey || candidate.ruleId) === String(meta.rule_key))
    || (catalog.rules || []).find((candidate) => String(candidate.ruleId) === String(meta.rule_id))

  let sourceFound = null
  let sourceConsumption = null
  if (tier > 1) {
    if (!String(meta.source_label_id || '').trim()) {
      fail(tier === 2 ? 'Open requires a first-hand source label.' : 'Refill and Cooked require a second-hand Open label.', 'source_label_required', 400)
    }
    sourceFound = await findRecord(env, 'FoodLabel', meta.source_label_id)
    if (sourceFound.record.outlet_id) assertAssignedOutletAccess(user, sourceFound.record.outlet_id)
    assertSourceHierarchy(sourceFound.record, tier)

    const candidates = await loadFifoCandidates(env, outletId, year, sourceFound.record)
    const requiredSource = fifoHead(candidates, rule || {}, tier - 1, outletId)
    assertFifoSelection(sourceFound.record, requiredSource)

    applySourceTraceability({
      catalog,
      recordInput,
      meta,
      sourceRecord: sourceFound.record,
      currentOutletId: outletId,
    })
    sourceConsumption = sourceConsumptionPatch(sourceFound.record, meta)
    if (sourceConsumption) {
      meta.source_remaining_after = sourceConsumption.remaining
      meta.source_status_after = sourceConsumption.status
      recordInput.notes = JSON.stringify(meta)
    }
  } else {
    meta.source_label_id = ''
    recordInput.notes = JSON.stringify(meta)
  }

  const record = newRecord('FoodLabel', recordInput, user)
  if (sourceConsumption && sourceFound?.record) {
    await updateRecord(env, 'FoodLabel', sourceFound.record.id, {
      notes: sourceConsumption.nextNotes,
      updated_date: now(),
      updated_by: user.email,
      version: Number(sourceFound.record.version || 0) + 1,
    }, { year: recordYear(sourceFound.record) })
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
      }, { year: recordYear(sourceFound.record) }).catch(() => undefined)
    }
    throw appendError
  }

  let printLog = null
  try {
    printLog = await appendPrintLog(env, user, record, printQuantity, input.printer_name, timestamp, tier)
  } catch (error) {
    console.error('FIFO label print log append failed', error)
  }

  try {
    await appendAudit(env, user, 'create_label_fifo_v26', 'FoodLabel', record.id, {
      outlet_id: outletId,
      rule_id: meta.rule_id,
      action: meta.action,
      source_tier: tier,
      source_stage: labelSourceStage(tier),
      source_label_id: meta.source_label_id || '',
      source_short_code: meta.source_short_code || '',
      print_quantity: printQuantity,
      fifo_reprint_locked: fifoReprintLocked(tier),
      fifo_policy_version: LABEL_FIFO_POLICY_VERSION,
      source_deduction_qty: Number(meta.source_consumed_qty || 0),
      print_log_saved: Boolean(printLog),
    })
  } catch (error) {
    console.error('FIFO label audit append failed', error)
  }

  return json(request, env, record, 201)
}

async function blockLockedReprint(request, env, url) {
  const match = url.pathname.match(/^\/api\/labels\/([^/]+)\/reprint$/)
  if (!match || request.method !== 'POST') return null
  const user = await getCurrentUser(request, env)
  assertCreatePermission(user, 'FoodLabel')
  const found = await findRecord(env, 'FoodLabel', decodeURIComponent(match[1]))
  const label = found.record
  if (label.outlet_id) assertOutletAccess(user, label.outlet_id)
  const tier = labelTierFromRecord(label)
  if (!fifoReprintLocked(tier)) return null

  const meta = parseMeta(label)
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

export async function handleLabelFifoV26(request, env, url = new URL(request.url)) {
  if (url.pathname === '/api/labels/catalog' && request.method === 'GET') {
    await getCurrentUser(request, env)
    const summaryOnly = url.searchParams.get('summary') === '1'
    const catalog = applyHierarchyToCatalog(await getLabelCatalog(env, { summaryOnly }))
    return json(request, env, catalog)
  }

  if (url.pathname === '/api/labels/create' && request.method === 'POST') {
    return createLabel(request, env)
  }

  return blockLockedReprint(request, env, url)
}
