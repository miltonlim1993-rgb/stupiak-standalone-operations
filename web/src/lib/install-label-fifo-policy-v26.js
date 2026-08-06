import { opsClient } from '@/api/opsClient'
import { applyHierarchyToCatalog, LABEL_FIFO_POLICY_VERSION } from '@/lib/label-fifo-policy-v26'

let installed = false

export function installLabelFifoPolicyV26() {
  if (installed) return
  installed = true
  const originalCatalog = opsClient.labels.catalog.bind(opsClient.labels)
  opsClient.labels.catalog = async (...args) => applyHierarchyToCatalog(await originalCatalog(...args))
  window.__chefopsLabelFifoPolicy = {
    version: LABEL_FIFO_POLICY_VERSION,
    first_hand: ['Prepare', 'Freeze', 'Received'],
    second_hand: ['Open'],
    third_hand: ['Refill', 'Cooked'],
    first_second_reprint_locked: true,
  }
}
