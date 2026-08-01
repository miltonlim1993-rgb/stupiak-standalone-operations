import { getCurrentUser } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import { assertAssignedOutletAccess, assignedOutletIds } from './permissions.js'
import { listRecords } from './sheets.js'

function now() {
  return new Date().toISOString()
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function truthy(value) {
  return value === true || String(value).toLowerCase() === 'true'
}

function recordId(record) {
  return String(record?.id || record?.__realtime?.entity_id || '').trim()
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
      created_at: row.created_at || '',
      created_by: row.created_by || '',
      updated_at: row.updated_at || '',
    },
  }
}

function mergeRows(sheetRows, d1Rows) {
  const byId = new Map((sheetRows || []).map((row) => [recordId(row), row]).filter(([id]) => id))
  for (const row of d1Rows || []) {
    const id = recordId(row)
    if (id) byId.set(id, { ...(byId.get(id) || {}), ...row })
  }
  return [...byId.values()]
}

function aliases(record = {}) {
  const result = []
  const stockListId = String(record.stock_list_id ?? '').trim()
  const itemId = String(record.item_id || '').trim()
  const itemName = String(record.item_name || '').trim().toLowerCase()
  if (stockListId) result.push(`list:${stockListId}`)
  if (itemId) result.push(`item:${itemId}`)
  if (itemName) result.push(`name:${itemName}`)
  return result
}

function safeKey(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
}

async function digest(value) {
  const bytes = new TextEncoder().encode(String(value || ''))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function replayResult(db, mutationId) {
  const row = await db.prepare(
    'SELECT result_json FROM ops_mutations WHERE mutation_id = ? LIMIT 1',
  ).bind(mutationId).first()
  const result = parseJson(row?.result_json, null)
  return result ? { ...result, replayed: true } : null
}

async function markQueued(db, mutationIds) {
  if (!mutationIds.length) return
  const timestamp = now()
  for (let index = 0; index < mutationIds.length; index += 100) {
    const ids = mutationIds.slice(index, index + 100)
    await db.prepare(`
      UPDATE sheet_sync_outbox
      SET status = 'queued', queued_at = ?, last_error = ''
      WHERE mutation_id IN (SELECT value FROM json_each(?))
    `).bind(timestamp, JSON.stringify(ids)).run()
  }
}

async function enqueueMirrors(env, messages) {
  if (!env.SHEET_SYNC_QUEUE || !messages.length) return false
  try {
    for (let index = 0; index < messages.length; index += 100) {
      const chunk = messages.slice(index, index + 100)
      if (typeof env.SHEET_SYNC_QUEUE.sendBatch === 'function') {
        await env.SHEET_SYNC_QUEUE.sendBatch(chunk.map((body) => ({ body })))
      } else if (typeof env.SHEET_SYNC_QUEUE.send === 'function') {
        await Promise.all(chunk.map((body) => env.SHEET_SYNC_QUEUE.send(body)))
      } else {
        return false
      }
    }
    await markQueued(env.OPS_DB, messages.map((message) => message.mutation_id))
    return true
  } catch (error) {
    console.error('Unable to enqueue atomic stock batch mirrors', error)
    return false
  }
}

async function broadcastBatch(env, outletId, baseMutationId, records, user) {
  if (!env.OUTLET_REALTIME?.getByName) return
  try {
    const stub = env.OUTLET_REALTIME.getByName(outletId)
    await stub.fetch('https://chefops-realtime.internal/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ChefOps-Realtime-Internal': '1',
      },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        type: 'stock_count.batch_updated',
        mutation_id: baseMutationId,
        entity: 'StockCount',
        outlet_id: outletId,
        records,
        occurred_at: now(),
        actor: {
          id: user.id || '',
          email: user.email,
          name: user.full_name || user.email,
          role: user.role,
        },
      }),
    })
  } catch (error) {
    console.error('Unable to broadcast atomic stock batch', error)
  }
}

function buildRecordRows(commits, outletId, countDate, timestamp, user) {
  return commits.map((item) => ({
    entity: 'StockCount',
    entity_id: item.id,
    outlet_id: outletId,
    business_date: countDate,
    status: 'counted',
    payload_json: JSON.stringify(item.record),
    version: item.version,
    created_at: item.createdAt,
    created_by: item.createdBy,
    updated_at: timestamp,
    updated_by: user.email,
    deleted_at: '',
  }))
}

