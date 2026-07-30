export const LOCAL_PRINT_CONNECTOR_VERSION = '4.6.17-local-print-connector-v19'
export const DEFAULT_LOCAL_PRINT_CONNECTOR_URL = 'http://127.0.0.1:8788'

function clean(value = '') {
  return String(value ?? '').trim()
}

export function normalizeLocalConnectorUrl(value = '') {
  const raw = clean(value).replace(/\/+$/, '')
  if (!raw) return DEFAULT_LOCAL_PRINT_CONNECTOR_URL
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(withProtocol)
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
      return DEFAULT_LOCAL_PRINT_CONNECTOR_URL
    }
    return `${url.protocol}//${url.host}`
  } catch {
    return DEFAULT_LOCAL_PRINT_CONNECTOR_URL
  }
}

export function isAutomaticLocalConnectorUrl(value = '') {
  const normalized = normalizeLocalConnectorUrl(value)
  try {
    const url = new URL(normalized)
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
      && Number(url.port || 80) === 8788
  } catch {
    return false
  }
}

export function webDirectProfile(profile = {}) {
  return {
    ...profile,
    bridge_url: DEFAULT_LOCAL_PRINT_CONNECTOR_URL,
    bridge_token: '',
    bridge_transport: profile.network_protocol === 'lpr' ? 'lpr' : 'raw_tcp',
    bridge_printer_ip: clean(profile.ip_address),
    bridge_printer_port: Number(profile.port || (profile.network_protocol === 'lpr' ? 515 : 9100)),
    bridge_lpr_queue: clean(profile.lpr_queue || 'lp'),
  }
}

export function localConnectorHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...extra,
  }
}

export function localConnectorTarget(profile = {}) {
  const protocol = clean(profile.network_protocol || 'raw_tcp').toLowerCase()
  return protocol === 'lpr'
    ? {
        mode: 'lpr',
        host: clean(profile.ip_address),
        port: Number(profile.port || 515),
        queue: clean(profile.lpr_queue || 'lp'),
      }
    : {
        mode: 'raw_tcp',
        host: clean(profile.ip_address),
        port: Number(profile.port || 9100),
      }
}

export function friendlyLocalConnectorError(error) {
  const message = clean(error?.message)
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) {
    return new Error('Local Print Connector is not installed or running on this computer. Install it once, then Web Direct Wi-Fi/LAN works without a pairing token.')
  }
  return error instanceof Error ? error : new Error(message || 'Local Print Connector request failed.')
}
