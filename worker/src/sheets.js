import { getSchema } from './schema.js'
import { googleFetch } from './google.js'
import {
  allSpreadsheetTargetsForEntity,
  inferFilterYear,
  inferRecordYear,
  spreadsheetIdForEntity,
} from './storage.js'


// Cloudflare Worker isolates are reused across requests. Keep a short, bounded
// read-through cache so one screen load does not turn into dozens of identical
// Google Sheets reads. Concurrent callers share the same in-flight promise.
const ENTITY_READ_CACHE = new Map()
const ENTITY_READ_INFLIGHT = new Map()
const ENSURE_SHEET_CACHE = new Map()
const ENSURE_SHEET_INFLIGHT = new Map()

const FAST_DYNAMIC_ENTITIES = new Set([
  'Notification', 'UrgentIssue', 'Task', 'StockCount', 'CloseUp', 'Attendance',
])

function entityCacheTtl(entity, schema) {
  if (entity === 'User') return 60_000
  if (FAST_DYNAMIC_ENTITIES.has(entity)) return 8_000
  if (schema.storage === 'master') return 120_000
  return 15_000
}

function entityCacheKey(entity, schema, target) {
  return `${target.spreadsheetId}:${schema.sheet}:${entity}`
}

function resultForDeletedMode(entry, includeDeleted) {
  return {
    headers: entry.headers,
    rows: includeDeleted ? entry.rows : entry.rows.filter(({ record }) => !record.deleted_at),
    target: entry.target,
    cached: true,
    stale: Boolean(entry.stale),
  }
}

function invalidateTargetCache(entity, schema, target) {
  const key = entityCacheKey(entity, schema, target)
  ENTITY_READ_CACHE.delete(key)
  ENTITY_READ_INFLIGHT.delete(key)
}

function pruneCaches(now = Date.now()) {
  if (ENTITY_READ_CACHE.size > 180) {
    for (const [key, value] of ENTITY_READ_CACHE) {
      if (now - value.cachedAt > 15 * 60_000) ENTITY_READ_CACHE.delete(key)
    }
  }
  if (ENSURE_SHEET_CACHE.size > 80) {
    for (const [key, value] of ENSURE_SHEET_CACHE) {
      if (value.expiresAt <= now) ENSURE_SHEET_CACHE.delete(key)
    }
  }
}

function a1(sheet, range = 'A:ZZ') {
  return `'${String(sheet).replaceAll("'", "''")}'!${range}`
}

function valuesUrl(spreadsheetId, range, suffix = '') {
  return `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}${suffix}`
}

function deserializeValue(value, field, schema) {
  if (schema.numberFields.includes(field)) {
    if (value === '' || value == null) return schema.nullableNumberFields.includes(field) ? '' : 0
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
  }
  if (schema.booleanFields.includes(field)) {
    return value === true || String(value).toLowerCase() === 'true'
  }
  return value ?? ''
}

