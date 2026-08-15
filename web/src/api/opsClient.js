import { getPackedEntity, getPackedLabelCatalog } from '@/lib/app-pack'
import { submitRealtimeMutation } from '@/lib/realtime-mutations'
import { readRealtimeRowsCached } from '@/lib/realtime-read-cache'

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
  if (path === '/api/auth/me') return 0
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
    if (path.startsWith('/api/auth/') || path.startsWith('/api/realtime/')) init.cache = 'no-store'
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

async function realtimeRows(entity, outletId, {
  filter = {},
  sort = '',
  limit = 500,
  year,
  legacySeed = true,
  force = false,
} = {}) {
  if (!REALTIME_ENTITIES.has(entity) || !outletId) return []

  const fetchRemote = async ({
    since = '',
    includeDeleted = true,
    limit: remoteLimit = 5000,
    legacySeed: remoteLegacySeed = legacySeed,
  } = {}) => {
    const params = new URLSearchParams({
      entity,
      outlet_id: outletId,
      include_deleted: includeDeleted ? '1' : '0',
      limit: String(Math.max(1, Math.min(Number(remoteLimit) || 5000, 5000))),
      filter: JSON.stringify(filter || {}),
      sort: String(sort || ''),
      legacy_seed: remoteLegacySeed ? '1' : '0',
      _: String(Date.now()),
    })
    if (since) params.set('since', since)
    if (year) params.set('year', String(year))
    return request(`/api/realtime/records?${params}`)
  }

  try {
    return await readRealtimeRowsCached({
      entity,
      outletId,
      fetchRemote,
      force,
    })
  } catch (error) {
    if (Number(error?.status || 0) === 401 || Number(error?.status || 0) === 403) throw error
    console.error(`Realtime ${entity} read unavailable`, error)
    return []
  }
}

function visibleRealtimeRows(rows, { filter = {}, sort = '', limit = 100 } = {}) {
  const visible = (rows || []).filter((row) => {
    const deleted = Boolean(row?.deleted_at || row?.__realtime?.deleted_at)
    return !deleted && matchesFilter(row, filter)
  })
  return sortedRows(visible, sort).slice(0, Math.max(1, Number(limit) || 100))
}

async function legacyRecord(entity, id, options = {}) {
  const params = addYear(new URLSearchParams({
    filter: JSON.stringify({ id }),
    limit: '2',
  }), options)
  const rows = await request(`/api/entities/${encodeURIComponent(entity)}?${params}`)
  return Array.isArray(rows) ? rows.find((row) => recordId(row) === String(id)) || rows[0] || null : null
}

async function realtimeRecord(entity, outletId, id, options = {}) {
  const rows = await realtimeRows(entity, outletId, {
    filter: { id: String(id) },
    limit: 5000,
    year: options?.year,
    force: true,
  })
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
      if (packed) return packed
      if (REALTIME_ENTITIES.has(entity) && outletId) {
        const rows = await realtimeRows(entity, outletId, {
          sort,
          limit: Math.max(Number(limit) || 100, 500),
          year: options?.year,
          legacySeed: options?.legacySeed !== false,
          force: options?.force === true,
        })
        return visibleRealtimeRows(rows, { sort, limit })
      }
      const params = addYear(new URLSearchParams({ sort, limit: String(limit) }), options)
      return request(`/api/entities/${encodeURIComponent(entity)}?${params}`)
    },
    async filter(filter = {}, sort = '', limit = 100, options = {}) {
      const outletId = packOutlet(filter)
      const packed = await getPackedEntity(entity, { filter, sort, limit, outletId })
      if (packed) return packed
      if (REALTIME_ENTITIES.has(entity) && outletId) {
        const rows = await realtimeRows(entity, outletId, {
          filter,
          sort,
          limit: Math.max(Number(limit) || 100, 500),
          year: options?.year,
          legacySeed: options?.legacySeed !== false,
          force: options?.force === true,
        })
        return visibleRealtimeRows(rows, { filter, sort, limit })
      }
      const params = addYear(new URLSearchParams({
        filter: JSON.stringify(filter || {}),
        sort,
        limit: String(limit),
      }), options)
      return request(`/api/entities/${encodeURIComponent(entity)}?${params}`)
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
      try { current = await realtimeRecord(entity, outletId, id, options) } catch {}
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
      try { current = await realtimeRecord(entity, outletId, id, options) } catch {}
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
    async list({ entity, outletId, since = '', includeDeleted = false, limit = 100, filter = {}, sort = '', year, force = false } = {}) {
      if (since) {
        const params = new URLSearchParams({
          entity,
          outlet_id: outletId,
          limit: String(limit),
          filter: JSON.stringify(filter || {}),
          sort: String(sort || ''),
          _: String(Date.now()),
        })
        params.set('since', since)
        if (includeDeleted) params.set('include_deleted', '1')
        if (year) params.set('year', String(year))
        return request(`/api/realtime/records?${params}`)
      }
      const rows = await realtimeRows(entity, outletId, { filter, sort, limit, year, force })
      const records = includeDeleted
        ? sortedRows((rows || []).filter((row) => matchesFilter(row, filter)), sort).slice(0, Math.max(1, Number(limit) || 100))
        : visibleRealtimeRows(rows, { filter, sort, limit })
      return {
        records,
        count: records.length,
        source: 'device-cache',
        server_time: new Date().toISOString(),
      }
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
