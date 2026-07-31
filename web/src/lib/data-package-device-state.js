const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {})
  const init = {
    method: options.method || 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers,
  }
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${API_BASE_URL}${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Device state request failed (${response.status})`)
    error.status = response.status
    error.code = data.code || ''
    throw error
  }
  return data
}

export function reportDataPackageDeviceState(payload = {}) {
  return request('/api/app/v4/data-package/device', {
    method: 'POST',
    body: payload,
  })
}

export function listDataPackageDevices(outletId = '') {
  const params = new URLSearchParams()
  if (String(outletId || '').trim()) params.set('outlet_id', String(outletId).trim())
  return request(`/api/app/v4/data-package/devices?${params}`)
}
