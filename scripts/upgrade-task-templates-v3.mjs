import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const varsCandidates = [path.join(root, '.dev.vars'), path.join(root, 'worker', '.dev.vars')]
const varsPath = varsCandidates.find((candidate) => existsSync(candidate))
const apply = process.argv.includes('--apply')
const outletId = String(process.env.CHEFOPS_TASK_OUTLET || 'RR-KCH').trim()
const PREFIX = 'CHEFOPS_CHECKLIST_V1:'
const REPORT_DIR = path.join(process.env.HOME || root, '.stupiaks-ops-data-packages', 'reports')

function parseEnv(text) {
  const result = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 0) continue
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return result
}

function required(env, key) {
  const value = String(env[key] || '').trim()
  if (!value) throw new Error(`Missing ${key} in ${varsPath || 'local private configuration'}`)
  return value
}

async function googleJson(url, { token, method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`Google API ${response.status}: ${JSON.stringify(data)}`)
  return data
}

async function accessToken(env) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: required(env, 'GOOGLE_DATA_CLIENT_ID'),
      client_secret: required(env, 'GOOGLE_DATA_CLIENT_SECRET'),
      refresh_token: required(env, 'GOOGLE_DATA_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  })
  const data = await response.json()
  if (!response.ok || !data.access_token) throw new Error('Unable to refresh Google access token')
  return data.access_token
}

function clean(value) {
  return String(value ?? '').trim()
}

function parseConfig(row) {
  const raw = clean(row.instructions)
  if (!raw.startsWith(PREFIX)) return null
  try {
    const parsed = JSON.parse(raw.slice(PREFIX.length))
    return parsed?.kind === 'operational_checklist' ? parsed : null
  } catch {
    return null
  }
}

function encodeConfig(config) {
  return `${PREFIX}${JSON.stringify(config)}`
}

function baseTemplate({ id, name, title, description, period, dueTime, displayOrder, estimatedMinutes, config, timestamp }) {
  return {
    id,
    outlet_id: outletId,
    created_date: timestamp,
    created_by: 'task-v3-upgrade@stupiaks-ops',
    updated_date: timestamp,
    updated_by: 'task-v3-upgrade@stupiaks-ops',
    deleted_at: '',
    version: 1,
    name,
    title,
    description,
    category: config.category || 'hygiene',
    priority: config.priority || 'high',
    status: 'active',
    assigned_to_role: 'staff',
    assigned_to_user_id: '',
    due_time: dueTime,
    marks: 0,
    penalty: 0,
    recurrence_rule: 'FREQ=DAILY',
    is_active: true,
    outlet_ids: outletId,
    station: config.station || 'Toilet',
    period,
    photo_required: (config.photo_groups || []).some((group) => String(group.rule).toUpperCase() === 'REQUIRED'),
    sop_id: '',
    display_order: displayOrder,
    checklist_mode: 'operational_checklist',
    estimated_minutes: estimatedMinutes,
    instructions: encodeConfig(config),
  }
}