function serializeValue(value) {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

function columnName(count) {
  let value = count
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

export async function readEntityRows(env, entity, { includeDeleted = false, year, target, force = false } = {}) {
  const schema = getSchema(entity)
  const resolved = target || spreadsheetIdForEntity(env, entity, { year })
  const key = entityCacheKey(entity, schema, resolved)
  const now = Date.now()
  pruneCaches(now)

  const cached = ENTITY_READ_CACHE.get(key)
  if (!force && cached && now - cached.cachedAt < entityCacheTtl(entity, schema)) {
    return resultForDeletedMode(cached, includeDeleted)
  }

  if (!force && ENTITY_READ_INFLIGHT.has(key)) {
    const shared = await ENTITY_READ_INFLIGHT.get(key)
    return resultForDeletedMode(shared, includeDeleted)
  }

  const load = (async () => {
    const lastColumn = schema.readLastColumn || columnName(schema.headers.length)
    const response = await googleFetch(env, valuesUrl(resolved.spreadsheetId, a1(schema.sheet, `A1:${lastColumn}`)))
    const data = await response.json()
    const values = data.values || []
    const headers = values.length ? values[0] : schema.headers
    const rows = values.slice(1).map((cells, index) => {
      const record = {}
      headers.forEach((field, column) => {
        record[field] = deserializeValue(cells[column], field, schema)
      })
      return { record, rowNumber: index + 2, target: resolved }
    })
    const entry = { headers, rows, target: resolved, cachedAt: Date.now(), stale: false }
    ENTITY_READ_CACHE.set(key, entry)
    return entry
  })()

  ENTITY_READ_INFLIGHT.set(key, load)
  try {
    const entry = await load
    return resultForDeletedMode(entry, includeDeleted)
  } catch (error) {
    // During a temporary Sheets quota spike, keep the app usable with the last
    // known rows instead of converting every route into a 502 error.
    if (cached && now - cached.cachedAt < 15 * 60_000) {
      return resultForDeletedMode({ ...cached, stale: true }, includeDeleted)
    }
    throw error
  } finally {
    if (ENTITY_READ_INFLIGHT.get(key) === load) ENTITY_READ_INFLIGHT.delete(key)
  }
}

function matchesValue(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$gte' in expected && String(actual) < String(expected.$gte)) return false
    if ('$lte' in expected && String(actual) > String(expected.$lte)) return false
    if ('$gt' in expected && String(actual) <= String(expected.$gt)) return false
    if ('$lt' in expected && String(actual) >= String(expected.$lt)) return false
    if ('$in' in expected && !expected.$in.map(String).includes(String(actual))) return false
    return true
  }
  return String(actual ?? '') === String(expected ?? '')
}

export function filterRecords(records, filter = {}) {
  return records.filter((record) => Object.entries(filter || {}).every(([field, expected]) => matchesValue(record[field], expected)))
}

const SPECIAL_ORDER = {
  priority: { low: 1, medium: 2, high: 3, urgent: 4, critical: 5 },
  status: { pending: 1, in_progress: 2, open: 2, done: 3, resolved: 3, overdue: 4, escalated: 4 },
}

export function sortRecords(records, sort = '') {
  const parts = String(sort || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (!parts.length) return records
  return [...records].sort((a, b) => {
    for (const part of parts) {
      const descending = part.startsWith('-')
      const field = descending ? part.slice(1) : part
      const order = SPECIAL_ORDER[field]
      const av = order ? (order[a[field]] || 0) : (a[field] ?? '')
      const bv = order ? (order[b[field]] || 0) : (b[field] ?? '')
      if (av === bv) continue
      const result = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true })
      return descending ? -result : result
    }
    return 0
  })
}

export async function listRecords(env, entity, { filter = {}, sort = '', limit = 100, year } = {}) {
  const schema = getSchema(entity)
  const targetYear = schema.storage === 'operations' ? (Number(year) || inferFilterYear(entity, filter)) : undefined
  const { rows } = await readEntityRows(env, entity, { year: targetYear })
  const filtered = filterRecords(rows.map(({ record }) => record), filter)
  return sortRecords(filtered, sort).slice(0, Math.max(0, Math.min(Number(limit) || 100, 5000)))
}

export async function appendRecord(env, entity, record, { year } = {}) {
  const schema = getSchema(entity)
  const targetYear = schema.storage === 'operations' ? (Number(year) || inferRecordYear(entity, record)) : undefined
  const target = spreadsheetIdForEntity(env, entity, { year: targetYear })
  const row = schema.headers.map((field) => serializeValue(record[field]))
  const response = await googleFetch(
    env,
    valuesUrl(target.spreadsheetId, a1(schema.sheet, 'A1'), ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: [row] }),
    },
  )
  await response.json()
  invalidateTargetCache(entity, schema, target)
  return record
}

export async function appendRecords(env, entity, records = [], { year } = {}) {
  if (!Array.isArray(records) || !records.length) return []
  const schema = getSchema(entity)
  const groups = new Map()
  for (const record of records) {
    const targetYear = schema.storage === 'operations' ? (Number(year) || inferRecordYear(entity, record)) : undefined
    const target = spreadsheetIdForEntity(env, entity, { year: targetYear })
    const key = `${target.spreadsheetId}|${targetYear || ''}`
    if (!groups.has(key)) groups.set(key, { target, rows: [] })
    groups.get(key).rows.push(schema.headers.map((field) => serializeValue(record[field])))
  }
  for (const { target, rows } of groups.values()) {
    const response = await googleFetch(
      env,
      valuesUrl(target.spreadsheetId, a1(schema.sheet, 'A1'), ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
      },
    )
    await response.json()
    invalidateTargetCache(entity, schema, target)
  }
  return records
}

