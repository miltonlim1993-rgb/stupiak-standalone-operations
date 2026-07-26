import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import '@/viewport.css'
import '@/lib/install-prompt'
import { applyTheme } from '@/lib/theme'
import { installNativeSessionFetch } from '@/lib/native-session'

const SW_REFRESH_KEY = 'chefops-sw-refreshed-native-viewport-mobile-shell-v4'

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function configureNativeViewport() {
  if (!isNativeAndroid()) return
  const viewport = document.querySelector('meta[name="viewport"]')
  viewport?.setAttribute(
    'content',
    'width=430, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content',
  )
  document.documentElement.dataset.chefopsNative = 'android'
}

function configureNativeSystemBars() {
  if (!isNativeAndroid()) return
  const systemBars = window.Capacitor?.Plugins?.SystemBars
  Promise.resolve(systemBars?.show?.()).catch(() => undefined)
  Promise.resolve(systemBars?.setStyle?.({ style: 'LIGHT' })).catch(() => undefined)
}

function installViewportMetrics() {
  const root = document.documentElement
  const update = () => {
    const visualHeight = Number(window.visualViewport?.height || 0)
    const layoutHeight = Number(window.innerHeight || 0)
    const height = Math.max(320, Math.round(visualHeight || layoutHeight))
    root.style.setProperty('--chefops-viewport-height', `${height}px`)
    root.style.setProperty('--chefops-viewport-offset-top', `${Math.max(0, Math.round(window.visualViewport?.offsetTop || 0))}px`)
    root.dataset.chefopsNative = isNativeAndroid() ? 'android' : 'web'
    window.__chefopsViewport = {
      native: isNativeAndroid(),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualWidth: window.visualViewport?.width || 0,
      visualHeight: window.visualViewport?.height || 0,
      devicePixelRatio: window.devicePixelRatio || 1,
    }
  }

  update()
  window.addEventListener('resize', update, { passive: true })
  window.addEventListener('orientationchange', update, { passive: true })
  window.visualViewport?.addEventListener('resize', update, { passive: true })
  window.visualViewport?.addEventListener('scroll', update, { passive: true })
}

configureNativeViewport()
installNativeSessionFetch()
applyTheme()
installViewportMetrics()
configureNativeSystemBars()

if (window.location.hash === '#/cash' || window.location.hash.startsWith('#/cash?')) {
  const suffix = window.location.hash.includes('?') ? `?${window.location.hash.split('?')[1]}` : window.location.search
  window.history.replaceState({}, '', `/close-up${suffix || ''}`)
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || sessionStorage.getItem(SW_REFRESH_KEY) === '1') return
    refreshing = true
    sessionStorage.setItem(SW_REFRESH_KEY, '1')
    window.location.reload()
  })

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => {
      registration.update().catch(() => undefined)
    }).catch((error) => console.warn('Service worker registration failed', error))
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
