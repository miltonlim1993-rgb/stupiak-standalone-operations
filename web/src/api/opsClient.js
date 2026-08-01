import { getPackedEntity, getPackedLabelCatalog } from '@/lib/app-pack'
import { submitRealtimeMutation } from '@/lib/realtime-mutations'

const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')

const GET_RESPONSE_CACHE = new Map()
const GET_INFLIGHT = new Map()
const REALTIME_ENTITIES = new Set([
  'Task',
  'TaskPhoto',
  'UrgentIssue',
  'StockCount',
  'CloseUp',
  'FoodLabel',
  'LabelPrintLog',
  'Attendance',
  'Receipt',
  'Notification',
  'TrainingAssignment',
  'TrainingProgress',
  'TrainingAcknowledgement',
  'TrainingAttempt',
])

function getTtl(path) {
  if (path === '/api/auth/me') return 15_000
  if (path.startsWith('/api/notifications')) return 12_000
  if (path === '/api/app/v4/version') return 300_000
  if (path.startsWith('/api/app/v4/bootstrap')) return 30_000
  if (path.startsWith('/api/entities/')) return 8_000
  if (path.startsWith('/api/labels/')) return 30_000
  if (path.startsWith('/api/realtime/')) return 0
  return 5_000
}

function clearGetCache() {
  GET_RESPONSE_CACHE.clear()
}

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

async function request(path, options = {}) {
  const method = options.method || 'GET'
  const isGet = method === 'GET' && options.body === undefined
  const cacheKey = isGet ? path : ''
  const currentTime = Date.now()

  if (isGet) {
    const cached = GET_RESPONSE_CACHE.get(cacheKey)
    if (cached && cached.expiresAt > currentTime) return cached.data
    if (GET_INFLIGHT.has(cacheKey)) return GET_INFLIGHT.get(cacheKey)
  }

  const execute = async () => {
    const headers = new Headers(options.headers || {})
    const init = { method, credentials: 'include', headers }
    if (options.body instanceof FormData) {
      init.body = options.body
    } else if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json')
      init.body = JSON.stringify(options.body)
    }
    const response = await fetch(`${API_BASE_URL}${path}`, init)
    const contentType = response.headers.get('content-type') || ''
    const data = contentType.includes('application/json') ? await response.json() : await response.text()
    if (!response.ok) {
      throw new ApiError(
        data?.error || data?.message || `Request failed (${response.status})`,
        response.status,
        data?.code,
        data?.details,
      )
    }
    const ttl = getTtl(path)
    if (isGet && ttl > 0) GET_RESPONSE_CACHE.set(cacheKey, { data, expiresAt: Date.now() + ttl })
    else if (!isGet) clearGetCache()
    return data
  }

  if (!isGet) return execute()
  const pending = execute()
  GET_INFLIGHT.set(cacheKey, pending)
  try { return await pending } finally { if (GET_INFLIGHT.get(cacheKey) === pending) GET_INFLIGHT.delete(cacheKey) }
}

function addYear(params, options) {
  if (options?.year) params.set('year', String(options.year))
  return params
}

function packOutlet(filter = {}) {
  const requested = filter?.outlet_id
  if (requested !== undefined && requested !== null && typeof requested !== 'object') return String(requested)
  return String(localStorage.getItem('chefops.data-pack.outlet') || '')
}

function recordId(row) {
  return String(row?.id || row?.__realtime?.entity_id || '').trim()
}