export async function findRecord(env, entity, id, { year } = {}) {
  const schema = getSchema(entity)
  const targets = allSpreadsheetTargetsForEntity(env, entity, year)
  for (const target of targets) {
    const { rows } = await readEntityRows(env, entity, { includeDeleted: true, target })
    const idField = schema.idField || 'id'
    const found = rows.find(({ record }) => String(record[idField] || '') === String(id || ''))
    if (found && !found.record.deleted_at) return found
  }
  const error = new Error(`${entity} record not found`)
  error.status = 404
  error.code = 'record_not_found'
  throw error
}

export async function updateRecordFlexible(env, entity, id, patch, { year, requiredFields = [] } = {}) {
  const schema = getSchema(entity)
  const targets = allSpreadsheetTargetsForEntity(env, entity, year)
  for (const target of targets) {
    let current = await readEntityRows(env, entity, { includeDeleted: true, target, force: true })
    let headers = [...current.headers]
    const missing = requiredFields.filter((field) => field && !headers.includes(field))
    if (missing.length) {
      const nextHeaders = [...headers, ...missing]
      await googleFetch(env, valuesUrl(
        target.spreadsheetId,
        a1(schema.sheet, `A1:${columnName(nextHeaders.length)}1`),
        '?valueInputOption=RAW',
      ), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ majorDimension: 'ROWS', values: [nextHeaders] }),
      })
      invalidateTargetCache(entity, schema, target)
      current = await readEntityRows(env, entity, { includeDeleted: true, target, force: true })
      headers = [...current.headers]
    }
    const idField = schema.idField || 'id'
    const found = current.rows.find(({ record }) => String(record[idField] || '') === String(id || ''))
    if (!found || found.record.deleted_at) continue
    const updated = { ...found.record, ...patch }
    const response = await googleFetch(env, valuesUrl(
      target.spreadsheetId,
      a1(schema.sheet, `A${found.rowNumber}:${columnName(headers.length)}${found.rowNumber}`),
      '?valueInputOption=RAW',
    ), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: [headers.map((field) => serializeValue(updated[field]))] }),
    })
    await response.json()
    invalidateTargetCache(entity, schema, target)
    return updated
  }
  const error = new Error(`${entity} record not found`)
  error.status = 404
  error.code = 'record_not_found'
  throw error
}

export async function updateRecord(env, entity, id, patch, { year } = {}) {
  const schema = getSchema(entity)
  const found = await findRecord(env, entity, id, { year })
  const updated = { ...found.record, ...patch }
  const row = schema.headers.map((field) => serializeValue(updated[field]))
  await googleFetch(env, valuesUrl(
    found.target.spreadsheetId,
    a1(schema.sheet, `A${found.rowNumber}:${columnName(schema.headers.length)}${found.rowNumber}`),
    '?valueInputOption=RAW',
  ), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values: [row] }),
  })
  invalidateTargetCache(entity, schema, found.target)
  return updated
}

