import { opsClient } from '@/api/opsClient'
import { loadOperationalTaskSnapshot } from '@/lib/operational-task-snapshot'
import {
  getWorkerPressureState,
  recordWorkerPressureFailure,
  recordWorkerPressureSuccess,
  shouldDeferWorkerRead,
  workerPressureDeferredError,
  workerPressureDeferredResponse,
} from '@/lib/worker-pressure-circuit'

const VERSION = 'bounded-global-sync-v2-pressure-aware'
const USER_ACTION_BYPASS_MS = 2_000
const TASK_BOOTSTRAP_TTL_MS = 10 * 60_000
const REALTIME_ENTITY_TTL_MS = 10 * 60_000
const NOTIFICATION_TTL_MS = 5 * 60_000
const PACK_MANIFEST_TTL_MS = 10 * 60_000
const RELEASE_MANIFEST_TTL_MS = 5 * 60_000

const BUDGETED_ENTITIES = new Set([
  'Attendance',
  'TrainingAssignment',
  'TrainingProgress',
])

let installed = false
let lastUserActionAt = 0
let originalFetch = null
let originalEntities = null
const methodCache = new Map()
const methodInflight = new Map()
const responseCache = new Map()
const responseInflight = new Map()
const stats = {
  method_cache_hits: 0,
  response_cache_hits: 0,
  inflight_joins: 0,
  network_calls: 0,
  stale_hidden_hits: 0,
  invalidations: 0,
  pressure_deferred: 0,
  pressure_cache_hits: 0,
  pressure_probes: 0,
}

function actorKey() {
  try {
    const user = JSON.parse(localStorage.getItem('chefops.auth.cached-user') || 'null')
    return String(user?.id || user?.google_sub || user?.email || 'anonymous').trim() || 'anonymous'
  } catch {
    return 'anonymous'
  }
}

