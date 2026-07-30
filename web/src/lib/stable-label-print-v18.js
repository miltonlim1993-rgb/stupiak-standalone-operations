import { opsClient } from '@/api/opsClient'
import {
  clearLegacyPrinterDraft,
  readPrinterDeviceBinding,
  readPrinterProfilesSnapshot,
  savePrinterProfilesSnapshot,
  selectPrinterProfile,
} from '@/lib/label-printer-profile'
import {
  effectiveConnectionType,
  normalizeBridgeUrl,
  normalizePrinterTransportProfile,
  printerRouteLabel,
  validatePrinterTransport,
} from '@/lib/printer-transport-v12'
import {
  asciiBase64,
  buildStableTsplLabelCommand,
  countStableLabelCopies,
} from '@/lib/stable-tspl-label-v16'
import {
  isNativeAndroidPrinterRuntime,
  showPrinterMessage,
} from '@/lib/native-label-print'

export const STABLE_LABEL_PRINT_VERSION = '4.6.16-stable-label-print-v18'
const BRIDGE_TIMEOUT_MS = 12000
const profilesCache = new Map()

function clean(value = '') {
  return String(value ?? '').trim()
}

function currentOutletId() {
  try {
    return clean(localStorage.getItem('chefops.data-pack.outlet'))
  } catch {
    return ''
  }
}

function directPrinter() {
  return window.Capacitor?.Plugins?.DirectLabelPrint
}

function isPrintableLabel(html) {
  const value = String(html || '')
  return value.includes('@page')
    && /class=["'][^"']*\blabel\b[^"']*["']/i.test(value)
    && (value.includes('window.print') || value.includes('barcode-wrap') || value.includes('TEST LABEL'))
}

function isLabelPopup(url, target, features) {
  const featureText = String(features || '').toLowerCase()
  return String(target || '') === '_blank'
    && (!url || String(url) === 'about:blank')
    && featureText.includes('width=480')
    && featureText.includes('height=640')
}

function extractJobName(html) {
  const match = String(html || '').match(/<title>([^<]+)<\/title>/i)
  return clean(match?.[1] || 'Stupiak Ops Label').slice(0, 80)
}

async function resolveOutletAndProfiles(requestedOutletId, { force = false } = {}) {
  let outletId = clean(requestedOutletId)
  if (!outletId) {
    const fallback = await opsClient.labels.printerProfile({ outletId: '' }).catch(() => null)
    outletId = clean(fallback?.outlet_id)
    if (!outletId) return { outletId: '', profiles: fallback?.id ? [fallback] : [] }
  }

  const cached = profilesCache.get(outletId)
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

  profilesCache.set(outletId, { loadedAt: Date.now(), profiles: profiles || [] })
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
    console.debug('Stable printer profile refresh failed; using device snapshot', error)
    const binding = readPrinterDeviceBinding(requestedOutletId)
    return normalizePrinterTransportProfile(
      selectPrinterProfile(readPrinterProfilesSnapshot(requestedOutletId), requestedOutletId, binding.selected_profile_id)
        || { outlet_id: requestedOutletId },
      requestedOutletId,
    )
  }
}

function directOptions(profile) {
  const nativeAndroid = isNativeAndroidPrinterRuntime()
  const normalized = normalizePrinterTransportProfile(profile)
  const connection = effectiveConnectionType(normalized)
  const validationProfile = connection === 'network' && !nativeAndroid
    ? { ...normalized, connection_type: 'driver_bridge', bridge_transport: normalized.network_protocol === 'lpr' ? 'lpr' : 'raw_tcp' }
    : normalized
  const validated = validatePrinterTransport(validationProfile, { nativeAndroid })
  return {
    normalized,
    connection,
    language: clean(normalized.command_language).toLowerCase(),
    nativeAndroid,
    timeoutMs: Math.max(1000, Math.min(30000, Number(normalized.connection_timeout_ms || 4000))),
    pluginOptions: {
      connectionType: connection,
      commandLanguage: 'tspl',
      ipAddress: clean(normalized.ip_address),
      port: Math.max(1, Math.min(65535, Number(normalized.port || (normalized.network_protocol === 'lpr' ? 515 : 9100)))),
      networkProtocol: clean(normalized.network_protocol || 'raw_tcp'),
      lprQueue: clean(normalized.lpr_queue || 'lp'),
      bluetoothMode: 'classic',
      bluetoothDeviceName: clean(normalized.bluetooth_device_name),
      bluetoothDeviceId: clean(normalized.bluetooth_device_id),
      retryLimit: Math.max(0, Math.min(20, Number(normalized.retry_limit || 0))),
      connectionTimeoutMs: Math.max(1000, Math.min(30000, Number(normalized.connection_timeout_ms || 4000))),
      mediaSensor: clean(normalized.media_sensor || 'gap'),
      gapMm: Math.max(0, Math.min(20, Number(normalized.gap_mm || 2))),
      gapOffsetMm: Math.max(-20, Math.min(20, Number(normalized.gap_offset_mm || 0))),
      blackMarkMm: Math.max(0, Math.min(20, Number(normalized.black_mark_mm || 2))),
      blackMarkOffsetMm: Math.max(-20, Math.min(20, Number(normalized.black_mark_offset_mm || 0))),
      xOffsetMm: Math.max(-20, Math.min(20, Number(normalized.x_offset_mm || 0))),
      yOffsetMm: Math.max(-20, Math.min(20, Number(normalized.y_offset_mm || 0))),
    },
    validated,
  }
}

