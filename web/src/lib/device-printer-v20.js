export const DEVICE_PRINTER_VERSION = '4.6.22-device-printer-v24-standalone-service'
export const LOCAL_CONNECTOR_URL = 'http://127.0.0.1:8788'
export const LOCAL_CONNECTOR_INSTALLER = '/print-service/install-stupiaks-print-service.cmd'

export const STABLE_4BARCODE_MEDIA = Object.freeze({
  brand: '4BARCODE',
  model: '4B-2054K',
  connection_type: 'network',
  command_language: 'tspl',
  network_protocol: 'raw_tcp',
  port: 9100,
  label_width_mm: 40,
  label_height_mm: 30,
  dpi: 203,
  default_copies: 1,
  media_sensor: 'gap',
  gap_mm: 2,
  gap_offset_mm: 0,
  black_mark_mm: 2,
  black_mark_offset_mm: 0,
  print_speed_mm_s: 76,
  darkness: 8,
  x_offset_mm: 0,
  y_offset_mm: 0,
  connection_timeout_ms: 5000,
  retry_limit: 3,
  enabled: true,
})

function clean(value = '') {
  return String(value ?? '').trim()
}

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function key(outletId = '') {
  return `stupiaks_ops.web_printer_device.v20.${clean(outletId) || 'default'}`
}

function safeJson(value = '') {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function portValue(value = 9100) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 && number <= 65535 ? Math.round(number) : 9100
}

function routeValue(value = '') {
  return clean(value).toLowerCase() === 'queue' ? 'queue' : 'raw_tcp'
}

export function stablePrinterProfile(profile = {}) {
  const webTransport = routeValue(profile.web_transport || profile.webTransport)
  return {
    ...profile,
    ...STABLE_4BARCODE_MEDIA,
    id: clean(profile.id),
    outlet_id: clean(profile.outlet_id),
    purpose: 'food_label',
    profile_name: clean(profile.profile_name || 'Food Label Printer'),
    ip_address: clean(profile.ip_address),
    port: portValue(profile.port || STABLE_4BARCODE_MEDIA.port),
    web_transport: webTransport,
    web_queue: clean(profile.web_queue || profile.queue),
    is_default: profile.is_default !== false,
    station_mode: 'this_device',
  }
}

export function readWebPrinterDevice(outletId = '', fallback = {}) {
  const saved = safeJson(storage()?.getItem(key(outletId))) || {}
  return stablePrinterProfile({
    ...fallback,
    ...saved,
    outlet_id: clean(outletId || fallback.outlet_id),
    ip_address: clean(saved.ip_address || fallback.ip_address),
    port: portValue(saved.port || fallback.port || 9100),
    web_transport: routeValue(saved.web_transport || fallback.web_transport),
    web_queue: clean(saved.web_queue || fallback.web_queue),
    profile_name: clean(saved.profile_name || fallback.profile_name || 'Food Label Printer'),
  })
}

export function saveWebPrinterDevice(outletId = '', value = {}) {
  const next = readWebPrinterDevice(outletId, value)
  const record = {
    version: DEVICE_PRINTER_VERSION,
    outlet_id: clean(outletId),
    profile_name: next.profile_name,
    ip_address: next.ip_address,
    port: next.port,
    web_transport: next.web_transport,
    web_queue: next.web_queue,
    updated_at: new Date().toISOString(),
  }
  try { storage()?.setItem(key(outletId), JSON.stringify(record)) } catch {}
  return stablePrinterProfile(record)
}

export function clearWebPrinterDevice(outletId = '') {
  try { storage()?.removeItem(key(outletId)) } catch {}
}

function loopbackRequest(url, init = {}) {
  const options = {
    mode: 'cors',
    cache: 'no-store',
    credentials: 'omit',
    ...init,
  }
  try {
    return new Request(url, { ...options, targetAddressSpace: 'loopback' })
  } catch {
    return new Request(url, options)
  }
}

export async function fetchLocalConnector(pathname = '/health', init = {}) {
  const path = String(pathname || '/health').startsWith('/') ? pathname : `/${pathname}`
  return fetch(loopbackRequest(`${LOCAL_CONNECTOR_URL}${path}`, init))
}

export async function listLocalPrinterQueues() {
  const response = await fetchLocalConnector('/printers')
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.ok === false) throw new Error(data?.error || 'Installed Windows printers could not be loaded.')
  return Array.isArray(data?.printers) ? data.printers : []
}

export function chooseRecommendedQueue(queues = [], savedQueue = '') {
  const rows = Array.isArray(queues) ? queues.filter((row) => clean(row?.name)) : []
  const exact = rows.find((row) => clean(row.name).toLowerCase() === clean(savedQueue).toLowerCase())
  if (exact) return exact.name
  const kitchenLabel = rows.find((row) => /kitchen\s*label\s*printer/i.test(clean(row.name)))
  if (kitchenLabel) return kitchenLabel.name
  const kitchen = rows.find((row) => /kitchen/i.test(clean(row.name)))
  if (kitchen) return kitchen.name
  const label = rows.find((row) => /label|4barcode|4b-2054/i.test(`${clean(row.name)} ${clean(row.driver)}`))
  return label?.name || rows[0]?.name || ''
}

export async function loopbackPermissionState() {
  if (!navigator.permissions?.query) return 'unknown'
  for (const name of ['loopback-network', 'local-network']) {
    try {
      const result = await navigator.permissions.query({ name })
      if (result?.state) return result.state
    } catch {}
  }
  return 'unknown'
}

export async function describeConnectorFailure(error) {
  const message = clean(error?.message)
  const permission = await loopbackPermissionState()
  if (permission === 'denied') {
    return {
      code: 'loopback_permission_denied',
      title: 'Chrome blocked local printing',
      message: 'Allow Local network access for Stupiak’s Ops in the address-bar site controls, then press Check again.',
    }
  }
  if (error?.name === 'AbortError') {
    return {
      code: 'connector_timeout',
      title: 'Local Print Service did not respond',
      message: 'Install or repair the Stupiak Print Service on this computer, then press Check again.',
    }
  }
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) {
    return {
      code: 'connector_unreachable',
      title: 'Local Print Service is not running',
      message: 'This computer needs the one-time Stupiak Print Service installation. It enables both Windows Printer Queue and Kitchen Direct IP.',
    }
  }
  return {
    code: clean(error?.code || 'connector_failed'),
    title: 'Printer connection failed',
    message: message || 'The printer connection could not be completed.',
  }
}

export function localConnectorTarget(profile = {}) {
  const route = routeValue(profile.web_transport)
  if (route === 'queue') {
    return {
      mode: 'queue',
      queue: clean(profile.web_queue),
    }
  }
  return {
    mode: 'raw_tcp',
    host: clean(profile.ip_address),
    port: portValue(profile.port || 9100),
  }
}

export function webPrinterRouteLabel(profile = {}) {
  return routeValue(profile.web_transport) === 'queue'
    ? `Windows Queue · ${clean(profile.web_queue) || 'Not selected'}`
    : `Direct IP · ${clean(profile.ip_address) || 'Not set'}:${portValue(profile.port || 9100)}`
}