function stable(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

function recentUserAction() {
  return Date.now() - lastUserActionAt <= USER_ACTION_BYPASS_MS
}

function markUserAction() {
  lastUserActionAt = Date.now()
}

function hiddenWithCached(entry) {
  return Boolean(entry) && typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function visibleUserAction() {
  return recentUserAction() && document.visibilityState !== 'hidden'
}

function canonicalApiOrigin() {
  try { return new URL(opsClient.apiBaseUrl, window.location.href).origin } catch { return window.location.origin }
}

function publishDiagnostics() {
  window.__chefopsRequestBudget = {
    version: VERSION,
    config: {
      user_action_bypass_ms: USER_ACTION_BYPASS_MS,
      task_bootstrap_ttl_ms: TASK_BOOTSTRAP_TTL_MS,
      realtime_entity_ttl_ms: REALTIME_ENTITY_TTL_MS,
      notification_ttl_ms: NOTIFICATION_TTL_MS,
      pack_manifest_ttl_ms: PACK_MANIFEST_TTL_MS,
      release_manifest_ttl_ms: RELEASE_MANIFEST_TTL_MS,
    },
    worker_pressure: getWorkerPressureState(),
    stats: { ...stats },
    cached_methods: methodCache.size,
    cached_responses: responseCache.size,
    updated_at: new Date().toISOString(),
  }
}

function deleteMethodKeys(predicate) {
  let removed = 0
  for (const key of [...methodCache.keys()]) {
    if (!predicate(key)) continue
    methodCache.delete(key)
    removed += 1
  }
  if (removed) {
    stats.invalidations += removed
    publishDiagnostics()
  }
}

function deleteResponseKeys(predicate) {
  let removed = 0
  for (const key of [...responseCache.keys()]) {
    if (!predicate(key)) continue
    responseCache.delete(key)
    removed += 1
  }
  if (removed) {
    stats.invalidations += removed
    publishDiagnostics()
  }
}

async function deferredMethodValue(cached, fallback) {
  stats.pressure_deferred += 1
  if (cached) {
    stats.method_cache_hits += 1
    stats.pressure_cache_hits += 1
    publishDiagnostics()
    return cached.value
  }
  if (typeof fallback === 'function') {
    const value = await fallback()
    stats.pressure_cache_hits += 1
    publishDiagnostics()
    return value
  }
  publishDiagnostics()
  throw workerPressureDeferredError()
}

function canonicalMethodProbeSucceeded(value) {
  if (!value || typeof value !== 'object') return true
  if (value.worker_pressure_deferred || value.device_snapshot) return false
  return String(value.storage || '').toLowerCase() !== 'device-snapshot'
}

async function boundedMethodCall(key, ttlMs, factory, {
  bypass = false,
  pressureAware = false,
  pressureFallback = null,
} = {}) {
  const now = Date.now()
  const cached = methodCache.get(key)
  if (methodInflight.has(key)) {
    stats.inflight_joins += 1
    publishDiagnostics()
    return methodInflight.get(key)
  }

  if (!bypass && cached && cached.expires_at > now) {
    stats.method_cache_hits += 1
    publishDiagnostics()
    return cached.value
  }
  if (!bypass && hiddenWithCached(cached)) {
    stats.method_cache_hits += 1
    stats.stale_hidden_hits += 1
    publishDiagnostics()
    return cached.value
  }

  let pressureProbe = false
  if (pressureAware && getWorkerPressureState().open) {
    if (shouldDeferWorkerRead({ explicit: bypass })) {
      return deferredMethodValue(cached, pressureFallback)
    }
    pressureProbe = true
    stats.pressure_probes += 1
    publishDiagnostics()
  }

  const pending = (async () => {
    try {
      const value = await factory()
      if (pressureProbe && canonicalMethodProbeSucceeded(value)) {
        recordWorkerPressureSuccess({ probe: true })
      }
      methodCache.set(key, {
        value,
        saved_at: Date.now(),
        expires_at: Date.now() + ttlMs,
      })
      publishDiagnostics()
      return value
    } catch (error) {
      const status = Number(error?.status || 0)
      if (pressureProbe) recordWorkerPressureFailure(error, 'budgeted_method_probe_failed')
      if (cached && status !== 401 && status !== 403) return cached.value
      throw error
    }
  })()

  methodInflight.set(key, pending)
  try { return await pending } finally { if (methodInflight.get(key) === pending) methodInflight.delete(key) }
}

function taskKey({ outletId = '', date = '' } = {}) {
  return `task-bootstrap::${actorKey()}::${String(outletId)}::${String(date)}`
}

function entityMethodKey(entity, method, args) {
  return `entity::${actorKey()}::${entity}::${method}::${stable(args)}`
}

function notificationKey(args) {
  return `notifications::${actorKey()}::${stable(args)}`
}

async function taskSnapshotFallback(args = {}) {
  const snapshot = await loadOperationalTaskSnapshot(args.outletId, args.date)
  if (!snapshot) throw workerPressureDeferredError()
  return {
    ...snapshot,
    storage: 'device-snapshot',
    device_snapshot: true,
    worker_pressure_deferred: true,
    server_time: snapshot.server_time || snapshot.device_snapshot_updated_at || new Date().toISOString(),
  }
}

function installTaskBudget() {
  const original = opsClient.tasks.operationalBootstrap.bind(opsClient.tasks)
  opsClient.tasks.operationalBootstrap = async (args = {}) => {
    const key = taskKey(args)
    const explicitUserRefresh = Boolean(args?.refresh) && visibleUserAction()
    return boundedMethodCall(
      key,
      TASK_BOOTSTRAP_TTL_MS,
      () => original(args),
      {
        bypass: explicitUserRefresh,
        pressureAware: true,
        pressureFallback: () => taskSnapshotFallback(args),
      },
    )
  }
}

function installEntityBudget() {
  originalEntities = opsClient.entities
  opsClient.entities = new Proxy({}, {
    get(_target, entityProperty) {
      const entity = String(entityProperty)
      const client = originalEntities[entityProperty]
      if (!client || !BUDGETED_ENTITIES.has(entity)) return client

      return {
        ...client,
        list(...args) {
          const key = entityMethodKey(entity, 'list', args)
          return boundedMethodCall(
            key,
            REALTIME_ENTITY_TTL_MS,
            () => client.list(...args),
            { bypass: visibleUserAction() },
          )
        },
        filter(...args) {
          const key = entityMethodKey(entity, 'filter', args)
          return boundedMethodCall(
            key,
            REALTIME_ENTITY_TTL_MS,
            () => client.filter(...args),
            { bypass: visibleUserAction() },
          )
        },
      }
    },
  })
}

function installNotificationBudget() {
  const originalList = opsClient.notifications.list.bind(opsClient.notifications)
  const originalRead = opsClient.notifications.read.bind(opsClient.notifications)
  const originalPush = opsClient.notifications.push.bind(opsClient.notifications)

  opsClient.notifications.list = (...args) => boundedMethodCall(
    notificationKey(args),
    NOTIFICATION_TTL_MS,
    () => originalList(...args),
    { bypass: visibleUserAction() },
  )

  opsClient.notifications.read = async (...args) => {
    const result = await originalRead(...args)
    deleteMethodKeys((key) => key.startsWith(`notifications::${actorKey()}::`))
    return result
  }

  opsClient.notifications.push = async (...args) => {
    const result = await originalPush(...args)
    deleteMethodKeys((key) => key.startsWith('notifications::'))
    return result
  }
}

function requestUrl(input) {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '')
    return new URL(raw, window.location.href)
  } catch {
    return null
  }
}