function quickToiletConfig() {
  const status = (id, nameCn, nameEn, instructionCn, instructionEn) => ({
    id,
    name: nameEn,
    name_cn: nameCn,
    name_en: nameEn,
    instruction: instructionEn,
    instruction_cn: instructionCn,
    instruction_en: instructionEn,
    completion_standard_cn: '发现问题必须立即处理；无法处理时报告异常。',
    completion_standard_en: 'Take immediate action. Report an issue when it cannot be corrected.',
    response_type: 'STATUS',
    required: true,
    options: ['Good', 'Action Taken', 'Issue'],
    pass_values: ['Good', 'Action Taken'],
    fail_values: ['Issue'],
    allow_na: false,
    photo_group_id: 'toilet-quick-issue',
    corrective_action_on_fail: true,
  })
  return {
    version: 3,
    kind: 'operational_checklist',
    checklist_key: 'toilet-quick-check',
    icon_key: 'toilet-quick-check',
    category: 'hygiene',
    station: 'Toilet',
    title_cn: '厕所快速检查',
    title_en: 'Toilet Quick Check',
    instruction_cn: '营业期间检查补充品、垃圾、积水、异味及明显卫生问题。发现问题立即处理。',
    instruction_en: 'During business hours, check supplies, rubbish, wet floors, odour and visible hygiene problems. Correct issues immediately.',
    completion_standard_cn: '厕纸与洗手液充足、垃圾未满、地面干燥、无明显异味或卫生问题。',
    completion_standard_en: 'Toilet paper and soap are available, bins are not full, floors are dry, and there is no obvious odour or hygiene issue.',
    timezone: 'Asia/Kuching',
    schedule: {
      shift_id: 'MORNING',
      shift_name: 'Morning Shift',
      shift_name_cn: '早班',
      shift_name_en: 'Morning Shift',
      open_time: '10:00',
      open_day_offset: 0,
      due_time: '20:45',
      due_day_offset: 0,
      lock_time: '20:59',
      lock_day_offset: 0,
    },
    sections: [{
      id: 'quick-check',
      name: 'Quick Check',
      name_cn: '营业期间快速检查',
      name_en: 'Business Hours Quick Check',
      items: [
        status('tq-01', '检查并补充厕纸', 'Check and refill toilet paper', '厕纸不足时立即补充。', 'Refill toilet paper immediately when low.'),
        status('tq-02', '检查并补充洗手液', 'Check and refill hand wash', '洗手液不足时立即补充。', 'Refill hand wash immediately when low.'),
        status('tq-03', '检查垃圾桶', 'Check rubbish bin', '垃圾接近满时立即清空并更换垃圾袋。', 'Empty the bin and replace the liner before it becomes full.'),
        status('tq-04', '检查地面积水', 'Check wet floor', '发现水迹立即清理并保持地面干燥。', 'Clean water immediately and keep the floor dry.'),
        status('tq-05', '检查异味与卫生问题', 'Check odour and hygiene', '发现异味、污渍或其他卫生问题立即处理。', 'Correct odour, stains or other hygiene problems immediately.'),
      ],
    }],
    photo_groups: [{
      id: 'toilet-quick-issue',
      name: 'Quick Check Issue',
      name_cn: '快速检查异常',
      name_en: 'Quick Check Issue',
      rule: 'ON_FAIL',
      min_photos: 1,
      max_photos: 3,
      capture_mode: 'CAMERA_ONLY',
      sample_caption_cn: '只在发现异常时拍摄问题位置与处理结果。',
      sample_caption_en: 'Only photograph the problem area and corrective result when an issue is found.',
    }],
  }
}