function comparable(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function orderedComparison(left, right) {
  const numericLeft = Number(left)
  const numericRight = Number(right)
  if (comparable(left) !== '' && comparable(right) !== '' && Number.isFinite(numericLeft) && Number.isFinite(numericRight)) {
    return numericLeft - numericRight
  }
  return comparable(left).localeCompare(comparable(right))
}

function matchesFilter(row, filter = {}) {
  return Object.entries(filter || {}).every(([field, expected]) => {
    if (expected === undefined) return true
    const actual = row?.[field]
    if (Array.isArray(expected)) return expected.map(comparable).includes(comparable(actual))
    if (expected && typeof expected === 'object') {
      if (Array.isArray(expected.$in) && !expected.$in.map(comparable).includes(comparable(actual))) return false
      if (Array.isArray(expected.$nin) && expected.$nin.map(comparable).includes(comparable(actual))) return false
      if (Object.prototype.hasOwnProperty.call(expected, '$ne') && comparable(actual) === comparable(expected.$ne)) return false
      if (Object.prototype.hasOwnProperty.call(expected, '$eq') && comparable(actual) !== comparable(expected.$eq)) return false
      if (Object.prototype.hasOwnProperty.call(expected, '$lt') && orderedComparison(actual, expected.$lt) >= 0) return false
      if (Object.prototype.hasOwnProperty.call(expected, '$lte') && orderedComparison(actual, expected.$lte) > 0) return false
      if (Object.prototype.hasOwnProperty.call(expected, '$gt') && orderedComparison(actual, expected.$gt) <= 0) return false
      if (Object.prototype.hasOwnProperty.call(expected, '$gte') && orderedComparison(actual, expected.$gte) < 0) return false
      if (Object.prototype.hasOwnProperty.call(expected, '$contains') && !comparable(actual).toLowerCase().includes(comparable(expected.$contains).toLowerCase())) return false
      return true
    }
    return comparable(actual) === comparable(expected)
  })
}

function sortedRows(rows, sort = '') {
  const fields = String(sort || '').split(',').map((value) => value.trim()).filter(Boolean)
  if (!fields.length) return rows
  return [...rows].sort((left, right) => {
    for (const fieldSpec of fields) {
      const descending = fieldSpec.startsWith('-')
      const field = descending ? fieldSpec.slice(1) : fieldSpec
      const comparison = orderedComparison(left?.[field], right?.[field])
      if (comparison === 0) continue
      return descending ? -comparison : comparison
    }
    return 0
  })
}

async function realtimeRows(entity, outletId, limit = 500) {
  if (!REALTIME_ENTITIES.has(entity) || !outletId) return []
  const params = new URLSearchParams({
    entity,
    outlet_id: outletId,
    include_deleted: '1',
    limit: String(Math.max(1, Math.min(Number(limit) || 500, 500))),
    _: String(Date.now()),
  })
  try {
    const result = await request(`/api/realtime/records?${params}`)
    return Array.isArray(result?.records) ? result.records : []
  } catch (error) {
    // During phased rollout, an undeployed or temporarily unavailable D1 layer
    // must not make existing read-only screens unusable.
    if ([404, 503].includes(Number(error?.status || 0))) return []
    throw error
  }
}

async function mergeRealtimeRows(entity, baseRows, {
  outletId = '',
  filter = {},
  sort = '',
  limit = 100,
} = {}) {
  const base = Array.isArray(baseRows) ? baseRows : []
  const overlay = await realtimeRows(entity, outletId, Math.max(limit, 500))
  if (!overlay.length) return base

  const byId = new Map(base.map((row) => [recordId(row), row]).filter(([id]) => id))
  const unkeyed = base.filter((row) => !recordId(row))
  for (const row of overlay) {
    const id = recordId(row)
    if (!id) continue
    const deleted = Boolean(row?.deleted_at || row?.__realtime?.deleted_at)
    if (deleted || !matchesFilter(row, filter)) {
      byId.delete(id)
      continue
    }
    byId.set(id, {
      ...(byId.get(id) || {}),
      ...row,
      __realtime: row.__realtime,
    })
  }
  return sortedRows([...byId.values(), ...unkeyed], sort).slice(0, Math.max(1, Number(limit) || 100))
}

async function legacyRecord(entity, id, options = {}) {
  const params = addYear(new URLSearchParams({
    filter: JSON.stringify({ id }),
    limit: '2',
  }), options)
  const rows = await request(`/api/entities/${encodeURIComponent(entity)}?${params}`)
  return Array.isArray(rows) ? rows.find((row) => recordId(row) === String(id)) || rows[0] || null : null
}

async function realtimeRecord(entity, outletId, id) {
  const rows = await realtimeRows(entity, outletId, 500)
  return rows.find((row) => recordId(row) === String(id)) || null
}

function entityClient(entity) {
  const legacyCreate = (data, options = {}) => {
    const params = addYear(new URLSearchParams(), options)
    const suffix = params.toString() ? `?${params}` : ''
    return request(`/api/entities/${encodeURIComponent(entity)}${suffix}`, { method: 'POST', body: data })
  }
  const legacyUpdate = (id, data, options = {}) => {
    const params = addYear(new URLSearchParams(), options)
    const suffix = params.toString() ? `?${params}` : ''
    return request(`/api/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}${suffix}`, { method: 'PATCH', body: data })
  }
  const legacyDelete = (id, options = {}) => {
    const params = addYear(new URLSearchParams(), options)
    const suffix = params.toString() ? `?${params}` : ''
    return request(`/api/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}${suffix}`, { method: 'DELETE' })
  }

  return {
    async list(sort = '', limit = 100, options = {}) {
      const outletId = packOutlet()
      const packed = await getPackedEntity(entity, { sort, limit, outletId })
      const params = addYear(new URLSearchParams({ sort, limit: String(limit) }), options)
      const base = packed || await request(`/api/entities/${encodeURIComponent(entity)}?${params}`)
      return mergeRealtimeRows(entity, base, { outletId, sort, limit })
    },
    async filter(filter = {}, sort = '', limit = 100, options = {}) {
      const outletId = packOutlet(filter)
      const packed = await getPackedEntity(entity, { filter, sort, limit, outletId })
      const params = addYear(new URLSearchParams({
        filter: JSON.stringify(filter || {}),
        sort,
        limit: String(limit),
      }), options)
      const base = packed || await request(`/api/entities/${encodeURIComponent(entity)}?${params}`)
      return mergeRealtimeRows(entity, base, { outletId, filter, sort, limit })
    },
    async create(data, options = {}) {
      const outletId = String(data?.outlet_id || packOutlet(data) || '').trim()
      if (!REALTIME_ENTITIES.has(entity) || !outletId) return legacyCreate(data, options)
      const id = String(data?.id || crypto.randomUUID())
      const result = await submitRealtimeMutation({
        entity,
        entity_id: id,
        outlet_id: outletId,
        operation: 'create',
        payload: { ...(data || {}), id, outlet_id: outletId },
      })
      clearGetCache()
      return result.record
    },
    async update(id, data, options = {}) {
      const outletId = String(data?.outlet_id || packOutlet(data) || '').trim()
      if (!REALTIME_ENTITIES.has(entity) || !outletId) return legacyUpdate(id, data, options)

      let current = null
      try { current = await realtimeRecord(entity, outletId, id) } catch {}
      if (!current) {
        try { current = await legacyRecord(entity, id, options) } catch {}
      }
      const result = await submitRealtimeMutation({
        entity,
        entity_id: String(id),
        outlet_id: outletId,
        operation: current?.__realtime ? 'update' : 'upsert',
        expected_version: current?.__realtime?.version,
        payload: {
          ...(current || {}),
          ...(data || {}),
          id: String(id),
          outlet_id: outletId,
          __realtime: undefined,
        },
      })
      clearGetCache()
      return result.record
    },
    async delete(id, options = {}) {
      const outletId = String(options?.outlet_id || packOutlet(options) || '').trim()
      if (!REALTIME_ENTITIES.has(entity) || !outletId) return legacyDelete(id, options)

      let current = null
      try { current = await realtimeRecord(entity, outletId, id) } catch {}
      // Existing Sheet-only records remain on the legacy delete path until
      // they have been seeded into D1 by a create or update mutation.
      if (!current?.__realtime) return legacyDelete(id, options)
      const result = await submitRealtimeMutation({
        entity,
        entity_id: String(id),
        outlet_id: outletId,
        operation: 'delete',
        expected_version: current.__realtime.version,
        payload: { ...current, __realtime: undefined },
      })
      clearGetCache()
      return result.record
    },
    updateMany(filter, update, options = {}) {
      const params = addYear(new URLSearchParams(), options)
      const suffix = params.toString() ? `?${params}` : ''
      return request(`/api/entities/${encodeURIComponent(entity)}/update-many${suffix}`, {
        method: 'POST',
        body: { filter, update },
      })
    },
  }
}

export const opsClient = {
  app: {
    bootstrap({ year } = {}) {
      const params = new URLSearchParams()
      if (year) params.set('year', String(year))
      const suffix = params.toString() ? `?${params}` : ''
      return request(`/api/app/v4/bootstrap${suffix}`, { method: 'POST' })
    },
    version() {
      return request('/api/app/v4/version')
    },
    registerDevice(payload) {
      return request('/api/app/v4/device', { method: 'POST', body: payload })
    },
    packManifest({ outletId = '', refresh = false } = {}) {
      const params = new URLSearchParams()
      if (outletId) params.set('outlet_id', outletId)
      if (refresh) { params.set('refresh', '1'); params.set('_', String(Date.now())) }
      return request(`/api/app/v4/pack/manifest?${params}`)
    },
    rebuildPack({ outletId = '' } = {}) {
      const params = new URLSearchParams()
      if (outletId) params.set('outlet_id', outletId)
      return request(`/api/app/v4/pack/rebuild?${params}`, { method: 'POST' })
    },
    rebuildAllPacks() {
      return request('/api/app/v4/pack/rebuild-all', { method: 'POST' })
    },
  },
  auth: {
    me: () => request('/api/auth/me'),
    loginWithGoogle: (credential) => request('/api/auth/google', { method: 'POST', body: { credential } }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    updateMe: (profile) => request('/api/auth/me', { method: 'PATCH', body: profile }),
  },
  realtime: {
    status() {
      return request(`/api/realtime/data/status?_=${Date.now()}`)
    },
    list({ entity, outletId, since = '', includeDeleted = false, limit = 100 }) {
      const params = new URLSearchParams({
        entity,
        outlet_id: outletId,
        limit: String(limit),
        _: String(Date.now()),
      })
      if (since) params.set('since', since)
      if (includeDeleted) params.set('include_deleted', '1')
      return request(`/api/realtime/records?${params}`)
    },
    mutate(payload, options) {
      return submitRealtimeMutation(payload, options)
    },
    retrySheetSync() {
      return request('/api/realtime/data/sync/retry', { method: 'POST', body: {} })
    },
  },
  entities: new Proxy({}, {
    get(_target, entity) {
      return entityClient(String(entity))
    },
  }),
  users: {
    updateAccess(userId, payload) {
      return request(`/api/users/${encodeURIComponent(userId)}/access`, { method: 'POST', body: payload })
    },
  },
  attendance: {
    importRoster(payload) {
      return request('/api/attendance/import', { method: 'POST', body: payload })
    },
  },
  tasks: {
    ensure(payload) {
      return request('/api/tasks/ensure', { method: 'POST', body: payload })
    },
    operationalBootstrap({ outletId, date, refresh = false }) {
      return request('/api/tasks/operational/bootstrap', {
        method: 'POST',
        body: { outlet_id: outletId, date, refresh },
      })
    },
    operationalAction(payload) {
      return request('/api/tasks/operational/action', { method: 'POST', body: payload })
    },
  },
  closeUp: {
    upsert(payload, { year } = {}) {
      const params = new URLSearchParams()
      if (year) params.set('year', String(year))
      const suffix = params.toString() ? `?${params}` : ''
      return request(`/api/close-up/upsert${suffix}`, { method: 'POST', body: payload })
    },
    retrySync(id, { year } = {}) {
      const params = new URLSearchParams()
      if (year) params.set('year', String(year))
      const suffix = params.toString() ? `?${params}` : ''
      return request(`/api/close-up/${encodeURIComponent(id)}/sync${suffix}`, { method: 'POST' })
    },
  },
  stockCounts: {
    saveBatch(payload) {
      return request('/api/stock-counts/batch', { method: 'POST', body: payload })
    },
  },
  inventory: {
    addOutletItem(payload) {
      return request('/api/inventory/outlet-stock-list', { method: 'POST', body: payload })
    },
  },
  notifications: {
    list({ targetPage = '', unreadOnly = true, limit = 50 } = {}) {
      const params = new URLSearchParams()
      if (targetPage) params.set('target_page', targetPage)
      if (unreadOnly) params.set('unread', '1')
      params.set('limit', String(limit))
      return request(`/api/notifications?${params}`)
    },
    push(payload) {
      return request('/api/notifications/push', { method: 'POST', body: payload })
    },
    read(id) {
      return request(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PATCH' })
    },
  },
  labels: {
    async catalog({ summaryOnly = false } = {}) {
      const packed = await getPackedLabelCatalog(packOutlet())
      if (packed) return packed
      return request(`/api/labels/catalog${summaryOnly ? '?summary=1' : ''}`)
    },
    printerProfile({ outletId = '' } = {}) {
      const params = new URLSearchParams()
      if (outletId) params.set('outlet_id', outletId)
      const suffix = params.toString() ? `?${params}` : ''
      return request(`/api/labels/printer-profile${suffix}`)
    },
    create(payload) {
      return request('/api/labels/create', { method: 'POST', body: payload })
    },
    reprint(id, payload) {
      return request(`/api/labels/${encodeURIComponent(id)}/reprint`, { method: 'POST', body: payload })
    },
    finishSource(id) {
      return request(`/api/labels/source/${encodeURIComponent(id)}/finish`, { method: 'POST', body: {} })
    },
  },
  integrations: {
    Core: {
      async UploadFile({ file, folderType = 'Attachments', outletName = '', outletId = '' }) {
        const form = new FormData()
        form.append('file', file)
        form.append('folderType', folderType)
        form.append('outletName', outletName)
        if (outletId) form.append('outletId', outletId)
        return request('/api/files/upload', { method: 'POST', body: form })
      },
    },
    Statvara: {
      status() {
        return request('/api/integrations/statvara/status')
      },
      syncReceipts(payload = {}) {
        return request('/api/integrations/statvara/receipts/sync', { method: 'POST', body: payload })
      },
    },
  },
  apiBaseUrl: API_BASE_URL,
}

export { ApiError }