function requestMethod(input, init = {}) {
  return String(init.method || input?.method || 'GET').toUpperCase()
}

function isCanonicalWorkerRequest(input) {
  const url = requestUrl(input)
  if (!url) return false
  return url.origin === canonicalApiOrigin() && url.pathname.startsWith('/api/')
}

function isCircuitDeferrableRead(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return false
  const url = requestUrl(input)
  if (!url || url.origin !== canonicalApiOrigin()) return false
  if (!url.pathname.startsWith('/api/')) return false
  if (url.pathname.startsWith('/api/auth/')) return false
  if (url.pathname.startsWith('/api/files/')) return false
  if (url.pathname === '/api/realtime/stream') return false
  return true
}

function responseCacheDescriptor(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return null
  const url = requestUrl(input)
  if (!url) return null

  if (url.origin === canonicalApiOrigin() && url.pathname === '/api/app/v4/pack/manifest') {
    const params = new URLSearchParams(url.search)
    params.delete('_')
    const normalized = `${url.pathname}?${params.toString()}`
    return {
      key: `fetch::${actorKey()}::${normalized}`,
      ttl: PACK_MANIFEST_TTL_MS,
      explicit: params.get('refresh') === '1',
      worker: true,
    }
  }

  if (url.origin === window.location.origin && url.pathname === '/app-release.json') {
    return {
      key: `fetch::release::${url.pathname}`,
      ttl: RELEASE_MANIFEST_TTL_MS,
      explicit: false,
      worker: url.origin === canonicalApiOrigin(),
    }
  }
  return null
}

function pressureCachedResponse(cached) {
  stats.pressure_deferred += 1
  if (cached) {
    stats.response_cache_hits += 1
    stats.pressure_cache_hits += 1
    publishDiagnostics()
    return cached.response.clone()
  }
  publishDiagnostics()
  return workerPressureDeferredResponse()
}

function observeWorkerResponse(response, { probe = false, source = '' } = {}) {
  if (!response) return
  if ([408, 425, 429, 500, 501, 502, 503, 504, 505].includes(Number(response.status))) {
    recordWorkerPressureFailure(response, source || `http_${response.status}`)
    publishDiagnostics()
    return
  }
  if (probe && response.ok) {
    recordWorkerPressureSuccess({ probe: true })
    publishDiagnostics()
  }
}

function installFetchBudget() {
  originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const descriptor = responseCacheDescriptor(input, init)
    const workerRequest = isCanonicalWorkerRequest(input)
    const circuitRead = isCircuitDeferrableRead(input, init)
    const now = Date.now()
    const cached = descriptor ? responseCache.get(descriptor.key) : null

    if (descriptor && responseInflight.has(descriptor.key)) {
      stats.inflight_joins += 1
      publishDiagnostics()
      const response = await responseInflight.get(descriptor.key)
      return response.clone()
    }
    if (descriptor && !descriptor.explicit && !visibleUserAction() && cached && cached.expires_at > now) {
      stats.response_cache_hits += 1
      publishDiagnostics()
      return cached.response.clone()
    }
    if (descriptor && !descriptor.explicit && !visibleUserAction() && hiddenWithCached(cached)) {
      stats.response_cache_hits += 1
      stats.stale_hidden_hits += 1
      publishDiagnostics()
      return cached.response.clone()
    }

    let pressureProbe = false
    if (circuitRead && getWorkerPressureState().open) {
      const explicit = Boolean(descriptor?.explicit) || visibleUserAction()
      if (shouldDeferWorkerRead({ explicit })) return pressureCachedResponse(cached)
      pressureProbe = true
      stats.pressure_probes += 1
      publishDiagnostics()
    }

    const run = async () => {
      if (workerRequest || descriptor?.worker) {
        stats.network_calls += 1
        publishDiagnostics()
      }
      try {
        const response = await originalFetch(input, init)
        if (workerRequest) {
          observeWorkerResponse(response, {
            probe: pressureProbe,
            source: requestUrl(input)?.pathname || 'worker_fetch',
          })
        }
        if (descriptor && response.ok) {
          responseCache.set(descriptor.key, {
            response: response.clone(),
            saved_at: Date.now(),
            expires_at: Date.now() + descriptor.ttl,
          })
          publishDiagnostics()
        }
        return response
      } catch (error) {
        if (workerRequest && (typeof navigator === 'undefined' || navigator.onLine)) {
          recordWorkerPressureFailure(error, requestUrl(input)?.pathname || 'worker_fetch_network')
          publishDiagnostics()
        }
        if (descriptor && cached) return cached.response.clone()
        throw error
      }
    }

    if (!descriptor) return run()
    const pending = run()
    responseInflight.set(descriptor.key, pending)
    try { return await pending } finally { if (responseInflight.get(descriptor.key) === pending) responseInflight.delete(descriptor.key) }
  }
}

