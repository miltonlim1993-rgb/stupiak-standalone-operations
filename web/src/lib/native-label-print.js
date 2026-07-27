import { opsClient } from '@/api/opsClient'
import {
  applyPrinterLayoutToHtml,
  clearLegacyPrinterDraft,
  formatPrinterLayoutOutcome,
  readPrinterDeviceBinding,
  readPrinterProfilesSnapshot,
  savePrinterProfilesSnapshot,
  selectPrinterProfile,
} from '@/lib/label-printer-profile'

const serverProfilesCache = new Map()

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function currentOutletId() {
  try {
    return String(localStorage.getItem('chefops.data-pack.outlet') || '').trim()
  } catch {
    return ''
  }
}

function extractJobName(html) {
  const match = String(html || '').match(/<title>([^<]+)<\/title>/i)
  return String(match?.[1] || 'Stupiak Ops Label').trim().slice(0, 80)
}

function isPrintableLabel(html) {
  const value = String(html || '')
  return value.includes('@page')
    && value.includes('class="label"')
    && (value.includes('window.print') || value.includes('barcode-wrap') || value.includes('TEST LABEL'))
}

function countCopies(html) {
  return Math.max(1, Math.min(100, (String(html || '').match(/class="label"/g) || []).length || 1))
}

function sanitizeLabelHtml(html) {
  const withoutScripts = String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const directStyle = '<style>html,body{overflow:hidden!important}.label~.label{display:none!important}</style>'
  return withoutScripts.includes('</head>')
    ? withoutScripts.replace('</head>', `${directStyle}</head>`)
    : `${directStyle}${withoutScripts}`
}

async function resolveOutletAndProfiles(requestedOutletId, { force = false } = {}) {
  let outletId = String(requestedOutletId || '').trim()

  if (!outletId) {
    const fallback = await opsClient.labels.printerProfile({ outletId: '' }).catch(() => null)
    outletId = String(fallback?.outlet_id || '').trim()
    if (!outletId) return { outletId: '', profiles: fallback?.id ? [fallback] : [] }
  }

  const cached = serverProfilesCache.get(outletId)
  if (!force && cached && Date.now() - cached.loadedAt < 15000) {
    return { outletId, profiles: cached.profiles }
  }

  let profiles = await opsClient.entities.PrinterProfile.filter(
    { outlet_id: outletId, purpose: 'food_label' },
    '-is_default,-updated_date',
    200,
  )

  if (!profiles?.length) {
    const fallback = await opsClient.labels.printerProfile({ outletId }).catch(() => null)
    profiles = fallback?.id ? [fallback] : []
  }

  serverProfilesCache.set(outletId, { loadedAt: Date.now(), profiles: profiles || [] })
  savePrinterProfilesSnapshot(outletId, profiles || [])
  clearLegacyPrinterDraft(outletId)
  return { outletId, profiles: profiles || [] }
}

async function resolvePrinterProfile() {
  const requestedOutletId = currentOutletId()

  try {
    const resolved = await resolveOutletAndProfiles(requestedOutletId, { force: true })
    const binding = readPrinterDeviceBinding(resolved.outletId)
    return selectPrinterProfile(resolved.profiles, resolved.outletId, binding.selected_profile_id)
      || { outlet_id: resolved.outletId }
  } catch (error) {
    console.debug('Server printer profiles could not be refreshed; using the device snapshot', error)
    const binding = readPrinterDeviceBinding(requestedOutletId)
    const snapshots = readPrinterProfilesSnapshot(requestedOutletId)
    return selectPrinterProfile(snapshots, requestedOutletId, binding.selected_profile_id)
      || { outlet_id: requestedOutletId }
  }
}

function resolveCachedPrinterProfile() {
  const outletId = currentOutletId()
  const binding = readPrinterDeviceBinding(outletId)
  return selectPrinterProfile(
    readPrinterProfilesSnapshot(outletId),
    outletId,
    binding.selected_profile_id,
  )
}

function directPrinter() {
  return window.Capacitor?.Plugins?.DirectLabelPrint
}

function showPrintMessage(message, tone = 'error') {
  document.getElementById('chefops-direct-print-message')?.remove()
  const item = document.createElement('div')
  item.id = 'chefops-direct-print-message'
  item.textContent = String(message || '')
  item.style.cssText = [
    'position:fixed',
    'top:calc(var(--chefops-header-height,3.5rem) + var(--chefops-safe-top,0px) + .65rem)',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:9999',
    'width:min(calc(100vw - 1.5rem),430px)',
    'padding:.8rem 1rem',
    'border-radius:.85rem',
    'font:600 13px/1.4 system-ui,sans-serif',
    'box-shadow:0 12px 34px rgba(0,0,0,.18)',
    tone === 'success'
      ? 'background:#ecfdf5;color:#047857;border:1px solid #a7f3d0'
      : 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca',
  ].join(';')
  document.body.appendChild(item)
  window.setTimeout(() => item.remove(), tone === 'success' ? 4200 : 5200)
}

function validateDirectProfile(profile) {
  const connectionType = String(profile?.connection_type || '').toLowerCase()
  const commandLanguage = String(profile?.command_language || '').toLowerCase()

  if (!profile?.enabled && profile?.enabled !== undefined) {
    throw new Error('The selected label printer profile is disabled.')
  }

  if (connectionType === 'network') {
    if (!String(profile?.ip_address || '').trim()) {
      throw new Error('Direct printing needs the printer IP address in Label Printer Settings.')
    }
  } else if (connectionType === 'bluetooth') {
    if (!String(profile?.bluetooth_device_id || profile?.bluetooth_device_name || '').trim()) {
      throw new Error('Direct printing needs a paired Bluetooth printer name or MAC address.')
    }
    if (String(profile?.bluetooth_mode || '').toLowerCase() === 'ble') {
      throw new Error('Direct BLE printing is not enabled. Select Bluetooth Classic / paired printer, or Wi-Fi / LAN.')
    }
  } else {
    throw new Error('Direct print is not configured. Open More → Label Printer Settings and choose Wi-Fi / LAN or Bluetooth.')
  }

  if (!['tspl', 'zpl', 'cpcl', 'escpos'].includes(commandLanguage)) {
    throw new Error('Choose the printer command language in Label Printer Settings: TSPL, ZPL, CPCL or ESC/POS.')
  }

  return { connectionType, commandLanguage }
}

