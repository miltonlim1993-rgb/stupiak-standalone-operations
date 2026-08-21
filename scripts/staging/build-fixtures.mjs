import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { OPERATIONAL_TEMPLATE_SEEDS } from '../../worker/src/operational-defaults.js'

const root = process.cwd()
const outDir = path.join(root, '.staging')
mkdirSync(outDir, { recursive: true })

const PACK_SCHEMA_VERSION = 2
const outlets = [
  {
    id: 'RR-KCH', code: 'RR-KCH', name: 'STAGING — Royal Richmond',
    status: 'active', address: 'Synthetic test outlet', timezone: 'Asia/Kuching',
  },
  {
    id: 'SKONE-BTU', code: 'SKONE-BTU', name: 'STAGING — SK One Bintulu',
    status: 'active', address: 'Synthetic test outlet', timezone: 'Asia/Kuching',
  },
]

const paymentMethods = [
  { id: 'stg-cash', code: 'cash', name: 'Cash', category: 'cash', display_order: 10, active: true },
  { id: 'stg-duitnow', code: 'duitnow', name: 'DuitNow', category: 'cashless', display_order: 20, active: true },
  { id: 'stg-grabfood', code: 'grabfood', name: 'GrabFood', category: 'delivery', display_order: 30, active: true },
]

const inventoryCatalog = [
  { id: 'stg-inv-bun', item_code: 'STG-BUN', item_name: 'Test Burger Bun', category: 'Dry', base_unit: 'pack', global_enabled: true },
  { id: 'stg-inv-pork', item_code: 'STG-PORK', item_name: 'Test Pork Patty', category: 'Frozen', base_unit: 'pack', global_enabled: true },
  { id: 'stg-inv-fries', item_code: 'STG-FRIES', item_name: 'Test Fries', category: 'Frozen', base_unit: 'bag', global_enabled: true },
  { id: 'stg-inv-cheese', item_code: 'STG-CHEESE', item_name: 'Test Cheese', category: 'Chiller', base_unit: 'pack', global_enabled: true },
  { id: 'stg-inv-cup', item_code: 'STG-CUP', item_name: 'Test Drink Cup', category: 'Packaging', base_unit: 'sleeve', global_enabled: true },
]

function stockList(outletId) {
  return inventoryCatalog.map((item, index) => ({
    id: `stg-stock-${outletId}-${index + 1}`,
    outlet_id: outletId,
    inventory_catalog_id: item.id,
    item_code: item.item_code,
    item_name: item.item_name,
    category: item.category,
    unit: item.base_unit,
    enabled: true,
    display_order: (index + 1) * 10,
    section: item.category,
  }))
}

function cloneTemplates(outletId) {
  const source = OPERATIONAL_TEMPLATE_SEEDS.filter((row) => String(row.instructions || '').startsWith('CHEFOPS_CHECKLIST_V1:'))
  return source.map((row, index) => ({
    ...row,
    id: `stg-${outletId.toLowerCase()}-${index + 1}-${String(row.id || 'task').slice(0, 54)}`,
    outlet_id: outletId,
    outlet_ids: outletId,
    title: `TEST — ${row.title || row.name || 'Operational checklist'}`,
    created_by: 'staging-fixture@stupiak.invalid',
    updated_by: 'staging-fixture@stupiak.invalid',
    version: 1,
    is_active: true,
  }))
}

const training = {
  sops: [{ id: 'stg-sop-1', sop_code: 'STG-001', title: 'TEST — Opening Safety SOP', category: 'Operations', active: true }],
  sop_steps: [
    { id: 'stg-sop-step-1', sop_id: 'stg-sop-1', step_order: 1, title: 'Check work area', instruction: 'Synthetic staging instruction.', active: true },
    { id: 'stg-sop-step-2', sop_id: 'stg-sop-1', step_order: 2, title: 'Confirm equipment', instruction: 'Synthetic staging instruction.', active: true },
  ],
  sop_assets: [],
  training_courses: [{ id: 'stg-course-1', title: 'TEST — New Staff Basics', category: 'Operations', active: true }],
  training_lessons: [{ id: 'stg-lesson-1', course_id: 'stg-course-1', lesson_order: 1, title: 'Staging lesson', content: 'Synthetic training content.', active: true }],
  training_quizzes: [],
  training_questions: [],
}

