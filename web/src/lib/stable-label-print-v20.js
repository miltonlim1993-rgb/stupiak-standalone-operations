import {
  describeConnectorFailure,
  fetchLocalConnector,
  localConnectorTarget,
  readWebPrinterDevice,
  saveWebPrinterDevice,
  stablePrinterProfile,
} from '@/lib/device-printer-v20'
import {
  asciiBase64,
  buildStableTsplLabelCommand,
  countStableLabelCopies,
} from '@/lib/stable-tspl-label-v16'
import { showPrinterMessage } from '@/lib/native-label-print'

export const STABLE_WEB_LABEL_PRINT_VERSION = '4.6.18-stable-web-label-print-v20'
const CONNECTOR_TIMEOUT_MS = 12000

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

function stableCommand(html, profile) {
  const fixed = stablePrinterProfile(profile)
  return buildStableTsplLabelCommand(html, {
    commandLanguage: 'tspl',
    widthMm: fixed.label_width_mm,
    heightMm: fixed.label_height_mm,
    dpi: fixed.dpi,
    copies: countStableLabelCopies(html),
    mediaSensor: fixed.media_sensor,
    gapMm: fixed.gap_mm,
    gapOffsetMm: fixed.gap_offset_mm,
    blackMarkMm: fixed.black_mark_mm,
    blackMarkOffsetMm: fixed.black_mark_offset_mm,
    xOffsetMm: fixed.x_offset_mm,
    yOffsetMm: fixed.y_offset_mm,
  })
}

async function sendWebStableLabel(html, requestedProfile = null) {
  const outletId = currentOutletId()
  const profile = saveWebPrinterDevice(
    outletId,
    requestedProfile || readWebPrinterDevice(outletId),
  )
  if (!clean(profile.ip_address)) {
    const error = new Error('Set the printer IP for this computer before printing.')
    error.code = 'web_printer_ip_missing'
    throw error
  }

  const stable = stableCommand(html, profile)
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS)
  try {
    const response = await fetchLocalConnector('/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...localConnectorTarget(profile),
        payloadBase64: asciiBase64(stable.command),
        timeoutMs: profile.connection_timeout_ms,
      }),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || data?.ok === false) {
      const error = new Error(data?.error || `Local print service failed (${response.status}).`)
      error.code = data?.code || 'connector_print_failed'
      throw error
    }

    const detail = {
      jobName: extractJobName(html),
      copies: stable.copies,
      dpi: stable.dpi,
      route: 'Web device-local RAW TCP',
      direct: true,
      render_mode: stable.mode,
      version: STABLE_WEB_LABEL_PRINT_VERSION,
      result: data,
      profile_name: profile.profile_name,
      width_mm: stable.widthMm,
      height_mm: stable.heightMm,
      fit_report: stable.report,
      payload_bytes: stable.command.length,
      device_local: true,
      size_contract: {
        version: STABLE_WEB_LABEL_PRINT_VERSION,
        source: 'stable-tspl-core-v16-web-device-v20',
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
        signature: `${stable.widthMm}x${stable.heightMm}@${stable.dpi}:stable-web-v20`,
      },
    }
    window.__chefopsLastCreatedLabelSizeContract = detail.size_contract
    window.__chefopsLastCreatedLabelSourceMatched = true
    window.__chefopsLastLabelPrintOutcome = detail
    window.__chefopsLastStableTsplPayload = stable.command
    window.dispatchEvent(new CustomEvent('chefops:native-print-started', { detail }))
    showPrinterMessage(
      `RAW TSPL sent · ${profile.ip_address}:${profile.port} · fixed 40×30 mm · ${stable.copies} copy.`,
      'success',
    )
    return detail
  } catch (error) {
    const described = await describeConnectorFailure(error)
    const next = new Error(`${described.title}. ${described.message}`)
    next.code = described.code
    throw next
  } finally {
    window.clearTimeout(timer)
  }
}

export async function printStableLabelHtmlV20(html, profileOverride = null) {
  if (!isPrintableLabel(html)) throw new Error('This is not a supported Food Label or Test Label document.')
  return sendWebStableLabel(html, profileOverride)
}

export function installStableLabelPrintV20() {
  if (window.__chefopsStableLabelPrintV20Installed) return
  window.__chefopsStableLabelPrintV20Installed = true
  window.__chefopsStableLabelPrintVersion = STABLE_WEB_LABEL_PRINT_VERSION
  window.__chefopsPrintStableLabelHtml = printStableLabelHtmlV20

  const browserOpen = window.open.bind(window)
  window.open = function chefopsStableLabelWindowOpenV20(url = '', target = '', features = '') {
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
        void printStableLabelHtmlV20(buffer).catch((error) => {
          printing = false
          const message = error?.message || 'Stable RAW TSPL printing failed.'
          console.error('Stable Web RAW TSPL print failed', error)
          showPrinterMessage(message)
          window.dispatchEvent(new CustomEvent('chefops:native-print-error', {
            detail: {
              message,
              code: error?.code || 'stable_web_tspl_print_failed',
              version: STABLE_WEB_LABEL_PRINT_VERSION,
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
