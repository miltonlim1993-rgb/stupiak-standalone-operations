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
  STABLE_TSPL_LABEL_VERSION,
} from '@/lib/stable-tspl-label-v16'
import {
  isNativeAndroidPrinterRuntime,
  showPrinterMessage,
} from '@/lib/native-label-print'

const BRIDGE_TIMEOUT_MS = 10000
const serverProfilesCache = new Map()

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
    console.debug('Stable TSPL profile refresh failed; using the device snapshot', error)
    const binding = readPrinterDeviceBinding(requestedOutletId)
    return normalizePrinterTransportProfile(
      selectPrinterProfile(readPrinterProfilesSnapshot(requestedOutletId), requestedOutletId, binding.selected_profile_id)
        || { outlet_id: requestedOutletId },
      requestedOutletId,
    )
  }
}

function directPrinter() {
  return window.Capacitor?.Plugins?.DirectLabelPrint
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
    gapMm: Math.max(0, Math.min(20, Number(normalized.gap_mm || 2))),
    gapOffsetMm: Math.max(-20, Math.min(20, Number(normalized.gap_offset_mm || 0))),
    blackMarkMm: Math.max(0, Math.min(20, Number(normalized.black_mark_mm || 2))),
    blackMarkOffsetMm: Math.max(-20, Math.min(20, Number(normalized.black_mark_offset_mm || 0))),
    xOffsetMm: Math.max(-20, Math.min(20, Number(normalized.x_offset_mm || 0))),
    yOffsetMm: Math.max(-20, Math.min(20, Number(normalized.y_offset_mm || 0))),
    profile: normalized,
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

async function bridgeRequest(profile, command, timeoutMs) {
  const normalized = normalizePrinterTransportProfile(profile)
  const base = normalizeBridgeUrl(normalized.bridge_url)
  if (!base) throw new Error('Print Bridge URL is missing.')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), Math.max(BRIDGE_TIMEOUT_MS, timeoutMs || 0))
  try {
    const response = await fetch(`${base}/print`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Print-Bridge-Token': String(normalized.bridge_token || '').trim(),
      },
      body: JSON.stringify({
        ...bridgeTarget(normalized),
        payloadBase64: asciiBase64(command),
        timeoutMs: Math.max(1000, Number(timeoutMs || 4000)),
      }),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Print Bridge request failed (${response.status}).`)
    return data || { ok: true }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Print Bridge did not acknowledge the RAW TSPL job in time.')
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

function stableCommand(html, options) {
  return buildStableTsplLabelCommand(html, {
    commandLanguage: options.commandLanguage,
    widthMm: Number(options.profile.label_width_mm || 40),
    heightMm: Number(options.profile.label_height_mm || 30),
    dpi: Number(options.profile.dpi || 203),
    copies: countStableLabelCopies(html),
    mediaSensor: options.mediaSensor,
    gapMm: options.gapMm,
    gapOffsetMm: options.gapOffsetMm,
    blackMarkMm: options.blackMarkMm,
    blackMarkOffsetMm: options.blackMarkOffsetMm,
    xOffsetMm: options.xOffsetMm,
    yOffsetMm: options.yOffsetMm,
  })
}

async function sendManagedStableLabel(html, profile) {
  const connection = effectiveConnectionType(profile)
  const options = directPrinterOptions(profile)
  if (options.commandLanguage !== 'tspl') {
    throw new Error('Bridge, LAN, Wi-Fi and Bluetooth Food Labels now require the stable TSPL profile. Change Printer language to TSPL.')
  }

  const stable = stableCommand(html, options)
  let result
  if (connection === 'driver_bridge') {
    result = await bridgeRequest(options.profile, stable.command, options.connectionTimeoutMs)
  } else {
    const plugin = directPrinter()
    if (!plugin?.printDirect) throw new Error('Install the latest Android APK for direct LAN, Wi-Fi or Bluetooth TSPL printing.')
    result = await plugin.printDirect({
      ...options,
      profile: undefined,
      html: '',
      rawCommandBase64: asciiBase64(stable.command),
      renderMode: stable.mode,
      jobName: extractJobName(html),
      widthMm: stable.widthMm,
      heightMm: stable.heightMm,
      dpi: stable.dpi,
      copies: stable.copies,
    })
  }

  const profileName = String(options.profile.profile_name || 'Food Label Printer').trim()
  const detail = {
    jobName: extractJobName(html),
    copies: stable.copies,
    dpi: stable.dpi,
    route: connection,
    direct: true,
    render_mode: stable.mode,
    version: stable.version,
    result,
    profile_id: options.profile.id || '',
    profile_name: profileName,
    width_mm: stable.widthMm,
    height_mm: stable.heightMm,
    fit_report: stable.report,
    payload_bytes: stable.command.length,
  }
  window.__chefopsLastLabelPrintOutcome = detail
  window.__chefopsLastStableTsplPayload = stable.command
  window.dispatchEvent(new CustomEvent('chefops:native-print-started', { detail }))
  showPrinterMessage(
    `RAW TSPL sent · ${profileName} · ${printerRouteLabel(options.profile)} · fixed ${stable.widthMm}×${stable.heightMm} mm · ${stable.copies} cop${stable.copies === 1 ? 'y' : 'ies'}.`,
    'success',
  )
  return detail
}

function delegateSystemPrint(browserOpen, html, features) {
  const opened = browserOpen('', '_blank', features || 'width=480,height=640')
  if (!opened) throw new Error('The device blocked the System Print window.')
  opened.document.open()
  opened.document.write(html)
  opened.document.close()
  return opened
}

export function installStableLabelPrintV16() {
  if (window.__chefopsStableLabelPrintV16Installed) return
  window.__chefopsStableLabelPrintV16Installed = true
  window.__chefopsStableLabelPrintVersion = STABLE_TSPL_LABEL_VERSION

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
        void resolvePrinterProfile().then((profile) => {
          const connection = effectiveConnectionType(profile)
          if (connection === 'system_print') {
            delegateSystemPrint(browserOpen, buffer, features)
            return null
          }
          return sendManagedStableLabel(buffer, profile)
        }).catch((error) => {
          printing = false
          const message = error?.message || 'Stable TSPL label printing failed.'
          console.error('Stable TSPL label print failed', error)
          showPrinterMessage(message)
          window.dispatchEvent(new CustomEvent('chefops:native-print-error', {
            detail: {
              message,
              code: error?.code || 'stable_tspl_print_failed',
              version: STABLE_TSPL_LABEL_VERSION,
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
