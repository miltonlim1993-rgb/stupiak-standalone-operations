const NATIVE_SESSION_KEY = 'chefops.native.session'
const FETCH_PATCH_FLAG = '__chefopsNativeSessionFetchInstalled'

export function getNativeSessionToken() {
  try {
    return String(localStorage.getItem(NATIVE_SESSION_KEY) || '').trim()
  } catch {
    return ''
  }
}

export function saveNativeSessionToken(token) {
  const value = String(token || '').trim()
  if (!value) return clearNativeSessionToken()
  try { localStorage.setItem(NATIVE_SESSION_KEY, value) } catch {}
}

export function clearNativeSessionToken() {
  try { localStorage.removeItem(NATIVE_SESSION_KEY) } catch {}
}

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function requestUrl(input) {
  try {
    return new URL(input instanceof Request ? input.url : String(input), window.location.href)
  } catch {
    return null
  }
}

function mergedHeaders(input, init) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers || {}).forEach((value, key) => headers.set(key, value))
  return headers
}

export function installNativeSessionFetch() {
  if (window[FETCH_PATCH_FLAG]) return
  window[FETCH_PATCH_FLAG] = true

  const originalFetch = window.fetch.bind(window)

  window.fetch = async (input, init = {}) => {
    const url = requestUrl(input)
    const token = getNativeSessionToken()
    const nativeAndroid = isNativeAndroid()

    if (!url || !url.pathname.startsWith('/api/') || (!token && !nativeAndroid)) {
      return originalFetch(input, init)
    }

    const headers = mergedHeaders(input, init)
    if (nativeAndroid) headers.set('X-ChefOps-Native', 'android')
    if (token) headers.set('Authorization', `Bearer ${token}`)

    const requestInit = { ...init, headers }
    const response = input instanceof Request
      ? await originalFetch(new Request(input, requestInit))
      : await originalFetch(input, requestInit)

    if (response.status === 401 && url.pathname !== '/api/auth/google') {
      clearNativeSessionToken()
    }

    return response
  }
}
