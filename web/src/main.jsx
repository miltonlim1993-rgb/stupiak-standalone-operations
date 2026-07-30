import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import '@/viewport.css'
import '@/panels-v8.css'
import '@/direct-print-v10.css'
import '@/guided-sop-media.css'
import '@/lib/install-prompt'
import { applyTheme } from '@/lib/theme'
import { installNativeSessionFetch } from '@/lib/native-session'
import { installNativeLabelPrintBridge } from '@/lib/native-label-print'

const SHELL_VERSION = 'task-sop-alarm-v18'

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function markRuntime() {
  const root = document.documentElement
  root.dataset.chefopsNative = isNativeAndroid() ? 'android' : 'web'
  root.dataset.chefopsShell = SHELL_VERSION
  window.__chefopsBuild = {
    shell: SHELL_VERSION,
    native: isNativeAndroid(),
    origin: window.location.origin,
  }
}

async function purgeNativeServiceWorkers() {
  if (!isNativeAndroid()) return

  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
    }
  } catch (error) {
    console.warn('Unable to unregister the old native service worker', error)
  }

  try {
    if ('caches' in window) {
      const names = await caches.keys()
      await Promise.all(names.map((name) => caches.delete(name)))
    }
  } catch (error) {
    console.warn('Unable to clear the old native shell cache', error)
  }
}

function configureNativeSystemBars() {
  if (!isNativeAndroid()) return
  const systemBars = window.Capacitor?.Plugins?.SystemBars
  Promise.resolve(systemBars?.show?.()).catch(() => undefined)
  Promise.resolve(systemBars?.setStyle?.({ style: 'LIGHT' })).catch(() => undefined)
}

async function registerBackgroundAlertChecks(registration) {
  try {
    if ('periodicSync' in registration) {
      await registration.periodicSync.register('chefops-task-alerts', { minInterval: 15 * 60 * 1000 })
    }
  } catch (error) {
    console.info('Periodic Task alert checks are not available in this browser', error)
  }

  try {
    if ('sync' in registration) await registration.sync.register('chefops-task-alerts-once')
  } catch (error) {
    console.info('One-time background Task alert check is not available', error)
  }
}

function publishShellHealth() {
  window.requestAnimationFrame(() => {
    const main = document.getElementById('chefops-mobile-main')
    const nav = document.getElementById('chefops-mobile-nav')
    if (!main || !nav) return
    const mainRect = main.getBoundingClientRect()
    const navRect = nav.getBoundingClientRect()
    window.__chefopsShellHealth = {
      version: SHELL_VERSION,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      mainTop: Math.round(mainRect.top),
      mainBottom: Math.round(mainRect.bottom),
      mainHeight: Math.round(mainRect.height),
      mainScrollHeight: main.scrollHeight,
      mainCanScroll: main.scrollHeight > main.clientHeight + 1,
      navTop: Math.round(navRect.top),
      navBottom: Math.round(navRect.bottom),
      navVisible: navRect.top >= 0 && navRect.bottom <= window.innerHeight + 2,
    }
  })
}

markRuntime()
installNativeSessionFetch()
installNativeLabelPrintBridge()
applyTheme()
configureNativeSystemBars()

if (isNativeAndroid()) {
  // APK assets are bundled locally. Keeping a service worker on https://localhost
  // can serve an older shell after an in-place APK update, so native builds purge it.
  purgeNativeServiceWorkers()
}

if (window.location.hash === '#/cash' || window.location.hash.startsWith('#/cash?')) {
  const suffix = window.location.hash.includes('?') ? `?${window.location.hash.split('?')[1]}` : window.location.search
  window.history.replaceState({}, '', `/close-up${suffix || ''}`)
}

if ('serviceWorker' in navigator && import.meta.env.PROD && !isNativeAndroid()) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Never reload an installed PWA while a checklist, stock count or form is in progress.
    // The active page keeps working and the new shell is used on the next normal launch.
    localStorage.setItem('chefops.pending-shell-version', SHELL_VERSION)
    window.dispatchEvent(new CustomEvent('chefops:shell-update-ready', {
      detail: { version: SHELL_VERSION, deferred: true },
    }))
  })

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => {
      registration.update().catch(() => undefined)
      registerBackgroundAlertChecks(registration)
    }).catch((error) => console.warn('Service worker registration failed', error))
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

publishShellHealth()