function bridgeTarget(profile, connection) {
  const normalized = normalizePrinterTransportProfile(profile)
  if (connection === 'network') {
    return normalized.network_protocol === 'lpr'
      ? {
          mode: 'lpr',
          host: clean(normalized.ip_address),
          port: Number(normalized.port || 515),
          queue: clean(normalized.lpr_queue || 'lp'),
        }
      : {
          mode: 'raw_tcp',
          host: clean(normalized.ip_address),
          port: Number(normalized.port || 9100),
        }
  }
  if (normalized.bridge_transport === 'queue') return { mode: 'queue', queue: clean(normalized.bridge_queue) }
  if (normalized.bridge_transport === 'lpr') {
    return {
      mode: 'lpr',
      host: clean(normalized.bridge_printer_ip),
      port: Number(normalized.bridge_printer_port || 515),
      queue: clean(normalized.bridge_lpr_queue || 'lp'),
    }
  }
  return {
    mode: 'raw_tcp',
    host: clean(normalized.bridge_printer_ip),
    port: Number(normalized.bridge_printer_port || 9100),
  }
}

async function bridgeRequest(profile, command, connection, timeoutMs) {
  const normalized = normalizePrinterTransportProfile(profile)
  const base = normalizeBridgeUrl(normalized.bridge_url)
  if (!base) {
    throw new Error(connection === 'network'
      ? 'Web Direct Wi-Fi/LAN requires the local Print Connector URL on this Windows or macOS computer.'
      : 'Print Bridge URL is missing.')
  }
  if (!clean(normalized.bridge_token)) throw new Error('Print Connector pairing token is missing.')

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), Math.max(BRIDGE_TIMEOUT_MS, timeoutMs || 0))
  try {
    const response = await fetch(`${base}/print`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Print-Bridge-Token': clean(normalized.bridge_token),
      },
      body: JSON.stringify({
        ...bridgeTarget(normalized, connection),
        payloadBase64: asciiBase64(command),
        timeoutMs: Math.max(1000, Number(timeoutMs || 4000)),
      }),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Print Connector request failed (${response.status}).`)
    return data || { ok: true }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Print Connector did not acknowledge the RAW TSPL job in time.')
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

function stableCommand(html, options) {
  return buildStableTsplLabelCommand(html, {
    commandLanguage: 'tspl',
    widthMm: Number(options.normalized.label_width_mm || 40),
    heightMm: Number(options.normalized.label_height_mm || 30),
    dpi: Number(options.normalized.dpi || 203),
    copies: countStableLabelCopies(html),
    mediaSensor: options.pluginOptions.mediaSensor,
    gapMm: options.pluginOptions.gapMm,
    gapOffsetMm: options.pluginOptions.gapOffsetMm,
    blackMarkMm: options.pluginOptions.blackMarkMm,
    blackMarkOffsetMm: options.pluginOptions.blackMarkOffsetMm,
    xOffsetMm: options.pluginOptions.xOffsetMm,
    yOffsetMm: options.pluginOptions.yOffsetMm,
  })
}

function publishResult(html, options, stable, result, actualRoute) {
  const profileName = clean(options.normalized.profile_name || 'Food Label Printer')
  const sizeContract = {
    version: STABLE_LABEL_PRINT_VERSION,
    source: 'stable-tspl-core-v16',
    physical_width_mm: stable.widthMm,
    physical_height_mm: stable.heightMm,
    created_canvas_width_mm: stable.widthMm,
    created_canvas_height_mm: stable.heightMm,
    content_width_mm: stable.widthMm,
    content_height_mm: stable.heightMm,
    raster_width_dots: stable.report.widthDots,
    raster_height_dots: stable.report.heightDots,
    native_command_width_mm: stable.widthMm,
    native_command_height_mm: stable.heightMm,
    signature: `${stable.widthMm}x${stable.heightMm}@${stable.dpi}:tspl-stable-v18`,
  }
  const detail = {
    jobName: extractJobName(html),
    copies: stable.copies,
    dpi: stable.dpi,
    route: actualRoute,
    direct: true,
    render_mode: stable.mode,
    version: STABLE_LABEL_PRINT_VERSION,
    result,
    profile_id: options.normalized.id || '',
    profile_name: profileName,
    width_mm: stable.widthMm,
    height_mm: stable.heightMm,
    fit_report: stable.report,
    payload_bytes: stable.command.length,
    size_contract: sizeContract,
  }
  window.__chefopsLastCreatedLabelSizeContract = sizeContract
  window.__chefopsLastCreatedLabelSourceMatched = true
  window.__chefopsLastLabelPrintOutcome = detail
  window.__chefopsLastStableTsplPayload = stable.command
  window.dispatchEvent(new CustomEvent('chefops:native-print-started', { detail }))
  showPrinterMessage(
    `RAW TSPL sent · ${profileName} · ${actualRoute} · ${stable.widthMm}×${stable.heightMm} mm · ${stable.copies} copy.`,
    'success',
  )
  return detail
}

export async function printStableLabelHtmlV18(html, profileOverride = null) {
  if (!isPrintableLabel(html)) throw new Error('This is not a supported Food Label or Test Label document.')
  const profile = normalizePrinterTransportProfile(profileOverride || await resolvePrinterProfile())
  const options = directOptions(profile)
  if (options.language !== 'tspl') throw new Error('Stable Food Labels require a TSPL printer profile.')
  if (options.connection === 'system_print') {
    throw new Error('Browser/System Print is disabled for Food Labels because it changes page size and splits labels. Choose Direct Wi-Fi/LAN or PC/Mac Bridge.')
  }
  if (options.connection === 'bluetooth' && !options.nativeAndroid) {
    throw new Error('Web Bluetooth cannot send printer SPP RAW TSPL. Use the Android APK or PC/Mac Bridge.')
  }

  const stable = stableCommand(html, options)
  let result
  let actualRoute
  if (options.connection === 'driver_bridge') {
    result = await bridgeRequest(profile, stable.command, 'driver_bridge', options.timeoutMs)
    actualRoute = 'PC/Mac Bridge RAW TSPL'
  } else if (options.connection === 'network' && !options.nativeAndroid) {
    result = await bridgeRequest(profile, stable.command, 'network', options.timeoutMs)
    actualRoute = 'Web Direct Wi-Fi/LAN via Local Connector'
  } else {
    const plugin = directPrinter()
    if (!plugin?.printDirect) throw new Error('Install the latest Android APK for native Direct Wi-Fi/LAN or Bluetooth printing.')
    result = await plugin.printDirect({
      ...options.pluginOptions,
      html: '',
      rawCommandBase64: asciiBase64(stable.command),
      renderMode: stable.mode,
      jobName: extractJobName(html),
      widthMm: stable.widthMm,
      heightMm: stable.heightMm,
      dpi: stable.dpi,
      copies: stable.copies,
    })
    actualRoute = printerRouteLabel(profile)
  }
  return publishResult(html, options, stable, result, actualRoute)
}

export function installStableLabelPrintV18() {
  if (window.__chefopsStableLabelPrintV18Installed) return
  window.__chefopsStableLabelPrintV18Installed = true
  window.__chefopsStableLabelPrintVersion = STABLE_LABEL_PRINT_VERSION
  window.__chefopsPrintStableLabelHtml = printStableLabelHtmlV18

  const browserOpen = window.open.bind(window)
  window.open = function chefopsStableLabelWindowOpen(url = '', target = '', features = '') {
    if (!isLabelPopup(url, target, features)) return browserOpen(url, target, features)

    let buffer = ''
    let closed = false
    let printing = false
    const fakeDocument = {
      open() { buffer = ''; printing = false },
      write(value) { buffer += String(value ?? '') },
      close() {
        if (!isPrintableLabel(buffer) || printing || closed) return
        printing = true
        void printStableLabelHtmlV18(buffer).catch((error) => {
          printing = false
          const message = error?.message || 'Stable RAW TSPL printing failed.'
          console.error('Stable RAW TSPL print failed', error)
          showPrinterMessage(message)
          window.dispatchEvent(new CustomEvent('chefops:native-print-error', {
            detail: {
              message,
              code: error?.code || 'stable_tspl_print_failed',
              version: STABLE_LABEL_PRINT_VERSION,
            },
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
