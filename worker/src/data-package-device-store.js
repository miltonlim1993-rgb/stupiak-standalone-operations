const PREFIX = 'chefops:data-package:v2:device:'
const TTL = 180 * 24 * 60 * 60
const MEMORY = new Map()

function clean(value = '') {
  return String(value || '').trim()
}

function outletKey(value = '') {
  return clean(value) || 'global'
}

function key(outletId, deviceId) {
  return `${PREFIX}${outletKey(outletId)}:${clean(deviceId)}`
}

async function put(env, storageKey, value) {
  const text = JSON.stringify(value)
  MEMORY.set(storageKey, text)
  if (env.APP_DATA_PACKS?.put) await env.APP_DATA_PACKS.put(storageKey, text, { expirationTtl: TTL })
}

async function get(env, storageKey) {
  if (env.APP_DATA_PACKS?.get) {
    const value = await env.APP_DATA_PACKS.get(storageKey, 'json')
    if (value !== null && value !== undefined) return value
  }
  const text = MEMORY.get(storageKey)
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

export async function saveDataPackageDeviceState(env, {
  outletId = '',
  deviceId = '',
  user = {},
  platform = '',
  appVersion = '',
  packageVersion = '',
  installedAt = '',
  status = 'active',
} = {}) {
  const id = clean(deviceId)
  if (!id) throw new Error('device_id is required')
  const outlet = outletKey(outletId || user?.outlet_id)
  const storageKey = key(outlet, id)
  const previous = await get(env, storageKey)
  const record = {
    device_id: id,
    outlet_id: outlet === 'global' ? '' : outlet,
    user_id: clean(user?.id),
    user_email: clean(user?.email),
    user_name: clean(user?.full_name || user?.email),
    platform: clean(platform),
    app_version: clean(appVersion),
    data_package_version: clean(packageVersion),
    data_package_installed_at: clean(installedAt),
    first_seen_at: previous?.first_seen_at || new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    status: clean(status || 'active'),
  }
  await put(env, storageKey, record)
  return record
}

export async function listDataPackageDeviceStates(env, outletId = '') {
  const outlet = outletKey(outletId)
  const prefix = `${PREFIX}${outlet}:`
  const records = []

  if (env.APP_DATA_PACKS?.list) {
    let cursor = undefined
    do {
      const page = await env.APP_DATA_PACKS.list({ prefix, cursor, limit: 1000 })
      const values = await Promise.all((page.keys || []).map((item) => get(env, item.name)))
      records.push(...values.filter(Boolean))
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
  } else {
    for (const [storageKey, text] of MEMORY.entries()) {
      if (!storageKey.startsWith(prefix)) continue
      try { records.push(JSON.parse(text)) } catch {}
    }
  }

  return records.sort((left, right) => String(right.last_seen_at || '').localeCompare(String(left.last_seen_at || '')))
}
