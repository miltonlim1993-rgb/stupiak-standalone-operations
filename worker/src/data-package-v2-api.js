import { getCurrentUser } from './auth.js'
import { json, readJson } from './http.js'
import { getAppPackModule, getOrBuildAppPack } from './app-pack.js'
import {
  buildDataPackageDraft,
  getDataPackageDirtyState,
  getDataPackageModuleObject,
  getLatestDataPackageManifest,
  listDataPackageReleases,
  publishDataPackageDraft,
  rollbackDataPackage,
} from './data-package-v2-store.js'

const MODULE_NAMES = ['core', 'inventory', 'tasks', 'training', 'labels']

function clean(value = '') {
  return String(value || '').trim()
}

function targetOutlet(user, requested = '') {
  const value = clean(requested)
  if (value) return value
  return clean(user?.outlet_id || String(user?.outlet_ids || '').split(',')[0])
}

function requirePublisher(user) {
  if (['manager', 'owner'].includes(clean(user?.role).toLowerCase())) return
  const error = new Error('Manager access required to publish operational data packages')
  error.status = 403
  error.code = 'data_package_publish_forbidden'
  throw error
}

function records(value) {
  if (Array.isArray(value)) return value.length
  if (!value || typeof value !== 'object') return 0
  return Object.values(value).reduce((sum, item) => sum + (Array.isArray(item) ? item.length : 0), 0)
}

function mediaReferenceKey(value = {}) {
  const driveId = clean(value.drive_file_id || value.source_id)
  if (driveId) return `drive:${driveId}`
  const url = clean(value.file_url || value.video_url || value.cover_image_url || value.thumbnail_url)
  return url ? `url:${url}` : ''
}

function scanMediaReferences(modules = {}) {
  const references = new Map()
  const push = (value, context) => {
    if (!value || typeof value !== 'object') return
    const key = mediaReferenceKey(value)
    if (!key) return
    if (!references.has(key)) {
      references.set(key, {
        source_key: key,
        source_provider: key.startsWith('drive:') ? 'google_drive' : 'external_url',
        source_id: clean(value.drive_file_id || value.source_id),
        source_url: clean(value.file_url || value.video_url || value.cover_image_url || value.thumbnail_url),
        file_name: clean(value.file_name),
        asset_type: clean(value.asset_type || value.photo_type || value.lesson_type || 'file'),
        contexts: [],
        packaged: false,
      })
    }
    references.get(key).contexts.push(context)
  }

  for (const row of modules.tasks?.task_template_photos || []) {
    push(row, { module: 'tasks', entity: 'TaskTemplatePhoto', id: row.id || '', parent_id: row.template_id || '' })
  }
  for (const row of modules.training?.sop_assets || []) {
    push(row, { module: 'training', entity: 'SOPAsset', id: row.id || '', parent_id: row.sop_id || '' })
  }
  for (const row of modules.training?.training_lessons || []) {
    if (row.video_url) push({ ...row, file_url: row.video_url, asset_type: 'video' }, { module: 'training', entity: 'TrainingLesson', id: row.id || '', parent_id: row.course_id || '' })
  }
  for (const row of modules.training?.training_courses || []) {
    if (row.cover_image_url) push({ ...row, file_url: row.cover_image_url, asset_type: 'image' }, { module: 'training', entity: 'TrainingCourse', id: row.id || '', parent_id: row.id || '' })
  }

  return [...references.values()]
}

async function buildSourceDraft(env, outletId, user) {
  const sourceManifest = await getOrBuildAppPack(env, outletId, { force: true })
  const modules = {}

  for (const name of MODULE_NAMES) {
    const info = sourceManifest?.modules?.[name]
    if (!info?.hash) continue
    const source = await getAppPackModule(env, outletId, name, info.hash)
    if (source?.data !== undefined) modules[name] = source.data
  }

  const mediaReferences = scanMediaReferences(modules)
  const sourceVersion = modules.core?.settings?.app_data_version || sourceManifest?.data_version || ''
  const draft = await buildDataPackageDraft({
    env,
    outletId,
    modules,
    media: {},
    generatedBy: user?.email || '',
    sourceVersion,
  })

  return { draft, sourceManifest, modules, mediaReferences }
}

export function compareDataPackageDraft(current, draftManifest, mediaReferences = []) {
  const moduleChanges = []
  const names = new Set([
    ...Object.keys(current?.modules || {}),
    ...Object.keys(draftManifest?.modules || {}),
  ])

  for (const name of [...names].sort()) {
    const before = current?.modules?.[name] || null
    const after = draftManifest?.modules?.[name] || null
    const state = !before ? 'added' : !after ? 'removed' : before.hash === after.hash ? 'unchanged' : 'changed'
    moduleChanges.push({
      name,
      state,
      previous_hash: before?.hash || '',
      next_hash: after?.hash || '',
      previous_bytes: Number(before?.bytes || 0),
      next_bytes: Number(after?.bytes || 0),
      previous_records: Number(before?.records || 0),
      next_records: Number(after?.records || 0),
      download_bytes: state === 'added' || state === 'changed' ? Number(after?.bytes || 0) : 0,
    })
  }

  const changed = moduleChanges.filter((item) => item.state !== 'unchanged')
  return {
    current_version: current?.version || '',
    draft_version: draftManifest?.version || '',
    changed: changed.length > 0 || mediaReferences.length > 0,
    module_changes: moduleChanges,
    changed_modules: changed.map((item) => item.name),
    download_bytes: changed.reduce((sum, item) => sum + item.download_bytes, 0),
    unresolved_media: mediaReferences,
    unresolved_media_count: mediaReferences.length,
    media_packaging_ready: mediaReferences.length === 0,
  }
}