const labelCatalog = {
  source: { spreadsheetId: '', productSheet: '', rulesSheet: '', timeZone: 'Asia/Kuala_Lumpur', status: 'staging-fixture' },
  summary: { productCount: 2, ruleCount: 2, actions: ['Prepare', 'Defrost'], storageConditions: ['Chiller', 'Freezer'] },
  products: [
    { productId: 'stg-label-pork', productName: 'Test Pork Patty', displayName: 'TEST Pork Patty', category: 'Frozen', sku: 'STG-PORK' },
    { productId: 'stg-label-sauce', productName: 'Test Sauce', displayName: 'TEST Sauce', category: 'Sauce', sku: 'STG-SAUCE' },
  ],
  rules: [
    { ruleId: 'stg-rule-1', ruleKey: 'stg-rule-1::Defrost::Chiller::1', productId: 'stg-label-pork', productName: 'Test Pork Patty', action: 'Defrost', storageCondition: 'Chiller', durationMinutes: 1440, manualExpiryRequired: false, requiresQuantity: true, quantityLabel: 'Qty', quantityUnit: 'pack', showQuantityOnLabel: true, requiresSource: false },
    { ruleId: 'stg-rule-2', ruleKey: 'stg-rule-2::Prepare::Chiller::2', productId: 'stg-label-sauce', productName: 'Test Sauce', action: 'Prepare', storageCondition: 'Chiller', durationMinutes: 720, manualExpiryRequired: false, requiresQuantity: true, quantityLabel: 'Qty', quantityUnit: 'bottle', showQuantityOnLabel: true, requiresSource: false },
  ],
}

const positions = [
  { id: 'stg-position-c', code: 'C', name: 'Cashier', short_name: 'Cashier', display_order: 10, active: true },
  { id: 'stg-position-g', code: 'G', name: 'Grill', short_name: 'Grill', display_order: 20, active: true },
  { id: 'stg-position-p', code: 'P', name: 'Packaging', short_name: 'Packaging', display_order: 30, active: true },
]

