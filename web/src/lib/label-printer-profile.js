const PROFILE_SCHEMA = 'stupiaks-label-printer-profile-v2'
const DEVICE_ID_KEY = 'stupiaks_ops.label_printer.device_id'

export const DEFAULT_PRINTER_LAYOUT = Object.freeze({
  orientation: 'auto',
  padding_top_mm: 1.2,
  padding_right_mm: 1.7,
  padding_bottom_mm: 0.75,
  padding_left_mm: 1.7,
})

function localStorageSafe() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function numberValue(value, fallback, minimum = 0, maximum = 1000) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

function clean(value = '') {
  return String(value ?? '').trim()
}

function bool(value) {
  return value === true || ['true', 'yes', '1'].includes(clean(value).toLowerCase())
}

function boolDefault(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : bool(value)
}

function safeJson(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function orientationValue(value) {
  const orientation = clean(value).toLowerCase()
  return ['auto', 'portrait', 'landscape'].includes(orientation) ? orientation : 'auto'
}

export function parsePrinterProfileNotes(value) {
  const raw = clean(value)
  const parsed = safeJson(raw)

  if (!parsed) {
    return {
      schema: PROFILE_SCHEMA,
      user_notes: raw,
      layout: { ...DEFAULT_PRINTER_LAYOUT },
    }
  }

  const layout = parsed.print_layout || parsed.layout || {}
  return {
    ...parsed,
    schema: PROFILE_SCHEMA,
    user_notes: clean(parsed.user_notes ?? parsed.notes ?? ''),
    layout: {
      orientation: orientationValue(layout.orientation),
      padding_top_mm: numberValue(layout.padding_top_mm, DEFAULT_PRINTER_LAYOUT.padding_top_mm, 0, 20),
      padding_right_mm: numberValue(layout.padding_right_mm, DEFAULT_PRINTER_LAYOUT.padding_right_mm, 0, 20),
      padding_bottom_mm: numberValue(layout.padding_bottom_mm, DEFAULT_PRINTER_LAYOUT.padding_bottom_mm, 0, 20),
      padding_left_mm: numberValue(layout.padding_left_mm, DEFAULT_PRINTER_LAYOUT.padding_left_mm, 0, 20),
    },
  }
}

export function normalizePrinterProfile(profile = {}, outletId = '') {
  const meta = parsePrinterProfileNotes(profile.notes)
  return {
    ...profile,
    id: clean(profile.id),
    outlet_id: clean(profile.outlet_id || outletId),
    purpose: clean(profile.purpose || 'food_label'),
    profile_name: clean(profile.profile_name || 'Food Label Printer'),
    brand: clean(profile.brand),
    model: clean(profile.model),
    connection_type: clean(profile.connection_type || 'system_print').toLowerCase(),
    command_language: clean(profile.command_language || 'browser').toLowerCase(),
    ip_address: clean(profile.ip_address),
    port: numberValue(profile.port, 9100, 1, 65535),
    bluetooth_mode: clean(profile.bluetooth_mode || 'classic').toLowerCase(),
    bluetooth_device_name: clean(profile.bluetooth_device_name),
    bluetooth_device_id: clean(profile.bluetooth_device_id),
    label_width_mm: numberValue(profile.label_width_mm, 40, 1, 500),
    label_height_mm: numberValue(profile.label_height_mm, 30, 1, 500),
    dpi: numberValue(profile.dpi, 203, 72, 1200),
    default_copies: numberValue(profile.default_copies, 1, 1, 100),
    retry_limit: numberValue(profile.retry_limit, 3, 0, 20),
    auto_print: boolDefault(profile.auto_print, false),
    standby_enabled: boolDefault(profile.standby_enabled, false),
    auto_reconnect: boolDefault(profile.auto_reconnect, true),
    queue_when_offline: boolDefault(profile.queue_when_offline, true),
    enabled: boolDefault(profile.enabled, true),
    is_default: boolDefault(profile.is_default, false),
    station_mode: clean(profile.station_mode || 'this_device'),
    station_device_name: clean(profile.station_device_name),
    orientation: orientationValue(profile.orientation ?? meta.layout.orientation),
    padding_top_mm: numberValue(profile.padding_top_mm, meta.layout.padding_top_mm, 0, 20),
    padding_right_mm: numberValue(profile.padding_right_mm, meta.layout.padding_right_mm, 0, 20),
    padding_bottom_mm: numberValue(profile.padding_bottom_mm, meta.layout.padding_bottom_mm, 0, 20),
    padding_left_mm: numberValue(profile.padding_left_mm, meta.layout.padding_left_mm, 0, 20),
    user_notes: clean(profile.user_notes ?? meta.user_notes),
  }
}

export function encodePrinterProfileNotes(profile = {}) {
  const existing = parsePrinterProfileNotes(profile.notes)
  const {
    layout: _legacyLayout,
    print_layout: _existingPrintLayout,
    notes: _legacyNotes,
    ...preserved
  } = existing

  return JSON.stringify({
    ...preserved,
    schema: PROFILE_SCHEMA,
    user_notes: clean(profile.user_notes),
    print_layout: {
      orientation: orientationValue(profile.orientation),
      padding_top_mm: numberValue(profile.padding_top_mm, DEFAULT_PRINTER_LAYOUT.padding_top_mm, 0, 20),
      padding_right_mm: numberValue(profile.padding_right_mm, DEFAULT_PRINTER_LAYOUT.padding_right_mm, 0, 20),
      padding_bottom_mm: numberValue(profile.padding_bottom_mm, DEFAULT_PRINTER_LAYOUT.padding_bottom_mm, 0, 20),
      padding_left_mm: numberValue(profile.padding_left_mm, DEFAULT_PRINTER_LAYOUT.padding_left_mm, 0, 20),
    },
  })
}

function deviceBindingKey(outletId) {
  return `stupiaks_ops.label_printer.device.${clean(outletId) || 'default'}`
}

function profilesSnapshotKey(outletId) {
  return `stupiaks_ops.label_printer.profiles.${clean(outletId) || 'default'}`
}

function randomDeviceId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `device-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function getOrCreatePrinterDeviceId() {
  const storage = localStorageSafe()
  if (!storage) return 'browser-session'
  const existing = clean(storage.getItem(DEVICE_ID_KEY))
  if (existing) return existing
  const id = randomDeviceId()
  try { storage.setItem(DEVICE_ID_KEY, id) } catch {}
  return id
}

export function readPrinterDeviceBinding(outletId) {
  const storage = localStorageSafe()
  const deviceId = getOrCreatePrinterDeviceId()
  if (!storage) return { device_id: deviceId, selected_profile_id: '', station_name: '' }

  const parsed = safeJson(storage.getItem(deviceBindingKey(outletId))) || {}
  return {
    device_id: clean(parsed.device_id || deviceId),
    selected_profile_id: clean(parsed.selected_profile_id),
    station_name: clean(parsed.station_name),
    updated_at: clean(parsed.updated_at),
  }
}

export function savePrinterDeviceBinding(outletId, profileId, stationName = '') {
  const storage = localStorageSafe()
  const binding = {
    device_id: getOrCreatePrinterDeviceId(),
    selected_profile_id: clean(profileId),
    station_name: clean(stationName),
    updated_at: new Date().toISOString(),
  }
  try { storage?.setItem(deviceBindingKey(outletId), JSON.stringify(binding)) } catch {}
  return binding
}

export function clearPrinterDeviceBinding(outletId) {
  const storage = localStorageSafe()
  try { storage?.removeItem(deviceBindingKey(outletId)) } catch {}
  return readPrinterDeviceBinding(outletId)
}

export function savePrinterProfilesSnapshot(outletId, profiles = []) {
  const storage = localStorageSafe()
  if (!storage || !clean(outletId)) return
  const normalized = (profiles || []).map((profile) => normalizePrinterProfile(profile, outletId))
  try {
    storage.setItem(profilesSnapshotKey(outletId), JSON.stringify({
      saved_at: new Date().toISOString(),
      profiles: normalized,
    }))
  } catch {}
}

export function readPrinterProfilesSnapshot(outletId) {
  const storage = localStorageSafe()
  if (!storage) return []
  const parsed = safeJson(storage.getItem(profilesSnapshotKey(outletId)))
  return Array.isArray(parsed?.profiles)
    ? parsed.profiles.map((profile) => normalizePrinterProfile(profile, outletId))
    : []
}

export function clearLegacyPrinterDraft(outletId) {
  const storage = localStorageSafe()
  try {
    storage?.removeItem(`stupiaks_ops.label_printer_draft.${clean(outletId) || 'default'}`)
  } catch {}
}

export function selectPrinterProfile(profiles = [], outletId = '', selectedProfileId = '') {
  const targetOutletId = clean(outletId)
  const enabled = (profiles || [])
    .map((profile) => normalizePrinterProfile(profile, targetOutletId))
    .filter((profile) => (
      profile.enabled
      && !profile.deleted_at
      && (!targetOutletId || profile.outlet_id === targetOutletId)
    ))

  if (!enabled.length) return null

  const requestedId = clean(selectedProfileId || readPrinterDeviceBinding(targetOutletId).selected_profile_id)
  return enabled.find((profile) => profile.id === requestedId)
    || enabled.find((profile) => profile.is_default)
    || enabled[0]
}

export function extractLabelDimensions(html) {
  const match = String(html || '').match(
    /@page\s*\{[^}]*size\s*:\s*([0-9.]+)mm\s+([0-9.]+)mm/i,
  )
  return {
    widthMm: numberValue(match?.[1], 40, 1, 500),
    heightMm: numberValue(match?.[2], 30, 1, 500),
  }
}

export function resolvePrinterLayout(profile = {}, sourceDimensions = {}) {
  const normalized = normalizePrinterProfile(profile)
  let widthMm = numberValue(normalized.label_width_mm, sourceDimensions.widthMm || 40, 1, 500)
  let heightMm = numberValue(normalized.label_height_mm, sourceDimensions.heightMm || 30, 1, 500)
  const orientationMode = orientationValue(normalized.orientation)

  if (orientationMode === 'portrait' && widthMm > heightMm) {
    ;[widthMm, heightMm] = [heightMm, widthMm]
  }
  if (orientationMode === 'landscape' && widthMm < heightMm) {
    ;[widthMm, heightMm] = [heightMm, widthMm]
  }

  return {
    orientation_mode: orientationMode,
    orientation: widthMm > heightMm ? 'landscape' : 'portrait',
    width_mm: widthMm,
    height_mm: heightMm,
    padding_top_mm: numberValue(normalized.padding_top_mm, DEFAULT_PRINTER_LAYOUT.padding_top_mm, 0, 20),
    padding_right_mm: numberValue(normalized.padding_right_mm, DEFAULT_PRINTER_LAYOUT.padding_right_mm, 0, 20),
    padding_bottom_mm: numberValue(normalized.padding_bottom_mm, DEFAULT_PRINTER_LAYOUT.padding_bottom_mm, 0, 20),
    padding_left_mm: numberValue(normalized.padding_left_mm, DEFAULT_PRINTER_LAYOUT.padding_left_mm, 0, 20),
  }
}

function layoutStyle(layout) {
  const padding = [
    layout.padding_top_mm,
    layout.padding_right_mm,
    layout.padding_bottom_mm,
    layout.padding_left_mm,
  ].map((value) => `${value}mm`).join(' ')

  return `<style id="chefops-printer-layout">
@page{size:${layout.width_mm}mm ${layout.height_mm}mm!important;margin:0!important}
html,body{margin:0!important;width:${layout.width_mm}mm!important;min-width:${layout.width_mm}mm!important;max-width:${layout.width_mm}mm!important}
body{min-height:${layout.height_mm}mm!important}
.label{width:${layout.width_mm}mm!important;height:${layout.height_mm}mm!important;padding:${padding}!important}
</style>`
}

export function applyPrinterLayoutToHtml(html, profile = {}) {
  const source = String(html || '')
  const layout = resolvePrinterLayout(profile, extractLabelDimensions(source))
  const withoutPrevious = source.replace(
    /<style\s+id=["']chefops-printer-layout["'][^>]*>[\s\S]*?<\/style>/gi,
    '',
  )
  const style = layoutStyle(layout)
  const output = withoutPrevious.includes('</head>')
    ? withoutPrevious.replace('</head>', `${style}</head>`)
    : `${style}${withoutPrevious}`

  return { html: output, layout }
}

export function formatPrinterLayoutOutcome(layout = {}) {
  const orientation = clean(layout.orientation || 'portrait')
  const padding = [
    layout.padding_top_mm,
    layout.padding_right_mm,
    layout.padding_bottom_mm,
    layout.padding_left_mm,
  ].join('/')
  return `${orientation[0]?.toUpperCase() || ''}${orientation.slice(1)} · ${layout.width_mm}×${layout.height_mm} mm · padding ${padding} mm`
}