async function preview(env, outletId, user) {
  const [{ draft, sourceManifest, modules, mediaReferences }, current, dirty] = await Promise.all([
    buildSourceDraft(env, outletId, user),
    getLatestDataPackageManifest(env, outletId),
    getDataPackageDirtyState(env, outletId),
  ])
  const comparison = compareDataPackageDraft(current, draft.manifest, mediaReferences)
  return {
    ok: true,
    outlet_id: outletId,
    generated_at: draft.manifest.generated_at,
    source_pack_version: sourceManifest?.version || '',
    source_record_counts: Object.fromEntries(Object.entries(modules).map(([name, value]) => [name, records(value)])),
    current_manifest: current,
    draft_manifest: draft.manifest,
    dirty,
    comparison,
  }
}

function cacheHeaders(version = '') {
  return {
    'Cache-Control': 'private, max-age=86400, immutable',
    ...(version ? { ETag: `"${version}"` } : {}),
  }
}

export async function handleDataPackageV2Api(request, env, url) {
  if (!url.pathname.startsWith('/api/app/v4/data-package') && !url.pathname.startsWith('/api/app/v4/pack/module/')) return null

  const user = await getCurrentUser(request, env)
  const requestedOutlet = clean(url.searchParams.get('outlet_id'))
  const outletId = targetOutlet(user, requestedOutlet)

  if (url.pathname === '/api/app/v4/data-package/manifest' && request.method === 'GET') {
    const manifest = await getLatestDataPackageManifest(env, outletId)
    if (!manifest) {
      const error = new Error('No Data Package v2 release has been published for this outlet')
      error.status = 404
      error.code = 'data_package_v2_not_published'
      throw error
    }
    const etag = `"${manifest.version}"`
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: cacheHeaders(manifest.version) })
    return json(request, env, manifest, 200, cacheHeaders(manifest.version))
  }

  const moduleMatch = url.pathname.match(/^\/api\/app\/v4\/(?:data-package|pack)\/module\/([^/]+)$/)
  if (moduleMatch && request.method === 'GET') {
    const name = decodeURIComponent(moduleMatch[1])
    const hash = clean(url.searchParams.get('hash'))
    const module = await getDataPackageModuleObject(env, outletId, name, hash)
    if (!module) {
      if (url.pathname.startsWith('/api/app/v4/pack/module/')) return null
      const error = new Error('Data Package v2 module was not found')
      error.status = 404
      error.code = 'data_package_v2_module_not_found'
      throw error
    }
    return json(request, env, module, 200, cacheHeaders(hash))
  }

  if (url.pathname === '/api/app/v4/data-package/status' && request.method === 'GET') {
    const [manifest, releases] = await Promise.all([
      getLatestDataPackageManifest(env, outletId),
      listDataPackageReleases(env, outletId),
    ])
    return json(request, env, { ok: true, outlet_id: outletId, manifest, ...releases })
  }

  if (url.pathname === '/api/app/v4/data-package/preview' && request.method === 'POST') {
    requirePublisher(user)
    const body = await readJson(request).catch(() => ({}))
    const target = targetOutlet(user, body.outlet_id || outletId)
    return json(request, env, await preview(env, target, user))
  }

  if (url.pathname === '/api/app/v4/data-package/publish' && request.method === 'POST') {
    requirePublisher(user)
    const body = await readJson(request).catch(() => ({}))
    const target = targetOutlet(user, body.outlet_id || outletId)
    const { draft, mediaReferences } = await buildSourceDraft(env, target, user)
    const expected = clean(body.expected_version)
    if (expected && expected !== draft.manifest.version) {
      const error = new Error('The source changed after preview. Preview the package again before publishing.')
      error.status = 409
      error.code = 'data_package_preview_outdated'
      error.details = { expected_version: expected, actual_version: draft.manifest.version }
      throw error
    }
    if (mediaReferences.length && body.allow_unpacked_media !== true) {
      const error = new Error('Media files still need to be packaged before this release can be published')
      error.status = 409
      error.code = 'data_package_media_not_packaged'
      error.details = { media_count: mediaReferences.length, media: mediaReferences.slice(0, 50) }
      throw error
    }
    const manifest = await publishDataPackageDraft(env, draft, { publishedBy: user.email || '' })
    return json(request, env, { ok: true, manifest }, 201)
  }

  if (url.pathname === '/api/app/v4/data-package/releases' && request.method === 'GET') {
    requirePublisher(user)
    return json(request, env, { ok: true, ...(await listDataPackageReleases(env, outletId)) })
  }

  if (url.pathname === '/api/app/v4/data-package/rollback' && request.method === 'POST') {
    requirePublisher(user)
    const body = await readJson(request)
    const target = targetOutlet(user, body.outlet_id || outletId)
    const manifest = await rollbackDataPackage(env, target, clean(body.version), { actor: user.email || '' })
    return json(request, env, { ok: true, manifest })
  }

  return null
}
