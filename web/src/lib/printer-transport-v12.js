import {
  encodePrinterProfileNotes,
  normalizePrinterProfile,
  parsePrinterProfileNotes,
} from './label-printer-profile.js'

export const PRINTER_TRANSPORT_VERSION = '4.6.16-web-direct-lan-transport-v18'

export const DEFAULT_PRINTER_TRANSPORT = Object.freeze({
  bridge_url: '',
  bridge_token: '',
  bridge_transport: 'queue',
  bridge_queue: '',
  bridge_platform: 'auto',
  bridge_printer_ip: '',
  bridge_printer_port: 9100,
  bridge_lpr_queue: 'lp',
  fallback_connection: 'system_print',
})

function clean(value = '') {
  return String(value ?? '').trim()
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '')
}

function numberValue(value, fallback, minimum = 0, maximum = 65535) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

function enumValue(value, allowed, fallback) {
  const normalized = clean(value).toLowerCase()
  return allowed.includes(normalized) ? normalized : fallback
}

function transportMeta(profile = {}) {
  const notes = parsePrinterProfileNotes(profile.notes)
  const raw = notes.printer_transport_v12 || notes.transport || {}
  return {
    bridge_url: clean(firstDefined(profile.bridge_url, raw.bridge_url, raw.url, DEFAULT_PRINTER_TRANSPORT.bridge_url)),
    bridge_token: clean(firstDefined(profile.bridge_token, raw.bridge_token, raw.token, DEFAULT_PRINTER_TRANSPORT.bridge_token)),
    bridge_transport: enumValue(
      firstDefined(profile.bridge_transport, raw.bridge_transport, raw.mode),
      ['queue', 'raw_tcp', 'lpr'],
      DEFAULT_PRINTER_TRANSPORT.bridge_transport,
    ),
    bridge_queue: clean(firstDefined(profile.bridge_queue, raw.bridge_queue, raw.queue, DEFAULT_PRINTER_TRANSPORT.bridge_queue)),
    bridge_platform: enumValue(
      firstDefined(profile.bridge_platform, raw.bridge_platform, raw.platform),
      ['auto', 'windows', 'macos', 'linux'],
      DEFAULT_PRINTER_TRANSPORT.bridge_platform,
    ),
    bridge_printer_ip: clean(firstDefined(
      profile.bridge_printer_ip,
      raw.bridge_printer_ip,
      raw.printer_ip,
      profile.ip_address,
      DEFAULT_PRINTER_TRANSPORT.bridge_printer_ip,
    )),
    bridge_printer_port: numberValue(
      firstDefined(profile.bridge_printer_port, raw.bridge_printer_port, raw.printer_port, profile.port),
      DEFAULT_PRINTER_TRANSPORT.bridge_printer_port,
      1,
      65535,
    ),
    bridge_lpr_queue: clean(firstDefined(
      profile.bridge_lpr_queue,
      raw.bridge_lpr_queue,
      raw.lpr_queue,
      DEFAULT_PRINTER_TRANSPORT.bridge_lpr_queue,
    )),
    fallback_connection: enumValue(
      firstDefined(profile.fallback_connection, raw.fallback_connection),
      ['none', 'system_print'],
      DEFAULT_PRINTER_TRANSPORT.fallback_connection,
    ),
  }
}

export function normalizePrinterTransportProfile(profile = {}, outletId = '') {
  return {
    ...normalizePrinterProfile(profile, outletId),
    ...transportMeta(profile),
  }
}

export function encodePrinterTransportNotes(profile = {}) {
  const base = JSON.parse(encodePrinterProfileNotes(profile))
  return JSON.stringify({
    ...base,
    printer_transport_v12: {
      schema: 'stupiaks-printer-transport-v18',
      bridge_url: clean(profile.bridge_url),
      bridge_token: clean(profile.bridge_token),
      bridge_transport: enumValue(profile.bridge_transport, ['queue', 'raw_tcp', 'lpr'], DEFAULT_PRINTER_TRANSPORT.bridge_transport),
      bridge_queue: clean(profile.bridge_queue),
      bridge_platform: enumValue(profile.bridge_platform, ['auto', 'windows', 'macos', 'linux'], DEFAULT_PRINTER_TRANSPORT.bridge_platform),
      bridge_printer_ip: clean(profile.bridge_printer_ip || profile.ip_address),
      bridge_printer_port: numberValue(profile.bridge_printer_port || profile.port, DEFAULT_PRINTER_TRANSPORT.bridge_printer_port, 1, 65535),
      bridge_lpr_queue: clean(profile.bridge_lpr_queue || profile.lpr_queue || DEFAULT_PRINTER_TRANSPORT.bridge_lpr_queue),
      fallback_connection: enumValue(profile.fallback_connection, ['none', 'system_print'], DEFAULT_PRINTER_TRANSPORT.fallback_connection),
    },
  })
}

