import { getCurrentUser } from './auth.js'
import { json, readJson } from './http.js'
import { getAppPackModule, getOrBuildAppPack } from './app-pack.js'
import { googleFetch } from './google.js'
import { assignedOutletIds, assertOutletAccess } from './permissions.js'
import {
  getPublishedMedia,
  publishedMediaManifest,
  savePublishedMedia,
} from './data-package-media-store.js'
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

export function resolveDataPackageOutlet(user, requested = '') {
  const value = clean(requested)
  if (value) {
    assertOutletAccess(user, value)
    return value
  }

  const fallback = clean(user?.outlet_id || assignedOutletIds(user)[0] || '')
  if (fallback) {
    assertOutletAccess(user, fallback)
    return fallback
  }

  if (['manager', 'owner'].includes(clean(user?.role).toLowerCase())) return ''

  const error = new Error('No outlet is assigned to your account')
  error.status = 403
  error.code = 'outlet_required'
  throw error
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

export function scanDataPackageMediaReferences(modules = {}) {
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

function providedMediaMap(mediaFiles = []) {
  const map = new Map()
  for (const file of mediaFiles || []) {
    const sourceKey = clean(file.source_key)
    if (sourceKey) map.set(sourceKey, file)
  }
  return map
}

function applyPackagedMedia(modules = {}, resolvedBySource = new Map()) {
  const next = {
    ...modules,
    tasks: modules.tasks ? { ...modules.tasks } : modules.tasks,
    training: modules.training ? { ...modules.training } : modules.training,
  }

  if (next.tasks?.task_template_photos) {
    next.tasks.task_template_photos = next.tasks.task_template_photos.map((row) => {
      const media = resolvedBySource.get(mediaReferenceKey(row))
      return media ? { ...row, package_media_id: media.hash, package_media_hash: media.hash } : row
    })
  }
  if (next.training?.sop_assets) {
    next.training.sop_assets = next.training.sop_assets.map((row) => {
      const media = resolvedBySource.get(mediaReferenceKey(row))
      return media ? { ...row, package_media_id: media.hash, package_media_hash: media.hash } : row
    })
  }
  if (next.training?.training_lessons) {
    next.training.training_lessons = next.training.training_lessons.map((row) => {
      if (!row.video_url) return row
      const media = resolvedBySource.get(mediaReferenceKey({ ...row, file_url: row.video_url }))
      return media ? { ...row, package_video_id: media.hash, package_media_id: media.hash } : row
    })
  }
  if (next.training?.training_courses) {
    next.training.training_courses = next.training.training_courses.map((row) => {
      if (!row.cover_image_url) return row
      const media = resolvedBySource.get(mediaReferenceKey({ ...row, file_url: row.cover_image_url }))
      return media ? { ...row, package_cover_media_id: media.hash } : row
    })
  }

  return next
}

function resolveMediaReferences(references = [], mediaFiles = []) {
  const provided = providedMediaMap(mediaFiles)
  const resolved = []
  const unresolved = []
  const bySource = new Map()

  for (const reference of references) {
    const file = provided.get(reference.source_key)
    if (!file) {
      unresolved.push(reference)
      continue
    }
    const normalized = {
      ...file,
      source_key: reference.source_key,
      kind: file.kind || reference.asset_type,
      file_name: file.file_name || reference.file_name,
    }
    resolved.push(normalized)
    bySource.set(reference.source_key, normalized)
  }

  return { resolved, unresolved, bySource }
}

async function sourceModules(env, outletId) {
  const sourceManifest = await getOrBuildAppPack(env, outletId, { force: true })
  const modules = {}
  for (const name of MODULE_NAMES) {
    const info = sourceManifest?.modules?.[name]
    if (!info?.hash) continue
    const source = await getAppPackModule(env, outletId, name, info.hash)
    if (source?.data !== undefined) modules[name] = source.data
  }
  return { sourceManifest, modules }
}

async function buildSourceDraft(env, outletId, actor = '', mediaFiles = []) {
  const { sourceManifest, modules } = await sourceModules(env, outletId)
  const mediaReferences = scanDataPackageMediaReferences(modules)
  const resolution = resolveMediaReferences(mediaReferences, mediaFiles)
  const packagedModules = applyPackagedMedia(modules, resolution.bySource)
  const sourceVersion = packagedModules.core?.settings?.app_data_version || sourceManifest?.data_version || ''
  const media = publishedMediaManifest(resolution.resolved)
  const draft = await buildDataPackageDraft({
    env,
    outletId,
    modules: packagedModules,
    media,
    generatedBy: actor,
    sourceVersion,
  })

  return {
    draft,
    sourceManifest,
    modules: packagedModules,
    mediaReferences,
    resolvedMedia: resolution.resolved,
    unresolvedMedia: resolution.unresolved,
  }
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

export async function previewDataPackageV2(env, outletId, { actor = '', mediaFiles = [] } = {}) {
  const [{ draft, sourceManifest, modules, unresolvedMedia, resolvedMedia }, current, dirty] = await Promise.all([
    buildSourceDraft(env, outletId, actor, mediaFiles),
    getLatestDataPackageManifest(env, outletId),
    getDataPackageDirtyState(env, outletId),
  ])
  const comparison = compareDataPackageDraft(current, draft.manifest, unresolvedMedia)
  return {
    ok: true,
    outlet_id: outletId,
    generated_at: draft.manifest.generated_at,
    source_pack_version: sourceManifest?.version || '',
    source_record_counts: Object.fromEntries(Object.entries(modules).map(([name, value]) => [name, records(value)])),
    current_manifest: current,
    draft_manifest: draft.manifest,
    dirty,
    packaged_media_count: resolvedMedia.length,
    comparison,
  }
}

export async function publishDataPackageV2(env, {
  outletId = '',
  actor = '',
  expectedVersion = '',
  expectedSourceVersion = '',
  mediaFiles = [],
} = {}) {
  const result = await buildSourceDraft(env, outletId, actor, mediaFiles)
  if (clean(expectedSourceVersion) && clean(expectedSourceVersion) !== clean(result.sourceManifest?.version)) {
    const error = new Error('The Google source changed while media was being packaged. Scan the package again.')
    error.status = 409
    error.code = 'data_package_source_changed'
    error.details = { expected_source_version: clean(expectedSourceVersion), actual_source_version: clean(result.sourceManifest?.version) }
    throw error
  }
  if (clean(expectedVersion) && clean(expectedVersion) !== clean(result.draft.manifest.version)) {
    const error = new Error('The source changed after preview. Preview the package again before publishing.')
    error.status = 409
    error.code = 'data_package_preview_outdated'
    error.details = { expected_version: clean(expectedVersion), actual_version: clean(result.draft.manifest.version) }
    throw error
  }
  if (result.unresolvedMedia.length) {
    const error = new Error('Media files still need to be packaged before this release can be published')
    error.status = 409
    error.code = 'data_package_media_not_packaged'
    error.details = { media_count: result.unresolvedMedia.length, media: result.unresolvedMedia.slice(0, 100) }
    throw error
  }

  await savePublishedMedia(env, result.resolvedMedia)
  const manifest = await publishDataPackageDraft(env, result.draft, { publishedBy: actor })
  return { manifest, source_pack_version: result.sourceManifest?.version || '' }
}

function cacheHeaders(version = '') {
  return {
    'Cache-Control': 'private, max-age=86400, immutable',
    ...(version ? { ETag: `"${version}"` } : {}),
  }
}

function manifestHasMedia(manifest, hash) {
  const normalized = clean(hash).toLowerCase()
  if (!normalized) return false
  const files = manifest?.media?.files || {}
  if (files[normalized]) return true
  return Object.values(files).some((item) => clean(item?.hash || item?.id).toLowerCase() === normalized)
}

async function mediaResponse(request, env, hash, outletId) {
  const manifest = await getLatestDataPackageManifest(env, outletId)
  if (!manifestHasMedia(manifest, hash)) {
    const error = new Error('Published package media was not found for this outlet')
    error.status = 404
    error.code = 'data_package_media_not_found'
    throw error
  }

  const media = await getPublishedMedia(env, hash)
  if (!media?.source_id) {
    const error = new Error('Published package media was not found')
    error.status = 404
    error.code = 'data_package_media_not_found'
    throw error
  }
  const headers = {}
  const range = request.headers.get('Range')
  if (range) headers.Range = range
  const upstream = await googleFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(media.source_id)}?alt=media`, { headers })
  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.set('Content-Type', media.mime_type || upstream.headers.get('Content-Type') || 'application/octet-stream')
  responseHeaders.set('Cache-Control', 'private, max-age=31536000, immutable')
  responseHeaders.set('ETag', `"${media.hash}"`)
  responseHeaders.set('Accept-Ranges', 'bytes')
  if (media.bytes) responseHeaders.set('X-Content-Length', String(media.bytes))
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

export async function handleDataPackageV2Api(request, env, url) {
  if (!url.pathname.startsWith('/api/app/v4/data-package') && !url.pathname.startsWith('/api/app/v4/pack/module/')) return null

  const user = await getCurrentUser(request, env)
  const requestedOutlet = clean(url.searchParams.get('outlet_id'))
  const outletId = resolveDataPackageOutlet(user, requestedOutlet)

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

  const mediaMatch = url.pathname.match(/^\/api\/app\/v4\/data-package\/media\/([a-f0-9]{64})$/i)
  if (mediaMatch && request.method === 'GET') return mediaResponse(request, env, mediaMatch[1], outletId)

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
    const target = resolveDataPackageOutlet(user, body.outlet_id || outletId)
    return json(request, env, await previewDataPackageV2(env, target, {
      actor: user.email || '',
      mediaFiles: Array.isArray(body.media_files) ? body.media_files : [],
    }))
  }

  if (url.pathname === '/api/app/v4/data-package/publish' && request.method === 'POST') {
    requirePublisher(user)
    const body = await readJson(request).catch(() => ({}))
    const target = resolveDataPackageOutlet(user, body.outlet_id || outletId)
    const result = await publishDataPackageV2(env, {
      outletId: target,
      actor: user.email || '',
      expectedVersion: body.expected_version,
      expectedSourceVersion: body.expected_source_version,
      mediaFiles: Array.isArray(body.media_files) ? body.media_files : [],
    })
    return json(request, env, { ok: true, ...result }, 201)
  }

  if (url.pathname === '/api/app/v4/data-package/releases' && request.method === 'GET') {
    requirePublisher(user)
    return json(request, env, { ok: true, ...(await listDataPackageReleases(env, outletId)) })
  }

  if (url.pathname === '/api/app/v4/data-package/rollback' && request.method === 'POST') {
    requirePublisher(user)
    const body = await readJson(request)
    const target = resolveDataPackageOutlet(user, body.outlet_id || outletId)
    const manifest = await rollbackDataPackage(env, target, clean(body.version), { actor: user.email || '' })
    return json(request, env, { ok: true, manifest })
  }

  return null
}
