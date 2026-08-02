import { getSchema } from './schema.js'
import { appendRecord, ensureEntitySheet, updateRecordFlexible } from './sheets.js'

const DIRECTORY_ENTITIES = new Set(['User', 'Outlet'])

function now() {
  return new Date().toISOString()
}

async function setSuccess(env, mutationId) {
  if (!env.OPS_DB?.prepare) return
  const timestamp = now()
  await env.OPS_DB.prepare(`
    UPDATE sheet_sync_outbox
    SET status = 'synced', attempts = attempts + 1, last_attempt_at = ?,
        synced_at = ?, last_error = ''
    WHERE mutation_id = ?
  `).bind(timestamp, timestamp, mutationId).run()
}

async function setFailure(env, mutationId, error) {
  if (!env.OPS_DB?.prepare) return
  const timestamp = now()
  const retryAt = new Date(Date.now() + 5 * 60_000).toISOString()
  await env.OPS_DB.prepare(`
    UPDATE sheet_sync_outbox
    SET status = 'pending', attempts = attempts + 1, last_attempt_at = ?,
        next_attempt_at = ?, last_error = ?
    WHERE mutation_id = ?
  `).bind(timestamp, retryAt, String(error?.message || error).slice(0, 1000), mutationId).run()
}

async function mirrorDirectoryRecord(env, body) {
  const entity = String(body.entity || '')
  const schema = getSchema(entity)
  const record = body.record || {}
  const entityId = String(body.entity_id || record[schema.idField || 'id'] || '').trim()
  await ensureEntitySheet(env, entity)
  try {
    await updateRecordFlexible(env, entity, entityId, record, {
      requiredFields: schema.headers,
    })
  } catch (error) {
    if (error?.code !== 'record_not_found') throw error
    if (body.operation !== 'delete') await appendRecord(env, entity, record)
  }
}

export async function processDirectoryMirrorQueue(batch, env) {
  const remaining = []
  for (const message of batch.messages || []) {
    const body = message.body || {}
    if (!DIRECTORY_ENTITIES.has(String(body.entity || ''))) {
      remaining.push(message)
      continue
    }

    try {
      await mirrorDirectoryRecord(env, body)
      await setSuccess(env, body.mutation_id)
      message.ack()
    } catch (error) {
      console.error('Directory Sheet mirror failed', body.mutation_id, error)
      await setFailure(env, body.mutation_id, error)
      message.retry()
    }
  }
  return remaining
}