export function normalizeBridgeUrl(value = '') {
  const raw = clean(value).replace(/\/+$/, '')
  if (!raw) return ''
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  return withProtocol.replace(/\/(health|printers|discover|test|print|print-queue|print-usb)$/i, '')
}

export function effectiveConnectionType(profile = {}) {
  const connection = clean(profile.connection_type || 'system_print').toLowerCase()
  if (connection === 'bluetooth' && ['system', 'ble'].includes(clean(profile.bluetooth_mode).toLowerCase())) {
    return 'system_print'
  }
  return connection
}

export function printerRouteLabel(profile = {}) {
  const normalized = normalizePrinterTransportProfile(profile)
  const connection = effectiveConnectionType(normalized)
  if (connection === 'network') {
    return normalized.network_protocol === 'lpr'
      ? `Direct LPR · ${normalized.ip_address || 'No IP'}:${normalized.port || 515}/${normalized.lpr_queue || 'lp'}`
      : `Direct Raw TCP · ${normalized.ip_address || 'No IP'}:${normalized.port || 9100}`
  }
  if (connection === 'driver_bridge') {
    const bridge = normalizeBridgeUrl(normalized.bridge_url) || 'No bridge URL'
    if (normalized.bridge_transport === 'queue') return `Driver Bridge · ${normalized.bridge_queue || 'No queue'} · ${bridge}`
    if (normalized.bridge_transport === 'lpr') return `Bridge LPR · ${normalized.bridge_printer_ip || 'No IP'}:${normalized.bridge_printer_port || 515}`
    return `Bridge Raw TCP · ${normalized.bridge_printer_ip || 'No IP'}:${normalized.bridge_printer_port || 9100}`
  }
  if (connection === 'bluetooth') {
    return `Bluetooth Classic · ${normalized.bluetooth_device_name || normalized.bluetooth_device_id || 'Not paired'}`
  }
  return 'Device system print / installed driver'
}

export function validatePrinterTransport(profile = {}, { nativeAndroid = false } = {}) {
  const normalized = normalizePrinterTransportProfile(profile)
  const connection = effectiveConnectionType(normalized)
  const language = clean(normalized.command_language).toLowerCase()

  if (!normalized.enabled && normalized.enabled !== undefined) throw new Error('The selected printer profile is disabled.')
  if (connection === 'system_print') return { normalized, connection, language: 'browser' }

  if (!['tspl', 'zpl', 'cpcl', 'escpos'].includes(language)) {
    throw new Error('Choose the printer command language: TSPL, ZPL, CPCL or ESC/POS.')
  }

  if (connection === 'network') {
    if (!clean(normalized.ip_address)) throw new Error('Enter the printer’s own IP address, not the computer IP.')
    if (normalized.network_protocol === 'lpr' && !clean(normalized.lpr_queue)) throw new Error('Enter the printer LPR queue name.')
    if (!nativeAndroid) {
      if (!normalizeBridgeUrl(normalized.bridge_url)) throw new Error('Web Direct Wi-Fi/LAN requires the Local Print Connector URL, normally http://127.0.0.1:8787.')
      if (!clean(normalized.bridge_token)) throw new Error('Enter the Local Print Connector pairing token.')
      return { normalized, connection, language, viaConnector: true }
    }
    return { normalized, connection, language, viaConnector: false }
  }

  if (connection === 'bluetooth') {
    if (!nativeAndroid) throw new Error('Bluetooth Classic RAW TSPL is available in the Android app. Web browsers must use Direct LAN through the Local Connector or PC/Mac Bridge.')
    if (clean(normalized.bluetooth_mode).toLowerCase() !== 'classic') {
      throw new Error('BLE and vendor-driver Bluetooth printers must use Device System Print. Raw Bluetooth supports paired Bluetooth Classic printers only.')
    }
    if (!clean(normalized.bluetooth_device_id || normalized.bluetooth_device_name)) throw new Error('Enter a paired Bluetooth printer name or MAC address.')
    return { normalized, connection, language }
  }

  if (connection === 'driver_bridge') {
    if (!normalizeBridgeUrl(normalized.bridge_url)) throw new Error('Enter the Windows/macOS Print Bridge URL, for example http://127.0.0.1:8787.')
    if (!clean(normalized.bridge_token)) throw new Error('Enter the pairing token shown by the Print Bridge computer.')
    if (normalized.bridge_transport === 'queue' && !clean(normalized.bridge_queue)) throw new Error('Enter the installed RAW printer queue name.')
    if (normalized.bridge_transport !== 'queue' && !clean(normalized.bridge_printer_ip)) throw new Error('Enter the printer IP used by the bridge computer.')
    return { normalized, connection, language }
  }

  throw new Error('Choose Direct Wi-Fi/LAN, PC/Mac Bridge, or Bluetooth Classic.')
}
