import { showPrinterMessage } from './native-label-print.js'
import { normalizePhysicalPrintOutcome } from './print-outcome-model-v13.js'

export const PRINT_OUTCOME_INTEGRITY_VERSION = '4.6.12-print-outcome-integrity-v13-size-contract-v14'

function clean(value = '') {
  return String(value ?? '').trim()
}

function almostEqual(left, right, tolerance = 0.01) {
  return Math.abs(Number(left) - Number(right)) <= tolerance
}

function attachSizeContract(detail) {
  const created = window.__chefopsLastCreatedLabelSizeContract
  const layout = detail.layout || {}
  if (!created) return { ...detail, size_contract_match: null }

  const widthMatched = almostEqual(created.physical_width_mm, layout.width_mm)
  const heightMatched = almostEqual(created.physical_height_mm, layout.height_mm)
  const matched = widthMatched && heightMatched
  return {
    ...detail,
    created_size_contract: created,
    size_contract_match: matched,
    size_contract_state: matched ? 'matched' : 'mismatch',
  }
}

function outcomeMessage(detail) {
  const printer = clean(detail.result?.printer || detail.profile_name || 'Selected printer')
  const copies = Math.max(1, Number(detail.copies || detail.result?.copies || 1))
  const contract = detail.created_size_contract
  const size = contract
    ? ` Canvas ${contract.created_canvas_width_mm.toFixed(1)}×${contract.created_canvas_height_mm.toFixed(1)} mm = media ${detail.layout?.width_mm}×${detail.layout?.height_mm} mm · ${contract.raster_width_dots}×${contract.raster_height_dots} dots.`
    : ''
  return `${detail.outcome_label} · ${printer} · ${copies} ${copies === 1 ? 'copy' : 'copies'}.${size} ${detail.outcome_explanation}`
}

export function installPrintOutcomeIntegrityV13() {
  if (typeof window === 'undefined' || window.__chefopsPrintOutcomeIntegrityV13) return
  window.__chefopsPrintOutcomeIntegrityV13 = true

  window.addEventListener('chefops:native-print-started', (event) => {
    const current = event.detail && typeof event.detail === 'object' ? event.detail : {}
    const normalized = attachSizeContract(normalizePhysicalPrintOutcome(current))
    Object.assign(current, normalized)

    if (current.size_contract_match === false) {
      current.outcome_state = 'size_contract_mismatch'
      current.outcome_label = 'Label size mismatch blocked from acceptance'
      current.physical_verified = false
      current.result.physicalVerified = false
      current.outcome_explanation = 'The created label canvas does not match the final printer media. Do not accept this printer profile until both sizes match.'
    }

    window.__chefopsLastLabelPrintOutcome = current
    showPrinterMessage(
      outcomeMessage(current),
      current.size_contract_match === false
        ? 'error'
        : current.outcome_state === 'dialog_opened'
          ? 'info'
          : 'success',
    )
    window.dispatchEvent(new CustomEvent('chefops:print-outcome-classified', { detail: current }))
  })
}
