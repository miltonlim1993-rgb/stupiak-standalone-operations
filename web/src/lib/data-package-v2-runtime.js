import { getDeviceId, platformName } from '@/lib/app-device'
import { reportDataPackageDeviceState } from '@/lib/data-package-device-state'
import {
  cleanupUnusedPackageObjects,
  getActiveDataPackage,
  getActivePackageMediaUrl,
  getActivePackageModule,
  rollbackLocalDataPackage,
  stageAndActivateDataPackage,
} from '@/lib/data-package-store-v2'
import {
  assertDataPackageStorageCapacity,
  estimateDataPackageStorage,
} from '@/lib/data-package-storage-preflight'

const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')
const STATUS_KEY = 'stupiaks.ops.data-package-v2.status'
const APP_VERSION = '4.5.1-data-package-v2'

let installPromise = null
const hydratedModules = new Map()

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

function packageObjectUrl(path = '', outletId = '') {
  const url = new URL(absolutePackagePath(path))
  if (clean(outletId)) url.searchParams.set('outlet_id', clean(outletId))
  return url.toString()
}

function mediaId(value = {}, fields = []) {
  for (const field of fields) {
    const result = clean(value?.[field])
    if (result) return result
  }
  return ''
}

async function localMediaUrl(value, outletId, fields) {
  const id = mediaId(value, fields)
  if (!id) return ''
  return getActivePackageMediaUrl(id, outletId)
}

async function hydrateTaskMedia(data, outletId) {
  if (!data || typeof data !== 'object') return data
  const photos = await Promise.all((data.task_template_photos || []).map(async (row) => {
    const url = await localMediaUrl(row, outletId, ['package_media_id', 'package_media_hash'])
    if (!url) return row
    return {
      ...row,
      source_file_url: row.source_file_url || row.file_url || '',
      source_thumbnail_url: row.source_thumbnail_url || row.thumbnail_url || '',
      file_url: url,
      thumbnail_url: url,
      package_local: true,
    }
  }))
  return { ...data, task_template_photos: photos }
}

async function hydrateTrainingMedia(data, outletId) {
  if (!data || typeof data !== 'object') return data
  const [assets, lessons, courses] = await Promise.all([
    Promise.all((data.sop_assets || []).map(async (row) => {
      const url = await localMediaUrl(row, outletId, ['package_media_id', 'package_media_hash'])
      if (!url) return row
      return {
        ...row,
        source_file_url: row.source_file_url || row.file_url || '',
        source_thumbnail_url: row.source_thumbnail_url || row.thumbnail_url || '',
        file_url: url,
        thumbnail_url: url,
        package_local: true,
      }
    })),
    Promise.all((data.training_lessons || []).map(async (row) => {
      const url = await localMediaUrl(row, outletId, ['package_video_id', 'package_media_id'])
      if (!url) return row
      return {
        ...row,
        source_video_url: row.source_video_url || row.video_url || '',
        video_url: url,
        package_local: true,
      }
    })),
    Promise.all((data.training_courses || []).map(async (row) => {
      const url = await localMediaUrl(row, outletId, ['package_cover_media_id'])
      if (!url) return row
      return {
        ...row,
        source_cover_image_url: row.source_cover_image_url || row.cover_image_url || '',
        cover_image_url: url,
        package_local: true,
      }
    })),
  ])
  return {
    ...data,
    sop_assets: assets,
    training_lessons: lessons,
    training_courses: courses,
  }
}

export async function hydrateDataPackageModuleMedia(name, data, outletId = '') {
  if (name === 'tasks') return hydrateTaskMedia(data, outletId)
  if (name === 'training') return hydrateTrainingMedia(data, outletId)
  return data
}

function clearHydratedModules() {
  hydratedModules.clear()
}

if (typeof window !== 'undefined') {
  window.addEventListener('chefops:data-package-v2-activated', clearHydratedModules)
}

