import { getPackedEntity, getPackedLabelCatalog } from '@/lib/app-pack'
const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')

const GET_RESPONSE_CACHE = new Map()
const GET_INFLIGHT = new Map()

function getTtl(path) {
  if (path === '/api/auth/me') return 15_000
  if (path.startsWith('/api/notifications')) return 12_000
  if (path === '/api/app/v4/version') return 300_000
  if (path.startsWith('/api/app/v4/bootstrap')) return 30_000
  if (path.startsWith('/api/entities/')) return 8_000
  if (path.startsWith('/api/labels/')) return 30_000
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
  const now = Date.now()

  if (isGet) {
    const cached = GET_RESPONSE_CACHE.get(cacheKey)
    if (cached && cached.expiresAt > now) return cached.data
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
    if (isGet) GET_RESPONSE_CACHE.set(cacheKey, { data, expiresAt: Date.now() + getTtl(path) })
    else clearGetCache()
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

function entityClient(entity) {
  return {
    async list(sort = '', limit = 100, options = {}) {
      const packed = await getPackedEntity(entity, { sort, limit, outletId: packOutlet() })
      if (packed) return packed
      const params = addYear(new URLSearchParams({ sort, limit: String(limit) }), options)
      return request(`/api/entities/${encodeURIComponent(entity)}?${params}`)
    },
    async filter(filter = {}, sort = '', limit = 100, options = {}) {
      const packed = await getPackedEntity(entity, { filter, sort, limit, outletId: packOutlet(filter) })
      if (packed) return packed
      const params = addYear(new URLSearchParams({
        filter: JSON.stringify(filter || {}),
        sort,
        limit: String(limit),
      }), options)
      return request(`/api/entities/${encodeURIComponent(entity)}?${params}`)
    },
    create(data, options = {}) {
      const params = addYear(new URLSearchParams(), options)
      const suffix = params.toString() ? `?${params}` : ''
      return request(`/api/entities/${encodeURIComponent(entity)}${suffix}`, { method: 'POST', body: data })
    },
    update(id, data, options = {}) {
      const params = addYear(new URLSearchParams(), options)
      const suffix = params.toString() ? `?${params}` : ''
      return request(`/api/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}${suffix}`, { method: 'PATCH', body: data })
    },
    delete(id, options = {}) {
      const params = addYear(new URLSearchParams(), options)
      const suffix = params.toString() ? `?${params}` : ''
      return request(`/api/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}${suffix}`, { method: 'DELETE' })
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
    workflowBootstrap({ outletId, date, refresh = false }) {
      return request('/api/tasks/v3/bootstrap', {
        method: 'POST',
        body: { outlet_id: outletId, date, refresh },
      })
    },
    workflowAction(payload) {
      return request('/api/tasks/v3/action', { method: 'POST', body: payload })
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