function fullToiletConfig() {
  const step = (id, nameCn, nameEn, instructionCn, instructionEn, group) => ({
    id,
    name: nameEn,
    name_cn: nameCn,
    name_en: nameEn,
    instruction: instructionEn,
    instruction_cn: instructionCn,
    instruction_en: instructionEn,
    completion_standard_cn: '完成清洁、消毒、补充并确认无明显污渍或异味。',
    completion_standard_en: 'Clean, sanitize, refill and confirm there is no visible dirt or odour.',
    response_type: 'CHECKBOX',
    required: true,
    pass_values: ['Done'],
    fail_values: [],
    allow_na: false,
    photo_group_id: group,
  })
  return {
    version: 3,
    kind: 'operational_checklist',
    checklist_key: 'toilet-full-cleaning',
    icon_key: 'toilet-full-cleaning',
    category: 'hygiene',
    station: 'Toilet',
    title_cn: '厕所完整清洁',
    title_en: 'Toilet Full Cleaning',
    instruction_cn: '按照步骤完成厕所完整清洁。晚上 9:00 前不可开始；开放时间由 Sheet 配置控制。',
    instruction_en: 'Complete every full-cleaning step. The task cannot start before 9:00 PM; the opening time is controlled by the Sheet configuration.',
    completion_standard_cn: '洗手盆、镜子、马桶、墙角、垃圾桶及地面全部清洁消毒，补充品充足，地面干燥。',
    completion_standard_en: 'Basin, mirror, toilet, corners, bin and floor are cleaned and sanitized, supplies are refilled, and the floor is dry.',
    timezone: 'Asia/Kuching',
    schedule: {
      shift_id: 'NIGHT',
      shift_name: 'Evening Shift',
      shift_name_cn: '晚班',
      shift_name_en: 'Evening Shift',
      open_time: '21:00',
      open_day_offset: 0,
      due_time: '23:00',
      due_day_offset: 0,
      lock_time: '23:30',
      lock_day_offset: 0,
    },
    sections: [{
      id: 'toilet-full',
      name: 'Full Cleaning Steps',
      name_cn: '完整清洁步骤',
      name_en: 'Full Cleaning Steps',
      items: [
        step('tf-01', '清洁洗手盆与镜子', 'Clean basin and mirror', '清洁并消毒洗手盆、台面、水龙头和洗手液容器；镜面无水痕。', 'Clean and sanitize the basin, counter, faucet and soap dispenser; leave the mirror streak-free.', 'toilet-basin'),
        step('tf-02', '清洁马桶内外', 'Clean toilet bowl inside and outside', '刷洗并消毒马桶内外、边缘及座圈。', 'Scrub and sanitize the toilet bowl inside and outside, including the rim and seat.', 'toilet-bowl'),
        step('tf-03', '补充厕纸', 'Refill toilet paper', '补充足够厕纸并确认可正常使用。', 'Refill enough toilet paper and confirm it is ready for use.', 'toilet-bowl'),
        step('tf-04', '补充洗手液', 'Refill hand wash', '补充洗手液并擦净容器表面。', 'Refill hand wash and wipe the dispenser clean.', 'toilet-basin'),
        step('tf-05', '清洁拖把', 'Clean the mop', '清洁并消毒拖把，使用后晾干。', 'Clean and sanitize the mop and leave it to dry.', 'toilet-overview'),
        step('tf-06', '清洁墙面和角落', 'Clean walls and corners', '清除墙面污渍、角落灰尘和蜘蛛网。', 'Remove wall splashes, corner dust and cobwebs.', 'toilet-overview'),
        step('tf-07', '清空垃圾桶', 'Empty rubbish bin', '清空垃圾并更换新垃圾袋，擦净垃圾桶。', 'Empty the rubbish, replace the liner and wipe the bin clean.', 'toilet-overview'),
        step('tf-08', '扫地及拖地', 'Sweep and mop the floor', '先扫地再拖地，完成后保持地面干燥。', 'Sweep before mopping and leave the floor dry.', 'toilet-floor'),
      ],
    }],
    photo_groups: [
      { id: 'toilet-overview', name: 'Toilet Overview', name_cn: '厕所全景', name_en: 'Toilet Overview', rule: 'REQUIRED', min_photos: 1, max_photos: 1, capture_mode: 'CAMERA_ONLY', sample_caption_cn: '从入口拍摄厕所全景，范围包括垃圾桶、墙角及整体整洁状态。', sample_caption_en: 'Photograph the full toilet from the entrance, including the bin, corners and overall cleanliness.' },
      { id: 'toilet-basin', name: 'Basin and Mirror', name_cn: '洗手盆与镜子', name_en: 'Basin and Mirror', rule: 'REQUIRED', min_photos: 1, max_photos: 1, capture_mode: 'CAMERA_ONLY', sample_caption_cn: '完整拍到洗手盆、镜子、水龙头和洗手液。', sample_caption_en: 'Include the basin, mirror, faucet and hand wash in the frame.' },
      { id: 'toilet-bowl', name: 'Toilet Bowl', name_cn: '马桶', name_en: 'Toilet Bowl', rule: 'REQUIRED', min_photos: 1, max_photos: 1, capture_mode: 'CAMERA_ONLY', sample_caption_cn: '拍摄清洁后的马桶内外与厕纸。', sample_caption_en: 'Photograph the cleaned toilet bowl inside and outside together with toilet paper.' },
      { id: 'toilet-floor', name: 'Indoor Floor', name_cn: '厕所地面', name_en: 'Indoor Floor', rule: 'REQUIRED', min_photos: 1, max_photos: 1, capture_mode: 'CAMERA_ONLY', sample_caption_cn: '拍摄完成后的干燥地面和墙角。', sample_caption_en: 'Photograph the dry finished floor and corners.' },
    ],
  }
}

