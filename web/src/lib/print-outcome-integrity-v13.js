import { showPrinterMessage } from './native-label-print.js'

export const PRINT_OUTCOME_INTEGRITY_VERSION = '4.6.12-print-outcome-integrity-v13'

function clean(value = '') {
  return String(value ?? '').trim()
}

function routeFrom(detail = {}) {
  return clean(detail.route || detail.result?.connectionType || 'system_print').toLowerCase()
}

export function normalizePhysicalPrintOutcome(detail = {}) {
  const result = detail.result && typeof detail.result === 'object' ? detail.result : {}
  const route = routeFrom(detail)
  const protocol = clean(result.networkProtocol || result.mode || '').toLowerCase()
  const bridgeTransport = clean(result.bridgeTransport || result.mode || '').toLowerCase()

  let outcomeState = 'job_sent'
  let outcomeLabel = 'Print job sent'
  let explanation = 'The transport accepted the job, but the physical label has not been verified.'

  if (result.dialog || route === 'system_print') {
    outcomeState = 'dialog_opened'
    outcomeLabel = 'System print dialog opened'
    explanation = 'Select the printer and complete the system print dialog. Opening the dialog is not a completed print.'
  } else if (route === 'driver_bridge' && (bridgeTransport === 'queue' || result.queue)) {
    outcomeState = 'queue_accepted'
    outcomeLabel = 'Computer print queue accepted the job'
    explanation = 'The Windows/macOS queue accepted the job, but the printer has not confirmed the physical label.'
  } else if (protocol === 'lpr' || bridgeTransport === 'lpr') {
    outcomeState = 'printer_job_acknowledged'
    outcomeLabel = 'LPR printer accepted the job'
    explanation = 'The LPR endpoint acknowledged the job. Check the physical label for size, direction and feed accuracy.'
  } else if (route === 'bluetooth') {
    outcomeState = 'bluetooth_data_sent'
    outcomeLabel = 'Bluetooth print data sent'
    explanation = 'The paired printer connection accepted the bytes. Check the physical label before marking the printer profile as accepted.'
  } else if (route === 'network') {
    outcomeState = 'raw_tcp_data_sent'
    outcomeLabel = 'Raw TCP print data sent'
    explanation = 'The socket accepted the bytes. Raw TCP does not prove that the printer fed and printed the label correctly.'
  } else if (route === 'driver_bridge') {
    outcomeState = 'bridge_data_sent'
    outcomeLabel = 'Print Bridge sent the job'
    explanation = 'The bridge accepted and forwarded the job. Check the physical label before accepting this printer profile.'
  }

  const normalizedResult = {
    ...result,
    printed: false,
    jobAccepted: outcomeState !== 'dialog_opened',
    physicalVerified: false,
    outcomeState,
  }

  return {
    ...detail,
    route,
    result: normalizedResult,
    outcome_state: outcomeState,
    outcome_label: outcomeLabel,
    outcome_explanation: explanation,
    transport_accepted: outcomeState !== 'dialog_opened',
    physical_verified: false,
  }
}

function outcomeMessage(detail) {
  const printer = clean(detail.result?.printer || detail.profile_name || 'Selected printer')
  const copies = Math.max(1, Number(detail.copies || detail.result?.copies || 1))
  return `${detail.outcome_label} · ${printer} · ${copies} ${copies === 1 ? 'copy' : 'copies'}. ${detail.outcome_explanation}`
}

export function installPrintOutcomeIntegrityV13() {
  if (typeof window === 'undefined' || window.__chefopsPrintOutcomeIntegrityV13) return
  window.__chefopsPrintOutcomeIntegrityV13 = true

  window.addEventListener('chefops:native-print-started', (event) => {
    const current = event.detail && typeof event.detail === 'object' ? event.detail : {}
    const normalized = normalizePhysicalPrintOutcome(current)
    Object.assign(current, normalized)
    window.__chefopsLastLabelPrintOutcome = current
    showPrinterMessage(
      outcomeMessage(current),
      current.outcome_state === 'dialog_opened' ? 'info' : 'success',
    )
    window.dispatchEvent(new CustomEvent('chefops:print-outcome-classified', { detail: current }))
  })
}
