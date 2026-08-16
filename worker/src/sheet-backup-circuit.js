const CIRCUIT_KEY = 'sheet-backup:circuit:v1'
const CACHE_TTL_MS = 15_000
const DEFAULT_FAILURE_WINDOW_MS = 10 * 60_000
const TRANSIENT_FAILURE_WINDOW_MS = 5 * 60_000
const PROBE_LEASE_MS = 2 * 60_000
const MAX_COOLDOWN_MINUTES = 24 * 60

let cachedState = null
let cachedAt = 0

function nowIso(now = Date.now()) {
  return new Date(now).toISOString()
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function defaultState() {
  return {
    version: 1,
    mode: 'closed',
    failure_class: '',
    failure_count: 0,
    window_started_at: '',
    opened_at: '',
    retry_after: '',
    open_count: 0,
    reason: '',
    last_upstream_status: 0,
    last_error: '',
    last_mutation_id: '',
    probe_mutation_id: '',
    probe_until: '',
    updated_at: nowIso(),
  }
}

function normalizedState(value) {
  const base = defaultState()
  if (!value || typeof value !== 'object') return base
  return {
    ...base,
    ...value,
    mode: value.mode === 'open' ? 'open' : 'closed',
    failure_count: Math.max(0, Number(value.failure_count || 0)),
    open_count: Math.max(0, Number(value.open_count || 0)),
    last_upstream_status: Math.max(0, Number(value.last_upstream_status || 0)),
  }
}

async function readState(env, { force = false } = {}) {
  const now = Date.now()
  if (!force && cachedState && now - cachedAt < CACHE_TTL_MS) return cachedState

  let state = cachedState || defaultState()
  if (env.APP_DATA_PACKS?.get) {
    try {
      const stored = await env.APP_DATA_PACKS.get(CIRCUIT_KEY, 'json')
      if (stored) state = normalizedState(stored)
    } catch (error) {
      console.warn('Unable to read Sheet backup circuit state; backup remains fail-open', {
        error: String(error?.message || error).slice(0, 300),
      })
    }
  }

  cachedState = normalizedState(state)
  cachedAt = now
  return cachedState
}

async function persistState(env, state) {
  const normalized = normalizedState({ ...state, updated_at: nowIso() })
  cachedState = normalized
  cachedAt = Date.now()

  if (env.APP_DATA_PACKS?.put) {
    try {
      await env.APP_DATA_PACKS.put(
        CIRCUIT_KEY,
        JSON.stringify(normalized),
        { expirationTtl: 3 * 24 * 60 * 60 },
      )
    } catch (error) {
      console.warn('Unable to persist Sheet backup circuit state', {
        error: String(error?.message || error).slice(0, 300),
      })
    }
  }
  return normalized
}

async function clearStoredState(env) {
  const closed = defaultState()
  cachedState = closed
  cachedAt = Date.now()
  if (env.APP_DATA_PACKS?.delete) {
    try {
      await env.APP_DATA_PACKS.delete(CIRCUIT_KEY)
      return closed
    } catch (error) {
      console.warn('Unable to clear Sheet backup circuit state', {
        error: String(error?.message || error).slice(0, 300),
      })
    }
  }
  return persistState(env, closed)
}

function failurePlan(decision = {}) {
  const status = Number(decision.upstreamStatus || 0)
  if ([401, 403].includes(status)) {
    return {
      failureClass: `google_auth_http_${status}`,
      threshold: 2,
      windowMs: DEFAULT_FAILURE_WINDOW_MS,
      baseCooldownMinutes: 6 * 60,
      reason: `google_auth_http_${status}_burst`,
    }
  }
  if (status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)) {
    return {
      failureClass: `google_permanent_http_${status}`,
      threshold: 5,
      windowMs: DEFAULT_FAILURE_WINDOW_MS,
      baseCooldownMinutes: 2 * 60,
      reason: `google_http_${status}_burst`,
    }
  }
  if (status === 429 || status >= 500) {
    return {
      failureClass: status === 429 ? 'google_rate_limited' : `google_transient_http_${status}`,
      threshold: 5,
      windowMs: TRANSIENT_FAILURE_WINDOW_MS,
      baseCooldownMinutes: 15,
      reason: status === 429 ? 'google_rate_limit_burst' : `google_http_${status}_burst`,
    }
  }
  return {
    failureClass: 'google_unknown_failure',
    threshold: 8,
    windowMs: TRANSIENT_FAILURE_WINDOW_MS,
    baseCooldownMinutes: 15,
    reason: 'google_unknown_failure_burst',
  }
}

function cooldownMinutes(plan, openCount) {
  const factor = 2 ** Math.max(0, Math.min(Number(openCount || 1) - 1, 5))
  return Math.min(plan.baseCooldownMinutes * factor, MAX_COOLDOWN_MINUTES)
}

export async function getSheetBackupCircuitState(env, options = {}) {
  const state = await readState(env, options)
  const now = Date.now()
  const retryAfter = timestamp(state.retry_after)
  return {
    ...state,
    is_open: state.mode === 'open',
    is_deferred: state.mode === 'open' && retryAfter > now,
    is_half_open: state.mode === 'open' && retryAfter > 0 && retryAfter <= now,
  }
}

