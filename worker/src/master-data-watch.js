import { rebuildAllAppPacks } from './app-pack.js'
import { googleFetch } from './google.js'

const MASTER_WATCH_STATE_KEY = 'chefops:master-data-watch:v1'

function masterSpreadsheetId(env) {
  return String(env.GOOGLE_MASTER_SPREADSHEET_ID || env.GOOGLE_SPREADSHEET_ID || '').trim()
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

async function readMasterModifiedTime(env, spreadsheetId) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}`)
  url.searchParams.set('fields', 'id,modifiedTime')
  const response = await googleFetch(env, url.toString())
  const data = await response.json()
  const modifiedTime = String(data.modifiedTime || '').trim()
  if (!modifiedTime) {
    const error = new Error('Google Drive did not return the Master spreadsheet modified time')
    error.status = 502
    error.code = 'master_modified_time_missing'
    throw error
  }
  return modifiedTime
}

export async function refreshAppPacksWhenMasterChanges(env, dependencies = {}) {
  const spreadsheetId = masterSpreadsheetId(env)
  if (!spreadsheetId) {
    const error = new Error('GOOGLE_MASTER_SPREADSHEET_ID is not configured')
    error.status = 500
    error.code = 'master_spreadsheet_not_configured'
    throw error
  }

  const readModifiedTime = dependencies.readModifiedTime || readMasterModifiedTime
  const rebuildPacks = dependencies.rebuildPacks || rebuildAllAppPacks
  const modifiedTime = await readModifiedTime(env, spreadsheetId)
  const previous = await readWatchState(env)

  if (String(previous?.modified_time || '') === modifiedTime && previous?.published_at) {
    return {
      ok: true,
      changed: false,
      modified_time: modifiedTime,
      published_at: previous.published_at,
      packs: previous.packs || [],
    }
  }

  const manifests = await rebuildPacks(env)
  if (!Array.isArray(manifests) || !manifests.length) {
    const error = new Error('No app data packs were published after the Master spreadsheet changed')
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

  await writeWatchState(env, {
    spreadsheet_id: spreadsheetId,
    modified_time: modifiedTime,
    published_at: publishedAt,
    packs,
  })

  return {
    ok: true,
    changed: true,
    modified_time: modifiedTime,
    published_at: publishedAt,
    packs,
  }
}
