import { opsClient } from '@/api/opsClient'
import {
  clearLegacyPrinterDraft,
  readPrinterDeviceBinding,
  readPrinterProfilesSnapshot,
  savePrinterProfilesSnapshot,
  selectPrinterProfile,
} from '@/lib/label-printer-profile'
import {
  DEFAULT_LOCAL_PRINT_CONNECTOR_URL,
  friendlyLocalConnectorError,
  localConnectorHeaders,
  localConnectorTarget,
  webDirectProfile,
} from '@/lib/local-print-connector-v19'
import {
  effectiveConnectionType,
  normalizePrinterTransportProfile,
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
import { printStableLabelHtmlV18 } from '@/lib/stable-label-print-v18'

export const STABLE_LABEL_PRINT_VERSION = '4.6.17-stable-label-print-v19'
const CONNECTOR_TIMEOUT_MS = 12000
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

function stableCommand(html, profile) {
  const normalized = normalizePrinterTransportProfile(profile)
  const mediaSensor = clean(normalized.media_sensor || 'gap')
  return buildStableTsplLabelCommand(html, {
    commandLanguage: 'tspl',
    widthMm: Number(normalized.label_width_mm || 40),
    heightMm: Number(normalized.label_height_mm || 30),
    dpi: Number(normalized.dpi || 203),
    copies: countStableLabelCopies(html),
    mediaSensor,
    gapMm: Math.max(0, Number(normalized.gap_mm || 2)),
    gapOffsetMm: Number(normalized.gap_offset_mm || 0),
    blackMarkMm: Math.max(0, Number(normalized.black_mark_mm || 2)),
    blackMarkOffsetMm: Number(normalized.black_mark_offset_mm || 0),
    xOffsetMm: Number(normalized.x_offset_mm || 0),
    yOffsetMm: Number(normalized.y_offset_mm || 0),
  })
}

async function printThroughAutomaticConnector(html, profile) {
  const normalized = webDirectProfile(normalizePrinterTransportProfile(profile))
  if (clean(normalized.command_language).toLowerCase() !== 'tspl') {
    throw new Error('Stable Food Labels require a TSPL printer profile.')
  }
  if (!clean(normalized.ip_address)) throw new Error('Enter the printer’s own Wi-Fi/LAN IP address.')

  const stable = stableCommand(html, normalized)
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS)
  try {
    const response = await fetch(`${DEFAULT_LOCAL_PRINT_CONNECTOR_URL}/print`, {
      method: 'POST',
      headers: localConnectorHeaders(),
      body: JSON.stringify({
        ...localConnectorTarget(normalized),
        payloadBase64: asciiBase64(stable.command),
        timeoutMs: Math.max(1000, Number(normalized.connection_timeout_ms || 4000)),
      }),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Local Print Connector failed (${response.status}).`)

    const sizeContract = {
      version: STABLE_LABEL_PRINT_VERSION,
      source: 'stable-tspl-core-v16-auto-local-v19',
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
      signature: `${stable.widthMm}x${stable.heightMm}@${stable.dpi}:tspl-stable-v19`,
    }
    const detail = {
      jobName: extractJobName(html),
      copies: stable.copies,
      dpi: stable.dpi,
      route: 'Web Direct Wi-Fi/LAN · Automatic Local Connector',
      direct: true,
      render_mode: stable.mode,
      version: STABLE_LABEL_PRINT_VERSION,
      result: data,
      profile_id: normalized.id || '',
      profile_name: clean(normalized.profile_name || 'Food Label Printer'),
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
      `RAW TSPL sent · ${detail.profile_name} · Web Direct LAN · ${stable.widthMm}×${stable.heightMm} mm · ${stable.copies} copy.`,
      'success',
    )
    return detail
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Local Print Connector did not respond. Make sure it is installed and running on this computer.')
    throw friendlyLocalConnectorError(error)
  } finally {
    window.clearTimeout(timer)
  }
}

export async function printStableLabelHtmlV19(html, profileOverride = null) {
  if (!isPrintableLabel(html)) throw new Error('This is not a supported Food Label or Test Label document.')
  const profile = normalizePrinterTransportProfile(profileOverride || await resolvePrinterProfile())
  const connection = effectiveConnectionType(profile)
  if (connection === 'network' && !isNativeAndroidPrinterRuntime()) {
    return printThroughAutomaticConnector(html, profile)
  }
  return printStableLabelHtmlV18(html, profile)
}

export function installStableLabelPrintV19() {
  if (window.__chefopsStableLabelPrintV19Installed) return
  window.__chefopsStableLabelPrintV19Installed = true
  window.__chefopsStableLabelPrintVersion = STABLE_LABEL_PRINT_VERSION
  window.__chefopsPrintStableLabelHtml = printStableLabelHtmlV19

  const browserOpen = window.open.bind(window)
  window.open = function chefopsStableLabelWindowOpenV19(url = '', target = '', features = '') {
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
        void printStableLabelHtmlV19(buffer).catch((error) => {
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
