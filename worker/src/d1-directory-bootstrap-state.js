import { listRecords } from './sheets.js'

const DIRECTORY_BOOTSTRAP_MARKER = 'ops:d1-directory-bootstrap:v1'
const MARKER_CACHE_TTL_MS = 30_000
let markerCache = { checkedAt: 0, complete: false, value: null }

export async function directoryBootstrapComplete(env) {
  const currentTime = Date.now()
  if (currentTime - markerCache.checkedAt < MARKER_CACHE_TTL_MS) return markerCache.complete
  if (!env.APP_DATA_PACKS?.get) return false
  try {
    const value = await env.APP_DATA_PACKS.get(DIRECTORY_BOOTSTRAP_MARKER, 'json')
    const complete = value?.status === 'complete'
    markerCache = { checkedAt: currentTime, complete, value: value || null }
    return complete
  } catch (error) {
    console.error('Unable to read D1 directory bootstrap marker', error)
    return false
  }
}

export async function markDirectoryBootstrapComplete(env, details = {}) {
  const value = {
    status: 'complete',
    completed_at: new Date().toISOString(),
    ...details,
  }
  markerCache = { checkedAt: Date.now(), complete: true, value }
  if (env.APP_DATA_PACKS?.put) {
    await env.APP_DATA_PACKS.put(DIRECTORY_BOOTSTRAP_MARKER, JSON.stringify(value))
  }
  return value
}

export async function listLegacyDirectoryRecordsDuringBootstrap(env, entity, { limit = 5000 } = {}) {
  if (await directoryBootstrapComplete(env)) return []
  if (!['User', 'Outlet'].includes(String(entity || ''))) return []
  return listRecords(env, entity, { limit: Math.max(1, Math.min(Number(limit) || 5000, 5000)) })
}

export async function findLegacyDirectoryUserDuringBootstrap(env, { googleSub = '', email = '' } = {}) {
  if (await directoryBootstrapComplete(env)) return null
  const normalizedEmail = String(email || '').trim().toLowerCase()
  if (googleSub) {
    const rows = await listRecords(env, 'User', {
      filter: { google_sub: String(googleSub) },
      limit: 1,
    })
    if (rows[0]) return rows[0]
  }
  if (normalizedEmail) {
    const rows = await listRecords(env, 'User', {
      filter: { email: normalizedEmail },
      limit: 1,
    })
    if (rows[0]) return rows[0]
  }
  return null
}
