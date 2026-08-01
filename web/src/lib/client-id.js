const CLIENT_ID_KEY = 'chefops.realtime.client-id'
const FETCH_PATCH_FLAG = '__chefopsRealtimeClientHeaderInstalled'

export function getRealtimeClientId() {
  try {
    let value = String(localStorage.getItem(CLIENT_ID_KEY) || '').trim()
    if (!value) {
      value = crypto.randomUUID()
      localStorage.setItem(CLIENT_ID_KEY, value)
    }
    return value
  } catch {
    return crypto.randomUUID()
  }
}

export function installRealtimeClientHeader() {
  if (window[FETCH_PATCH_FLAG]) return
  window[FETCH_PATCH_FLAG] = true
  const clientId = getRealtimeClientId()
  const originalFetch = window.fetch.bind(window)

  window.fetch = async (input, init = {}) => {
    let url = null
    try { url = new URL(input instanceof Request ? input.url : String(input), window.location.href) } catch {}
    if (!url || !url.pathname.startsWith('/api/')) return originalFetch(input, init)

    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value))
    headers.set('X-ChefOps-Client-Id', clientId)
    const requestInit = { ...init, headers }
    return input instanceof Request
      ? originalFetch(new Request(input, requestInit))
      : originalFetch(input, requestInit)
  }
}
