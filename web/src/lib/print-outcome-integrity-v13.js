import { showPrinterMessage } from './native-label-print.js'
import { normalizePhysicalPrintOutcome } from './print-outcome-model-v13.js'

export const PRINT_OUTCOME_INTEGRITY_VERSION = '4.6.12-print-outcome-integrity-v13'

function clean(value = '') {
  return String(value ?? '').trim()
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
