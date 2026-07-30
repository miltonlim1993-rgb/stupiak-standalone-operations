import { opsClient } from '@/api/opsClient'

const REFRESHED_OUTLETS = new Set()
let installed = false

export function installTaskTemplateRefreshV6() {
  if (installed) return
  installed = true

  const original = opsClient.tasks.workflowBootstrap.bind(opsClient.tasks)
  opsClient.tasks.workflowBootstrap = async ({ outletId, date, refresh = false } = {}) => {
    const outletKey = String(outletId || '').trim()
    const firstLoadForOutlet = Boolean(outletKey) && !REFRESHED_OUTLETS.has(outletKey)
    const result = await original({
      outletId,
      date,
      refresh: Boolean(refresh || firstLoadForOutlet),
    })
    if (outletKey) REFRESHED_OUTLETS.add(outletKey)
    return result
  }
}
