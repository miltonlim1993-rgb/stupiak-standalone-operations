import { rebuildAllAppPacks } from './app-pack.js'
import { listRecords } from './sheets.js'

const MASTER_WATCH_STATE_KEY = 'chefops:master-data-watch:v1'
const MASTER_WATCH_SOURCE = 'sheets-task-template-fingerprint-v1'

function masterSpreadsheetId(env) {
  return String(env.GOOGLE_MASTER_SPREADSHEET_ID || env.GOOGLE_SPREADSHEET_ID || '').trim()
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readWatchState(env) {
  if (!env.APP_DATA_PACKS?.get) return null
  try {
    return await env.APP_DATA_PACKS.get(MASTER_WATCH_STATE_KEY, 'json')
  } catch (error) {
    console.error('Unable to read master data watch state', error)
    return null
  }
}

async function writeWatchState(env, value) {
  if (!env.APP_DATA_PACKS?.put) return
  await env.APP_DATA_PACKS.put(MASTER_WATCH_STATE_KEY, JSON.stringify(value))
}

async function readMasterEntity(env, spreadsheetId, entity, options) {
  try {
    return await listRecords(env, entity, options)
  } catch (cause) {
    const error = new Error(
      `Master spreadsheet ${spreadsheetId}: unable to read ${entity}. ${String(cause?.message || cause)}`,
    )
    error.status = Number(cause?.status || 502)
    error.code = `master_${String(entity).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}_read_failed`
    error.cause = cause
    throw error
  }
}

async function readTaskTemplateFingerprint(env, spreadsheetId = masterSpreadsheetId(env)) {
  const templates = await readMasterEntity(env, spreadsheetId, 'TaskTemplate', {
    sort: 'id',
    limit: 3000,
  })
  const photos = await readMasterEntity(env, spreadsheetId, 'TaskTemplatePhoto', {
    sort: 'template_id,display_order,id',
    limit: 6000,
  })
  const fingerprint = await sha256(JSON.stringify({
    task_templates: templates || [],
    task_template_photos: photos || [],
  }))
  return {
    fingerprint,
    template_count: (templates || []).length,
    photo_count: (photos || []).length,
  }
}

function errorDetails(error) {
  return {
    last_error: String(error?.code || error?.message || error).slice(0, 500),
    last_error_message: String(error?.message || error).slice(0, 1000),
    last_error_at: new Date().toISOString(),
  }
}

function hasCurrentPublication(previous, sourceFingerprint) {
  return Boolean(
    previous?.published_at
    && String(previous?.source_fingerprint || '') === sourceFingerprint
    && Array.isArray(previous?.packs)
    && previous.packs.length > 0,
  )
}

export async function refreshAppPacksWhenMasterChanges(env, dependencies = {}) {
  const spreadsheetId = masterSpreadsheetId(env)
  if (!spreadsheetId) {
    const error = new Error('GOOGLE_MASTER_SPREADSHEET_ID is not configured')
    error.status = 500
    error.code = 'master_spreadsheet_not_configured'
    throw error
  }

  const readFingerprint = dependencies.readFingerprint || readTaskTemplateFingerprint
  const rebuildPacks = dependencies.rebuildPacks || rebuildAllAppPacks
  const force = Boolean(dependencies.force)
  const checkedAt = new Date().toISOString()
  const previous = await readWatchState(env)

  try {
    const source = await readFingerprint(env, spreadsheetId)
    const sourceFingerprint = String(source?.fingerprint || source || '').trim()
    if (!sourceFingerprint) {
      const error = new Error('Task Template fingerprint is empty')
      error.status = 502
      error.code = 'master_fingerprint_empty'
      throw error
    }

    // A deploy can race the 2-minute watcher. When the current Worker has already
    // published this exact fingerprint and the published pack list is present,
    // a second force request is a verification, not a reason to rewrite every KV
    // key again. Reuse the proven publication and clear any stale failure state.
    if (hasCurrentPublication(previous, sourceFingerprint)) {
      const next = {
        ...previous,
        spreadsheet_id: spreadsheetId,
        source: MASTER_WATCH_SOURCE,
        source_fingerprint: sourceFingerprint,
        checked_at: checkedAt,
        template_count: Number(source?.template_count || previous?.template_count || 0),
        photo_count: Number(source?.photo_count || previous?.photo_count || 0),
        last_error: '',
        last_error_message: '',
        last_error_at: '',
        force_verified: force,
      }
      await writeWatchState(env, next)
      return { ok: true, changed: false, verified_existing_publication: force, ...next }
    }

    const manifests = await rebuildPacks(env)
    if (!Array.isArray(manifests) || !manifests.length) {
      const error = new Error('No app data packs were published after Task Templates changed')
      error.status = 502
      error.code = 'master_pack_publish_empty'
      throw error
    }

    const publishedAt = new Date().toISOString()
    const packs = manifests.map((manifest) => ({
      outlet_id: String(manifest.outlet_id || ''),
      version: String(manifest.version || ''),
      data_version: String(manifest.data_version || ''),
    }))
    const next = {
      spreadsheet_id: spreadsheetId,
      source: MASTER_WATCH_SOURCE,
      source_fingerprint: sourceFingerprint,
      checked_at: checkedAt,
      published_at: publishedAt,
      template_count: Number(source?.template_count || 0),
      photo_count: Number(source?.photo_count || 0),
      packs,
      last_error: '',
      last_error_message: '',
      last_error_at: '',
      force_verified: false,
    }
    await writeWatchState(env, next)
    return { ok: true, changed: true, ...next }
  } catch (error) {
    try {
      await writeWatchState(env, {
        ...(previous || {}),
        spreadsheet_id: spreadsheetId,
        source: MASTER_WATCH_SOURCE,
        checked_at: checkedAt,
        ...errorDetails(error),
      })
    } catch (stateError) {
      console.error('Unable to persist Master watcher failure state', stateError)
    }
    throw error
  }
}
