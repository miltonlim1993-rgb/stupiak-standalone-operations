function clean(value = '') {
  return String(value ?? '').trim()
}

function enabled(row = {}) {
  return row.enabled === true || ['true', 'yes', '1'].includes(clean(row.enabled).toLowerCase())
}

export function samplePhotosForGroup(samples = [], groupId = '') {
  const target = clean(groupId)
  if (!target) return []

  return (samples || [])
    .filter((row) => {
      if (!row || row.deleted_at || !enabled(row)) return false
      const type = clean(row.photo_type)
      return type === target || type === `checklist:${target}`
    })
    .sort((left, right) => Number(left.display_order || 0) - Number(right.display_order || 0))
}

export function firstSamplePhotoForGroup(samples = [], groupId = '') {
  return samplePhotosForGroup(samples, groupId)[0] || null
}