function relevantEventEntity(detail = {}) {
  const direct = String(detail.entity || '')
  if (direct) return direct
  const entities = Array.isArray(detail.entities) ? detail.entities.map(String) : []
  return entities.length === 1 ? entities[0] : ''
}

function invalidateEntity(entity, outletId = '') {
  const actor = actorKey()
  const outlet = String(outletId || '')
  deleteMethodKeys((key) => {
    if (!key.startsWith(`entity::${actor}::${entity}::`)) return false
    return !outlet || key.includes(`\"outlet_id\":${JSON.stringify(outlet)}`) || key.includes(JSON.stringify(outlet))
  })
}

function installInvalidationEvents() {
  const onRealtime = (event) => {
    const detail = event?.detail || {}
    const entity = relevantEventEntity(detail)
    const outletId = String(detail.outlet_id || detail.record?.outlet_id || detail.payload?.record?.outlet_id || '')

    if (entity === 'Notification') {
      deleteMethodKeys((key) => key.startsWith(`notifications::${actorKey()}::`))
    }
    if (BUDGETED_ENTITIES.has(entity)) invalidateEntity(entity, outletId)

    if (entity === 'Task') {
      const action = String(detail.action || detail.type || '').toLowerCase()
      if (action.includes('created') || action.includes('deleted')) {
        const date = String(detail.record?.due_date || detail.payload?.record?.due_date || '').slice(0, 10)
        const prefix = `task-bootstrap::${actorKey()}::${outletId}::`
        deleteMethodKeys((key) => key.startsWith(prefix) && (!date || key.endsWith(`::${date}`)))
      }
    }
  }

  const onMutation = (event) => {
    const detail = event?.detail || {}
    const entity = String(detail.entity || detail.mutation?.entity || '')
    const outletId = String(detail.outlet_id || detail.mutation?.outlet_id || '')
    if (BUDGETED_ENTITIES.has(entity)) invalidateEntity(entity, outletId)
    if (entity === 'Notification') deleteMethodKeys((key) => key.startsWith(`notifications::${actorKey()}::`))
  }

  const onPack = () => {
    deleteMethodKeys((key) => key.startsWith(`task-bootstrap::${actorKey()}::`))
    deleteResponseKeys((key) => key.includes('/api/app/v4/pack/manifest'))
  }

  const onOnline = () => {
    deleteMethodKeys((key) => key.startsWith(`task-bootstrap::${actorKey()}::`))
    for (const entity of BUDGETED_ENTITIES) invalidateEntity(entity)
    deleteMethodKeys((key) => key.startsWith(`notifications::${actorKey()}::`))
  }

  window.addEventListener('chefops:realtime', onRealtime)
  window.addEventListener('chefops:realtime-applied', onRealtime)
  window.addEventListener('chefops:mutation-committed', onMutation)
  window.addEventListener('chefops:data-pack-updated', onPack)
  window.addEventListener('chefops:worker-pressure-state', publishDiagnostics)
  window.addEventListener('online', onOnline)
}

export function installGlobalRequestBudget() {
  if (installed) return
  installed = true

  window.addEventListener('pointerdown', markUserAction, { capture: true, passive: true })
  window.addEventListener('touchstart', markUserAction, { capture: true, passive: true })
  window.addEventListener('keydown', markUserAction, { capture: true })

  installTaskBudget()
  installEntityBudget()
  installNotificationBudget()
  installFetchBudget()
  installInvalidationEvents()
  publishDiagnostics()
}

export function clearGlobalRequestBudget() {
  methodCache.clear()
  responseCache.clear()
  publishDiagnostics()
}

export {
  NOTIFICATION_TTL_MS,
  PACK_MANIFEST_TTL_MS,
  REALTIME_ENTITY_TTL_MS,
  RELEASE_MANIFEST_TTL_MS,
  TASK_BOOTSTRAP_TTL_MS,
  USER_ACTION_BYPASS_MS,
  VERSION as GLOBAL_REQUEST_BUDGET_VERSION,
}
