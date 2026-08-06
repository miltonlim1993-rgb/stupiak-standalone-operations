const SANDBOX_ENABLED = import.meta.env.DEV
  && String(import.meta.env.VITE_LOCAL_UI_SANDBOX || '').toLowerCase() === 'true'

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
  outlet_id: 'RR-KCH',
  outlet_ids: JSON.stringify(['RR-KCH']),
  name_confirmed: true,
  requires_name_setup: false,
}

const CATALOG = {
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

function createLabel(body) {
  const rule = CATALOG.rules.find((item) => item.ruleKey === body.rule_key)
    || CATALOG.rules.find((item) => item.ruleId === body.rule_id)
  if (!rule) return { error: 'The selected expiry rule no longer exists', code: 'label_rule_not_found' }

  const product = CATALOG.products.find((item) => item.productId === rule.productId)
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
  }
  const record = {
    id,
    outlet_id: body.outlet_id || 'RR-KCH',
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
      outlet_id: body.outlet_id || 'RR-KCH',
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
  if (path === '/api/app/v4/version') return json({ version: 'local-ui-sandbox', local_ui_sandbox: true })
  if (path === '/api/app/v4/bootstrap') return json({ ok: true, local_ui_sandbox: true })
  if (path === '/api/realtime/data/status') return json({ ok: true, mode: 'local-browser', local_ui_sandbox: true })
  if (path.startsWith('/api/notifications')) return json([])
  if (path === '/api/labels/catalog') {
    return json(url.searchParams.get('summary') === '1'
      ? { source: CATALOG.source, summary: CATALOG.summary }
      : CATALOG)
  }
  if (path === '/api/labels/printer-profile') {
    return json({
      id: 'local-printer',
      outlet_id: url.searchParams.get('outlet_id') || 'RR-KCH',
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
    if (entity === 'FoodLabel') return json({ records: currentLabels() })
    if (entity === 'LabelPrintLog') return json({ records: currentLogs() })
    return json({ records: [] })
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
    const labels = currentLabels()
    const index = labels.findIndex((item) => String(item.id) === id)
    if (index < 0) return json({ error: 'Food label was not found', code: 'label_not_found' }, 404)
    const quantity = Math.max(1, Number(body.reprint_quantity || 1))
    const timestamp = new Date().toISOString()
    const label = {
      ...labels[index],
      total_reprint_quantity: Number(labels[index].total_reprint_quantity || 0) + quantity,
      reprint_count: Number(labels[index].reprint_count || 0) + 1,
      last_reprinted_at: timestamp,
      last_reprinted_by_name: SANDBOX_USER.full_name,
    }
    labels[index] = label
    saveLabels(labels)
    return json({ label, print: { action: 'reprint', quantity, printed_at: timestamp, printed_by_name: SANDBOX_USER.full_name } })
  }
  const finish = path.match(/^\/api\/labels\/source\/([^/]+)\/finish$/)
  if (finish && method === 'POST') {
    const id = decodeURIComponent(finish[1])
    const labels = currentLabels()
    const index = labels.findIndex((item) => String(item.id) === id)
    if (index < 0) return json({ error: 'Source label was not found', code: 'source_label_not_found' }, 404)
    let meta = {}
    try { meta = JSON.parse(labels[index].notes || '{}') } catch {}
    labels[index] = {
      ...labels[index],
      notes: JSON.stringify({ ...meta, source_status: 'depleted', source_remaining_qty: 0, source_finished_at: new Date().toISOString() }),
    }
    saveLabels(labels)
    return json(labels[index])
  }
  if (path.startsWith('/api/entities/')) return json([])

  return json({ ok: true, local_ui_sandbox: true })
}

export function installLocalUiSandbox() {
  if (!SANDBOX_ENABLED || window.__chefopsLocalUiSandboxInstalled) return false
  window.__chefopsLocalUiSandboxInstalled = true
  localStorage.setItem(USER_KEY, JSON.stringify(SANDBOX_USER))

  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const source = typeof input === 'string' ? input : input?.url
    const url = new URL(source, window.location.origin)
    if (url.pathname.startsWith('/api/')) return routeSandboxRequest(input, init)
    return nativeFetch(input, init)
  }

  window.__chefopsLocalSandbox = {
    enabled: true,
    user: SANDBOX_USER,
    catalog: CATALOG,
    reset() {
      localStorage.removeItem(LABELS_KEY)
      localStorage.removeItem(LOGS_KEY)
      window.location.reload()
    },
  }
  document.documentElement.dataset.chefopsLocalSandbox = 'true'
  console.info('ChefOps local UI sandbox enabled: authentication and Label data stay in this browser only.')
  return true
}
