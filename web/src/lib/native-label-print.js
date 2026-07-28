import { opsClient } from '@/api/opsClient'
import {
  applyPrinterLayoutToHtml,
  clearLegacyPrinterDraft,
  formatPrinterLayoutOutcome,
  normalizePrinterProfile,
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
  const normalized = normalizePrinterProfile(profile)
  const connectionType = String(normalized.connection_type || '').toLowerCase()
  const commandLanguage = String(normalized.command_language || '').toLowerCase()

  if (!normalized.enabled && normalized.enabled !== undefined) {
    throw new Error('The selected label printer profile is disabled.')
  }

  if (connectionType === 'network') {
    if (!String(normalized.ip_address || '').trim()) {
      throw new Error('Direct printing needs the printer IP address in Label Printer Settings.')
    }
  } else if (connectionType === 'bluetooth') {
    if (!String(normalized.bluetooth_device_id || normalized.bluetooth_device_name || '').trim()) {
      throw new Error('Direct printing needs a paired Bluetooth printer name or MAC address.')
    }
    if (String(normalized.bluetooth_mode || '').toLowerCase() !== 'classic') {
      throw new Error('Direct printing supports Bluetooth Classic / paired printers. Use Android System Print for BLE or vendor-driver printers.')
    }
  } else {
    throw new Error('Direct print is not configured. Choose Wi-Fi / LAN or Bluetooth Classic, or use Android System Print.')
  }

  if (!['tspl', 'zpl', 'cpcl', 'escpos'].includes(commandLanguage)) {
    throw new Error('Choose the printer command language: TSPL, ZPL, CPCL or ESC/POS.')
  }

  return { normalized, connectionType, commandLanguage }
}

function directPrinterOptions(profile) {
  const { normalized, connectionType, commandLanguage } = validateDirectProfile(profile)
  return {
    connectionType,
    commandLanguage,
    ipAddress: String(normalized.ip_address || '').trim(),
    port: Math.max(1, Math.min(65535, Number(normalized.port || (normalized.network_protocol === 'lpr' ? 515 : 9100)))),
    networkProtocol: String(normalized.network_protocol || 'raw_tcp'),
    lprQueue: String(normalized.lpr_queue || 'lp').trim(),
    bluetoothMode: 'classic',
    bluetoothDeviceName: String(normalized.bluetooth_device_name || '').trim(),
    bluetoothDeviceId: String(normalized.bluetooth_device_id || '').trim(),
    retryLimit: Math.max(0, Math.min(20, Number(normalized.retry_limit || 0))),
    connectionTimeoutMs: Math.max(1000, Math.min(30000, Number(normalized.connection_timeout_ms || 4000))),
    mediaSensor: String(normalized.media_sensor || 'gap'),
    gapMm: Math.max(0, Math.min(20, Number(normalized.gap_mm || 0))),
    gapOffsetMm: Math.max(-20, Math.min(20, Number(normalized.gap_offset_mm || 0))),
    blackMarkMm: Math.max(0, Math.min(20, Number(normalized.black_mark_mm || 0))),
    blackMarkOffsetMm: Math.max(-20, Math.min(20, Number(normalized.black_mark_offset_mm || 0))),
    printSpeedMmS: Math.max(10, Math.min(305, Number(normalized.print_speed_mm_s || 76))),
    darkness: Math.max(0, Math.min(15, Number(normalized.darkness || 8))),
    xOffsetMm: Math.max(-20, Math.min(20, Number(normalized.x_offset_mm || 0))),
    yOffsetMm: Math.max(-20, Math.min(20, Number(normalized.y_offset_mm || 0))),
    profile: normalized,
  }
}

export async function testDirectPrinterProfile(profile) {
  if (!isNativeAndroid()) throw new Error('Connection testing is available inside the Android app.')
  const plugin = directPrinter()
  if (!plugin?.testConnection) throw new Error('Install the latest Android APK to test printer connections.')
  const options = directPrinterOptions(profile)
  const result = await plugin.testConnection(options)
  return { ...result, profile: options.profile }
}

export async function calibrateDirectPrinterProfile(profile) {
  if (!isNativeAndroid()) throw new Error('Media calibration is available inside the Android app.')
  const plugin = directPrinter()
  if (!plugin?.calibrateMedia) throw new Error('Install the latest Android APK to calibrate printer media.')
  const options = directPrinterOptions(profile)
  if (options.commandLanguage === 'escpos') {
    throw new Error('ESC/POS does not provide a standard gap or black-mark calibration command. Use the printer driver or hardware feed/calibrate button.')
  }
  if (options.mediaSensor === 'continuous') {
    throw new Error('Continuous media does not use gap or black-mark calibration.')
  }
  const result = await plugin.calibrateMedia(options)
  return { ...result, profile: options.profile }
}

async function sendDirectLabel(html) {
  const plugin = directPrinter()
  if (!plugin?.printDirect) throw new Error('The Android direct-print service is unavailable in this APK.')

  const profile = await resolvePrinterProfile()
  const options = directPrinterOptions(profile)
  const transformed = applyPrinterLayoutToHtml(html, options.profile)
  const jobName = extractJobName(transformed.html)
  const copies = countCopies(transformed.html)

  const result = await plugin.printDirect({
    ...options,
    profile: undefined,
    html: sanitizeLabelHtml(transformed.html),
    jobName,
    widthMm: transformed.layout.width_mm,
    heightMm: transformed.layout.height_mm,
    dpi: Math.max(72, Number(options.profile.dpi || 203)),
    copies,
  })

  const profileName = String(options.profile.profile_name || 'Label printer').trim()
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
    profile_id: options.profile.id || '',
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