async function reportInstalledPackage(outletId, manifest, installedAt = '') {
  if (!manifest?.version) return null
  try {
    return await reportDataPackageDeviceState({
      outlet_id: clean(outletId),
      device_id: getDeviceId(),
      platform: platformName(),
      app_version: APP_VERSION,
      data_package_version: manifest.version,
      data_package_installed_at: installedAt,
      status: 'active',
    })
  } catch {
    return null
  }
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

export async function checkDataPackageV2Storage(outletId = '') {
  const manifest = await api(manifestPath(outletId))
  return estimateDataPackageStorage(manifest, outletId)
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
      error_code: '',
      error_details: null,
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
      await reportInstalledPackage(outletId, manifest, active?.installed_at || '')
      return { manifest, reusedRelease: true, status: ready }
    }

    writeStatus({
      state: 'preflight',
      outlet_id: outletKey(outletId),
      installed_version: active?.manifest?.version || '',
      available_version: manifest.version,
      total_bytes: manifest.total_bytes || 0,
      completed_bytes: 0,
      completed_objects: 0,
    })
    onProgress({ state: 'preflight', manifest })

    const storagePlan = await assertDataPackageStorageCapacity(manifest, outletId)
    writeStatus({
      state: 'downloading',
      outlet_id: outletKey(outletId),
      installed_version: active?.manifest?.version || '',
      available_version: manifest.version,
      total_bytes: storagePlan.download_bytes,
      package_bytes: storagePlan.package_bytes,
      completed_bytes: 0,
      completed_objects: 0,
      storage_plan: storagePlan,
    })
    onProgress({ state: 'downloading', storagePlan, completedBytes: 0, totalBytes: storagePlan.download_bytes })

    await stageAndActivateDataPackage({
      manifest,
      outletId,
      fetcher: (path) => fetch(packageObjectUrl(path, outletId), {
        credentials: 'include',
        cache: 'no-store',
      }),
      onProgress(progress) {
        writeStatus({
          state: progress.state,
          outlet_id: outletKey(outletId),
          installed_version: progress.state === 'ready' ? manifest.version : active?.manifest?.version || '',
          available_version: manifest.version,
          total_bytes: progress.totalBytes || storagePlan.download_bytes || manifest.total_bytes || 0,
          package_bytes: manifest.total_bytes || 0,
          completed_bytes: progress.completedBytes || 0,
          completed_objects: progress.completedObjects || 0,
          total_objects: progress.totalObjects || 0,
          current_object: progress.item?.name || '',
          current_kind: progress.item?.kind || '',
          reused_object: Boolean(progress.reused),
          storage_plan: storagePlan,
          error: '',
          error_code: '',
          error_details: null,
        })
        onProgress({ ...progress, storagePlan })
      },
    })

    clearHydratedModules()
    const installedAt = new Date().toISOString()
    const ready = writeStatus({
      state: 'ready',
      outlet_id: outletKey(outletId),
      installed_version: manifest.version,
      available_version: manifest.version,
      total_bytes: manifest.total_bytes || 0,
      package_bytes: manifest.total_bytes || 0,
      installed_at: installedAt,
      storage_plan: storagePlan,
      error: '',
      error_code: '',
      error_details: null,
    })

    await reportInstalledPackage(outletId, manifest, installedAt)
    cleanupUnusedPackageObjects({ keepReleasesPerOutlet: 2 }).catch(() => undefined)
    return { manifest, reusedRelease: false, status: ready, storagePlan }
  })().catch((error) => {
    writeStatus({
      state: 'error',
      outlet_id: outletKey(outletId),
      error: error?.message || 'Unable to install operations data package',
      error_code: error?.code || '',
      error_details: error?.details || null,
      failed_at: new Date().toISOString(),
    })
    throw error
  })

  installPromise = run
  try { return await run } finally { if (installPromise === run) installPromise = null }
}

export async function getDataPackageV2Module(name, outletId = '') {
  const active = await getActiveDataPackage(outletId)
  if (!active?.manifest?.version) return null
  const cacheKey = `${outletKey(outletId)}:${active.manifest.version}:${name}`
  if (hydratedModules.has(cacheKey)) return hydratedModules.get(cacheKey)

  const module = await getActivePackageModule(name, outletId)
  if (!module) return null
  const data = module?.data !== undefined ? module.data : module
  const hydrated = await hydrateDataPackageModuleMedia(name, data, outletId)
  hydratedModules.set(cacheKey, hydrated)
  return hydrated
}

export async function getDataPackageV2MediaUrl(mediaIdValue, outletId = '') {
  return getActivePackageMediaUrl(mediaIdValue, outletId)
}

export async function rollbackInstalledDataPackageV2(outletId = '') {
  const manifest = await rollbackLocalDataPackage(outletId)
  clearHydratedModules()
  writeStatus({
    state: 'ready',
    outlet_id: outletKey(outletId),
    installed_version: manifest.version,
    rolled_back_at: new Date().toISOString(),
    error: '',
  })
  await reportInstalledPackage(outletId, manifest, new Date().toISOString())
  return manifest
}

export const dataPackageV2Admin = {
  status(outletId = '') {
    const params = new URLSearchParams()
    if (clean(outletId)) params.set('outlet_id', clean(outletId))
    return api(`/api/app/v4/data-package/status?${params}`)
  },
  preview(outletOrOptions = '') {
    const options = typeof outletOrOptions === 'string'
      ? { outletId: outletOrOptions, mediaFiles: [] }
      : (outletOrOptions || {})
    return api('/api/app/v4/data-package/preview', {
      method: 'POST',
      body: {
        outlet_id: clean(options.outletId),
        media_files: Array.isArray(options.mediaFiles) ? options.mediaFiles : [],
      },
    })
  },
  publish({
    outletId = '',
    expectedVersion = '',
    expectedSourceVersion = '',
    mediaFiles = [],
  } = {}) {
    return api('/api/app/v4/data-package/publish', {
      method: 'POST',
      body: {
        outlet_id: clean(outletId),
        expected_version: clean(expectedVersion),
        expected_source_version: clean(expectedSourceVersion),
        media_files: Array.isArray(mediaFiles) ? mediaFiles : [],
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
