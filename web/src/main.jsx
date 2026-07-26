import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import '@/viewport.css'
import '@/lib/install-prompt'
import { applyTheme } from '@/lib/theme'
import { installNativeSessionFetch } from '@/lib/native-session'

const SW_REFRESH_KEY = 'chefops-sw-refreshed-single-scroll-shell-v5'
const SHELL_VERSION = 'single-scroll-v5'

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function markRuntime() {
  document.documentElement.dataset.chefopsNative = isNativeAndroid() ? 'android' : 'web'
}

function configureNativeSystemBars() {
  if (!isNativeAndroid()) return
  const systemBars = window.Capacitor?.Plugins?.SystemBars
  Promise.resolve(systemBars?.show?.()).catch(() => undefined)
  Promise.resolve(systemBars?.setStyle?.({ style: 'LIGHT' })).catch(() => undefined)
}

function installShellGuard(root) {
  let frame = 0

  const enforce = () => {
    frame = 0
    const app = root.querySelector('.chefops-app')
    const shell = root.querySelector('.chefops-shell')
    const content = root.querySelector('.chefops-content')
    const header = root.querySelector('.chefops-app-header')
    const main = root.querySelector('.chefops-main-scroll')
    const nav = root.querySelector('.chefops-bottom-nav')
    if (!app || !shell || !content || !header || !main || !nav) return

    Object.assign(app.style, {
      width: '100%',
      height: '100dvh',
      minHeight: '0',
      overflow: 'hidden',
    })
    Object.assign(shell.style, {
      width: '100%',
      height: '100%',
      minHeight: '0',
      overflow: 'hidden',
    })
    Object.assign(content.style, {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      minHeight: '0',
      overflow: 'hidden',
    })
    Object.assign(header.style, { flex: '0 0 auto' })
    Object.assign(main.style, {
      flex: '1 1 0%',
      width: '100%',
      height: 'auto',
      minHeight: '0',
      overflowX: 'hidden',
      overflowY: 'auto',
      touchAction: 'pan-y',
      WebkitOverflowScrolling: 'touch',
    })
    Object.assign(nav.style, { flex: '0 0 auto' })

    const navRect = nav.getBoundingClientRect()
    const mainRect = main.getBoundingClientRect()
    window.__chefopsShellHealth = {
      version: SHELL_VERSION,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      mainTop: Math.round(mainRect.top),
      mainBottom: Math.round(mainRect.bottom),
      mainHeight: Math.round(mainRect.height),
      mainScrollHeight: main.scrollHeight,
      navTop: Math.round(navRect.top),
      navBottom: Math.round(navRect.bottom),
      navVisible: navRect.top >= 0 && navRect.bottom <= window.innerHeight + 2,
    }
  }

  const schedule = () => {
    if (frame) return
    frame = window.requestAnimationFrame(enforce)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(root, { childList: true, subtree: true })
  window.addEventListener('resize', schedule, { passive: true })
  window.addEventListener('orientationchange', schedule, { passive: true })
  schedule()
}

markRuntime()
installNativeSessionFetch()
applyTheme()
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

const rootElement = document.getElementById('root')
ReactDOM.createRoot(rootElement).render(<App />)
installShellGuard(rootElement)
