import {
  ATTENDANCE_ROSTER_POLICY,
  mirrorAttendanceRosterToSheets,
} from './realtime-attendance-roster.js'

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
  `).bind(
    timestamp,
    retryAt,
    String(error?.message || error).slice(0, 1000),
    mutationId,
  ).run()
}

function isRosterMirror(body) {
  return String(body?.entity || '') === ATTENDANCE_ROSTER_POLICY.entity
    && String(body?.operation || '') === ATTENDANCE_ROSTER_POLICY.operation
}

export async function processAttendanceRosterMirrorQueue(batch, env) {
  const remaining = []
  for (const message of batch.messages || []) {
    const body = message.body || {}
    if (!isRosterMirror(body)) {
      remaining.push(message)
      continue
    }

    try {
      const handled = await mirrorAttendanceRosterToSheets(env, body)
      if (!handled) {
        remaining.push(message)
        continue
      }
      await setSuccess(env, body.mutation_id)
      message.ack()
    } catch (error) {
      console.error('Duty Roster Sheet mirror failed', body.mutation_id, error)
      await setFailure(env, body.mutation_id, error)
      message.retry()
    }
  }
  return remaining
}