function sha24(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function packKey(type, target, suffix = '') {
  return `chefops:pack:${PACK_SCHEMA_VERSION}:${type}:${target}${suffix ? `:${suffix}` : ''}`
}

const kv = []
for (const target of ['global', ...outlets.map((row) => row.id)]) {
  const outletId = target === 'global' ? '' : target
  const modules = {
    core: {
      outlets,
      payment_methods: paymentMethods,
      settings: {
        app_data_version: 'staging-cleanup-v1',
        release_notes: 'Synthetic staging data — never production.',
        production_web_url: '',
        support_url: '',
        data_pack_message: 'STAGING / TEST DATA',
      },
      media_rules: [
        { id: 'stg-media-task', module: 'task', outlet_id: '', allowed_media: 'photo', max_file_mb: 10, max_photos: 10, active: true },
        { id: 'stg-media-urgent', module: 'urgent_issue', outlet_id: '', allowed_media: 'photo', max_file_mb: 10, max_photos: 10, active: true },
      ],
      positions,
    },
    inventory: {
      outlet_id: outletId,
      inventory_catalog: inventoryCatalog,
      outlet_stock_list: outletId ? stockList(outletId) : [],
    },
    tasks: {
      task_templates: outletId ? cloneTemplates(outletId) : outlets.flatMap((row) => cloneTemplates(row.id)),
      task_template_photos: [],
    },
    training,
    labels: labelCatalog,
  }

  const manifestModules = {}
  for (const [name, data] of Object.entries(modules)) {
    const hash = sha24(JSON.stringify({ name, data }))
    const body = JSON.stringify({ name, generated_at: new Date().toISOString(), data })
    kv.push({ key: packKey('module', target, `${name}:${hash}`), value: body })
    manifestModules[name] = {
      hash,
      bytes: Buffer.byteLength(body),
      path: `/api/app/v4/pack/module/${encodeURIComponent(name)}?outlet_id=${encodeURIComponent(outletId)}&hash=${hash}`,
    }
  }
  const version = sha24(JSON.stringify(Object.fromEntries(Object.entries(manifestModules).map(([name, info]) => [name, info.hash]))))
  kv.push({
    key: packKey('manifest', target),
    value: JSON.stringify({
      ok: true,
      schema_version: PACK_SCHEMA_VERSION,
      version,
      data_version: 'staging-cleanup-v1',
      generated_at: new Date().toISOString(),
      outlet_id: outletId,
      total_bytes: Object.values(manifestModules).reduce((sum, item) => sum + item.bytes, 0),
      modules: manifestModules,
      storage: 'cloudflare-kv',
      environment: 'staging',
    }),
  })
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

const timestamp = new Date().toISOString()
const owner = {
  id: 'staging-owner',
  outlet_id: 'RR-KCH',
  outlet_ids: JSON.stringify(['RR-KCH', 'SKONE-BTU']),
  created_date: timestamp,
  created_by: 'staging-fixture@stupiak.invalid',
  updated_date: timestamp,
  updated_by: 'staging-fixture@stupiak.invalid',
  deleted_at: '',
  version: 1,
  google_sub: '',
  email: 'staging-owner@stupiak.invalid',
  full_name: 'Staging Owner',
  avatar_url: '',
  role: 'owner',
  phone: '+60000000000',
  department: 'STAGING',
  status: 'active',
  last_login_at: '',
  name_confirmed: true,
  name_confirmed_at: timestamp,
  name_updated_at: timestamp,
}

function opsRecordSql(entity, id, outletId, status, payload) {
  return `INSERT INTO ops_records (entity, entity_id, outlet_id, business_date, status, payload_json, version, created_at, created_by, updated_at, updated_by, deleted_at) VALUES (${sqlString(entity)}, ${sqlString(id)}, ${sqlString(outletId)}, '', ${sqlString(status)}, ${sqlString(JSON.stringify(payload))}, 1, ${sqlString(timestamp)}, 'staging-fixture@stupiak.invalid', ${sqlString(timestamp)}, 'staging-fixture@stupiak.invalid', '') ON CONFLICT(entity, entity_id) DO UPDATE SET outlet_id=excluded.outlet_id,status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by,deleted_at='';`
}

const sql = [
  '-- STAGING ONLY. Synthetic directory seed; contains no production users or business rows.',
  ...outlets.map((outlet) => opsRecordSql('Outlet', outlet.id, outlet.id, 'active', {
    ...outlet,
    created_date: timestamp,
    created_by: 'staging-fixture@stupiak.invalid',
    updated_date: timestamp,
    updated_by: 'staging-fixture@stupiak.invalid',
    deleted_at: '',
    version: 1,
  })),
  opsRecordSql('User', owner.id, owner.outlet_id, owner.status, owner),
  '',
].join('\n')

writeFileSync(path.join(outDir, 'kv-seed.json'), `${JSON.stringify(kv, null, 2)}\n`)
writeFileSync(path.join(outDir, 'd1-seed.sql'), sql)
console.log(`STAGING_FIXTURE_KV_KEYS=${kv.length}`)
console.log('STAGING_FIXTURE_OUTLETS=2')
console.log('STAGING_FIXTURE_OWNER=staging-owner@stupiak.invalid')
console.log('PRODUCTION_DATA_COPIED=false')
