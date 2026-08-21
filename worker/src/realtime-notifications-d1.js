import { getCurrentUser } from './auth.js'
import { listDirectoryRecords } from './d1-directory-store.js'
import { errorResponse, json, readJson } from './http.js'

const NOTIFICATION_PAGES = new Set([
  '/', '/tasks', '/stock', '/urgent', '/inventory', '/attendance',
  '/labels', '/receipts', '/close-up', '/notifications', '/install',
])

function now() {
  return new Date().toISOString()
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function database(env) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('Notification D1 database is unavailable')
    error.status = 503
    error.code = 'notification_d1_unavailable'
    throw error
  }
  return env.OPS_DB
}

function requireNotificationManager(user) {
  if (['manager', 'owner'].includes(String(user?.role || '').toLowerCase())) return
  const error = new Error('Manager access required to push notifications')
  error.status = 403
  error.code = 'forbidden'
  throw error
}

function normalizeNotificationPage(value) {
  const target = String(value || '/').trim() || '/'
  return NOTIFICATION_PAGES.has(target) ? target : '/'
}

function firstAssignedOutlet(record = {}) {
  const direct = String(record.outlet_id || '').trim()
  if (direct) return direct
  const raw = String(record.outlet_ids || '').trim()
  if (!raw) return 'global'
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed[0]) return String(parsed[0]).trim() || 'global'
    } catch {}
  }
  return String(raw.split(',')[0] || '').replace(/[\[\]"]/g, '').trim() || 'global'
}

function notificationFromRow(row) {
  if (!row) return null
  return {
    ...(parseJson(row.payload_json, {}) || {}),
    __realtime: {
      entity: 'Notification',
      entity_id: row.entity_id,
      outlet_id: row.outlet_id || 'global',
      version: Number(row.version || 0),
      updated_at: row.updated_at || '',
      deleted_at: row.deleted_at || '',
      sync_status: row.sync_status || 'synced',
    },
  }
}

async function listNotifications(request, env, url, user) {
  const db = database(env)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200)
  const targetPage = String(url.searchParams.get('target_page') || '').trim()
  const unreadOnly = url.searchParams.get('unread') === '1'
  const fetchLimit = Math.min(Math.max(limit * 4, 100), 800)
  const response = await db.prepare(`
    SELECT r.*,
      COALESCE((SELECT o.status FROM sheet_sync_outbox o
        WHERE o.entity = 'Notification' AND o.entity_id = r.entity_id
        ORDER BY o.id DESC LIMIT 1), 'synced') AS sync_status
    FROM ops_records r
    WHERE r.entity = 'Notification'
      AND r.deleted_at = ''
      AND json_extract(r.payload_json, '$.recipient_user_id') = ?
    ORDER BY r.created_at DESC, r.updated_at DESC
    LIMIT ?
  `).bind(String(user.id || ''), fetchLimit).all()

  const current = Date.now()
  const records = (response.results || [])
    .map(notificationFromRow)
    .filter((row) => {
      if (!row) return false
      if (unreadOnly && String(row.status || 'unread') !== 'unread') return false
      if (targetPage && String(row.target_page || '/') !== targetPage) return false
      if (row.expires_at) {
        const expires = Date.parse(row.expires_at)
        if (Number.isFinite(expires) && expires < current) return false
      }
      return true
    })
    .slice(0, limit)

  return json(request, env, records)
}

function mirrorMessage({ mutationId, record, outletId, operation, version, committedAt }) {
  return {
    mutation_id: mutationId,
    entity: 'Notification',
    entity_id: record.id,
    outlet_id: outletId,
    operation,
    record,
    version,
    committed_at: committedAt,
  }
}

