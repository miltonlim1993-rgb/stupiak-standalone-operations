export function parseOutletIds(value) {
  const source = typeof value === 'object' && value !== null
    ? [value.outlet_id, value.outlet_ids]
    : [value]
  const result = []
  for (const entry of source) {
    if (Array.isArray(entry)) {
      result.push(...entry)
      continue
    }
    const raw = String(entry || '').trim()
    if (!raw) continue
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          result.push(...parsed)
          continue
        }
      } catch {
        // Fall through to comma parsing.
      }
    }
    result.push(...raw.split(',').map((item) => item.trim()).filter(Boolean))
  }
  return [...new Set(result.map(String).filter(Boolean))]
}

export function outletFilter(outletIds) {
  const ids = parseOutletIds(outletIds)
  if (!ids.length) return {}
  return { outlet_id: ids.length === 1 ? ids[0] : { $in: ids } }
}

export function serializeOutletIds(outletIds) {
  return parseOutletIds(outletIds).join(',')
}

export function outletLabel(outlet, fallback = '') {
  return outlet?.name || outlet?.code || outlet?.id || fallback
}
