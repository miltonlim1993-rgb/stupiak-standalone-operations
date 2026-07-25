import { googleFetch } from './google.js'
import { listRecords } from './sheets.js'

const DEFAULT_LABEL_SPREADSHEET_ID = '17lM8AUdJ2vOQ9sFx4jogP8S2P8KSPnRmVQ569q1Fgk8'
const DEFAULT_PRODUCT_SHEET = 'ProductMaster'
const DEFAULT_RULES_SHEET = 'ExpiryRules'
const DEFAULT_TIME_ZONE = 'Asia/Kuala_Lumpur'

function a1(sheet, range) {
  return `'${String(sheet).replaceAll("'", "''")}'!${range}`
}

function valuesUrl(spreadsheetId, range) {
  return `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
}

function asBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true'
}

function asNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function rowsToObjects(values) {
  if (!Array.isArray(values) || values.length < 2) return []
  const headers = values[0].map((value) => String(value || '').trim())
  return values.slice(1).map((row) => Object.fromEntries(
    headers.filter(Boolean).map((header, index) => [header, row[index] ?? '']),
  ))
}

async function readValues(env, spreadsheetId, sheet, range = 'A1:ZZ') {
  const response = await googleFetch(env, valuesUrl(spreadsheetId, a1(sheet, range)))
  const data = await response.json()
  return data.values || []
}

async function readSourceSettings(env) {
  const settings = await listRecords(env, 'AppSetting', {
    filter: { category: 'labels' },
    sort: 'key',
    limit: 50,
  })
  const map = Object.fromEntries(settings.map((row) => [row.key, row.value]))
  return {
    spreadsheetId: String(
      map.label_rules_spreadsheet_id
      || env.GOOGLE_LABEL_SPREADSHEET_ID
      || DEFAULT_LABEL_SPREADSHEET_ID,
    ).trim(),
    productSheet: String(map.label_product_master_sheet || DEFAULT_PRODUCT_SHEET).trim(),
    rulesSheet: String(map.label_expiry_rules_sheet || DEFAULT_RULES_SHEET).trim(),
    timeZone: String(map.label_time_zone || DEFAULT_TIME_ZONE).trim(),
  }
}

export async function getLabelCatalog(env, { summaryOnly = false } = {}) {
  const source = await readSourceSettings(env)
  if (!source.spreadsheetId) {
    const error = new Error('Label rules spreadsheet is not configured')
    error.status = 503
    error.code = 'label_source_not_configured'
    throw error
  }

  const [productValues, ruleValues] = await Promise.all([
    readValues(env, source.spreadsheetId, source.productSheet, 'A1:Z2000'),
    readValues(env, source.spreadsheetId, source.rulesSheet, 'A1:AZ3000'),
  ])

  const products = rowsToObjects(productValues)
    .filter((row) => row.productId && asBoolean(row.enabled))
    .map((row) => ({
      productId: String(row.productId),
      productName: String(row.productName || row.displayName || row.productId),
      displayName: String(row.displayName || row.productName || row.productId),
      category: String(row.category || ''),
      sku: String(row.sku || ''),
      productBarcode: String(row.productBarcode || ''),
      alternateBarcodes: String(row.alternateBarcodes || ''),
      defaultLabelTitle: String(row.defaultLabelTitle || row.displayName || row.productName || ''),
      note: String(row.note || ''),
    }))

  const rules = rowsToObjects(ruleValues)
    .filter((row) => row.ruleId && asBoolean(row.enabled))
    .map((row, index) => ({
      ruleId: String(row.ruleId),
      ruleKey: `${String(row.ruleId)}::${String(row.action || '')}::${String(row.storageCondition || '')}::${index + 2}`,
      productId: String(row.productId || ''),
      productName: String(row.productName || ''),
      action: String(row.action || ''),
      storageCondition: String(row.storageCondition || ''),
      durationMinutes: asNumber(row.durationMinutes),
      manualExpiryRequired: asBoolean(row.manualExpiryRequired),
      requiresQuantity: asBoolean(row.requiresQuantity),
      quantityLabel: String(row.quantityLabel || ''),
      quantityUnit: String(row.quantityUnit || ''),
      showQuantityOnLabel: asBoolean(row.showQuantityOnLabel),
      note: String(row.note || ''),
      requiresSource: asBoolean(row.requiresSource),
      allowedSourceActions: String(row.allowedSourceActions || ''),
      sourceAllowedOutlets: String(row.sourceAllowedOutlets || ''),
      sourceExpiryMode: String(row.sourceExpiryMode || ''),
      sourceProductId: String(row.sourceProductId || ''),
      sourceProductName: String(row.sourceProductName || ''),
      outputProductId: String(row.outputProductId || ''),
      outputProductName: String(row.outputProductName || ''),
      sourceUsageMode: String(row.sourceUsageMode || ''),
      sourceCapacity: asNumber(row.sourceCapacity),
      consumePerLabel: asNumber(row.consumePerLabel || 1),
      sourceUnit: String(row.sourceUnit || row.quantityUnit || ''),
    }))

  const actions = [...new Set(rules.map((row) => row.action).filter(Boolean))].sort()
  const storageConditions = [...new Set(rules.map((row) => row.storageCondition).filter(Boolean))].sort()
  const summary = {
    productCount: products.length,
    ruleCount: rules.length,
    actions,
    storageConditions,
  }

  return {
    source: {
      spreadsheetId: source.spreadsheetId,
      productSheet: source.productSheet,
      rulesSheet: source.rulesSheet,
      timeZone: source.timeZone,
      status: 'connected',
    },
    summary,
    ...(summaryOnly ? {} : { products, rules }),
  }
}

function fail(message, code = 'invalid_label_request', status = 400) {
  const error = new Error(message)
  error.status = status
  error.code = code
  throw error
}

function storageKey(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return ''
  if (raw.includes('freezer')) return 'freezer'
  if (raw.includes('frozen')) return 'frozen'
  if (raw.includes('refriger')) return 'refrigerated'
  if (raw.includes('chill')) return 'chiller'
  if (raw.includes('defrost')) return 'defrost'
  if (raw.includes('room')) return 'room_temp'
  if (raw.includes('dry')) return 'dry_storage'
  if (raw.includes('heat') || raw.includes('hot')) return 'heated'
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
}

function dateKey(date, timeZone) {
  const parts = zonedParts(date, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function productBatchPrefix(name) {
  const words = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  if (!words.length) return 'LBL'
  if (words.length === 1) return words[0].slice(0, 4)
  return words.slice(0, 4).map((word) => word[0]).join('').slice(0, 4)
}

function readableBatchCode(name, date, timeZone, barcodeValue) {
  const parts = zonedParts(date, timeZone)
  const datePart = `${String(parts.year).slice(-2)}${parts.month}${parts.day}`
  const token = String(barcodeValue || '').replace(/\D/g, '').slice(-4).padStart(4, '0')
  return `${productBatchPrefix(name)}-${datePart}-${token}`
}

function ean13CheckDigit(firstTwelve) {
  const digits = String(firstTwelve).split('').map(Number)
  const sum = digits.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0)
  return String((10 - (sum % 10)) % 10)
}

function barcode(date) {
  const epoch = String(date.getTime()).replace(/\D/g, '')
  const random = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0')
  const base = (`29${epoch}${random}`).slice(-12).padStart(12, '0')
  return `${base}${ean13CheckDigit(base)}`
}

function parseManualExpiry(value, preparedAt) {
  const expiry = new Date(String(value || ''))
  if (Number.isNaN(expiry.getTime())) fail('A valid manual use-by date and time is required', 'invalid_manual_expiry')
  if (expiry.getTime() <= preparedAt.getTime()) fail('Use-by time must be later than the prepared time', 'manual_expiry_not_future')
  return expiry
}

function parseRecordMeta(record) {
  try {
    const parsed = JSON.parse(record?.notes || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}


function sourceStatus(meta = {}) {
  return String(meta.source_status || meta.batch_status || 'active').trim().toLowerCase()
}

export function sourceBatchAvailability(record) {
  const meta = parseRecordMeta(record)
  const status = sourceStatus(meta)
  const remainingRaw = meta.source_remaining_qty
  const remaining = remainingRaw === '' || remainingRaw === null || remainingRaw === undefined ? null : Number(remainingRaw)
  const capacity = Number(meta.source_capacity || 0)
  const tracked = String(meta.source_usage_mode || '').toLowerCase() === 'tracked' || (Number.isFinite(capacity) && capacity > 0)
  return { meta, status, tracked, remaining: remaining !== null && Number.isFinite(remaining) ? remaining : null }
}

export function sourceConsumptionPatch(sourceRecord, childMeta = {}) {
  const { meta, status, tracked, remaining } = sourceBatchAvailability(sourceRecord)
  if (['depleted', 'expired', 'void'].includes(status)) {
    fail('This source batch has already been used up or closed.', 'source_label_depleted', 409)
  }
  if (!tracked) return null
  const consume = Math.max(0, Number(childMeta.source_consumed_qty || 0))
  const current = remaining ?? Number(meta.source_capacity || sourceRecord.quantity || 0)
  if (!Number.isFinite(current) || current < consume) {
    fail(`This source batch has only ${Number.isFinite(current) ? current : 0} remaining. Choose another batch.`, 'source_label_insufficient', 409)
  }
  const next = Math.max(0, Math.round((current - consume + Number.EPSILON) * 1000) / 1000)
  const updatedMeta = {
    ...meta,
    source_remaining_qty: next,
    source_status: next <= 0 ? 'depleted' : 'active',
    source_last_consumed_at: new Date().toISOString(),
    source_total_consumed_qty: Math.round((Number(meta.source_total_consumed_qty || 0) + consume + Number.EPSILON) * 1000) / 1000,
  }
  return { previousNotes: sourceRecord.notes || '{}', nextNotes: JSON.stringify(updatedMeta), remaining: next, status: updatedMeta.source_status, consumed: consume }
}

export function finishSourceBatchPatch(sourceRecord) {
  const meta = parseRecordMeta(sourceRecord)
  return {
    notes: JSON.stringify({ ...meta, source_status: 'depleted', source_remaining_qty: 0, source_finished_at: new Date().toISOString() }),
  }
}

function sourcePrefix(name) {
  const words = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return 'SRC'
  if (words.length === 1) return words[0].slice(0, 3).padEnd(3, 'X')
  return words.slice(0, 3).map((word) => word[0]).join('').padEnd(3, 'X')
}

function sourceShortCode(sourceRecord, sourceMeta, timeZone) {
  const prepared = new Date(sourceMeta.prepared_at || sourceRecord.created_date || sourceRecord.prep_date || '')
  const parts = Number.isNaN(prepared.getTime())
    ? { year: '00', month: '00', day: '00' }
    : zonedParts(prepared, timeZone)
  const datePart = `${String(parts.year).slice(-2)}${parts.month}${parts.day}`
  const token = String(sourceRecord.serial_batch || sourceRecord.barcode || sourceRecord.id || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(-2)
    .padStart(2, '0')
  return `${sourcePrefix(sourceRecord.item_name || sourceMeta.product_name)}-${datePart}-${token}`
}

function parsedExpiry(record, meta) {
  const expiry = new Date(meta.expires_at || record.expiry_date || '')
  return Number.isNaN(expiry.getTime()) ? null : expiry
}

function normalizedList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function expiryMode(value) {
  return String(value || 'none').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

export function applySourceTraceability({ catalog, recordInput, meta, sourceRecord, currentOutletId = '' }) {
  if (!meta.requires_source) return { recordInput, meta }
  if (!sourceRecord || sourceRecord.deleted_at) {
    fail('The selected source label is no longer available', 'source_label_unavailable', 409)
  }

  if (currentOutletId && sourceRecord.outlet_id && String(sourceRecord.outlet_id) !== String(currentOutletId)) {
    fail('The source label belongs to another outlet', 'source_label_wrong_outlet', 409)
  }

  const rule = (catalog.rules || []).find((candidate) => String(candidate.ruleKey || candidate.ruleId) === String(meta.rule_key))
    || (catalog.rules || []).find((candidate) => String(candidate.ruleId) === String(meta.rule_id))
  const sourceMeta = parseRecordMeta(sourceRecord)
  const availability = sourceBatchAvailability(sourceRecord)
  if (['depleted', 'expired', 'void'].includes(availability.status) || (availability.tracked && availability.remaining !== null && availability.remaining <= 0)) {
    fail('This source batch has been used up. Choose another batch.', 'source_label_depleted', 409)
  }
  const allowedActions = normalizedList(rule?.allowedSourceActions)

  if (allowedActions.length && !allowedActions.includes(String(sourceMeta.action || '').toLowerCase())) {
    fail('The selected source label does not match this process', 'source_label_rule_mismatch', 409)
  }

  if (rule?.sourceProductId && String(sourceMeta.product_id || '') !== String(rule.sourceProductId)) {
    fail('The selected source label is for a different product', 'source_label_product_mismatch', 409)
  }

  if (!rule?.sourceProductId && rule?.sourceProductName) {
    const sourceName = String(sourceRecord.item_name || sourceMeta.product_name || '').toLowerCase()
    if (!sourceName.includes(String(rule.sourceProductName).toLowerCase())) {
      fail('The selected source label is for a different product', 'source_label_product_mismatch', 409)
    }
  }

  const sourceExpiry = parsedExpiry(sourceRecord, sourceMeta)
  const mode = expiryMode(meta.source_expiry_mode)
  const sourceExpiryRequired = [
    'min', 'minimum', 'earliest', 'cap', 'cap_at_source', 'source_cap',
    'source', 'inherit', 'same_as_source',
  ].includes(mode)

  if (sourceExpiryRequired && !sourceExpiry) {
    fail('The source batch has no valid use-by time. Create or correct the source label first.', 'source_label_expiry_missing', 409)
  }
  if (sourceExpiry && sourceExpiry.getTime() <= Date.now()) {
    fail('This source batch has expired. Choose another batch.', 'source_label_expired', 409)
  }

  const timeZone = String(catalog.source?.timeZone || DEFAULT_TIME_ZONE)
  const calculatedExpiry = new Date(meta.expires_at)
  let finalExpiry = calculatedExpiry

  if (sourceExpiry) {
    if (['source', 'inherit', 'same_as_source'].includes(mode)) {
      finalExpiry = sourceExpiry
    } else if (['min', 'minimum', 'earliest', 'cap', 'cap_at_source', 'source_cap'].includes(mode)) {
      finalExpiry = sourceExpiry.getTime() < calculatedExpiry.getTime() ? sourceExpiry : calculatedExpiry
    }
  }

  const code = sourceShortCode(sourceRecord, sourceMeta, timeZone)
  const expiryLimited = sourceExpiry && finalExpiry.getTime() < calculatedExpiry.getTime()

  Object.assign(meta, {
    label_type: 'traceable',
    source_label_id: String(sourceRecord.id || meta.source_label_id || ''),
    source_short_code: code,
    source_serial_batch: String(sourceRecord.serial_batch || ''),
    source_barcode: String(sourceRecord.barcode || ''),
    source_product_id: String(sourceMeta.product_id || rule?.sourceProductId || ''),
    source_product_name: String(sourceRecord.item_name || sourceMeta.product_name || rule?.sourceProductName || ''),
    source_action: String(sourceMeta.action || ''),
    source_prepared_at: String(sourceMeta.prepared_at || sourceRecord.created_date || sourceRecord.prep_date || ''),
    source_expires_at: sourceExpiry ? sourceExpiry.toISOString() : '',
    source_outlet_id: String(sourceRecord.outlet_id || ''),
    source_created_by: String(sourceRecord.created_by || ''),
    calculated_expires_at: calculatedExpiry.toISOString(),
    expires_at: finalExpiry.toISOString(),
    expiry_limited_by_source: Boolean(expiryLimited),
    source_consumed_qty: Math.max(0, Number(meta.source_consumed_qty || 0)),
    source_remaining_before: availability.remaining,
  })

  recordInput.expiry_date = dateKey(finalExpiry, timeZone)
  recordInput.notes = JSON.stringify(meta)
  return { recordInput, meta }
}

export function buildAutomaticLabelInput(catalog, input = {}, preparedAt = new Date()) {
  const ruleKey = String(input.rule_key || '').trim()
  const ruleId = String(input.rule_id || '').trim()
  const matchingRules = (catalog.rules || []).filter((candidate) => String(candidate.ruleId) === ruleId)
  const rule = ruleKey
    ? (catalog.rules || []).find((candidate) => String(candidate.ruleKey) === ruleKey)
    : (matchingRules.length === 1 ? matchingRules[0] : null)
  if (!rule) {
    if (!ruleKey && matchingRules.length > 1) fail('This rule ID is duplicated. Select the process again.', 'duplicate_label_rule')
    fail('The selected expiry rule no longer exists', 'label_rule_not_found', 404)
  }

  if (input.product_id && String(input.product_id) !== String(rule.productId)) {
    fail('The selected product does not match the expiry rule', 'label_rule_product_mismatch')
  }

  const product = (catalog.products || []).find((candidate) => String(candidate.productId) === String(rule.productId)) || {
    productId: rule.productId,
    productName: rule.productName,
    displayName: rule.productName,
    defaultLabelTitle: rule.productName,
    note: '',
  }

  const quantity = rule.requiresQuantity ? Number(input.quantity) : 1
  if (rule.requiresQuantity && (!Number.isFinite(quantity) || quantity <= 0)) {
    fail('A valid quantity is required for this label rule', 'invalid_label_quantity')
  }

  const printQuantity = Number(input.print_quantity || 1)
  if (!Number.isInteger(printQuantity) || printQuantity < 1 || printQuantity > 100) {
    fail('Print quantity must be a whole number from 1 to 100', 'invalid_print_quantity')
  }

  const sourceLabelId = String(input.source_label_id || '').trim()
  if (rule.requiresSource && !sourceLabelId) {
    fail('A source label is required for this label rule', 'source_label_required')
  }

  const durationMinutes = Number(rule.durationMinutes || 0)
  if (!rule.manualExpiryRequired && (!Number.isFinite(durationMinutes) || durationMinutes <= 0)) {
    fail(
      'This expiry rule has no valid automatic duration. Update ExpiryRules before printing.',
      'invalid_label_rule_duration',
      409,
    )
  }

  const expiryAt = rule.manualExpiryRequired
    ? parseManualExpiry(input.manual_expiry_at, preparedAt)
    : new Date(preparedAt.getTime() + durationMinutes * 60000)

  if (Number.isNaN(expiryAt.getTime()) || expiryAt.getTime() <= preparedAt.getTime()) {
    fail('The calculated use-by time must be later than the made time', 'invalid_calculated_expiry', 409)
  }

  const timeZone = String(catalog.source?.timeZone || DEFAULT_TIME_ZONE)
  const labelTitle = String(
    product.displayName
    || product.productName
    || (rule.requiresSource ? rule.outputProductName : '')
    || rule.productName
    || product.defaultLabelTitle
    || rule.outputProductName
    || 'Food Label',
  )
  const labelBarcode = barcode(preparedAt)
  const batchCode = readableBatchCode(labelTitle, preparedAt, timeZone, labelBarcode)
  const meta = {
    schema: 'chefops.food-label.v4',
    label_type: rule.requiresSource ? 'traceable' : 'standard',
    product_id: String(product.productId || rule.productId || ''),
    product_name: String(product.productName || rule.productName || labelTitle),
    rule_id: String(rule.ruleId),
    rule_key: String(rule.ruleKey || rule.ruleId),
    action: String(rule.action || ''),
    storage_condition_display: String(rule.storageCondition || ''),
    duration_minutes: durationMinutes,
    manual_expiry: Boolean(rule.manualExpiryRequired),
    prepared_at: preparedAt.toISOString(),
    calculated_expires_at: expiryAt.toISOString(),
    expires_at: expiryAt.toISOString(),
    time_zone: timeZone,
    requires_quantity: Boolean(rule.requiresQuantity),
    quantity_label: String(rule.quantityLabel || ''),
    quantity_unit: String(rule.quantityUnit || ''),
    show_quantity_on_label: Boolean(rule.showQuantityOnLabel),
    requires_source: Boolean(rule.requiresSource),
    source_label_id: sourceLabelId,
    source_short_code: '',
    source_serial_batch: '',
    source_barcode: '',
    source_product_id: String(rule.sourceProductId || ''),
    source_product_name: String(rule.sourceProductName || ''),
    source_expiry_mode: String(rule.sourceExpiryMode || ''),
    output_product_id: String(rule.outputProductId || ''),
    output_product_name: String(rule.outputProductName || ''),
    source_usage_mode: String(rule.sourceUsageMode || '').toLowerCase() === 'tracked' || Number(rule.sourceCapacity || 0) > 0 || Boolean(rule.requiresQuantity) ? 'tracked' : 'manual',
    source_capacity: Number(rule.sourceCapacity || (rule.requiresQuantity ? quantity : 0)) || 0,
    source_remaining_qty: Number(rule.sourceCapacity || (rule.requiresQuantity ? quantity : 0)) || null,
    source_unit: String(rule.sourceUnit || rule.quantityUnit || ''),
    source_status: 'active',
    source_consume_per_label: Math.max(0, Number(rule.consumePerLabel || 1)),
    source_consumed_qty: rule.requiresSource ? Math.max(0, printQuantity * Math.max(0, Number(rule.consumePerLabel || 1))) : 0,
    initial_print_quantity: printQuantity,
    total_reprint_quantity: 0,
    reprint_count: 0,
    printer_name: String(input.printer_name || ''),
    rule_note: String(rule.note || product.note || ''),
    batch_code: batchCode,
    barcode_value: labelBarcode,
    generation_mode: 'server_rule',
  }

  return {
    recordInput: {
      item_name: labelTitle,
      prep_date: dateKey(preparedAt, timeZone),
      expiry_date: dateKey(expiryAt, timeZone),
      serial_batch: batchCode,
      barcode: labelBarcode,
      storage_condition: storageKey(rule.storageCondition),
      allergens: '',
      weight: '',
      quantity,
      notes: JSON.stringify(meta),
      initial_print_quantity: printQuantity,
      total_reprint_quantity: 0,
      reprint_count: 0,
      printer_name: String(input.printer_name || ''),
    },
    meta,
  }
}
