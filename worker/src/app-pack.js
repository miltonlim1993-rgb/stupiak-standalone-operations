import { ensureEntitySheet, listRecords } from './sheets.js'
import { getLabelCatalog } from './labels.js'
import { ensureMediaRules } from './media-rules.js'

const PACK_SCHEMA_VERSION = 2
const DEFAULT_PAYMENT_METHODS = [
  { id: 'payment-cash', code: 'cash', name: 'Cash', icon: 'banknote', color: 'emerald', category: 'cash', display_order: 10, active: true, requires_reference: false },
  { id: 'payment-duitnow', code: 'duitnow', name: 'DuitNow', icon: 'qr-code', color: 'violet', category: 'cashless', display_order: 20, active: true, requires_reference: false },
  { id: 'payment-sarawak-pay', code: 'sarawak_pay', name: 'Sarawak Pay', icon: 'wallet-cards', color: 'sky', category: 'cashless', display_order: 30, active: true, requires_reference: false },
  { id: 'payment-pay-go', code: 'pay_and_go', name: 'Pay & Go', icon: 'credit-card', color: 'blue', category: 'cashless', display_order: 40, active: true, requires_reference: false },
  { id: 'payment-grab-dine-out', code: 'grab_dine_out', name: 'Grab Dine Out', icon: 'smartphone', color: 'emerald', category: 'cashless', display_order: 50, active: true, requires_reference: false },
  { id: 'payment-grabfood', code: 'grabfood', name: 'GrabFood', icon: 'bike', color: 'green', category: 'delivery', display_order: 60, active: true, requires_reference: false },
  { id: 'payment-shopeefood', code: 'shopeefood', name: 'ShopeeFood', icon: 'bike', color: 'orange', category: 'delivery', display_order: 70, active: true, requires_reference: false },
  { id: 'payment-foodpanda', code: 'foodpanda', name: 'Foodpanda', icon: 'bike', color: 'pink', category: 'delivery', display_order: 80, active: true, requires_reference: false },
]

export const POSITION_MASTER_SEEDS = [
  { id: 'position-c', code: 'C', name: 'Cashier', short_name: 'Cashier', icon: 'wallet-cards', pattern: 'coins', color: '#D97706', display_order: 10, active: true, notes: '' },
  { id: 'position-ca', code: 'CA', name: 'Cashier Assistant', short_name: 'Cashier Asst.', icon: 'badge-help', pattern: 'counter', color: '#0284C7', display_order: 20, active: true, notes: '' },
  { id: 'position-df', code: 'DF', name: 'Deep Fryer', short_name: 'Deep Fryer', icon: 'flame', pattern: 'bubbles', color: '#EA580C', display_order: 30, active: true, notes: '' },
  { id: 'position-g', code: 'G', name: 'Grill', short_name: 'Grill', icon: 'cooking-pot', pattern: 'grill', color: '#DC2626', display_order: 40, active: true, notes: '' },
  { id: 'position-e', code: 'E', name: 'Event', short_name: 'Event', icon: 'party-popper', pattern: 'burst', color: '#7C3AED', display_order: 50, active: true, notes: '' },
  { id: 'position-sd', code: 'SD', name: 'Special Duty', short_name: 'Special Duty', icon: 'sparkles', pattern: 'diagonal', color: '#4F46E5', display_order: 60, active: true, notes: '' },
  { id: 'position-p', code: 'P', name: 'Packaging', short_name: 'Packaging', icon: 'package-check', pattern: 'boxes', color: '#0F766E', display_order: 70, active: true, notes: '' },
]

const MEMORY = new Map()
const BUILD_INFLIGHT = new Map()

function outletKey(value = '') {
  return String(value || '').trim() || 'global'
}

function keyFor(type, outletId, suffix = '') {
  return `chefops:pack:${PACK_SCHEMA_VERSION}:${type}:${outletKey(outletId)}${suffix ? `:${suffix}` : ''}`
}

function cacheRequest(key) {
  return new Request(`https://chefops-pack.invalid/${encodeURIComponent(key)}`)
}

async function storeGet(env, key) {
  if (env.APP_DATA_PACKS?.get) {
    const value = await env.APP_DATA_PACKS.get(key)
    if (value !== null && value !== undefined) return value
  }
  if (MEMORY.has(key)) return MEMORY.get(key)
  try {
    const response = await caches.default.match(cacheRequest(key))
    if (response) {
      const value = await response.text()
      MEMORY.set(key, value)
      return value
    }
  } catch {}
  return null
}

