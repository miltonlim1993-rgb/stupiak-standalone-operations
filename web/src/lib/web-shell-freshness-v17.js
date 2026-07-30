export const WEB_SHELL_FRESHNESS_VERSION = '4.6.15-web-shell-freshness-v17'

const RELOAD_KEY = 'chefops.web-shell-reload-version'

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function publishedVersion(source = '') {
  return String(source || '').match(/const VERSION = ['"]([^'"]+)['"]/)?.[1] || ''
}

function currentVersion() {
  return String(document.documentElement.dataset.chefopsShell || window.__chefopsBuild?.shell || '')
}

function shouldCheck(pathname = window.location.pathname) {
  return pathname === '/labels' || pathname === '/labels/settings' || pathname === '/more'
}

export async function verifyFreshWebShellV17({ force = false } = {}) {
  if (isNativeAndroid() || (!force && !shouldCheck())) return { checked: false }

  try {
    const response = await fetch(`/sw.js?chefops-fresh=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Cache-Control': 'no-cache' },
    })
    if (!response.ok) return { checked: true, fresh: null }
    const latest = publishedVersion(await response.text())
    const current = currentVersion()
    if (!latest || !current || latest === current) {
      sessionStorage.removeItem(RELOAD_KEY)
      return { checked: true, fresh: true, latest, current }
    }

    if (sessionStorage.getItem(RELOAD_KEY) !== latest) {
      sessionStorage.setItem(RELOAD_KEY, latest)
      window.location.reload()
      return { checked: true, fresh: false, reloading: true, latest, current }
    }
    return { checked: true, fresh: false, reloading: false, latest, current }
  } catch {
    return { checked: true, fresh: null }
  }
}

export function installWebShellFreshnessV17() {
  if (typeof window === 'undefined' || window.__chefopsWebShellFreshnessV17) return
  window.__chefopsWebShellFreshnessV17 = true

  const check = () => { void verifyFreshWebShellV17() }
  window.addEventListener('pageshow', check)
  window.addEventListener('popstate', check)
  window.addEventListener('focus', check)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  window.setTimeout(check, 250)
}