export async function updateManyRecords(env, entity, filter, patch, { year } = {}) {
  const schema = getSchema(entity)
  const targetYear = schema.storage === 'operations' ? (Number(year) || inferFilterYear(entity, filter)) : undefined
  const { rows, target } = await readEntityRows(env, entity, { year: targetYear })
  const matches = rows.filter(({ record }) => filterRecords([record], filter).length > 0)
  if (!matches.length) return { updated: 0 }
  const data = matches.map(({ record, rowNumber }) => {
    const updated = { ...record, ...patch, version: Number(record.version || 0) + 1 }
    return {
      range: a1(schema.sheet, `A${rowNumber}:${columnName(schema.headers.length)}${rowNumber}`),
      majorDimension: 'ROWS',
      values: [schema.headers.map((field) => serializeValue(updated[field]))],
    }
  })
  await googleFetch(env, `https://sheets.googleapis.com/v4/spreadsheets/${target.spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  })
  invalidateTargetCache(entity, schema, target)
  return { updated: matches.length }
}


function rawRow(schema, record) {
  return schema.headers.map((field) => serializeValue(record[field]))
}

function stockAliases(record = {}) {
  const aliases = []
  const stockListId = String(record.stock_list_id || record.stock_list_id === 0 ? record.stock_list_id : '').trim()
  const itemId = String(record.item_id || '').trim()
  const itemName = String(record.item_name || '').trim().toLowerCase()
  if (stockListId) aliases.push(`list:${stockListId}`)
  if (itemId) aliases.push(`item:${itemId}`)
  if (itemName) aliases.push(`name:${itemName}`)
  return aliases
}

/**
 * Save one outlet's stock count without changing the master stock list.
 * OutletStockLists defines what should be counted; StockCounts stores the
 * employee's actual quantity and identity for the selected date.
 */
export async function saveStockCountBatch(env, {
  user,
  countDate,
  outletId,
  items,
}) {
  const year = Number(String(countDate).slice(0, 4))
  const stockSchema = getSchema('StockCount')

  const stockListRead = await readEntityRows(env, 'OutletStockList')
  const stockRead = await readEntityRows(env, 'StockCount', { year })

  const stockListById = new Map(
    stockListRead.rows
      .filter(({ record }) => (
        String(record.outlet_id || '') === String(outletId || '')
        && record.enabled === true
      ))
      .map((row) => [String(row.record.stock_list_id || ''), row.record]),
  )

  const sameDateByAlias = new Map()
  const previousByAlias = new Map()
  for (const row of stockRead.rows) {
    const record = row.record
    if (String(record.outlet_id || '') !== String(outletId || '')) continue
    const date = String(record.count_date || '')
    for (const alias of stockAliases(record)) {
      if (date === countDate) sameDateByAlias.set(alias, row)
      if (date < countDate) {
        const previous = previousByAlias.get(alias)
        if (!previous || String(previous.record.count_date || '') < date) previousByAlias.set(alias, row)
      }
    }
  }

  const timestamp = new Date().toISOString()
  const stockUpdates = []
  const stockAppends = []
  const savedRecords = []

  for (const input of items) {
    const stockList = stockListById.get(String(input.stock_list_id || ''))
    if (!stockList) continue

    const actualQty = Number(input.actual_qty)
    if (!Number.isFinite(actualQty) || actualQty < 0) continue

    const aliases = stockAliases(stockList)
    const existing = aliases.map((alias) => sameDateByAlias.get(alias)).find(Boolean)
    const previous = aliases.map((alias) => previousByAlias.get(alias)).find(Boolean)
    const expectedQty = existing
      ? existing.record.expected_qty
      : (previous ? Number(previous.record.actual_qty) : '')
    const variance = expectedQty === '' || expectedQty == null
      ? ''
      : actualQty - Number(expectedQty)

    const stockRecord = existing
      ? {
          ...existing.record,
          item_name: stockList.item_name || existing.record.item_name || '',
          category: stockList.category || existing.record.category || '',
          expected_qty: expectedQty,
          actual_qty: actualQty,
          unit: stockList.count_uom || existing.record.unit || '',
          variance,
          counted_by: user.full_name || user.email,
          counted_by_email: user.email,
          status: 'counted',
          stock_list_id: stockList.stock_list_id || '',
          item_id: stockList.item_id || '',
          updated_date: timestamp,
          updated_by: user.email,
          version: Number(existing.record.version || 0) + 1,
        }
      : {
          id: crypto.randomUUID(),
          outlet_id: outletId,
          created_date: timestamp,
          created_by: user.email,
          updated_date: timestamp,
          updated_by: user.email,
          deleted_at: '',
          version: 1,
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

    if (existing) {
      stockUpdates.push({
        range: a1(stockSchema.sheet, `A${existing.rowNumber}:${columnName(stockSchema.headers.length)}${existing.rowNumber}`),
        majorDimension: 'ROWS',
        values: [rawRow(stockSchema, stockRecord)],
      })
    } else {
      stockAppends.push(rawRow(stockSchema, stockRecord))
    }

    savedRecords.push({
      stock_list_id: stockList.stock_list_id,
      item_id: stockList.item_id,
      stock_count_id: stockRecord.id,
      item_name: stockList.item_name,
      actual_qty: actualQty,
      expected_qty: expectedQty,
      variance,
    })
  }

  if (stockUpdates.length) {
    await googleFetch(env, `https://sheets.googleapis.com/v4/spreadsheets/${stockRead.target.spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data: stockUpdates }),
    })
  }

  if (stockAppends.length) {
    await googleFetch(
      env,
      valuesUrl(stockRead.target.spreadsheetId, a1(stockSchema.sheet, 'A1'), ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ majorDimension: 'ROWS', values: stockAppends }),
      },
    )
  }

  invalidateTargetCache('StockCount', stockSchema, stockRead.target)

  return {
    saved: savedRecords.length,
    created: stockAppends.length,
    updated: stockUpdates.length,
    list_items: stockListById.size,
    records: savedRecords,
  }
}