function buildMutationRows(commits, responseBody, baseMutationId, outletId, requestedAt, timestamp, user) {
  return [
    ...commits.map((item) => ({
      mutation_id: item.mutationId,
      outlet_id: outletId,
      entity: 'StockCount',
      entity_id: item.id,
      operation: item.operation,
      actor_email: user.email,
      actor_name: user.full_name || user.email,
      requested_at: requestedAt,
      committed_at: timestamp,
      result_json: JSON.stringify({
        ok: true,
        mutation_id: item.mutationId,
        entity: 'StockCount',
        entity_id: item.id,
        outlet_id: outletId,
        version: item.version,
        record: item.record,
        sync_status: 'pending',
        committed_at: timestamp,
      }),
    })),
    {
      mutation_id: baseMutationId,
      outlet_id: outletId,
      entity: 'StockCountBatch',
      entity_id: `${outletId}|${responseBody.count_date}`,
      operation: 'batch_upsert',
      actor_email: user.email,
      actor_name: user.full_name || user.email,
      requested_at: requestedAt,
      committed_at: timestamp,
      result_json: JSON.stringify(responseBody),
    },
  ]
}

function buildOutboxRows(commits, outletId, timestamp) {
  return commits.map((item) => ({
    mutation_id: item.mutationId,
    entity: 'StockCount',
    entity_id: item.id,
    outlet_id: outletId,
    operation: item.operation,
    payload_json: JSON.stringify(item.message),
    status: 'pending',
    attempts: 0,
    next_attempt_at: timestamp,
  }))
}

async function persistAtomicBatch(env, rows) {
  const recordsJson = JSON.stringify(rows.records)
  const mutationsJson = JSON.stringify(rows.mutations)
  const outboxJson = JSON.stringify(rows.outbox)

  const recordStatement = env.OPS_DB.prepare(`
    INSERT INTO ops_records (
      entity, entity_id, outlet_id, business_date, status, payload_json,
      version, created_at, created_by, updated_at, updated_by, deleted_at
    )
    SELECT
      json_extract(value, '$.entity'),
      json_extract(value, '$.entity_id'),
      json_extract(value, '$.outlet_id'),
      json_extract(value, '$.business_date'),
      json_extract(value, '$.status'),
      json_extract(value, '$.payload_json'),
      CAST(json_extract(value, '$.version') AS INTEGER),
      json_extract(value, '$.created_at'),
      json_extract(value, '$.created_by'),
      json_extract(value, '$.updated_at'),
      json_extract(value, '$.updated_by'),
      json_extract(value, '$.deleted_at')
    FROM json_each(?)
    WHERE 1
    ON CONFLICT(entity, entity_id) DO UPDATE SET
      outlet_id = excluded.outlet_id,
      business_date = excluded.business_date,
      status = excluded.status,
      payload_json = excluded.payload_json,
      version = excluded.version,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by,
      deleted_at = excluded.deleted_at
  `).bind(recordsJson)

  const mutationStatement = env.OPS_DB.prepare(`
    INSERT INTO ops_mutations (
      mutation_id, outlet_id, entity, entity_id, operation, actor_email,
      actor_name, requested_at, committed_at, result_json
    )
    SELECT
      json_extract(value, '$.mutation_id'),
      json_extract(value, '$.outlet_id'),
      json_extract(value, '$.entity'),
      json_extract(value, '$.entity_id'),
      json_extract(value, '$.operation'),
      json_extract(value, '$.actor_email'),
      json_extract(value, '$.actor_name'),
      json_extract(value, '$.requested_at'),
      json_extract(value, '$.committed_at'),
      json_extract(value, '$.result_json')
    FROM json_each(?)
  `).bind(mutationsJson)

  const outboxStatement = env.OPS_DB.prepare(`
    INSERT INTO sheet_sync_outbox (
      mutation_id, entity, entity_id, outlet_id, operation, payload_json,
      status, attempts, next_attempt_at
    )
    SELECT
      json_extract(value, '$.mutation_id'),
      json_extract(value, '$.entity'),
      json_extract(value, '$.entity_id'),
      json_extract(value, '$.outlet_id'),
      json_extract(value, '$.operation'),
      json_extract(value, '$.payload_json'),
      json_extract(value, '$.status'),
      CAST(json_extract(value, '$.attempts') AS INTEGER),
      json_extract(value, '$.next_attempt_at')
    FROM json_each(?)
  `).bind(outboxJson)

  await env.OPS_DB.batch([recordStatement, mutationStatement, outboxStatement])
}

