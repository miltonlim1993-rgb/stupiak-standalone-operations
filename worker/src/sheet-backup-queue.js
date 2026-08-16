import {
  flushPendingSheetMirrors as flushLegacyPendingSheetMirrors,
  handleRealtimeDataApi,
  processSheetMirrorQueue as processLegacySheetMirrorQueue,
} from './realtime-store.js'
import {
  gateSheetBackupAttempt,
  getSheetBackupCircuitState,
  recordSheetBackupFailure,
  recordSheetBackupSuccess,
} from './sheet-backup-circuit.js'

export { handleRealtimeDataApi }

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
  if (!env.OPS_DB?.prepare || !mutationId) return { status: 'missing', decision: null, lastError: '' }

  const row = await env.OPS_DB.prepare(`
    SELECT status, attempts, last_error
    FROM sheet_sync_outbox
    WHERE mutation_id = ?
    LIMIT 1
  `).bind(mutationId).first()

  if (!row) return { status: 'missing', decision: null, lastError: '' }
  if (String(row.status || '') !== 'pending') {
    return {
      status: String(row.status || ''),
      decision: null,
      lastError: String(row.last_error || ''),
    }
  }

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
      last_error: String(row.last_error || '').slice(0, 500),
    })
  } else {
    console.warn('Sheet backup deferred by D1 outbox', {
      mutation_id: mutationId,
      attempts: Number(row.attempts || 0),
      retry_in_minutes: decision.delayMinutes,
      reason: decision.reason,
      upstream_status: decision.upstreamStatus || undefined,
    })
  }

  return {
    status: decision.status,
    decision,
    lastError: String(row.last_error || ''),
  }
}

async function deferOutboxForCircuit(env, mutationId, gate) {
  if (!env.OPS_DB?.prepare || !mutationId) return
  const nextAttemptAt = String(gate?.nextAttemptAt || '').trim()
    || new Date(Date.now() + 15 * 60_000).toISOString()
  await env.OPS_DB.prepare(`
    UPDATE sheet_sync_outbox
    SET status = 'pending', next_attempt_at = ?
    WHERE mutation_id = ? AND status IN ('queued', 'pending')
  `).bind(nextAttemptAt, mutationId).run()
}

/**
 * The hourly D1 outbox flush stops feeding the Queue while the optional Google
 * backup circuit is open. Once the cooldown expires, only one row is queued as
 * a recovery probe. Canonical D1/R2 data is not touched by this gate.
 */
export async function flushPendingSheetMirrors(env, limit = 50) {
  const circuit = await getSheetBackupCircuitState(env)
  if (circuit.is_deferred) {
    return {
      queued: 0,
      sheet_backup_circuit: 'open',
      retry_after: circuit.retry_after || '',
    }
  }

  const effectiveLimit = circuit.is_half_open
    ? 1
    : Math.max(1, Math.min(Number(limit) || 50, 100))
  const result = await flushLegacyPendingSheetMirrors(env, effectiveLimit)
  return {
    ...result,
    sheet_backup_circuit: circuit.is_half_open ? 'half_open' : 'closed',
  }
}

/**
 * Google Sheets is a downstream backup only. The durable D1 outbox owns retry
 * scheduling, so a Google failure must not also enter Cloudflare Queue retry.
 *
 * Repeated upstream failures also open a KV-backed circuit. Messages arriving
 * while that circuit is open are acknowledged and returned to the D1 outbox
 * without touching Google. This keeps Cloudflare D1/R2 canonical writes live
 * even if Sheet permissions, schema, quota, or upstream availability is bad.
 *
 * If recording retry state in D1 itself throws, the consumer still throws and
 * Cloudflare Queue may retry because durable retry ownership was not persisted.
 */
export async function processSheetMirrorQueue(batch, env) {
  for (const message of batch.messages || []) {
    const body = message.body || {}
    const mutationId = String(body.mutation_id || '').trim()

    if (mutationId) {
      const gate = await gateSheetBackupAttempt(env, {
        mutationId,
        allowProbe: true,
      })
      if (!gate.allowed) {
        await deferOutboxForCircuit(env, mutationId, gate)
        message.ack()
        continue
      }
    }

    const wrappedMessage = {
      body,
      ack: () => message.ack(),
      retry: () => message.ack(),
    }

    await processLegacySheetMirrorQueue({ messages: [wrappedMessage] }, env)

    if (!mutationId) continue
    const outcome = await finalizeOutboxFailure(env, mutationId)
    if (outcome.decision) {
      await recordSheetBackupFailure(env, {
        decision: outcome.decision,
        lastError: outcome.lastError,
        mutationId,
      })
    } else if (outcome.status === 'synced') {
      await recordSheetBackupSuccess(env, { mutationId })
    }
  }
}
