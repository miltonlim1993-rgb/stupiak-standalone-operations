import { opsClient } from '@/api/opsClient'
import { installCreatedLabelSizeContractV14 } from '@/lib/label-size-contract-v14'
import { installLabelSizeContractStatusV14 } from '@/lib/label-size-contract-status-v14'
import { installPrintOutcomeIntegrityV13 } from '@/lib/print-outcome-integrity-v13'
import { installLabelContentOrientationV7 } from '@/lib/label-content-orientation-v7'
import { installStableLabelPrintV16 } from '@/lib/stable-label-print-v16'
import { installStableLabelPrintV20 } from '@/lib/stable-label-print-v20'
import { installLabelFifoPolicyV26 } from '@/lib/install-label-fifo-policy-v26'

const FINAL_LABEL_RUNTIME_VERSION = 'stable-tspl-v16-date-fit-v22+d1-fifo-v26'
let installed = false

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function apiUrl(pathname) {
  const configured = String(import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/$/, '')
  return configured ? `${configured}${pathname}` : pathname
}

function nativeHeaders() {
  return isNativeAndroid() ? { 'X-ChefOps-Native': 'android' } : {}
}

async function liveD1Catalog(options = {}) {
  const summaryOnly = options?.summaryOnly || options?.summary_only || options?.summary === true
  const suffix = summaryOnly ? '?summary=1' : ''
  const response = await fetch(apiUrl(`/api/labels/catalog${suffix}`), {
    credentials: 'include',
    cache: 'no-store',
    headers: nativeHeaders(),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof data?.error === 'string'
      ? data.error
      : data?.error?.message || data?.message || `Label catalog failed (${response.status})`
    const error = new Error(message)
    error.status = response.status
    error.code = data?.code || data?.error?.code || 'label_catalog_live_failed'
    throw error
  }
  return data
}

function installD1PrimaryLabelCatalog() {
  const packedFallback = opsClient.labels.catalog.bind(opsClient.labels)
  opsClient.labels.catalog = async (...args) => {
    try {
      return await liveD1Catalog(args[0] || {})
    } catch (error) {
      console.warn('Live D1 Label catalog unavailable; using installed Label package fallback', error)
      return packedFallback(...args)
    }
  }
}

export function installFinalLabelRuntime() {
  if (installed) return
  installed = true

  installD1PrimaryLabelCatalog()
  installCreatedLabelSizeContractV14()
  installPrintOutcomeIntegrityV13()
  installLabelContentOrientationV7()
  installLabelSizeContractStatusV14()
  if (isNativeAndroid()) installStableLabelPrintV16()
  else installStableLabelPrintV20()
  installLabelFifoPolicyV26()

  window.__chefopsFinalLabelRuntime = {
    version: FINAL_LABEL_RUNTIME_VERSION,
    printing: isNativeAndroid()
      ? 'android-raw-tspl-stable-v16-date-fit-v22'
      : 'web-raw-tspl-stable-v20-date-fit-v22',
    label_catalog: 'd1-primary-with-installed-package-fallback',
    source_policy: 'three-stage-source-chain-v26',
  }
}