function upgradeOpeningConfig(existing) {
  const config = structuredClone(existing)
  config.version = 3
  config.timezone = 'Asia/Kuching'
  config.title_cn = '开档备料检查'
  config.title_en = 'Opening Preparation Check'
  config.instruction_cn = '按标准数量与储存状态检查开档备料，实际不足时记录补充结果。'
  config.instruction_en = 'Check opening preparation against required quantities and storage conditions. Record replenishment when stock is short.'
  config.completion_standard_cn = '关键备料数量达到标准并储存正确；不足或错误状态必须记录处理方式。'
  config.completion_standard_en = 'Critical preparation meets required quantities and storage standards; shortages or incorrect storage require corrective action.'
  config.schedule = {
    ...config.schedule,
    shift_name_cn: '早班',
    shift_name_en: 'Morning Shift',
  }
  const section = (config.sections || []).find((row) => row.id === 'frozen')
  if (section) {
    section.name_cn = '肉饼与冷冻品'
    section.name_en = 'Patty and Frozen Items'
    const pork = (section.items || []).find((row) => row.id === 'op-11')
    if (pork) Object.assign(pork, {
      name_cn: '猪肉饼',
      name_en: 'Pork Patty',
      instruction_cn: '标准数量：2 Containers。填写实际数量。',
      instruction_en: 'Required quantity: 2 containers. Enter the actual quantity.',
      completion_standard_cn: '数量足够，或不足后已补充；无库存必须报告异常。',
      completion_standard_en: 'Quantity is sufficient or has been refilled; out of stock must be reported.',
      response_type: 'QUANTITY',
      unit: 'Containers',
      required_quantity: 2,
      options: ['Sufficient', 'Refilled', 'Out of Stock'],
      fail_values: [],
      corrective_action_on_fail: false,
    })
    if (!(section.items || []).some((row) => row.id === 'op-11-storage')) {
      const index = Math.max(0, (section.items || []).findIndex((row) => row.id === 'op-11'))
      section.items.splice(index + 1, 0, {
        id: 'op-11-storage',
        name: 'Pork Patty Storage Condition',
        name_cn: '猪肉饼储存状态',
        name_en: 'Pork Patty Storage Condition',
        instruction_cn: '选择当前实际储存或解冻状态。',
        instruction_en: 'Select the actual storage or defrosting condition.',
        completion_standard_cn: '储存状态必须符合备料要求。',
        completion_standard_en: 'Storage condition must meet the preparation standard.',
        response_type: 'STATUS',
        required: true,
        options: ['Frozen', 'Chilled', 'Room Temperature', 'Defrosting', 'Incorrect Storage'],
        pass_values: ['Frozen', 'Chilled', 'Defrosting'],
        fail_values: ['Room Temperature', 'Incorrect Storage'],
        allow_na: false,
        photo_group_id: 'opening-frozen',
        corrective_action_on_fail: true,
      })
    }
  }
  return config
}

function rowObject(headers, values) {
  return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
}

function rowValues(headers, object) {
  return headers.map((header) => object[header] ?? '')
}

