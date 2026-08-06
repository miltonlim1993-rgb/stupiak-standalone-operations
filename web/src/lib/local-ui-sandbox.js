const SANDBOX_ENABLED = import.meta.env.DEV
  && String(import.meta.env.VITE_LOCAL_UI_SANDBOX || '').toLowerCase() === 'true'

const SANDBOX_OUTLET = String(import.meta.env.VITE_LOCAL_SANDBOX_OUTLET || 'RR-KCH').trim() || 'RR-KCH'
const SNAPSHOT_URL = `/local-sandbox/${SANDBOX_OUTLET.toLowerCase()}-pack.json`
const USER_KEY = 'chefops.auth.cached-user'
const LABELS_KEY = 'chefops.local-ui-sandbox.food-labels.v1'
const LOGS_KEY = 'chefops.local-ui-sandbox.label-print-logs.v1'

const SANDBOX_USER = {
  id: 'local-owner',
  google_sub: 'local-owner',
  email: 'local.owner@stupiaks.test',
  full_name: 'Milton Local',
  role: 'owner',
  status: 'active',
  outlet_id: SANDBOX_OUTLET,
  outlet_ids: JSON.stringify([SANDBOX_OUTLET]),
  name_confirmed: true,
  requires_name_setup: false,
}

const BUILTIN_CATALOG = {
  source: {
    spreadsheetId: 'local-ui-sandbox',
    productSheet: 'LabelProduct',
    rulesSheet: 'LabelRule',
    timeZone: 'Asia/Kuala_Lumpur',
    status: 'connected',
    storage: 'local-browser',
  },
  summary: {
    productCount: 3,
    ruleCount: 4,
    actions: ['Open', 'Prepare', 'Refill'],
    storageConditions: ['Chiller', 'Dry Storage'],
  },
  products: [
    {
      productId: 'beef-mix-powder-6kg',
      productName: 'Beef Mix Powder 6kg',
      displayName: 'Beef Mix Powder 6kg',
      defaultLabelTitle: 'Beef Mix Powder 6kg',
      category: 'Dry Ingredients',
      enabled: true,
    },
    {
      productId: 'sweet-sour-spicy-sauce',
      productName: 'Sweet Sour Spicy Sauce',
      displayName: 'Sweet Sour Spicy Sauce',
      defaultLabelTitle: 'Sweet Sour Spicy Sauce',
      category: 'Sauce',
      enabled: true,
    },
    {
      productId: 'burger-sauce-bottle',
      productName: 'Burger Sauce Bottle',
      displayName: 'Burger Sauce Bottle',
      defaultLabelTitle: 'Burger Sauce Bottle',
      category: 'Sauce',
      enabled: true,
    },
  ],
  rules: [
    {
      ruleId: 'beef-mix-prepare',
      ruleKey: 'beef-mix-prepare::Prepare::Dry Storage::1',
      productId: 'beef-mix-powder-6kg',
      productName: 'Beef Mix Powder 6kg',
      action: 'Prepare',
      storageCondition: 'Dry Storage',
      durationMinutes: 60,
      manualExpiryRequired: true,
      requiresQuantity: false,
      requiresSource: false,
      enabled: true,
    },
    {
      ruleId: 'sauce-prepare',
      ruleKey: 'sauce-prepare::Prepare::Chiller::2',
      productId: 'sweet-sour-spicy-sauce',
      productName: 'Sweet Sour Spicy Sauce',
      action: 'Prepare',
      storageCondition: 'Chiller',
      durationMinutes: 10080,
      manualExpiryRequired: false,
      requiresQuantity: false,
      requiresSource: false,
      enabled: true,
    },
    {
      ruleId: 'sauce-open',
      ruleKey: 'sauce-open::Open::Chiller::3',
      productId: 'sweet-sour-spicy-sauce',
      productName: 'Sweet Sour Spicy Sauce',
      action: 'Open',
      storageCondition: 'Chiller',
      durationMinutes: 4320,
      manualExpiryRequired: false,
      requiresQuantity: false,
      requiresSource: true,
      sourceProductId: 'sweet-sour-spicy-sauce',
      sourceProductName: 'Sweet Sour Spicy Sauce',
      allowedSourceActions: 'Prepare',
      sourceExpiryMode: 'min',
      enabled: true,
    },
    {
      ruleId: 'bottle-refill',
      ruleKey: 'bottle-refill::Refill::Chiller::4',
      productId: 'burger-sauce-bottle',
      productName: 'Burger Sauce Bottle',
      action: 'Refill',
      storageCondition: 'Chiller',
      durationMinutes: 1440,
      manualExpiryRequired: false,
      requiresQuantity: false,
      requiresSource: true,
      sourceProductId: 'sweet-sour-spicy-sauce',
      sourceProductName: 'Sweet Sour Spicy Sauce',
      allowedSourceActions: 'Open',
      sourceExpiryMode: 'min',
      enabled: true,
    },
  ],
}