async function storePut(env, key, value, { ttl = 30 * 24 * 60 * 60 } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  MEMORY.set(key, text)
  if (env.APP_DATA_PACKS?.put) {
    await env.APP_DATA_PACKS.put(key, text, { expirationTtl: ttl })
  }
  try {
    await caches.default.put(cacheRequest(key), new Response(text, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${Math.min(ttl, 86400)}`,
      },
    }))
  } catch {}
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function publicSettings(rows = []) {
  const allowed = new Set([
    'app_data_version', 'android_apk_url', 'android_apk_version',
    'release_notes', 'production_web_url', 'support_url', 'data_pack_message',
  ])
  return Object.fromEntries(rows
    .filter((row) => allowed.has(String(row.key || '')))
    .map((row) => [row.key, row.value]))
}

function activeOnly(rows = []) {
  return rows.filter((row) => row.deleted_at === '' || row.deleted_at === null || row.deleted_at === undefined)
}

async function sharedData(env) {
  await Promise.all([
    ensureEntitySheet(env, 'PaymentMethod', { seedRecords: DEFAULT_PAYMENT_METHODS }),
    ensureEntitySheet(env, 'AppSetting'),
    ensureMediaRules(env),
    ensureEntitySheet(env, 'PositionMaster', { seedRecords: POSITION_MASTER_SEEDS }),
  ])
  const [
    outlets, methods, settings, mediaRules, positions, templates, templatePhotos, inventoryCatalog, labelCatalog,
    sops, sopSteps, sopAssets, trainingCourses, trainingLessons, trainingQuizzes, trainingQuestions,
  ] = await Promise.all([
    listRecords(env, 'Outlet', { sort: 'name', limit: 500 }),
    listRecords(env, 'PaymentMethod', { filter: { active: true }, sort: 'display_order,name', limit: 300 }),
    listRecords(env, 'AppSetting', { sort: 'key', limit: 500 }),
    listRecords(env, 'MediaRule', { sort: 'module,outlet_id', limit: 500 }),
    listRecords(env, 'PositionMaster', { filter: { active: true }, sort: 'display_order,name', limit: 100 }),
    listRecords(env, 'TaskTemplate', { filter: { is_active: true }, sort: 'display_order,name', limit: 2000 }),
    listRecords(env, 'TaskTemplatePhoto', { sort: 'template_id,display_order', limit: 6000 }),
    listRecords(env, 'InventoryCatalog', { filter: { global_enabled: true }, sort: 'item_name', limit: 5000 }),
    getLabelCatalog(env),
    listRecords(env, 'SOP', { filter: { active: true }, sort: 'category,sop_code', limit: 3000 }),
    listRecords(env, 'SOPStep', { filter: { active: true }, sort: 'sop_id,step_order', limit: 10000 }),
    listRecords(env, 'SOPAsset', { filter: { active: true }, sort: 'sop_id,step_id,display_order', limit: 10000 }),
    listRecords(env, 'TrainingCourse', { filter: { active: true }, sort: 'category,title', limit: 3000 }),
    listRecords(env, 'TrainingLesson', { filter: { active: true }, sort: 'course_id,lesson_order', limit: 10000 }),
    listRecords(env, 'TrainingQuiz', { filter: { active: true }, sort: 'course_id,title', limit: 3000 }),
    listRecords(env, 'TrainingQuestion', { filter: { active: true }, sort: 'quiz_id,question_order', limit: 10000 }),
  ])
  return {
    outlets: activeOnly(outlets),
    paymentMethods: activeOnly(methods),
    settingsRows: activeOnly(settings),
    mediaRules: activeOnly(mediaRules),
    positions: activeOnly(positions),
    taskTemplates: activeOnly(templates),
    taskTemplatePhotos: activeOnly(templatePhotos),
    inventoryCatalog: activeOnly(inventoryCatalog),
    labelCatalog,
    sops: activeOnly(sops), sopSteps: activeOnly(sopSteps), sopAssets: activeOnly(sopAssets),
    trainingCourses: activeOnly(trainingCourses), trainingLessons: activeOnly(trainingLessons),
    trainingQuizzes: activeOnly(trainingQuizzes), trainingQuestions: activeOnly(trainingQuestions),
  }
}

async function buildModules(env, outletId, shared = null) {
  const data = shared || await sharedData(env)
  const stockList = outletId && outletId !== 'global'
    ? await listRecords(env, 'OutletStockList', {
      filter: { outlet_id: outletId, enabled: true },
      sort: 'section,display_order,item_name',
      limit: 5000,
    })
    : []

  return {
    core: {
      outlets: data.outlets,
      payment_methods: data.paymentMethods,
      settings: publicSettings(data.settingsRows),
      media_rules: data.mediaRules,
      positions: data.positions,
    },
    inventory: {
      outlet_id: outletId === 'global' ? '' : outletId,
      inventory_catalog: data.inventoryCatalog,
      outlet_stock_list: activeOnly(stockList),
    },
    tasks: {
      task_templates: data.taskTemplates,
      task_template_photos: data.taskTemplatePhotos,
    },
    training: {
      sops: data.sops, sop_steps: data.sopSteps, sop_assets: data.sopAssets,
      training_courses: data.trainingCourses, training_lessons: data.trainingLessons,
      training_quizzes: data.trainingQuizzes, training_questions: data.trainingQuestions,
    },
    labels: data.labelCatalog,
  }
}

async function persistPack(env, outletId, modules) {
  const generatedAt = new Date().toISOString()
  const manifestModules = {}

  for (const [name, data] of Object.entries(modules)) {
    const stableBody = JSON.stringify({ name, data })
    const hash = (await sha256(stableBody)).slice(0, 24)
    const body = JSON.stringify({ name, generated_at: generatedAt, data })
    const moduleKey = keyFor('module', outletId, `${name}:${hash}`)
    await storePut(env, moduleKey, body)
    manifestModules[name] = {
      hash,
      bytes: new TextEncoder().encode(body).length,
      path: `/api/app/v4/pack/module/${encodeURIComponent(name)}?outlet_id=${encodeURIComponent(outletId === 'global' ? '' : outletId)}&hash=${hash}`,
    }
  }

  const versionBasis = JSON.stringify(Object.fromEntries(Object.entries(manifestModules).map(([name, info]) => [name, info.hash])))
  const version = (await sha256(versionBasis)).slice(0, 24)
  const core = modules.core || {}
  const manifest = {
    ok: true,
    schema_version: PACK_SCHEMA_VERSION,
    version,
    data_version: core.settings?.app_data_version || version,
    generated_at: generatedAt,
    outlet_id: outletId === 'global' ? '' : outletId,
    total_bytes: Object.values(manifestModules).reduce((sum, item) => sum + Number(item.bytes || 0), 0),
    modules: manifestModules,
    storage: env.APP_DATA_PACKS?.get ? 'cloudflare-kv' : 'worker-cache',
  }
  await storePut(env, keyFor('manifest', outletId), manifest)
  await storePut(env, keyFor('dirty', outletId), { dirty_at: '', modules: [] }, { ttl: 86400 })
  return manifest
}

async function rebuildTargets(env, targets) {
  const shared = await sharedData(env)
  const results = []
  for (const target of targets) {
    try {
      results.push(await getOrBuildAppPack(env, target, { force: true, shared }))
    } catch (error) {
      console.error('App pack rebuild failed', target, error)
    }
  }
  return results
}

function queueRebuild(env, outletId) {
  const task = outletId
    ? rebuildTargets(env, new Set(['global', outletKey(outletId)]))
    : rebuildAllAppPacks(env)
  const guarded = task.catch((error) => console.error('Queued app pack rebuild failed', error))
  if (env.__CHEFOPS_CTX?.waitUntil) env.__CHEFOPS_CTX.waitUntil(guarded)
  else void guarded
}

export async function markAppPackDirty(env, outletId = '', { modules = [] } = {}) {
  const targets = new Set(['global'])
  if (outletId) targets.add(outletKey(outletId))
  const changedAt = new Date().toISOString()
  await Promise.all([...targets].map((target) => storePut(env, keyFor('dirty', target), {
    dirty_at: changedAt,
    modules: [...new Set((modules || []).map((value) => String(value || '').trim()).filter(Boolean))],
  }, { ttl: 7 * 24 * 60 * 60 })))
  queueRebuild(env, outletId)
}

export async function getPublishedAppPack(env, outletId = '') {
  const target = outletKey(outletId)
  const manifestRaw = await storeGet(env, keyFor('manifest', target))
  if (!manifestRaw) return null
  try { return JSON.parse(manifestRaw) } catch { return null }
}

export async function getOrBuildAppPack(env, outletId = '', { force = false, shared = null } = {}) {
  const target = outletKey(outletId)
  const manifestRaw = await storeGet(env, keyFor('manifest', target))
  let manifest = null
  try { manifest = manifestRaw ? JSON.parse(manifestRaw) : null } catch {}

  // Client manifest checks must never fan out into Google Sheets. They only
  // receive the last package that was fully built and atomically published to
  // Cloudflare. Sheet-backed publishing happens through the scheduled job,
  // the dirty-record background queue, or an explicit manager rebuild POST.
  if (!force) return manifest

  const inflightKey = `${target}:force`
  if (BUILD_INFLIGHT.has(inflightKey)) return BUILD_INFLIGHT.get(inflightKey)
  const promise = (async () => {
    const modules = await buildModules(env, target, shared)
    return persistPack(env, target, modules)
  })()
  BUILD_INFLIGHT.set(inflightKey, promise)
  try { return await promise } finally { BUILD_INFLIGHT.delete(inflightKey) }
}

export async function getAppPackModule(env, outletId, name, hash) {
  const target = outletKey(outletId)
  const manifest = await getPublishedAppPack(env, target)
  if (!manifest) return null
  const info = manifest.modules?.[name]
  if (!info) return null
  if (hash && String(hash) !== String(info.hash)) return null
  const raw = await storeGet(env, keyFor('module', target, `${name}:${info.hash}`))
  return raw ? JSON.parse(raw) : null
}

export async function rebuildAllAppPacks(env) {
  const shared = await sharedData(env)
  const outlets = shared.outlets || []
  const targets = new Set(['global'])
  outlets.forEach((row) => {
    if (row.id) targets.add(String(row.id))
    if (row.code) targets.add(String(row.code))
  })
  const results = []
  for (const target of targets) {
    try {
      results.push(await getOrBuildAppPack(env, target, { force: true, shared }))
    } catch (error) {
      console.error('App pack rebuild failed', target, error)
    }
  }
  return results
}
