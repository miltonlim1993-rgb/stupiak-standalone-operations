import { opsClient } from '@/api/opsClient'

const VERSION = 'bounded-global-sync-v1'
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

async function boundedMethodCall(key, ttlMs, factory, { bypass = false } = {}) {
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

  const pending = (async () => {
    stats.network_calls += 1
    publishDiagnostics()
    try {
      const value = await factory()
      methodCache.set(key, {
        value,
        saved_at: Date.now(),
        expires_at: Date.now() + ttlMs,
      })
      publishDiagnostics()
      return value
    } catch (error) {
      const status = Number(error?.status || 0)
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

function installTaskBudget() {
  const original = opsClient.tasks.operationalBootstrap.bind(opsClient.tasks)
  opsClient.tasks.operationalBootstrap = async (args = {}) => {
    const key = taskKey(args)
    const explicitUserRefresh = Boolean(args?.refresh) && recentUserAction()
    return boundedMethodCall(
      key,
      TASK_BOOTSTRAP_TTL_MS,
      () => original(args),
      { bypass: explicitUserRefresh },
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
            { bypass: recentUserAction() },
          )
        },
        filter(...args) {
          const key = entityMethodKey(entity, 'filter', args)
          return boundedMethodCall(
            key,
            REALTIME_ENTITY_TTL_MS,
            () => client.filter(...args),
            { bypass: recentUserAction() },
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
    { bypass: recentUserAction() },
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

function responseCacheDescriptor(input, init = {}) {
  const method = String(init.method || input?.method || 'GET').toUpperCase()
  if (method !== 'GET') return null
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '')
    const url = new URL(raw, window.location.href)
    if (url.origin !== window.location.origin) return null

    if (url.pathname === '/api/app/v4/pack/manifest') {
      const params = new URLSearchParams(url.search)
      params.delete('_')
      const normalized = `${url.pathname}?${params.toString()}`
      return {
        key: `fetch::${actorKey()}::${normalized}`,
        ttl: PACK_MANIFEST_TTL_MS,
        explicit: params.get('refresh') === '1',
      }
    }

    if (url.pathname === '/app-release.json') {
      return {
        key: `fetch::release::${url.pathname}`,
        ttl: RELEASE_MANIFEST_TTL_MS,
        explicit: false,
      }
    }
  } catch {}
  return null
}

function installFetchBudget() {
  originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const descriptor = responseCacheDescriptor(input, init)
    if (!descriptor) return originalFetch(input, init)

    const { key, ttl, explicit } = descriptor
    const now = Date.now()
    const cached = responseCache.get(key)
    const bypass = (explicit || recentUserAction()) && document.visibilityState !== 'hidden'

    if (responseInflight.has(key)) {
      stats.inflight_joins += 1
      publishDiagnostics()
      const response = await responseInflight.get(key)
      return response.clone()
    }
    if (!bypass && cached && cached.expires_at > now) {
      stats.response_cache_hits += 1
      publishDiagnostics()
      return cached.response.clone()
    }
    if (!bypass && hiddenWithCached(cached)) {
      stats.response_cache_hits += 1
      stats.stale_hidden_hits += 1
      publishDiagnostics()
      return cached.response.clone()
    }

    const pending = (async () => {
      stats.network_calls += 1
      publishDiagnostics()
      try {
        const response = await originalFetch(input, init)
        if (response.ok) {
          responseCache.set(key, {
            response: response.clone(),
            saved_at: Date.now(),
            expires_at: Date.now() + ttl,
          })
          publishDiagnostics()
        }
        return response
      } catch (error) {
        if (cached) return cached.response.clone()
        throw error
      }
    })()

    responseInflight.set(key, pending)
    try { return await pending } finally { if (responseInflight.get(key) === pending) responseInflight.delete(key) }
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
