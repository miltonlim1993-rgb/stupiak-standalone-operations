import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import '@/viewport.css'
import '@/panels-v8.css'
import '@/direct-print-v10.css'
import '@/label-printer-settings-v2.css'
import '@/label-printer-settings-force-mobile.css'
import '@/cross-device-v15.css'
import '@/document-scroll-v15.css'
import '@/lib/install-prompt'
import { applyTheme } from '@/lib/theme'
import { installDeviceViewportV15 } from '@/lib/device-viewport-v15'
import { installNativeSessionFetch } from '@/lib/native-session'
import { installNativeLabelPrintBridge } from '@/lib/native-label-print'
import { installStableLabelPrintV16 } from '@/lib/stable-label-print-v16'
import { installStableLabelPrintV20 } from '@/lib/stable-label-print-v20'
import { installCreatedLabelSizeContractV14 } from '@/lib/label-size-contract-v14'
import { installLabelSizeContractStatusV14 } from '@/lib/label-size-contract-status-v14'
import { installPrintOutcomeIntegrityV13 } from '@/lib/print-outcome-integrity-v13'
import { installLabelContentOrientationV7 } from '@/lib/label-content-orientation-v7'
import { installLabelSettingsStaffV17 } from '@/lib/label-settings-staff-v17'
import { installWebShellFreshnessV17 } from '@/lib/web-shell-freshness-v17'
import { installSupermarketBarcodeScannerV25 } from '@/lib/supermarket-barcode-scan-v25'
import { installLabelFifoPolicyV26 } from '@/lib/install-label-fifo-policy-v26'
import { installTaskBilingualShell } from '@/lib/task-bilingual-shell'
import { installTaskTemplateRefreshV6 } from '@/lib/task-template-refresh-v6'

const SHELL_VERSION = '4.6.25-label-source-fifo-v26'

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
    printerTransport: 'v12',
    stableTsplCore: 'v16-date-fit-v22',
    androidStablePrint: 'v16-date-fit-v22',
    webStablePrint: 'device-local-v25-windows-queue-kitchen-ip',
    labelDateBoxes: 'shared-core-narrow-1x2-centered-2-dot-safe-area',
    labelSettingsStaff: 'single-toolbar-icon-v25',
    barcodeScanner: 'supermarket-hid-live-camera-native-v25',
    labelFifoPolicy: 'three-stage-source-chain-v26',
    webShellFreshness: 'v17',
    printOutcomeIntegrity: 'v13',
    labelSizeContract: 'v14',
    deviceViewport: 'v15',
    dataPackageStorage: 'cache-idb-v3',
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
      await Promise.all(names.filter((name) => !name.startsWith('stupiaks-ops-data-package-v2-objects-')).map((name) => caches.delete(name)))
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

function publishShellHealth() {
  window.requestAnimationFrame(() => {
    const main = document.getElementById('chefops-mobile-main')
    const nav = document.getElementById('chefops-mobile-nav')
    if (!main || !nav) return
    const mainRect = main.getBoundingClientRect()
    const navRect = nav.getBoundingClientRect()
    window.__chefopsShellHealth = {
      version: SHELL_VERSION,
      viewportWidth: window.__chefopsViewport?.width || window.innerWidth,
      viewportHeight: window.__chefopsViewport?.height || window.innerHeight,
      platform: window.__chefopsViewport?.platform || 'web',
      mainTop: Math.round(mainRect.top),
      mainBottom: Math.round(mainRect.bottom),
      mainHeight: Math.round(mainRect.height),
      mainScrollHeight: main.scrollHeight,
      mainCanScroll: main.scrollHeight > main.clientHeight + 1,
      navTop: Math.round(navRect.top),
      navBottom: Math.round(navRect.bottom),
      navVisible: navRect.top >= 0 && navRect.bottom <= (window.__chefopsViewport?.height || window.innerHeight) + 2,
    }
  })
}

markRuntime()
installDeviceViewportV15()
installWebShellFreshnessV17()
installNativeSessionFetch()
installNativeLabelPrintBridge()
installCreatedLabelSizeContractV14()
installPrintOutcomeIntegrityV13()
installLabelContentOrientationV7()
installLabelSizeContractStatusV14()
if (isNativeAndroid()) installStableLabelPrintV16()
else installStableLabelPrintV20()
installLabelSettingsStaffV17()
installSupermarketBarcodeScannerV25()
installLabelFifoPolicyV26()
installTaskTemplateRefreshV6()
installTaskBilingualShell()
applyTheme()
configureNativeSystemBars()

if (isNativeAndroid()) {
  purgeNativeServiceWorkers()
}

if (window.location.hash === '#/cash' || window.location.hash.startsWith('#/cash?')) {
  const suffix = window.location.hash.includes('?') ? `?${window.location.hash.split('?')[1]}` : window.location.search
  window.history.replaceState({}, '', `/close-up${suffix || ''}`)
}

if ('serviceWorker' in navigator && import.meta.env.PROD && !isNativeAndroid()) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    localStorage.setItem('chefops.pending-shell-version', SHELL_VERSION)
    window.dispatchEvent(new CustomEvent('chefops:shell-update-ready', {
      detail: { version: SHELL_VERSION, deferred: true },
    }))
  })

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => {
      registration.update().catch(() => undefined)
    }).catch((error) => console.warn('Service worker registration failed', error))
  })
}

const rootElement = document.getElementById('root')
ReactDOM.createRoot(rootElement).render(<App />)
window.addEventListener('load', publishShellHealth, { once: true })
window.addEventListener('resize', publishShellHealth, { passive: true })
window.visualViewport?.addEventListener('resize', publishShellHealth, { passive: true })