/**
 * Canonical D1 writes never depend on this circuit. This gate only decides
 * whether the optional Google Sheet backup may consume a Queue delivery or a
 * Google API request right now.
 */
export async function gateSheetBackupAttempt(env, {
  mutationId = '',
  allowProbe = false,
} = {}) {
  const state = await readState(env)
  if (state.mode !== 'open') {
    return { allowed: true, probe: false, reason: 'closed', nextAttemptAt: '' }
  }

  const now = Date.now()
  const retryAfter = timestamp(state.retry_after)
  if (retryAfter > now) {
    return {
      allowed: false,
      probe: false,
      reason: state.reason || 'circuit_open',
      nextAttemptAt: state.retry_after,
    }
  }

  if (!allowProbe || !mutationId) {
    return {
      allowed: false,
      probe: false,
      reason: 'half_open_waiting_for_probe',
      nextAttemptAt: state.retry_after || nowIso(now),
    }
  }

  const probeUntil = timestamp(state.probe_until)
  if (probeUntil > now && state.probe_mutation_id && state.probe_mutation_id !== mutationId) {
    return {
      allowed: false,
      probe: false,
      reason: 'half_open_probe_in_flight',
      nextAttemptAt: state.probe_until,
    }
  }

  if (probeUntil > now && state.probe_mutation_id === mutationId) {
    return { allowed: true, probe: true, reason: 'half_open_probe_replay', nextAttemptAt: '' }
  }

  const reserved = await persistState(env, {
    ...state,
    probe_mutation_id: mutationId,
    probe_until: nowIso(now + PROBE_LEASE_MS),
  })
  return {
    allowed: true,
    probe: true,
    reason: 'half_open_probe_reserved',
    nextAttemptAt: '',
    state: reserved,
  }
}

export async function recordSheetBackupFailure(env, {
  decision = {},
  lastError = '',
  mutationId = '',
} = {}) {
  // Keep the in-isolate state authoritative during a Queue batch. KV is the
  // cross-isolate persistence layer, but forcing an immediate KV read after
  // every write can observe eventual-consistency lag and lose burst counts.
  const state = await readState(env)
  const now = Date.now()
  const plan = failurePlan(decision)
  const retryAfter = timestamp(state.retry_after)
  const probeFailed = state.mode === 'open'
    && retryAfter <= now
    && state.probe_mutation_id
    && state.probe_mutation_id === mutationId

  // Do not continually extend a currently-open circuit because stale Queue
  // deliveries arrive after the breaker has already protected the backup path.
  if (state.mode === 'open' && retryAfter > now) return state

  const windowStart = timestamp(state.window_started_at)
  const sameWindow = state.failure_class === plan.failureClass
    && windowStart > 0
    && now - windowStart <= plan.windowMs
  const failureCount = probeFailed
    ? plan.threshold
    : (sameWindow ? Number(state.failure_count || 0) + 1 : 1)
  const shouldOpen = probeFailed || failureCount >= plan.threshold

  if (!shouldOpen) {
    return persistState(env, {
      ...state,
      mode: 'closed',
      failure_class: plan.failureClass,
      failure_count: failureCount,
      window_started_at: sameWindow ? state.window_started_at : nowIso(now),
      reason: '',
      last_upstream_status: Number(decision.upstreamStatus || 0),
      last_error: String(lastError || '').slice(0, 500),
      last_mutation_id: mutationId,
      probe_mutation_id: '',
      probe_until: '',
    })
  }

  const openCount = Math.max(1, Number(state.open_count || 0) + 1)
  const delayMinutes = cooldownMinutes(plan, openCount)
  const opened = await persistState(env, {
    ...state,
    mode: 'open',
    failure_class: plan.failureClass,
    failure_count: failureCount,
    window_started_at: sameWindow ? state.window_started_at : nowIso(now),
    opened_at: nowIso(now),
    retry_after: nowIso(now + delayMinutes * 60_000),
    open_count: openCount,
    reason: plan.reason,
    last_upstream_status: Number(decision.upstreamStatus || 0),
    last_error: String(lastError || '').slice(0, 500),
    last_mutation_id: mutationId,
    probe_mutation_id: '',
    probe_until: '',
  })

  console.error('Sheet backup circuit opened; D1/R2 remain canonical and writes continue', {
    reason: opened.reason,
    failure_class: opened.failure_class,
    failure_count: opened.failure_count,
    upstream_status: opened.last_upstream_status || undefined,
    retry_after: opened.retry_after,
    mutation_id: mutationId || undefined,
  })
  return opened
}

export async function recordSheetBackupSuccess(env, { mutationId = '' } = {}) {
  const state = await readState(env)
  const now = Date.now()
  const retryAfter = timestamp(state.retry_after)
  const successfulProbe = state.mode === 'open'
    && retryAfter <= now
    && (!state.probe_mutation_id || state.probe_mutation_id === mutationId)

  if (!successfulProbe) return state

  console.info('Sheet backup circuit recovered after successful probe', {
    mutation_id: mutationId || undefined,
    previous_reason: state.reason || undefined,
  })
  return clearStoredState(env)
}

export async function clearSheetBackupCircuit(env) {
  return clearStoredState(env)
}

export const SHEET_BACKUP_CIRCUIT_VERSION = 'sheet-backup-circuit-v1'
