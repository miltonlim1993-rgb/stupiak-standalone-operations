import { getActiveDataPackage } from '@/lib/data-package-store-v2'

const MIB = 1024 * 1024
const MINIMUM_RESERVE_BYTES = 16 * MIB
const LARGE_OBJECT_WARNING_BYTES = 100 * MIB

function number(value = 0) {
  const result = Number(value || 0)
  return Number.isFinite(result) && result > 0 ? result : 0
}

function objectRows(manifest = {}) {
  const rows = []
  for (const [name, info] of Object.entries(manifest.modules || {})) {
    if (!info?.hash) continue
    rows.push({
      kind: 'module',
      name,
      hash: String(info.hash).toLowerCase(),
      bytes: number(info.bytes),
      mime_type: 'application/json',
    })
  }
  for (const [name, info] of Object.entries(manifest.media?.files || {})) {
    if (!info?.hash) continue
    rows.push({
      kind: 'media',
      name,
      hash: String(info.hash).toLowerCase(),
      bytes: number(info.bytes),
      mime_type: String(info.mime_type || 'application/octet-stream'),
    })
  }
  return rows
}

function activeObjectHashes(active) {
  const hashes = new Set()
  for (const row of objectRows(active?.manifest || {})) hashes.add(`${row.kind}:${row.hash}`)
  return hashes
}

async function storageEstimate() {
  if (!navigator.storage?.estimate) {
    return { supported: false, quota: 0, usage: 0, available: 0, persisted: false }
  }

  let persisted = false
  try {
    persisted = Boolean(await navigator.storage.persist?.())
  } catch {}

  try {
    const estimate = await navigator.storage.estimate()
    const quota = number(estimate?.quota)
    const usage = number(estimate?.usage)
    return {
      supported: quota > 0,
      quota,
      usage,
      available: quota > 0 ? Math.max(0, quota - usage) : 0,
      persisted,
    }
  } catch {
    return { supported: false, quota: 0, usage: 0, available: 0, persisted }
  }
}

export async function estimateDataPackageStorage(manifest, outletId = '') {
  if (!manifest?.version) throw new Error('Data package manifest is missing.')

  const [active, storage] = await Promise.all([
    getActiveDataPackage(outletId),
    storageEstimate(),
  ])
  const existing = activeObjectHashes(active)
  const objects = objectRows(manifest)
  const missing = objects.filter((item) => !existing.has(`${item.kind}:${item.hash}`))
  const reused = objects.filter((item) => existing.has(`${item.kind}:${item.hash}`))
  const downloadBytes = missing.reduce((sum, item) => sum + item.bytes, 0)
  const reusedBytes = reused.reduce((sum, item) => sum + item.bytes, 0)
  const largestObject = missing.reduce((largest, item) => item.bytes > (largest?.bytes || 0) ? item : largest, null)
  const reserveBytes = Math.max(MINIMUM_RESERVE_BYTES, Math.ceil(downloadBytes * 0.15))
  const requiredAvailableBytes = downloadBytes + reserveBytes
  const canInstall = !storage.supported || storage.available >= requiredAvailableBytes

  return {
    outlet_id: String(outletId || manifest.outlet_id || '').trim() || 'global',
    installed_version: active?.manifest?.version || '',
    target_version: manifest.version,
    object_count: objects.length,
    download_object_count: missing.length,
    reused_object_count: reused.length,
    package_bytes: objects.reduce((sum, item) => sum + item.bytes, 0),
    download_bytes: downloadBytes,
    reused_bytes: reusedBytes,
    reserve_bytes: reserveBytes,
    required_available_bytes: requiredAvailableBytes,
    quota_bytes: storage.quota,
    usage_bytes: storage.usage,
    available_bytes: storage.available,
    storage_estimate_supported: storage.supported,
    persistent_storage_granted: storage.persisted,
    can_install: canInstall,
    largest_object: largestObject,
    large_object_warning: Boolean(largestObject?.bytes >= LARGE_OBJECT_WARNING_BYTES),
  }
}

export async function assertDataPackageStorageCapacity(manifest, outletId = '') {
  const plan = await estimateDataPackageStorage(manifest, outletId)
  if (plan.can_install) return plan

  const error = new Error('This device does not have enough free storage for the verified operations package. Free some space and retry; the current working release remains unchanged.')
  error.code = 'data_package_storage_insufficient'
  error.details = plan
  throw error
}
