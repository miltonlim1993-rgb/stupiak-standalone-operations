const VERSION = 'worker-pressure-circuit-v1'
const STORAGE_KEY = 'chefops.worker-pressure-circuit.v1'
const BASE_BACKOFF_MS = 5 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000
const FAILURE_WINDOW_MS = 2 * 60_000
const SOFT_FAILURE_THRESHOLD = 2
const PROBE_INTERVAL_MS = 60_000

const HARD_PRESSURE_STATUSES = new Set([408, 425, 429, 502, 503, 504])
const SOFT_PRESSURE_STATUSES = new Set([500, 501, 505])
const AUTH_STATUSES = new Set([401, 403])

const EMPTY_STATE = Object.freeze({
  failure_count: 0,
  window_started_at: 0,
  open_until: 0,
  last_failure_at: 0,
  last_status: 0,
  last_code: '',
  last_probe_at: 0,
  opened_reason: '',
})

let memoryState = null

function number(value) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeState(input = {}) {
  return {
    failure_count: Math.max(0, number(input.failure_count)),
    window_started_at: Math.max(0, number(input.window_started_at)),
    open_until: Math.max(0, number(input.open_until)),
    last_failure_at: Math.max(0, number(input.last_failure_at)),
    last_status: Math.max(0, number(input.last_status)),
    last_code: String(input.last_code || ''),
    last_probe_at: Math.max(0, number(input.last_probe_at)),
    opened_reason: String(input.opened_reason || ''),
  }
}

function readStoredState() {
  if (memoryState) return memoryState
  try {
    memoryState = normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'))
  } catch {
    memoryState = { ...EMPTY_STATE }
  }
  return memoryState
}

function publish(state) {
  if (typeof window === 'undefined') return
  window.__chefopsWorkerPressure = {
    version: VERSION,
    ...state,
    open: state.open_until > Date.now(),
    remaining_ms: Math.max(0, state.open_until - Date.now()),
    updated_at: new Date().toISOString(),
  }
  window.dispatchEvent(new CustomEvent('chefops:worker-pressure-state', {
    detail: window.__chefopsWorkerPressure,
  }))
}

function writeState(next) {
  memoryState = normalizeState(next)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryState)) } catch {}
  publish(memoryState)
  return memoryState
}

function activeState() {
  const state = readStoredState()
  if (state.open_until && state.open_until <= Date.now()) {
    return writeState({ ...state, open_until: 0, opened_reason: '' })
  }
  return state
}

function statusFrom(value) {
  if (value instanceof Response) return Number(value.status || 0)
  return Number(value?.status || value?.response?.status || 0)
}

function codeFrom(value) {
  return String(value?.code || value?.response?.code || '').trim()
}

function pressureClass(value) {
  const status = statusFrom(value)
  if (AUTH_STATUSES.has(status)) return 'ignore'
  if (HARD_PRESSURE_STATUSES.has(status)) return 'hard'
  if (SOFT_PRESSURE_STATUSES.has(status)) return 'soft'
  if (!status && typeof navigator !== 'undefined' && navigator.onLine) return 'soft'
  return 'ignore'
}

function backoffMs(failureCount) {
  const exponent = Math.max(0, Math.min(Number(failureCount || 1) - 1, 3))
  return Math.min(BASE_BACKOFF_MS * (2 ** exponent), MAX_BACKOFF_MS)
}

export function recordWorkerPressureFailure(value, reason = '') {
  const kind = pressureClass(value)
  if (kind === 'ignore') return getWorkerPressureState()

  const now = Date.now()
  const current = activeState()
  const sameWindow = current.window_started_at && now - current.window_started_at <= FAILURE_WINDOW_MS
  const failureCount = sameWindow ? current.failure_count + 1 : 1
  const shouldOpen = kind === 'hard' || failureCount >= SOFT_FAILURE_THRESHOLD
  const status = statusFrom(value)
  const code = codeFrom(value)
  const openUntil = shouldOpen
    ? Math.max(current.open_until || 0, now + backoffMs(failureCount))
    : current.open_until || 0

  const next = writeState({
    ...current,
    failure_count: failureCount,
    window_started_at: sameWindow ? current.window_started_at : now,
    open_until: openUntil,
    last_failure_at: now,
    last_status: status,
    last_code: code,
    opened_reason: shouldOpen ? (String(reason || code || `http_${status || 'network'}`)) : current.opened_reason,
  })
  return { ...next, open: next.open_until > now, remaining_ms: Math.max(0, next.open_until - now) }
}

export function recordWorkerPressureSuccess({ probe = false } = {}) {
  const current = activeState()
  if (!current.open_until && !probe) return getWorkerPressureState()
  return writeState({
    ...EMPTY_STATE,
    last_probe_at: current.last_probe_at,
  })
}

export function getWorkerPressureState() {
  const state = activeState()
  return {
    version: VERSION,
    ...state,
    open: state.open_until > Date.now(),
    remaining_ms: Math.max(0, state.open_until - Date.now()),
  }
}

export function reserveWorkerPressureProbe() {
  const current = activeState()
  if (!current.open_until) return true
  const now = Date.now()
  if (current.last_probe_at && now - current.last_probe_at < PROBE_INTERVAL_MS) return false
  writeState({ ...current, last_probe_at: now })
  return true
}

export function shouldDeferWorkerRead({ explicit = false } = {}) {
  const current = getWorkerPressureState()
  if (!current.open) return false
  if (!explicit) return true
  return !reserveWorkerPressureProbe()
}

export function workerPressureDeferredError() {
  const state = getWorkerPressureState()
  const error = new Error('Server request pressure is temporarily high. Cached device data is being used while automatic retries cool down.')
  error.status = 503
  error.code = 'worker_pressure_deferred'
  error.retry_at = state.open_until ? new Date(state.open_until).toISOString() : ''
  return error
}

export function workerPressureDeferredResponse() {
  const error = workerPressureDeferredError()
  return new Response(JSON.stringify({
    error: error.message,
    code: error.code,
    retry_at: error.retry_at,
    cached_mode: true,
  }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-ChefOps-Worker-Pressure': 'deferred',
    },
  })
}

export function clearWorkerPressureCircuit() {
  return writeState({ ...EMPTY_STATE })
}

export {
  BASE_BACKOFF_MS,
  FAILURE_WINDOW_MS,
  MAX_BACKOFF_MS,
  PROBE_INTERVAL_MS,
  SOFT_FAILURE_THRESHOLD,
  STORAGE_KEY as WORKER_PRESSURE_STORAGE_KEY,
  VERSION as WORKER_PRESSURE_VERSION,
}