function columnName(index) {
  let value = index + 1
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

async function main() {
  if (!varsPath) throw new Error('No .dev.vars or worker/.dev.vars was found')
  const env = parseEnv(await fs.readFile(varsPath, 'utf8'))
  const spreadsheetId = required(env, 'GOOGLE_MASTER_SPREADSHEET_ID')
  const token = await accessToken(env)
  const range = encodeURIComponent("'TaskTemplates'!A:ZZ")
  const sheet = await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, { token })
  const values = sheet.values || []
  if (!values.length) throw new Error('TaskTemplates sheet is empty')
  const headers = values[0].map(clean)
  if (!headers.includes('id') || !headers.includes('instructions')) throw new Error('TaskTemplates headers are incomplete')
  const rows = values.slice(1).map((row, index) => ({ rowNumber: index + 2, values: row, object: rowObject(headers, row) }))
  const byId = new Map(rows.map((row) => [clean(row.object.id), row]))
  const timestamp = new Date().toISOString()

  const openingRow = byId.get('tmpl-rr-opening-checklist-v3')
  if (!openingRow) throw new Error('Opening checklist template tmpl-rr-opening-checklist-v3 was not found')
  const openingConfig = parseConfig(openingRow.object)
  if (!openingConfig) throw new Error('Opening checklist config could not be parsed')

  const desired = [
    {
      ...openingRow.object,
      title: 'Opening Preparation Check',
      description: 'Bilingual quantity, status and storage-condition opening preparation check.',
      updated_date: timestamp,
      updated_by: 'task-v3-upgrade@stupiaks-ops',
      version: Number(openingRow.object.version || 0) + 1,
      instructions: encodeConfig(upgradeOpeningConfig(openingConfig)),
    },
    baseTemplate({ id: 'tmpl-rr-toilet-quick-v3', name: 'toilet-quick-check', title: 'Toilet Quick Check', description: 'Business-hours toilet supply and hygiene quick check.', period: 'MORNING', dueTime: '20:45', displayOrder: 2, estimatedMinutes: 5, config: quickToiletConfig(), timestamp }),
    baseTemplate({ id: 'tmpl-rr-toilet-full-v3', name: 'toilet-full-cleaning', title: 'Toilet Full Cleaning', description: 'Full bilingual toilet cleaning available after the configured evening opening time.', period: 'NIGHT', dueTime: '23:00', displayOrder: 3, estimatedMinutes: 20, config: fullToiletConfig(), timestamp }),
  ]

  const deactivateIds = ['tmpl-rr-toilet-morning-v3']
  const changes = []
  const updates = []
  const appends = []
  const endColumn = columnName(headers.length - 1)

  for (const object of desired) {
    const existing = byId.get(object.id)
    if (existing) {
      const merged = { ...existing.object, ...object, created_date: existing.object.created_date || timestamp, created_by: existing.object.created_by || 'task-v3-upgrade@stupiaks-ops' }
      updates.push({ range: `'TaskTemplates'!A${existing.rowNumber}:${endColumn}${existing.rowNumber}`, majorDimension: 'ROWS', values: [rowValues(headers, merged)] })
      changes.push({ id: object.id, action: 'update', row: existing.rowNumber, title: merged.title, period: merged.period, due_time: merged.due_time })
    } else {
      appends.push(rowValues(headers, object))
      changes.push({ id: object.id, action: 'append', title: object.title, period: object.period, due_time: object.due_time })
    }
  }

  for (const id of deactivateIds) {
    const existing = byId.get(id)
    if (!existing) continue
    const merged = { ...existing.object, is_active: false, status: 'legacy', updated_date: timestamp, updated_by: 'task-v3-upgrade@stupiaks-ops', version: Number(existing.object.version || 0) + 1 }
    updates.push({ range: `'TaskTemplates'!A${existing.rowNumber}:${endColumn}${existing.rowNumber}`, majorDimension: 'ROWS', values: [rowValues(headers, merged)] })
    changes.push({ id, action: 'deactivate', row: existing.rowNumber, title: merged.title })
  }

  const report = {
    schema: 'stupiaks-task-template-upgrade-v3',
    generated_at: timestamp,
    mode: apply ? 'apply' : 'dry-run',
    outlet_id: outletId,
    spreadsheet_id: spreadsheetId,
    changes,
    writes_performed: false,
    config_summary: {
      toilet_quick_open: '10:00',
      toilet_quick_due: '20:45',
      toilet_full_open: '21:00',
      toilet_full_due: '23:00',
      toilet_full_required_photos: 4,
      timezone: 'Asia/Kuching',
      opening_quantity_item: 'Pork Patty',
      opening_storage_item: 'Pork Patty Storage Condition',
    },
  }

  if (apply) {
    if (updates.length) await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, { token, method: 'POST', body: { valueInputOption: 'RAW', data: updates } })
    if (appends.length) {
      const appendRange = encodeURIComponent("'TaskTemplates'!A:ZZ")
      await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { token, method: 'POST', body: { majorDimension: 'ROWS', values: appends } })
    }
    report.writes_performed = true
  }

  await fs.mkdir(REPORT_DIR, { recursive: true })
  const safeTime = timestamp.replaceAll(':', '-').replaceAll('.', '-')
  const reportPath = path.join(REPORT_DIR, `${outletId}-task-template-v3-${apply ? 'apply' : 'dry-run'}-${safeTime}.json`)
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  console.log(`\n${apply ? '✅ Task Template v3 applied' : '✅ Task Template v3 dry run completed'}`)
  console.log(`Outlet: ${outletId}`)
  console.log(`Changes: ${changes.length}`)
  for (const change of changes) console.log(`- ${change.action}: ${change.id} · ${change.title || ''}`)
  console.log(`Report: ${reportPath}`)
  if (!apply) console.log('No Google Sheet rows were changed. Run again with --apply only after reviewing this report.')
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`)
  process.exitCode = 1
})