/**
 * Lazily creates a v4 sheet tab and writes the schema header. The result is
 * cached for this Worker isolate, and concurrent bootstrap calls share one
 * promise instead of repeatedly reading spreadsheet metadata.
 */
export async function ensureEntitySheet(env, entity, { year, seedRecords = [] } = {}) {
  const schema = getSchema(entity)
  const target = spreadsheetIdForEntity(env, entity, { year })
  const key = `${target.spreadsheetId}:${schema.sheet}`
  const now = Date.now()
  const cached = ENSURE_SHEET_CACHE.get(key)
  if (cached && cached.expiresAt > now) return cached.result
  if (ENSURE_SHEET_INFLIGHT.has(key)) return ENSURE_SHEET_INFLIGHT.get(key)

  const ensurePromise = (async () => {
    const metadataResponse = await googleFetch(
      env,
      `https://sheets.googleapis.com/v4/spreadsheets/${target.spreadsheetId}?fields=sheets(properties(sheetId,title,gridProperties))`,
    )
    const metadata = await metadataResponse.json()
    let sheet = (metadata.sheets || []).find((entry) => entry?.properties?.title === schema.sheet)
    let createdSheet = false

    if (!sheet) {
      const createResponse = await googleFetch(
        env,
        `https://sheets.googleapis.com/v4/spreadsheets/${target.spreadsheetId}:batchUpdate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{
              addSheet: {
                properties: {
                  title: schema.sheet,
                  gridProperties: {
                    rowCount: Math.max(1000, seedRecords.length + 100),
                    columnCount: Math.max(26, schema.headers.length),
                    frozenRowCount: 1,
                  },
                },
              },
            }],
          }),
        },
      )
      const created = await createResponse.json()
      sheet = created.replies?.[0]?.addSheet || null
      createdSheet = true
    }

    // Header writes are safe and do not consume the Sheets read quota. They are
    // performed once per isolate instead of on every bootstrap request.
    await googleFetch(
      env,
      valuesUrl(
        target.spreadsheetId,
        a1(schema.sheet, `A1:${columnName(schema.headers.length)}1`),
        '?valueInputOption=RAW',
      ),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ majorDimension: 'ROWS', values: [schema.headers] }),
      },
    )

    invalidateTargetCache(entity, schema, target)
    const current = await readEntityRows(env, entity, { year, target, force: true })
    let seeded = false
    if (!current.rows.length && seedRecords.length) {
      const timestamp = new Date().toISOString()
      const rows = seedRecords.map((input) => {
        const record = Object.fromEntries(schema.headers.map((field) => [field, '']))
        Object.assign(record, input)
        const idField = schema.idField || 'id'
        record[idField] ||= crypto.randomUUID()
        if (schema.headers.includes('created_date')) record.created_date ||= timestamp
        if (schema.headers.includes('created_by')) record.created_by ||= 'system@chefops'
        if (schema.headers.includes('updated_date')) record.updated_date ||= timestamp
        if (schema.headers.includes('updated_by')) record.updated_by ||= 'system@chefops'
        if (schema.headers.includes('deleted_at')) record.deleted_at ||= ''
        if (schema.headers.includes('version')) record.version ||= 1
        return schema.headers.map((field) => serializeValue(record[field]))
      })
      await googleFetch(
        env,
        valuesUrl(target.spreadsheetId, a1(schema.sheet, 'A1'), ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
        },
      )
      seeded = true
      invalidateTargetCache(entity, schema, target)
    }

    const result = {
      entity,
      sheet: schema.sheet,
      spreadsheetId: target.spreadsheetId,
      year: target.year,
      created: createdSheet,
      seeded,
    }
    ENSURE_SHEET_CACHE.set(key, { result, expiresAt: Date.now() + 30 * 60_000 })
    return result
  })()

  ENSURE_SHEET_INFLIGHT.set(key, ensurePromise)
  try {
    return await ensurePromise
  } finally {
    if (ENSURE_SHEET_INFLIGHT.get(key) === ensurePromise) ENSURE_SHEET_INFLIGHT.delete(key)
  }
}