async function sendDirectLabel(html) {
  const plugin = directPrinter()
  if (!plugin?.printDirect) throw new Error('The Android direct-print service is unavailable in this APK.')

  const profile = await resolvePrinterProfile()
  const { connectionType, commandLanguage } = validateDirectProfile(profile)
  const transformed = applyPrinterLayoutToHtml(html, profile)
  const jobName = extractJobName(transformed.html)
  const copies = countCopies(transformed.html)

  const result = await plugin.printDirect({
    html: sanitizeLabelHtml(transformed.html),
    jobName,
    widthMm: transformed.layout.width_mm,
    heightMm: transformed.layout.height_mm,
    dpi: Math.max(72, Number(profile.dpi || 203)),
    copies,
    connectionType,
    commandLanguage,
    ipAddress: String(profile.ip_address || '').trim(),
    port: Math.max(1, Math.min(65535, Number(profile.port || 9100))),
    bluetoothMode: String(profile.bluetooth_mode || 'classic'),
    bluetoothDeviceName: String(profile.bluetooth_device_name || '').trim(),
    bluetoothDeviceId: String(profile.bluetooth_device_id || '').trim(),
    retryLimit: Math.max(0, Math.min(20, Number(profile.retry_limit || 0))),
  })

  const profileName = String(profile.profile_name || 'Label printer').trim()
  const outcome = formatPrinterLayoutOutcome(transformed.layout)
  showPrintMessage(
    `Printed to ${result?.printer || profileName} · ${outcome} · ${copies} cop${copies === 1 ? 'y' : 'ies'}.`,
    'success',
  )

  const detail = {
    jobName,
    copies,
    direct: true,
    result,
    profile_id: profile.id || '',
    profile_name: profileName,
    layout: transformed.layout,
  }
  window.__chefopsLastLabelPrintOutcome = detail
  window.dispatchEvent(new CustomEvent('chefops:native-print-started', { detail }))
}

function isLabelPopup(url, target, features) {
  const featureText = String(features || '').toLowerCase()
  return String(target || '') === '_blank'
    && (!url || String(url) === 'about:blank')
    && featureText.includes('width=480')
    && featureText.includes('height=640')
}

function installSystemLabelLayoutBridge() {
  if (window.__chefopsSystemLabelLayoutInstalled) return
  window.__chefopsSystemLabelLayoutInstalled = true

  const browserOpen = window.open.bind(window)
  window.open = function chefopsLabelLayoutWindowOpen(url = '', target = '', features = '') {
    const opened = browserOpen(url, target, features)
    if (!opened || !isLabelPopup(url, target, features)) return opened

    const installWriter = () => {
      const originalWrite = opened.document.write.bind(opened.document)
      opened.document.write = (value) => {
        const source = String(value ?? '')
        if (!isPrintableLabel(source) || source.includes('id="chefops-printer-layout"')) {
          return originalWrite(source)
        }

        const profile = resolveCachedPrinterProfile()
        if (!profile) return originalWrite(source)

        const transformed = applyPrinterLayoutToHtml(source, profile)
        const detail = {
          direct: false,
          prepared: true,
          profile_id: profile.id || '',
          profile_name: profile.profile_name || '',
          layout: transformed.layout,
        }
        window.__chefopsLastLabelPrintOutcome = detail
        window.dispatchEvent(new CustomEvent('chefops:label-print-layout', { detail }))
        showPrintMessage(
          `Print sheet prepared · ${profile.profile_name || 'Label printer'} · ${formatPrinterLayoutOutcome(transformed.layout)}.`,
          'success',
        )
        return originalWrite(transformed.html)
      }
    }

    const originalDocumentOpen = opened.document.open.bind(opened.document)
    opened.document.open = (...args) => {
      const result = originalDocumentOpen(...args)
      installWriter()
      return result
    }
    installWriter()
    return opened
  }
}

export function installNativeLabelPrintBridge() {
  clearLegacyPrinterDraft(currentOutletId())
  installSystemLabelLayoutBridge()
  if (!isNativeAndroid() || window.__chefopsNativePrintInstalled) return
  window.__chefopsNativePrintInstalled = true

  const browserOpen = window.open.bind(window)

  window.open = function chefopsNativeWindowOpen(url = '', target = '', features = '') {
    if (!isLabelPopup(url, target, features)) return browserOpen(url, target, features)

    let buffer = ''
    let closed = false
    let printing = false

    const fakeDocument = {
      open() {
        buffer = ''
        printing = false
      },
      write(value) {
        buffer += String(value ?? '')
      },
      close() {
        if (!isPrintableLabel(buffer) || printing || closed) return
        printing = true
        void sendDirectLabel(buffer).catch((error) => {
          printing = false
          const message = error?.message || 'Direct label printing failed.'
          console.error('Direct label print failed', error)
          showPrintMessage(message)
          window.dispatchEvent(new CustomEvent('chefops:native-print-error', {
            detail: { message, direct: true },
          }))
        })
      },
    }

    return {
      get closed() { return closed },
      document: fakeDocument,
      close() { closed = true },
      focus() {},
      print() { fakeDocument.close() },
    }
  }
}