async function saveAtomicBatch(request, env) {
  if (!env.OPS_DB?.prepare || !env.OPS_DB?.batch) {
    const error = new Error('Realtime D1 database is not configured')
    error.status = 503
    error.code = 'realtime_database_unavailable'
    throw error
  }

  const user = await getCurrentUser(request, env)
  const body = await readJson(request)
  const countDate = String(body.count_date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(countDate)) {
    const error = new Error('count_date must use YYYY-MM-DD')
    error.status = 400
    error.code = 'invalid_count_date'
    throw error
  }

  const rawItems = Array.isArray(body.items) ? body.items.slice(0, 500) : []
  if (!rawItems.length) {
    const error = new Error('No stock quantities were supplied')
    error.status = 400
    error.code = 'empty_stock_count'
    throw error
  }

  const outletId = String(
    body.outlet_id || user.outlet_id || assignedOutletIds(user)[0] || '',
  ).trim()
  if (!outletId) {
    const error = new Error('Your account is not assigned to an outlet')
    error.status = 400
    error.code = 'missing_outlet'
    throw error
  }
  assertAssignedOutletAccess(user, outletId)

  const normalizedForId = rawItems.map((item) => ({
    stock_list_id: String(item.stock_list_id || ''),
    actual_qty: Number(item.actual_qty),
  }))
  const suppliedMutationId = String(
    body.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '',
  ).trim()
  const baseMutationId = (
    suppliedMutationId
    || `stock-batch:${await digest(JSON.stringify({ outletId, countDate, items: normalizedForId }))}`
  ).slice(0, 150)

  const replay = await replayResult(env.OPS_DB, baseMutationId)
  if (replay) return replay

  const year = Number(countDate.slice(0, 4))
  const [stockListRows, sheetCounts, d1Query] = await Promise.all([
    listRecords(env, 'OutletStockList', {
      filter: { outlet_id: outletId },
      sort: 'section,display_order',
      limit: 5000,
    }),
    listRecords(env, 'StockCount', {
      filter: { outlet_id: outletId, count_date: { $lte: countDate } },
      sort: '-count_date',
      limit: 5000,
      year,
    }),
    env.OPS_DB.prepare(`
      SELECT * FROM ops_records
      WHERE entity = 'StockCount' AND outlet_id = ? AND deleted_at = ''
      ORDER BY business_date DESC, updated_at DESC LIMIT 5000
    `).bind(outletId).all(),
  ])

  const stockListById = new Map(
    stockListRows
      .filter((record) => truthy(record.enabled))
      .map((record) => [String(record.stock_list_id || ''), record]),
  )
  const allCounts = mergeRows(
    sheetCounts,
    (d1Query.results || []).map(realtimeRecord),
  )
  const sameDateByAlias = new Map()
  const previousByAlias = new Map()

  for (const record of allCounts) {
    const date = String(record.count_date || '')
    if (!date || date > countDate) continue
    for (const alias of aliases(record)) {
      if (date === countDate) sameDateByAlias.set(alias, record)
      if (date < countDate) {
        const previous = previousByAlias.get(alias)
        if (!previous || String(previous.count_date || '') < date) {
          previousByAlias.set(alias, record)
        }
      }
    }
  }

  const timestamp = now()
  const commits = []
  for (const input of rawItems) {
    const stockList = stockListById.get(String(input.stock_list_id || ''))
    if (!stockList) continue
    const actualQty = Number(input.actual_qty)
    if (!Number.isFinite(actualQty) || actualQty < 0) continue

    const itemAliases = aliases(stockList)
    const existing = itemAliases.map((alias) => sameDateByAlias.get(alias)).find(Boolean) || null
    const previous = itemAliases.map((alias) => previousByAlias.get(alias)).find(Boolean) || null
    const expectedQty = existing
      ? existing.expected_qty
      : (previous ? Number(previous.actual_qty) : '')
    const variance = expectedQty === '' || expectedQty == null
      ? ''
      : actualQty - Number(expectedQty)
    const id = existing?.id
      || `stock-${safeKey(countDate)}-${safeKey(outletId)}-${safeKey(stockList.stock_list_id)}`
    const previousD1Version = Number(existing?.__realtime?.version || 0)
    const version = previousD1Version + 1
    const operation = previousD1Version ? 'update' : 'upsert'

    const record = {
      ...(existing || {}),
      id,
      outlet_id: outletId,
      created_date: existing?.created_date || timestamp,
      created_by: existing?.created_by || user.email,
      updated_date: timestamp,
      updated_by: user.email,
      deleted_at: '',
      version,
      item_name: stockList.item_name || existing?.item_name || '',
      category: stockList.category || existing?.category || '',
      expected_qty: expectedQty,
      actual_qty: actualQty,
      unit: stockList.count_uom || existing?.unit || '',
      variance,
      count_date: countDate,
      counted_by: user.full_name || user.email,
      counted_by_email: user.email,
      status: 'counted',
      submitted_to_whatsapp: existing?.submitted_to_whatsapp || false,
      submitted_to_erp: existing?.submitted_to_erp || false,
      notes: existing?.notes || '',
      stock_list_id: stockList.stock_list_id || '',
      item_id: stockList.item_id || '',
    }
    delete record.__realtime

    const mutationId = `${baseMutationId}:${safeKey(stockList.stock_list_id)}`.slice(0, 160)
    const message = {
      mutation_id: mutationId,
      entity: 'StockCount',
      entity_id: id,
      outlet_id: outletId,
      operation,
      record,
      version,
      committed_at: timestamp,
    }

    commits.push({
      id,
      mutationId,
      operation,
      version,
      record,
      message,
      createdAt: existing?.__realtime?.created_at || existing?.created_date || timestamp,
      createdBy: existing?.__realtime?.created_by || existing?.created_by || user.email,
      summary: {
        stock_list_id: stockList.stock_list_id,
        item_id: stockList.item_id,
        stock_count_id: id,
        item_name: stockList.item_name,
        actual_qty: actualQty,
        expected_qty: expectedQty,
        variance,
      },
    })
    sameDateByAlias.set(`list:${stockList.stock_list_id}`, {
      ...record,
      __realtime: { version },
    })
  }

  if (!commits.length) {
    const error = new Error('No valid stock quantities matched this outlet stock list')
    error.status = 400
    error.code = 'empty_valid_stock_count'
    throw error
  }

  const responseBody = {
    ok: true,
    replayed: false,
    mutation_id: baseMutationId,
    outlet_id: outletId,
    count_date: countDate,
    saved: commits.length,
    created: commits.filter((item) => item.operation === 'upsert').length,
    updated: commits.filter((item) => item.operation === 'update').length,
    list_items: stockListById.size,
    records: commits.map((item) => item.summary),
    committed_at: timestamp,
    sync_status: 'pending',
  }

  const requestedAt = String(body.requested_at || timestamp)
  const rows = {
    records: buildRecordRows(commits, outletId, countDate, timestamp, user),
    mutations: buildMutationRows(
      commits,
      responseBody,
      baseMutationId,
      outletId,
      requestedAt,
      timestamp,
      user,
    ),
    outbox: buildOutboxRows(commits, outletId, timestamp),
  }

  try {
    await persistAtomicBatch(env, rows)
  } catch (error) {
    const concurrentReplay = await replayResult(env.OPS_DB, baseMutationId)
    if (concurrentReplay) return concurrentReplay
    throw error
  }

  const sideEffects = Promise.all([
    enqueueMirrors(env, commits.map((item) => item.message)),
    broadcastBatch(env, outletId, baseMutationId, commits.map((item) => item.record), user),
  ])
  if (env.__CHEFOPS_CTX?.waitUntil) env.__CHEFOPS_CTX.waitUntil(sideEffects)
  else await sideEffects

  return responseBody
}

export async function handleJsonAtomicStockCountBatch(request, env, url) {
  if (url.pathname !== '/api/stock-counts/batch' || request.method !== 'POST') return null
  try {
    return json(request, env, await saveAtomicBatch(request, env))
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
