import {
  cleanupUnusedPackageObjects,
  getActiveDataPackage,
  getActivePackageMediaUrl,
  getActivePackageModule,
  rollbackLocalDataPackage,
  stageAndActivateDataPackage,
} from '@/lib/data-package-store-v2'

const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')
const STATUS_KEY = 'stupiaks.ops.data-package-v2.status'

let installPromise = null

function clean(value = '') {
  return String(value || '').trim()
}

function outletKey(value = '') {
  return clean(value) || 'global'
}

function readStatus() {
  try { return JSON.parse(localStorage.getItem(STATUS_KEY) || '{}') } catch { return {} }
}

function writeStatus(patch = {}) {
  const next = { ...readStatus(), ...patch }
  localStorage.setItem(STATUS_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent('chefops:data-package-v2-status', { detail: next }))
  return next
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {})
  const init = {
    method: options.method || 'GET',
    credentials: 'include',
    cache: options.cache || 'no-store',
    headers,
  }
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${API_BASE_URL}${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Data package request failed (${response.status})`)
    error.status = response.status
    error.code = data.code || ''
    error.details = data.details
    throw error
  }
  return data
}

function manifestPath(outletId = '') {
  const params = new URLSearchParams()
  if (clean(outletId)) params.set('outlet_id', clean(outletId))
  params.set('_', String(Date.now()))
  return `/api/app/v4/data-package/manifest?${params}`
}

function absolutePackagePath(path = '') {
  const value = clean(path)
  if (/^https?:\/\//i.test(value)) return value
  return `${API_BASE_URL}${value.startsWith('/') ? value : `/${value}`}`
}

export function getDataPackageV2Status() {
  return readStatus()
}

export async function getInstalledDataPackage(outletId = '') {
  return getActiveDataPackage(outletId)
}

export async function checkDataPackageV2Update(outletId = '') {
  const [active, remote] = await Promise.all([
    getActiveDataPackage(outletId),
    api(manifestPath(outletId)),
  ])
  return {
    outlet_id: outletKey(outletId),
    installed_version: active?.manifest?.version || '',
    available_version: remote?.version || '',
    update_available: Boolean(remote?.version && remote.version !== active?.manifest?.version),
    installed: active,
    manifest: remote,
  }
}

export async function installLatestDataPackageV2({
  outletId = '',
  force = false,
  onProgress = () => {},
} = {}) {
  if (installPromise && !force) return installPromise

  const run = (async () => {
    const active = await getActiveDataPackage(outletId)
    writeStatus({
      state: 'checking',
      outlet_id: outletKey(outletId),
      installed_version: active?.manifest?.version || '',
      error: '',
      checked_at: new Date().toISOString(),
    })

    const manifest = await api(manifestPath(outletId))
    if (!force && active?.manifest?.version === manifest.version) {
      const ready = writeStatus({
        state: 'ready',
        outlet_id: outletKey(outletId),
        installed_version: manifest.version,
        available_version: manifest.version,
        total_bytes: manifest.total_bytes || 0,
        checked_at: new Date().toISOString(),
      })
      onProgress({ state: 'ready', reusedRelease: true, manifest })
      return { manifest, reusedRelease: true, status: ready }
    }

    writeStatus({
      state: 'downloading',
      outlet_id: outletKey(outletId),
      installed_version: active?.manifest?.version || '',
      available_version: manifest.version,
      total_bytes: manifest.total_bytes || 0,
      completed_bytes: 0,
      completed_objects: 0,
    })

    await stageAndActivateDataPackage({
      manifest,
      outletId,
      fetcher: (path) => fetch(absolutePackagePath(path), {
        credentials: 'include',
        cache: 'no-store',
      }),
      onProgress(progress) {
        writeStatus({
          state: progress.state,
          outlet_id: outletKey(outletId),
          installed_version: progress.state === 'ready' ? manifest.version : active?.manifest?.version || '',
          available_version: manifest.version,
          total_bytes: progress.totalBytes || manifest.total_bytes || 0,
          completed_bytes: progress.completedBytes || 0,
          completed_objects: progress.completedObjects || 0,
          total_objects: progress.totalObjects || 0,
          current_object: progress.item?.name || '',
          current_kind: progress.item?.kind || '',
          reused_object: Boolean(progress.reused),
          error: '',
        })
        onProgress(progress)
      },
    })

    const ready = writeStatus({
      state: 'ready',
      outlet_id: outletKey(outletId),
      installed_version: manifest.version,
      available_version: manifest.version,
      total_bytes: manifest.total_bytes || 0,
      installed_at: new Date().toISOString(),
      error: '',
    })

    cleanupUnusedPackageObjects({ keepReleasesPerOutlet: 2 }).catch(() => undefined)
    return { manifest, reusedRelease: false, status: ready }
  })().catch((error) => {
    writeStatus({
      state: 'error',
      outlet_id: outletKey(outletId),
      error: error?.message || 'Unable to install operations data package',
      failed_at: new Date().toISOString(),
    })
    throw error
  })

  installPromise = run
  try { return await run } finally { if (installPromise === run) installPromise = null }
}

export async function getDataPackageV2Module(name, outletId = '') {
  const module = await getActivePackageModule(name, outletId)
  if (!module) return null
  return module?.data !== undefined ? module.data : module
}

export async function getDataPackageV2MediaUrl(mediaId, outletId = '') {
  return getActivePackageMediaUrl(mediaId, outletId)
}

export async function rollbackInstalledDataPackageV2(outletId = '') {
  const manifest = await rollbackLocalDataPackage(outletId)
  writeStatus({
    state: 'ready',
    outlet_id: outletKey(outletId),
    installed_version: manifest.version,
    rolled_back_at: new Date().toISOString(),
    error: '',
  })
  return manifest
}

export const dataPackageV2Admin = {
  status(outletId = '') {
    const params = new URLSearchParams()
    if (clean(outletId)) params.set('outlet_id', clean(outletId))
    return api(`/api/app/v4/data-package/status?${params}`)
  },
  preview(outletId = '') {
    return api('/api/app/v4/data-package/preview', { method: 'POST', body: { outlet_id: clean(outletId) } })
  },
  publish({ outletId = '', expectedVersion = '', allowUnpackedMedia = false } = {}) {
    return api('/api/app/v4/data-package/publish', {
      method: 'POST',
      body: {
        outlet_id: clean(outletId),
        expected_version: clean(expectedVersion),
        allow_unpacked_media: Boolean(allowUnpackedMedia),
      },
    })
  },
  releases(outletId = '') {
    const params = new URLSearchParams()
    if (clean(outletId)) params.set('outlet_id', clean(outletId))
    return api(`/api/app/v4/data-package/releases?${params}`)
  },
  rollback({ outletId = '', version = '' } = {}) {
    return api('/api/app/v4/data-package/rollback', {
      method: 'POST',
      body: { outlet_id: clean(outletId), version: clean(version) },
    })
  },
}