function insertStatements(db, {
  mutationId,
  record,
  outletId,
  actor,
  operation,
  version,
  committedAt,
}) {
  const message = mirrorMessage({ mutationId, record, outletId, operation, version, committedAt })
  return {
    message,
    statements: [
      db.prepare(`
        INSERT INTO ops_records (
          entity, entity_id, outlet_id, business_date, status, payload_json,
          version, created_at, created_by, updated_at, updated_by, deleted_at
        ) VALUES ('Notification', ?, ?, '', ?, ?, ?, ?, ?, ?, ?, '')
        ON CONFLICT(entity, entity_id) DO UPDATE SET
          outlet_id = excluded.outlet_id,
          status = excluded.status,
          payload_json = excluded.payload_json,
          version = excluded.version,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by,
          deleted_at = ''
      `).bind(
        record.id,
        outletId,
        String(record.status || ''),
        JSON.stringify(record),
        version,
        String(record.created_date || committedAt),
        String(record.created_by || actor.email),
        committedAt,
        actor.email,
      ),
      db.prepare(`
        INSERT INTO ops_mutations (
          mutation_id, outlet_id, entity, entity_id, operation, actor_email,
          actor_name, requested_at, committed_at, result_json
        ) VALUES (?, ?, 'Notification', ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        mutationId,
        outletId,
        record.id,
        operation,
        actor.email,
        actor.full_name || actor.email,
        committedAt,
        committedAt,
        JSON.stringify({ ok: true, entity: 'Notification', entity_id: record.id, version, record }),
      ),
      db.prepare(`
        INSERT INTO sheet_sync_outbox (
          mutation_id, entity, entity_id, outlet_id, operation, payload_json,
          status, attempts, next_attempt_at
        ) VALUES (?, 'Notification', ?, ?, ?, ?, 'pending', 0, ?)
      `).bind(
        mutationId,
        record.id,
        outletId,
        operation,
        JSON.stringify(message),
        committedAt,
      ),
    ],
  }
}

async function queueMirror(env, mutationId, message) {
  if (!env.SHEET_SYNC_QUEUE?.send) return false
  try {
    await env.SHEET_SYNC_QUEUE.send(message)
    await env.OPS_DB.prepare(`
      UPDATE sheet_sync_outbox
      SET status = 'queued', queued_at = ?, last_error = ''
      WHERE mutation_id = ?
    `).bind(now(), mutationId).run()
    return true
  } catch (error) {
    console.error('Unable to queue Notification Sheet mirror', mutationId, error)
    return false
  }
}

async function pushNotifications(request, env, user) {
  requireNotificationManager(user)
  const body = await readJson(request)
  const requestedIds = [...new Set((Array.isArray(body.recipient_user_ids) ? body.recipient_user_ids : [])
    .map((value) => String(value || '').trim()).filter(Boolean))]
  if (!requestedIds.length) {
    const error = new Error('Select at least one recipient user ID')
    error.status = 400
    error.code = 'missing_recipients'
    throw error
  }

  const title = String(body.title || '').trim()
  const messageText = String(body.message || '').trim()
  if (!title || !messageText) {
    const error = new Error('Notification title and message are required')
    error.status = 400
    error.code = 'missing_notification_content'
    throw error
  }

  const directory = await listDirectoryRecords(env, 'User', { limit: 5000 })
  const recipients = (directory || []).filter((row) => requestedIds.includes(String(row.id || '')))
  if (!recipients.length) {
    const error = new Error('No matching recipient user IDs were found')
    error.status = 404
    error.code = 'recipients_not_found'
    throw error
  }

  const db = database(env)
  const timestamp = now()
  const targetPage = normalizeNotificationPage(body.target_page)
  const queuedMessages = []

  // Commit in bounded chunks so a large recipient list cannot exceed a D1 batch.
  for (let offset = 0; offset < recipients.length; offset += 40) {
    const chunk = recipients.slice(offset, offset + 40)
    const statements = []
    for (const recipient of chunk) {
      const id = crypto.randomUUID()
      const outletId = firstAssignedOutlet(recipient)
      const record = {
        id,
        outlet_id: outletId === 'global' ? '' : outletId,
        created_date: timestamp,
        created_by: user.email,
        updated_date: timestamp,
        updated_by: user.email,
        deleted_at: '',
        version: 1,
        recipient_user_id: String(recipient.id || ''),
        recipient_email: String(recipient.email || ''),
        recipient_name: String(recipient.full_name || recipient.email || ''),
        title,
        message: messageText,
        target_page: targetPage,
        entity_type: String(body.entity_type || ''),
        entity_id: String(body.entity_id || ''),
        status: 'unread',
        read_at: '',
        pushed_by_name: user.full_name || user.email,
        pushed_by_email: user.email,
        expires_at: String(body.expires_at || ''),
        priority: String(body.priority || 'normal'),
        action_label: String(body.action_label || 'Open'),
        metadata_json: JSON.stringify(body.metadata || {}),
      }
      const mutationId = `notification:push:${id}`
      const prepared = insertStatements(db, {
        mutationId,
        record,
        outletId,
        actor: user,
        operation: 'create',
        version: 1,
        committedAt: timestamp,
      })
      statements.push(...prepared.statements)
      queuedMessages.push({ mutationId, message: prepared.message })
    }
    if (statements.length) await db.batch(statements)
  }

  await Promise.all(queuedMessages.map(({ mutationId, message }) => queueMirror(env, mutationId, message)))
  return json(request, env, { ok: true, created: recipients.length }, 201)
}

async function markNotificationRead(request, env, user, id) {
  const db = database(env)
  const row = await db.prepare(`
    SELECT * FROM ops_records
    WHERE entity = 'Notification' AND entity_id = ? AND deleted_at = ''
    LIMIT 1
  `).bind(id).first()
  if (!row) {
    const error = new Error('Notification was not found in D1')
    error.status = 404
    error.code = 'notification_not_found'
    throw error
  }

  const existing = notificationFromRow(row)
  if (String(existing.recipient_user_id || '') !== String(user.id || '')) {
    const error = new Error('This notification does not belong to your user ID')
    error.status = 403
    error.code = 'forbidden'
    throw error
  }

  if (String(existing.status || '') === 'read') return json(request, env, existing)

  const timestamp = now()
  const version = Number(row.version || 0) + 1
  const record = {
    ...existing,
    __realtime: undefined,
    status: 'read',
    read_at: timestamp,
    updated_date: timestamp,
    updated_by: user.email,
    version,
  }
  const outletId = String(row.outlet_id || firstAssignedOutlet(user) || 'global')
  const mutationId = `notification:read:${id}:${crypto.randomUUID()}`
  const prepared = insertStatements(db, {
    mutationId,
    record,
    outletId,
    actor: user,
    operation: 'update',
    version,
    committedAt: timestamp,
  })
  await db.batch(prepared.statements)
  await queueMirror(env, mutationId, prepared.message)
  return json(request, env, {
    ...record,
    __realtime: {
      entity: 'Notification',
      entity_id: id,
      outlet_id: outletId,
      version,
      updated_at: timestamp,
      deleted_at: '',
      sync_status: 'pending',
    },
  })
}

export async function handleD1Notifications(request, env, url) {
  if (!url.pathname.startsWith('/api/notifications')) return null
  try {
    const user = await getCurrentUser(request, env)
    if (url.pathname === '/api/notifications' && request.method === 'GET') {
      return listNotifications(request, env, url, user)
    }
    if (url.pathname === '/api/notifications/push' && request.method === 'POST') {
      return pushNotifications(request, env, user)
    }
    const readMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/)
    if (readMatch && request.method === 'PATCH') {
      return markNotificationRead(request, env, user, decodeURIComponent(readMatch[1]))
    }
    const error = new Error('Notification endpoint not found')
    error.status = 404
    error.code = 'notification_endpoint_not_found'
    throw error
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
