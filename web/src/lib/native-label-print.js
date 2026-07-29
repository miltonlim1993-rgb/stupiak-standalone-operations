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
import { applyCreatedLabelSizeContract } from '@/lib/label-size-contract-v14'
import {
  effectiveConnectionType,
  normalizeBridgeUrl,
  normalizePrinterTransportProfile,
  printerRouteLabel,
  validatePrinterTransport,
} from '@/lib/printer-transport-v12'
import {
  asciiBase64,
  buildTsplFoodLabelCommand,
} from '@/lib/tspl-food-label-compat'

const serverProfilesCache = new Map()
const BRIDGE_TIMEOUT_MS = 10000

export function isNativeAndroidPrinterRuntime() {
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
  if (!force && cached && Date.now() - cached.loadedAt < 15000) return { outletId, profiles: cached.profiles }

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
    return normalizePrinterTransportProfile(
      selectPrinterProfile(resolved.profiles, resolved.outletId, binding.selected_profile_id)
        || { outlet_id: resolved.outletId },
      resolved.outletId,
    )
  } catch (error) {
    console.debug('Server printer profiles could not be refreshed; using the device snapshot', error)
    const binding = readPrinterDeviceBinding(requestedOutletId)
    return normalizePrinterTransportProfile(
      selectPrinterProfile(readPrinterProfilesSnapshot(requestedOutletId), requestedOutletId, binding.selected_profile_id)
        || { outlet_id: requestedOutletId },
      requestedOutletId,
    )
  }
}

function resolveCachedPrinterProfile() {
  const outletId = currentOutletId()
  const binding = readPrinterDeviceBinding(outletId)
  const selected = selectPrinterProfile(readPrinterProfilesSnapshot(outletId), outletId, binding.selected_profile_id)
  return selected ? normalizePrinterTransportProfile(selected, outletId) : null
}

function directPrinter() {
  return window.Capacitor?.Plugins?.DirectLabelPrint
}

export function showPrinterMessage(message, tone = 'error') {
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
    'width:min(calc(100vw - 1.5rem),520px)',
    'padding:.85rem 1rem',
    'border-radius:.9rem',
    'font:600 13px/1.45 system-ui,sans-serif',
    'box-shadow:0 12px 34px rgba(0,0,0,.18)',
    tone === 'success'
      ? 'background:#ecfdf5;color:#047857;border:1px solid #a7f3d0'
      : tone === 'info'
        ? 'background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe'
        : 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca',
  ].join(';')
  document.body.appendChild(item)
  window.setTimeout(() => item.remove(), tone === 'success' ? 5000 : 8000)
}

