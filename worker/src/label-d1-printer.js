import { getCurrentUser } from './auth.js'
import { json, readJson } from './http.js'
import { assertReadPermission } from './permissions.js'
import {
  asBoolean,
  findD1Record,
  listD1Rows,
  matchesFilter,
  mutateLabelRecord,
  parseJson,
  resolveOutletId,
  withoutRealtime,
} from './label-d1-store.js'

function fallbackPrinter(outletId) {
  return {
    id: '', outlet_id: outletId, purpose: 'food_label', profile_name: 'Browser Print',
    connection_type: 'system_print', command_language: 'browser',
    label_width_mm: 40, label_height_mm: 30, dpi: 203, default_copies: 1,
    auto_print: false, standby_enabled: false, auto_reconnect: false,
    queue_when_offline: true, retry_limit: 3, is_default: true, enabled: true,
    station_mode: 'this_device', configured: false,
  }
}

function printerResponse(profile, outletId) {
  if (!profile) return fallbackPrinter(outletId)
  return {
    ...withoutRealtime(profile),
    label_width_mm: Number(profile.label_width_mm || 40),
    label_height_mm: Number(profile.label_height_mm || 30),
    dpi: Number(profile.dpi || 203),
    default_copies: Number(profile.default_copies || 1),
    retry_limit: Number(profile.retry_limit || 0),
    auto_print: asBoolean(profile.auto_print),
    standby_enabled: asBoolean(profile.standby_enabled),
    auto_reconnect: asBoolean(profile.auto_reconnect),
    queue_when_offline: asBoolean(profile.queue_when_offline),
    is_default: asBoolean(profile.is_default),
    enabled: asBoolean(profile.enabled), configured: true,
  }
}

export async function handleD1PrinterProfileEntity(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'entities' || parts[2] !== 'PrinterProfile') return null
  const user = await getCurrentUser(request, env)
  assertReadPermission(user, 'PrinterProfile')
  const actionOrId = parts[3]

  if (request.method === 'GET' && !actionOrId) {
    const filter = parseJson(url.searchParams.get('filter'), {}) || {}
    const outletId = resolveOutletId(user, filter.outlet_id)
    const rows = await listD1Rows(env, 'PrinterProfile', {
      outletId, limit: url.searchParams.get('limit') || 200,
    })
    return json(request, env, rows.map(withoutRealtime).filter((row) => matchesFilter(row, filter)))
  }

  if (request.method === 'POST' && actionOrId === 'update-many') {
    const body = await readJson(request)
    const filter = body.filter || {}
    const patch = body.update?.$set || body.update || {}
    const outletId = resolveOutletId(user, filter.outlet_id || patch.outlet_id)
    const rows = (await listD1Rows(env, 'PrinterProfile', { outletId, limit: 500 }))
      .filter((row) => matchesFilter(row, filter))
    let updated = 0
    for (const row of rows) {
      await mutateLabelRecord(request, env, user, {
        entity: 'PrinterProfile', entityId: row.id,
        outletId: row.outlet_id || outletId, operation: 'update',
        expectedVersion: row.__realtime?.version,
        payload: { ...withoutRealtime(row), ...patch, outlet_id: row.outlet_id || outletId },
        mutationId: `printer-update-many:${row.id}:${crypto.randomUUID()}`,
      })
      updated += 1
    }
    return json(request, env, { matched: rows.length, updated })
  }

  if (request.method === 'POST' && !actionOrId) {
    const body = await readJson(request)
    const id = String(body.id || crypto.randomUUID())
    const result = await mutateLabelRecord(request, env, user, {
      entity: 'PrinterProfile', entityId: id, outletId: body.outlet_id,
      operation: 'create', payload: { ...body, id },
    })
    return json(request, env, result.record, 201)
  }

  if (actionOrId && request.method === 'PATCH') {
    const id = decodeURIComponent(actionOrId)
    const body = await readJson(request)
    const existing = await findD1Record(env, 'PrinterProfile', id, { includeDeleted: true })
    const result = await mutateLabelRecord(request, env, user, {
      entity: 'PrinterProfile', entityId: id,
      outletId: body.outlet_id || existing?.outlet_id, operation: 'update',
      expectedVersion: existing?.__realtime?.version,
      payload: { ...withoutRealtime(existing), ...body },
    })
    return json(request, env, result.record)
  }

  if (actionOrId && request.method === 'DELETE') {
    const id = decodeURIComponent(actionOrId)
    const existing = await findD1Record(env, 'PrinterProfile', id, { includeDeleted: true })
    const result = await mutateLabelRecord(request, env, user, {
      entity: 'PrinterProfile', entityId: id, outletId: existing?.outlet_id,
      operation: 'delete', expectedVersion: existing?.__realtime?.version,
      payload: withoutRealtime(existing),
    })
    return json(request, env, result.record)
  }
  return null
}

export async function handleD1PrinterProfileApi(request, env, url) {
  if (url.pathname !== '/api/labels/printer-profile') return null
  const user = await getCurrentUser(request, env)
  if (request.method === 'GET') {
    const outletId = resolveOutletId(user, url.searchParams.get('outlet_id'))
    if (!outletId) return json(request, env, fallbackPrinter(''))
    const profiles = (await listD1Rows(env, 'PrinterProfile', { outletId, limit: 100 }))
      .map(withoutRealtime)
      .filter((row) => row.purpose === 'food_label' && asBoolean(row.enabled))
    const profile = profiles.find((row) => asBoolean(row.is_default)) || profiles[0]
    return json(request, env, printerResponse(profile, outletId))
  }
  if (request.method === 'POST' || request.method === 'PUT') {
    const body = await readJson(request)
    const outletId = resolveOutletId(user, body.outlet_id)
    const id = String(body.id || crypto.randomUUID())
    const existing = body.id
      ? await findD1Record(env, 'PrinterProfile', id, { includeDeleted: true })
      : null
    const result = await mutateLabelRecord(request, env, user, {
      entity: 'PrinterProfile', entityId: id, outletId,
      operation: existing ? 'update' : 'create',
      expectedVersion: existing?.__realtime?.version,
      payload: {
        ...withoutRealtime(existing), ...body, id, outlet_id: outletId, purpose: 'food_label',
      },
    })
    return json(request, env, result.record, existing ? 200 : 201)
  }
  return null
}
