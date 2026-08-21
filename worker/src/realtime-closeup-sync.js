import { getCurrentUser } from './auth.js'
import { errorResponse, json } from './http.js'
import { assertOutletAccess } from './permissions.js'

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function now() {
  return new Date().toISOString()
}

async function closeUpRow(env, id) {
  return env.OPS_DB.prepare(`
    SELECT r.*,
      (SELECT o.mutation_id FROM sheet_sync_outbox o
       WHERE o.entity = 'CloseUp' AND o.entity_id = r.entity_id
       ORDER BY o.id DESC LIMIT 1) AS mirror_mutation_id,
      (SELECT o.status FROM sheet_sync_outbox o
       WHERE o.entity = 'CloseUp' AND o.entity_id = r.entity_id
       ORDER BY o.id DESC LIMIT 1) AS mirror_status,
      (SELECT o.attempts FROM sheet_sync_outbox o
       WHERE o.entity = 'CloseUp' AND o.entity_id = r.entity_id
       ORDER BY o.id DESC LIMIT 1) AS mirror_attempts,
      (SELECT o.last_error FROM sheet_sync_outbox o
       WHERE o.entity = 'CloseUp' AND o.entity_id = r.entity_id
       ORDER BY o.id DESC LIMIT 1) AS mirror_error,
      (SELECT o.synced_at FROM sheet_sync_outbox o
       WHERE o.entity = 'CloseUp' AND o.entity_id = r.entity_id
       ORDER BY o.id DESC LIMIT 1) AS mirror_synced_at
    FROM ops_records r
    WHERE r.entity = 'CloseUp' AND r.entity_id = ? AND r.deleted_at = ''
    LIMIT 1
  `).bind(id).first()
}

function syncView(row) {
  return {
    record_id: row.entity_id,
    outlet_id: row.outlet_id,
    d1_committed: true,
    d1_version: Number(row.version || 0),
    d1_updated_at: row.updated_at || '',
    sheet_backup: {
      role: 'asynchronous_backup_record_only',
      blocks_store_save: false,
      mutation_id: row.mirror_mutation_id || '',
      status: row.mirror_status || 'pending',
      attempts: Number(row.mirror_attempts || 0),
      last_error: row.mirror_error || '',
      synced_at: row.mirror_synced_at || '',
    },
  }
}

export async function handleRealtimeCloseUpSync(request, env, url) {
  const match = url.pathname.match(/^\/api\/close-up\/([^/]+)\/(sync|sync-status)$/)
  if (!match) return null

  try {
    if (!env.OPS_DB?.prepare) {
      const error = new Error('Close Up D1 database is unavailable')
      error.status = 503
      error.code = 'close_up_d1_unavailable'
      throw error
    }

    const id = decodeURIComponent(match[1])
    const action = match[2]
    const row = await closeUpRow(env, id)
    if (!row) {
      const error = new Error('Close Up record was not found in D1')
      error.status = 404
      error.code = 'close_up_not_found'
      throw error
    }

    const user = await getCurrentUser(request, env)
    const record = parseJson(row.payload_json, {}) || {}
    if (record.outlet_id) assertOutletAccess(user, record.outlet_id)

    if (action === 'sync-status' && request.method === 'GET') {
      return json(request, env, syncView(row))
    }

    if (action !== 'sync' || request.method !== 'POST') {
      const error = new Error('Method not allowed')
      error.status = 405
      error.code = 'method_not_allowed'
      throw error
    }
    if (!row.mirror_mutation_id) {
      const error = new Error('No Sheet backup outbox entry exists for this Close Up record')
      error.status = 409
      error.code = 'close_up_mirror_missing'
      throw error
    }

    const retryAt = now()
    await env.OPS_DB.prepare(`
      UPDATE sheet_sync_outbox
      SET status = 'pending', next_attempt_at = ?, last_error = ''
      WHERE mutation_id = ?
    `).bind(retryAt, row.mirror_mutation_id).run()

    const payloadRow = await env.OPS_DB.prepare(
      'SELECT payload_json FROM sheet_sync_outbox WHERE mutation_id = ? LIMIT 1',
    ).bind(row.mirror_mutation_id).first()
    const message = parseJson(payloadRow?.payload_json, null)
    let queued = false
    if (message && env.SHEET_SYNC_QUEUE?.send) {
      await env.SHEET_SYNC_QUEUE.send(message)
      await env.OPS_DB.prepare(`
        UPDATE sheet_sync_outbox
        SET status = 'queued', queued_at = ?
        WHERE mutation_id = ?
      `).bind(retryAt, row.mirror_mutation_id).run()
      queued = true
    }

    const refreshed = await closeUpRow(env, id)
    return json(request, env, {
      ok: true,
      accepted: true,
      queued,
      ...syncView(refreshed || row),
    }, 202)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