function directPrinterOptions(profile) {
  const { normalized, connection, language } = validatePrinterTransport(profile, { nativeAndroid: isNativeAndroidPrinterRuntime() })
  return {
    connectionType: connection,
    commandLanguage: language,
    ipAddress: String(normalized.ip_address || '').trim(),
    port: Math.max(1, Math.min(65535, Number(normalized.port || (normalized.network_protocol === 'lpr' ? 515 : 9100)))),
    networkProtocol: String(normalized.network_protocol || 'raw_tcp'),
    lprQueue: String(normalized.lpr_queue || 'lp').trim(),
    bluetoothMode: String(normalized.bluetooth_mode || 'classic'),
    bluetoothDeviceName: String(normalized.bluetooth_device_name || '').trim(),
    bluetoothDeviceId: String(normalized.bluetooth_device_id || '').trim(),
    bridgeUrl: normalizeBridgeUrl(normalized.bridge_url),
    bridgeToken: String(normalized.bridge_token || '').trim(),
    bridgeTransport: String(normalized.bridge_transport || 'queue'),
    bridgeQueue: String(normalized.bridge_queue || '').trim(),
    bridgePrinterIp: String(normalized.bridge_printer_ip || normalized.ip_address || '').trim(),
    bridgePrinterPort: Math.max(1, Math.min(65535, Number(normalized.bridge_printer_port || normalized.port || 9100))),
    bridgeLprQueue: String(normalized.bridge_lpr_queue || normalized.lpr_queue || 'lp').trim(),
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

async function bridgeRequest(profile, pathname, body = null, { timeoutMs = BRIDGE_TIMEOUT_MS } = {}) {
  const normalized = normalizePrinterTransportProfile(profile)
  const base = normalizeBridgeUrl(normalized.bridge_url)
  if (!base) throw new Error('Print Bridge URL is missing.')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${base}${pathname}`, {
      method: body === null ? 'GET' : 'POST',
      headers: {
        ...(body === null ? {} : { 'Content-Type': 'application/json' }),
        'X-Print-Bridge-Token': String(normalized.bridge_token || '').trim(),
      },
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Print Bridge request failed (${response.status}).`)
    return data || { ok: true }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Print Bridge did not respond within ${Math.round(timeoutMs / 1000)} seconds.`)
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

function bridgeTarget(profile) {
  const normalized = normalizePrinterTransportProfile(profile)
  return normalized.bridge_transport === 'queue'
    ? { mode: 'queue', queue: normalized.bridge_queue }
    : normalized.bridge_transport === 'lpr'
      ? { mode: 'lpr', host: normalized.bridge_printer_ip, port: normalized.bridge_printer_port || 515, queue: normalized.bridge_lpr_queue || 'lp' }
      : { mode: 'raw_tcp', host: normalized.bridge_printer_ip, port: normalized.bridge_printer_port || 9100 }
}

export async function discoverBridgePrinterQueues(profile) {
  validatePrinterTransport({ ...profile, bridge_queue: profile.bridge_queue || '__discover__' }, { nativeAndroid: isNativeAndroidPrinterRuntime() })
  const data = await bridgeRequest(profile, '/printers')
  return Array.isArray(data.printers) ? data.printers : []
}

export async function testPrinterProfile(profile) {
  const { normalized, connection } = validatePrinterTransport(profile, { nativeAndroid: isNativeAndroidPrinterRuntime() })
  if (connection === 'system_print') {
    return { connected: true, printer: 'Device system print / installed driver', connectionType: connection, requiresTestLabel: true }
  }
  if (connection === 'driver_bridge') {
    const health = await bridgeRequest(normalized, '/health')
    const tested = await bridgeRequest(normalized, '/test', bridgeTarget(normalized))
    return { ...tested, bridge: health, connectionType: connection }
  }
  const plugin = directPrinter()
  if (!plugin?.testConnection) throw new Error('Install the latest Android APK to test direct printer connections.')
  const options = directPrinterOptions(normalized)
  const result = await plugin.testConnection({ ...options, profile: undefined })
  return { ...result, profile: options.profile }
}

export const testDirectPrinterProfile = testPrinterProfile

function calibrationCommand(language, sensor) {
  if (language === 'tspl') return sensor === 'black_mark' ? 'BLINEDETECT\r\n' : 'GAPDETECT\r\n'
  if (language === 'zpl') return `^XA${sensor === 'black_mark' ? '^MNM' : '^MNY'}^XZ~JC`
  if (language === 'cpcl') return `! UTILITIES\r\n${sensor === 'black_mark' ? 'BAR-SENSE' : 'GAP-SENSE'}\r\nFORM\r\nPRINT\r\n`
  throw new Error('This command language does not support automatic media calibration.')
}

export async function calibratePrinterProfile(profile) {
  const { normalized, connection, language } = validatePrinterTransport(profile, { nativeAndroid: isNativeAndroidPrinterRuntime() })
  if (connection === 'system_print') throw new Error('Use the printer driver or hardware feed/calibrate button for System Print.')
  if (language === 'escpos') throw new Error('ESC/POS has no standard gap or black-mark calibration command.')
  if (normalized.media_sensor === 'continuous') throw new Error('Continuous media does not use gap or black-mark calibration.')

  if (connection === 'driver_bridge') {
    const command = calibrationCommand(language, normalized.media_sensor)
    return bridgeRequest(normalized, '/print', {
      ...bridgeTarget(normalized),
      payloadBase64: btoa(command),
    })
  }

  const plugin = directPrinter()
  if (!plugin?.calibrateMedia) throw new Error('Install the latest Android APK to calibrate printer media.')
  const options = directPrinterOptions(normalized)
  const result = await plugin.calibrateMedia({ ...options, profile: undefined })
  return { ...result, profile: options.profile }
}

export const calibrateDirectPrinterProfile = calibratePrinterProfile

function prepareLabel(html, profile) {
  const options = directPrinterOptions(profile)
  const dpi = Math.max(72, Number(options.profile.dpi || 203))
  const layoutApplied = applyPrinterLayoutToHtml(html, options.profile)
  const canonical = applyCreatedLabelSizeContract(layoutApplied.html, options.profile)
  const transformed = {
    html: canonical.html,
    layout: {
      ...layoutApplied.layout,
      dpi,
      created_canvas_width_mm: canonical.contract.created_canvas_width_mm,
      created_canvas_height_mm: canonical.contract.created_canvas_height_mm,
      content_width_mm: canonical.contract.content_width_mm,
      content_height_mm: canonical.contract.content_height_mm,
      raster_width_dots: canonical.contract.raster_width_dots,
      raster_height_dots: canonical.contract.raster_height_dots,
      size_contract_signature: canonical.contract.signature,
    },
  }
  window.__chefopsLastCreatedLabelSizeContract = canonical.contract
  window.__chefopsLastCreatedLabelSourceMatched = canonical.source_matched_setting
  const jobName = extractJobName(transformed.html)
  const copies = countCopies(transformed.html)
  const nativeTspl = buildTsplFoodLabelCommand(transformed.html, {
    ...options,
    widthMm: transformed.layout.width_mm,
    heightMm: transformed.layout.height_mm,
    dpi,
    copies,
  })
  return { options, transformed, jobName, copies, dpi, nativeTspl, sizeContract: canonical.contract }
}

async function sendNativeManagedLabel(prepared) {
  const plugin = directPrinter()
  if (!plugin?.printDirect) throw new Error('The Android direct-print service is unavailable in this APK.')
  const { options, transformed, jobName, copies, dpi, nativeTspl } = prepared
  return plugin.printDirect({
    ...options,
    profile: undefined,
    html: sanitizeLabelHtml(transformed.html),
    rawCommandBase64: nativeTspl ? asciiBase64(nativeTspl.command) : '',
    renderMode: nativeTspl?.mode || 'html-raster',
    jobName,
    widthMm: transformed.layout.width_mm,
    heightMm: transformed.layout.height_mm,
    dpi,
    copies,
  })
}

function openSystemPrint(browserOpen, transformed, prepared) {
  const opened = browserOpen('', '_blank', 'width=480,height=640')
  if (!opened) throw new Error('The device blocked the system print window.')
  opened.document.open()
  opened.document.write(transformed.html)
  opened.document.close()
  return { printed: true, printer: 'Device system print / installed driver', route: 'system_print', dialog: true, jobName: prepared.jobName }
}

async function printSystemLabel(browserOpen, prepared) {
  const plugin = directPrinter()
  if (isNativeAndroidPrinterRuntime() && plugin?.printSystem) {
    return plugin.printSystem({
      html: sanitizeLabelHtml(prepared.transformed.html),
      jobName: prepared.jobName,
      widthMm: prepared.transformed.layout.width_mm,
      heightMm: prepared.transformed.layout.height_mm,
      dpi: prepared.dpi,
    })
  }
  return openSystemPrint(browserOpen, prepared.transformed, prepared)
}

async function sendBridgeLabel(prepared, browserOpen) {
  const { options, nativeTspl } = prepared
  if (nativeTspl) {
    return bridgeRequest(options.profile, '/print', {
      ...bridgeTarget(options.profile),
      payloadBase64: asciiBase64(nativeTspl.command),
    }, { timeoutMs: Math.max(BRIDGE_TIMEOUT_MS, options.connectionTimeoutMs) })
  }

  if (isNativeAndroidPrinterRuntime() && directPrinter()?.printDirect) {
    return sendNativeManagedLabel(prepared)
  }

  if (options.profile.fallback_connection === 'system_print') {
    showPrinterMessage('This label needs driver rendering, so it was opened with Device System Print instead of RAW Bridge output.', 'info')
    return printSystemLabel(browserOpen, prepared)
  }
  throw new Error('This rotated or non-ASCII label cannot be sent as RAW bridge data. Enable System Print fallback or use the Android app.')
}

async function sendLabelByProfile(html, browserOpen) {
  const profile = await resolvePrinterProfile()
  const connection = effectiveConnectionType(profile)
  const prepared = prepareLabel(html, profile)
  let result

  if (connection === 'system_print') result = await printSystemLabel(browserOpen, prepared)
  else if (connection === 'driver_bridge') result = await sendBridgeLabel(prepared, browserOpen)
  else result = await sendNativeManagedLabel(prepared)

  const profileName = String(prepared.options.profile.profile_name || 'Label printer').trim()
  const outcome = prepared.nativeTspl
    ? `Native ${prepared.options.commandLanguage.toUpperCase()} · fixed ${prepared.nativeTspl.widthMm}×${prepared.nativeTspl.heightMm} mm`
    : formatPrinterLayoutOutcome(prepared.transformed.layout)
  showPrinterMessage(
    `${result?.dialog ? 'System print opened' : 'Print job sent'} · ${profileName} · ${printerRouteLabel(prepared.options.profile)} · ${outcome} · ${prepared.copies} cop${prepared.copies === 1 ? 'y' : 'ies'}.`,
    result?.dialog ? 'info' : 'success',
  )

  const detail = {
    jobName: prepared.jobName,
    copies: prepared.copies,
    dpi: prepared.dpi,
    route: connection,
    direct: connection !== 'system_print',
    render_mode: prepared.nativeTspl?.mode || 'html-raster',
    result,
    profile_id: prepared.options.profile.id || '',
    profile_name: profileName,
    layout: prepared.transformed.layout,
    size_contract: prepared.sizeContract,
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
  const originalOpen = window.open.bind(window)
  window.open = function chefopsSystemLayoutOpen(url = '', target = '', features = '') {
    const opened = originalOpen(url, target, features)
    if (!opened || !isLabelPopup(url, target, features)) return opened
    const installWriter = () => {
      const originalWrite = opened.document.write.bind(opened.document)
      opened.document.write = (value) => {
        const source = String(value ?? '')
        if (!isPrintableLabel(source) || source.includes('id="chefops-printer-layout"')) return originalWrite(source)
        const profile = resolveCachedPrinterProfile()
        if (!profile) return originalWrite(source)
        const layoutApplied = applyPrinterLayoutToHtml(source, profile)
        const canonical = applyCreatedLabelSizeContract(layoutApplied.html, profile)
        window.__chefopsLastCreatedLabelSizeContract = canonical.contract
        window.__chefopsLastCreatedLabelSourceMatched = canonical.source_matched_setting
        return originalWrite(canonical.html)
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
  if (window.__chefopsNativePrintInstalled) return
  window.__chefopsNativePrintInstalled = true

  const browserOpen = window.open.bind(window)
  window.open = function chefopsManagedLabelWindowOpen(url = '', target = '', features = '') {
    if (!isLabelPopup(url, target, features)) return browserOpen(url, target, features)

    const cached = resolveCachedPrinterProfile()
    const cachedConnection = cached ? effectiveConnectionType(cached) : 'system_print'
    if (!isNativeAndroidPrinterRuntime() && cachedConnection === 'system_print') {
      return browserOpen(url, target, features)
    }

    let buffer = ''
    let closed = false
    let printing = false
    const fakeDocument = {
      open() { buffer = ''; printing = false },
      write(value) { buffer += String(value ?? '') },
      close() {
        if (!isPrintableLabel(buffer) || printing || closed) return
        printing = true
        void sendLabelByProfile(buffer, browserOpen).catch((error) => {
          printing = false
          const message = error?.message || 'Label printing failed.'
          console.error('Managed label print failed', error)
          showPrinterMessage(message)
          window.dispatchEvent(new CustomEvent('chefops:native-print-error', { detail: { message, route: cachedConnection } }))
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