let activeCatalog = BUILTIN_CATALOG
let productionSnapshot = null
let snapshotPromise = null

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null')
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
  window.dispatchEvent(new CustomEvent('chefops:local-sandbox-change', { detail: { key } }))
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function requestBody(init) {
  if (!init?.body) return {}
  if (typeof init.body === 'string') {
    try { return JSON.parse(init.body) } catch { return {} }
  }
  return init.body
}

function moduleData(name) {
  const value = productionSnapshot?.modules?.[name]
  return value?.data ?? value ?? {}
}

function catalogSummary(catalog) {
  const products = Array.isArray(catalog?.products) ? catalog.products : []
  const rules = Array.isArray(catalog?.rules) ? catalog.rules : []
  return {
    productCount: products.length,
    ruleCount: rules.length,
    actions: [...new Set(rules.map((row) => row.action).filter(Boolean))].sort(),
    storageConditions: [...new Set(rules.map((row) => row.storageCondition).filter(Boolean))].sort(),
  }
}

async function loadProductionSnapshot({ refresh = false } = {}) {
  if (!SANDBOX_ENABLED) return null
  if (snapshotPromise && !refresh) return snapshotPromise

  const suffix = refresh ? `?_=${Date.now()}` : ''
  snapshotPromise = fetch(`${SNAPSHOT_URL}${suffix}`, { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Read-only production snapshot is unavailable (${response.status})`)
      const snapshot = await response.json()
      if (!snapshot?.manifest?.version || !snapshot?.modules) throw new Error('Read-only production snapshot is incomplete')

      productionSnapshot = snapshot
      const labels = snapshot.modules.labels?.data ?? snapshot.modules.labels
      if (Array.isArray(labels?.products) && labels.products.length && Array.isArray(labels?.rules) && labels.rules.length) {
        activeCatalog = {
          ...labels,
          source: {
            ...(labels.source || {}),
            status: 'connected',
            storage: 'production-kv-readonly-local-sandbox',
            snapshotVersion: snapshot.manifest.version,
            snapshotGeneratedAt: snapshot.manifest.generated_at || '',
            snapshotPulledAt: snapshot.pulled_at || '',
          },
          summary: labels.summary || catalogSummary(labels),
        }
      }

      window.dispatchEvent(new CustomEvent('chefops:local-sandbox-data-ready', {
        detail: {
          outlet_id: snapshot.outlet_id || SANDBOX_OUTLET,
          version: snapshot.manifest.version,
          generated_at: snapshot.manifest.generated_at || '',
          pulled_at: snapshot.pulled_at || '',
        },
      }))
      console.info('ChefOps local sandbox loaded the read-only production package.', snapshot.manifest.version)
      return snapshot
    })
    .catch((error) => {
      productionSnapshot = null
      activeCatalog = BUILTIN_CATALOG
      console.warn('ChefOps local sandbox is using built-in fallback data.', error)
      return null
    })

  return snapshotPromise
}

function snapshotRows(entity) {
  const core = moduleData('core')
  const inventory = moduleData('inventory')
  const tasks = moduleData('tasks')
  const training = moduleData('training')

  const map = {
    Outlet: core.outlets,
    PaymentMethod: core.payment_methods,
    PositionMaster: core.positions,
    MediaRule: core.media_rules,
    InventoryCatalog: inventory.inventory_catalog,
    OutletStockList: inventory.outlet_stock_list,
    TaskTemplate: tasks.task_templates,
    TaskTemplatePhoto: tasks.task_template_photos,
    SOP: training.sops,
    SOPStep: training.sop_steps,
    SOPAsset: training.sop_assets,
    TrainingCourse: training.training_courses,
    TrainingLesson: training.training_lessons,
    TrainingQuiz: training.training_quizzes,
    TrainingQuestion: training.training_questions,
    LabelProduct: activeCatalog.products,
    LabelRule: activeCatalog.rules,
  }

  if (entity === 'AppSetting') {
    return Object.entries(core.settings || {}).map(([key, value]) => ({ key, value }))
  }
  return Array.isArray(map[entity]) ? map[entity] : []
}

function comparable(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function matchesExpected(actual, expected) {
  if (expected === undefined) return true
  if (Array.isArray(expected)) return expected.map(comparable).includes(comparable(actual))
  if (expected && typeof expected === 'object') {
    if (Array.isArray(expected.$in) && !expected.$in.map(comparable).includes(comparable(actual))) return false
    if (Array.isArray(expected.$nin) && expected.$nin.map(comparable).includes(comparable(actual))) return false
    if (Object.prototype.hasOwnProperty.call(expected, '$eq') && comparable(actual) !== comparable(expected.$eq)) return false
    if (Object.prototype.hasOwnProperty.call(expected, '$ne') && comparable(actual) === comparable(expected.$ne)) return false
    return true
  }
  return comparable(actual) === comparable(expected)
}

function filteredRows(rows, url) {
  let filter = {}
  try { filter = JSON.parse(url.searchParams.get('filter') || '{}') } catch {}
  const limit = Math.max(1, Number(url.searchParams.get('limit') || 5000))
  return (rows || [])
    .filter((row) => Object.entries(filter || {}).every(([field, expected]) => matchesExpected(row?.[field], expected)))
    .slice(0, limit)
}

function pad(value, size = 2) {
  return String(value).padStart(size, '0')
}

function barcodeValue() {
  const raw = `${Date.now()}${Math.floor(Math.random() * 100000)}`.replace(/\D/g, '')
  return raw.slice(-13).padStart(13, '0')
}

function batchCode(productName, preparedAt) {
  const prefix = String(productName || 'LBL')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((word) => word[0])
    .join('') || 'LBL'
  return `${prefix}-${String(preparedAt.getFullYear()).slice(-2)}${pad(preparedAt.getMonth() + 1)}${pad(preparedAt.getDate())}-${pad(Math.floor(Math.random() * 10000), 4)}`
}

function currentLabels() {
  return readJson(LABELS_KEY, [])
}

function saveLabels(labels) {
  writeJson(LABELS_KEY, labels)
}

function currentLogs() {
  return readJson(LOGS_KEY, [])
}

function baselineRows(entity) {
  const value = productionSnapshot?.realtime?.[entity]
  return Array.isArray(value) ? value : []
}

function mergeById(localRows, remoteRows) {
  const result = []
  const seen = new Set()
  for (const row of [...(localRows || []), ...(remoteRows || [])]) {
    const id = String(row?.id || row?.__realtime?.entity_id || '')
    if (id && seen.has(id)) continue
    if (id) seen.add(id)
    result.push(row)
  }
  return result
}

function allLabels() {
  return mergeById(currentLabels(), baselineRows('FoodLabel'))
}

function allLogs() {
  return mergeById(currentLogs(), baselineRows('LabelPrintLog'))
}

function upsertLocalLabel(label) {
  const labels = currentLabels()
  const index = labels.findIndex((row) => String(row.id) === String(label.id))
  if (index >= 0) labels[index] = label
  else labels.unshift(label)
  saveLabels(labels)
  return label
}

function createLabel(body) {
  const rule = activeCatalog.rules.find((item) => item.ruleKey === body.rule_key)
    || activeCatalog.rules.find((item) => item.ruleId === body.rule_id)
  if (!rule) return { error: 'The selected expiry rule no longer exists', code: 'label_rule_not_found' }

  const product = activeCatalog.products.find((item) => item.productId === rule.productId)
  const preparedAt = new Date()
  const manual = body.manual_expiry_at ? new Date(body.manual_expiry_at) : null
  const expiresAt = manual && !Number.isNaN(manual.getTime())
    ? manual
    : new Date(preparedAt.getTime() + Number(rule.durationMinutes || 60) * 60000)
  const id = crypto.randomUUID()
  const barcode = barcodeValue()
  const batch = batchCode(product?.displayName || rule.productName, preparedAt)
  const copies = Math.max(1, Number(body.print_quantity || 1))
  const meta = {
    product_id: rule.productId,
    product_name: product?.displayName || rule.productName,
    rule_id: rule.ruleId,
    rule_key: rule.ruleKey,
    action: rule.action,
    storage_condition: rule.storageCondition,
    prepared_at: preparedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    batch_code: batch,
    source_label_id: body.source_label_id || '',
    requires_source: Boolean(rule.requiresSource),
    source_status: rule.action === 'Prepare' ? 'active' : undefined,
    source_usage_mode: rule.action === 'Prepare' ? 'tracked' : undefined,
    source_capacity: rule.action === 'Prepare' ? copies : undefined,
    source_remaining_qty: rule.action === 'Prepare' ? copies : undefined,
    local_ui_sandbox: true,
    production_snapshot_version: productionSnapshot?.manifest?.version || '',
  }
  const record = {
    id,
    outlet_id: body.outlet_id || SANDBOX_OUTLET,
    item_name: product?.displayName || rule.productName,
    quantity: Number(body.quantity || 1),
    prep_date: preparedAt.toISOString().slice(0, 10),
    expiry_date: expiresAt.toISOString(),
    serial_batch: batch,
    barcode,
    initial_print_quantity: copies,
    total_reprint_quantity: 0,
    reprint_count: 0,
    printer_name: body.printer_name || 'Local UI Sandbox',
    printed_at: preparedAt.toISOString(),
    printed_by_user_id: SANDBOX_USER.id,
    printed_by_name: SANDBOX_USER.full_name,
    created_date: preparedAt.toISOString(),
    created_by: SANDBOX_USER.email,
    notes: JSON.stringify(meta),
    __realtime: {
      entity: 'FoodLabel',
      entity_id: id,
      outlet_id: body.outlet_id || SANDBOX_OUTLET,
      version: 1,
      created_at: preparedAt.toISOString(),
      updated_at: preparedAt.toISOString(),
      deleted_at: '',
    },
  }
  saveLabels([record, ...currentLabels()])
  writeJson(LOGS_KEY, [{
    id: crypto.randomUUID(),
    outlet_id: record.outlet_id,
    label_id: id,
    batch_code: batch,
    barcode,
    print_action: 'print',
    print_quantity: copies,
    printed_at: preparedAt.toISOString(),
    printed_by_name: SANDBOX_USER.full_name,
  }, ...currentLogs()])
  return record
}

async function routeSandboxRequest(input, init = {}) {
  const source = typeof input === 'string' ? input : input?.url
  const url = new URL(source, window.location.origin)
  const method = String(init?.method || 'GET').toUpperCase()
  const path = url.pathname

  if (path === '/api/auth/me') return json(SANDBOX_USER)
  if (path === '/api/auth/config') return json({ local_enabled: true, registration_enabled: true, google_enabled: false, local_ui_sandbox: true })
  if (path === '/api/auth/logout') return json({ ok: true })

  await loadProductionSnapshot()

  if (path === '/api/app/v4/version') {
    return json({
      version: 'local-ui-sandbox',
      local_ui_sandbox: true,
      production_snapshot_version: productionSnapshot?.manifest?.version || '',
    })
  }
  if (path === '/api/app/v4/bootstrap') {
    return json({
      ok: true,
      local_ui_sandbox: true,
      user: SANDBOX_USER,
      data_version: productionSnapshot?.manifest?.data_version || productionSnapshot?.manifest?.version || 'local-fallback',
      production_snapshot: productionSnapshot?.manifest || null,
    })
  }
  if (path === '/api/realtime/data/status') {
    return json({
      ok: true,
      mode: productionSnapshot ? 'production-snapshot-readonly-local-overlay' : 'local-browser-fallback',
      local_ui_sandbox: true,
      production_snapshot_version: productionSnapshot?.manifest?.version || '',
    })
  }
  if (path.startsWith('/api/notifications')) return json([])
  if (path === '/api/labels/catalog') {
    return json(url.searchParams.get('summary') === '1'
      ? { source: activeCatalog.source, summary: activeCatalog.summary || catalogSummary(activeCatalog) }
      : activeCatalog)
  }
  if (path === '/api/labels/printer-profile') {
    return json({
      id: 'local-printer',
      outlet_id: url.searchParams.get('outlet_id') || SANDBOX_OUTLET,
      profile_name: 'Local UI Sandbox',
      printer_name: 'Local UI Sandbox',
      label_width_mm: 40,
      label_height_mm: 30,
      dpi: 203,
      default_copies: 1,
      connection_type: 'system_print',
      configured: true,
      enabled: true,
    })
  }
  if (path === '/api/realtime/records' && method === 'GET') {
    const entity = url.searchParams.get('entity') || ''
    if (entity === 'FoodLabel') return json({ records: filteredRows(allLabels(), url) })
    if (entity === 'LabelPrintLog') return json({ records: filteredRows(allLogs(), url) })
    return json({ records: filteredRows(snapshotRows(entity), url) })
  }
  if (path === '/api/labels/create' && method === 'POST') {
    const created = createLabel(await requestBody(init))
    if (created.error) return json(created, 404)
    return json(created, 201)
  }
  const reprint = path.match(/^\/api\/labels\/([^/]+)\/reprint$/)
  if (reprint && method === 'POST') {
    const id = decodeURIComponent(reprint[1])
    const body = await requestBody(init)
    const existing = allLabels().find((item) => String(item.id) === id)
    if (!existing) return json({ error: 'Food label was not found', code: 'label_not_found' }, 404)
    const quantity = Math.max(1, Number(body.reprint_quantity || 1))
    const timestamp = new Date().toISOString()
    const label = upsertLocalLabel({
      ...existing,
      total_reprint_quantity: Number(existing.total_reprint_quantity || 0) + quantity,
      reprint_count: Number(existing.reprint_count || 0) + 1,
      last_reprinted_at: timestamp,
      last_reprinted_by_name: SANDBOX_USER.full_name,
    })
    return json({ label, print: { action: 'reprint', quantity, printed_at: timestamp, printed_by_name: SANDBOX_USER.full_name } })
  }
  const finish = path.match(/^\/api\/labels\/source\/([^/]+)\/finish$/)
  if (finish && method === 'POST') {
    const id = decodeURIComponent(finish[1])
    const existing = allLabels().find((item) => String(item.id) === id)
    if (!existing) return json({ error: 'Source label was not found', code: 'source_label_not_found' }, 404)
    let meta = {}
    try { meta = JSON.parse(existing.notes || '{}') } catch {}
    const label = upsertLocalLabel({
      ...existing,
      notes: JSON.stringify({ ...meta, source_status: 'depleted', source_remaining_qty: 0, source_finished_at: new Date().toISOString() }),
    })
    return json(label)
  }

  const entityMatch = path.match(/^\/api\/entities\/([^/]+)$/)
  if (entityMatch && method === 'GET') {
    return json(filteredRows(snapshotRows(decodeURIComponent(entityMatch[1])), url))
  }
  if (path.startsWith('/api/entities/')) return json([])

  return json({ ok: true, local_ui_sandbox: true })
}

export function installLocalUiSandbox() {
  if (!SANDBOX_ENABLED || window.__chefopsLocalUiSandboxInstalled) return false
  window.__chefopsLocalUiSandboxInstalled = true
  localStorage.setItem(USER_KEY, JSON.stringify(SANDBOX_USER))
  localStorage.setItem('chefops.data-pack.outlet', SANDBOX_OUTLET)

  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const source = typeof input === 'string' ? input : input?.url
    const url = new URL(source, window.location.origin)
    if (url.pathname.startsWith('/api/')) return routeSandboxRequest(input, init)
    return nativeFetch(input, init)
  }

  void loadProductionSnapshot()

  window.__chefopsLocalSandbox = {
    enabled: true,
    user: SANDBOX_USER,
    get catalog() { return activeCatalog },
    get snapshot() { return productionSnapshot },
    async refreshData() {
      snapshotPromise = null
      return loadProductionSnapshot({ refresh: true })
    },
    reset() {
      localStorage.removeItem(LABELS_KEY)
      localStorage.removeItem(LOGS_KEY)
      window.location.reload()
    },
  }
  document.documentElement.dataset.chefopsLocalSandbox = 'true'
  console.info('ChefOps local UI sandbox enabled: production package is read-only and all mutations stay in this browser.')
  return true
}
