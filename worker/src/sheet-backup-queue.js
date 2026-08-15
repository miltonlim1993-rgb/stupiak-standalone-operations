import {
  flushPendingSheetMirrors,
  handleRealtimeDataApi,
  processSheetMirrorQueue as processLegacySheetMirrorQueue,
} from './realtime-store.js'

export { flushPendingSheetMirrors, handleRealtimeDataApi }

const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_BASE_DELAY_MINUTES = 60
const MAX_DELAY_MINUTES = 24 * 60

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function backupPolicy(env) {
  return {
    maxAttempts: Math.min(
      positiveInteger(env.SHEET_BACKUP_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
      50,
    ),
    baseDelayMinutes: Math.min(
      positiveInteger(env.SHEET_BACKUP_RETRY_BASE_MINUTES, DEFAULT_BASE_DELAY_MINUTES),
      MAX_DELAY_MINUTES,
    ),
  }
}

function googleHttpStatus(lastError) {
  const match = /Google API\s+(\d{3})\b/i.exec(String(lastError || ''))
  return match ? Number(match[1]) : 0
}

export function sheetBackupFailurePolicy(lastError, attempts, env = {}) {
  const policy = backupPolicy(env)
  const attemptCount = Math.max(0, Number(attempts || 0))
  const upstreamStatus = googleHttpStatus(lastError)
  const authConfigurationFailure = /google_(?:data|drive)_auth_(?:disabled|unconfigured)|invalid_grant|invalid_client|unauthorized_client/i
    .test(String(lastError || ''))
  const permanentHttpFailure = upstreamStatus >= 400
    && upstreamStatus < 500
    && ![408, 409, 425, 429].includes(upstreamStatus)
  const exhausted = attemptCount >= policy.maxAttempts
  const dead = authConfigurationFailure || permanentHttpFailure || exhausted

  const exponentialFactor = Math.max(0, Math.min(attemptCount - 1, 5))
  const delayMinutes = Math.min(
    policy.baseDelayMinutes * (2 ** exponentialFactor),
    MAX_DELAY_MINUTES,
  )

  return {
    status: dead ? 'dead' : 'pending',
    retryable: !dead,
    reason: authConfigurationFailure
      ? 'google_auth_configuration'
      : permanentHttpFailure
        ? `google_http_${upstreamStatus}`
        : exhausted
          ? 'max_attempts_exhausted'
          : upstreamStatus === 429
            ? 'google_rate_limited'
            : upstreamStatus >= 500
              ? `google_http_${upstreamStatus}`
              : 'transient_or_unknown',
    upstreamStatus,
    maxAttempts: policy.maxAttempts,
    delayMinutes,
  }
}

async function finalizeOutboxFailure(env, mutationId) {
  if (!env.OPS_DB?.prepare || !mutationId) return null

  const row = await env.OPS_DB.prepare(`
    SELECT status, attempts, last_error
    FROM sheet_sync_outbox
    WHERE mutation_id = ?
    LIMIT 1
  `).bind(mutationId).first()

  if (!row || String(row.status || '') !== 'pending') return null

  const decision = sheetBackupFailurePolicy(row.last_error, row.attempts, env)
  const timestamp = new Date().toISOString()
  const nextAttemptAt = decision.retryable
    ? new Date(Date.now() + decision.delayMinutes * 60_000).toISOString()
    : timestamp

  await env.OPS_DB.prepare(`
    UPDATE sheet_sync_outbox
    SET status = ?, next_attempt_at = ?
    WHERE mutation_id = ? AND status = 'pending'
  `).bind(decision.status, nextAttemptAt, mutationId).run()

  if (decision.status === 'dead') {
    console.error('Sheet backup moved to dead outbox; Cloudflare D1 remains canonical', {
      mutation_id: mutationId,
      attempts: Number(row.attempts || 0),
      reason: decision.reason,
      upstream_status: decision.upstreamStatus || undefined,
    })
  } else {
    console.warn('Sheet backup deferred by D1 outbox', {
      mutation_id: mutationId,
      attempts: Number(row.attempts || 0),
      retry_in_minutes: decision.delayMinutes,
      reason: decision.reason,
    })
  }

  return decision
}

/**
 * Google Sheets is a downstream backup only. The durable D1 outbox owns retry
 * scheduling, so a Google failure must not also enter Cloudflare Queue retry.
 *
 * The legacy mirror processor already records failures in sheet_sync_outbox.
 * We replace message.retry() with message.ack() after that durable write, then
 * apply bounded backoff/dead-letter policy to the outbox row. If recording the
 * failure in D1 itself throws, the legacy processor still throws and Cloudflare
 * Queue may retry the delivery because canonical retry state was not persisted.
 */
export async function processSheetMirrorQueue(batch, env) {
  const mutationIds = new Set()
  const messages = (batch.messages || []).map((message) => {
    const body = message.body || {}
    const mutationId = String(body.mutation_id || '').trim()
    if (mutationId) mutationIds.add(mutationId)

    return {
      body,
      ack: () => message.ack(),
      retry: () => message.ack(),
    }
  })

  await processLegacySheetMirrorQueue({ messages }, env)

  for (const mutationId of mutationIds) {
    await finalizeOutboxFailure(env, mutationId)
  }
}
