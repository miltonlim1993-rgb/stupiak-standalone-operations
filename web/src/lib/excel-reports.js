import ExcelJS from 'exceljs'
import { buildTaskPerformance, minutesBetween } from '@/lib/performance'

const BRAND_YELLOW = 'FFF6B900'
const BRAND_BLACK = 'FF161616'
const LIGHT_YELLOW = 'FFFFF4CC'
const LIGHT_GREY = 'FFF3F4F6'
const BORDER = 'FFD1D5DB'

const SECTION_ORDER = ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary']

function safeFilePart(value) {
  return String(value || '').replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/^_+|_+$/g, '')
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function statusFor(actual, minimum) {
  if (actual === '' || actual == null || Number.isNaN(Number(actual))) return 'NOT COUNTED'
  const qty = Number(actual)
  const min = Number(minimum || 0)
  if (min <= 0) return 'NO MIN'
  return qty <= min ? 'ORDER' : 'OK'
}

function sectionFor(item) {
  const source = String(item.source_sheet || '').trim()
  if (SECTION_ORDER.includes(source)) return source
  const category = String(item.category || '')
  if (category === 'Food & Ingredients') return 'Inventory'
  if (category === 'Packaging & Utensils') return 'Untensil PG1'
  if (category === 'Cleaning & Operations') return 'Utensil PG2'
  if (category === 'Stationery') return 'Stationary'
  return source || 'Other'
}

function monthKeys(fromDate, toDate) {
  const start = new Date(`${fromDate}T00:00:00`)
  const end = new Date(`${toDate}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return []
  const result = []
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  const last = new Date(end.getFullYear(), end.getMonth(), 1)
  while (cursor <= last) {
    result.push({
      key: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
      label: cursor.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
      short: cursor.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }).replace(' ', ''),
    })
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return result
}

function weekOfMonth(dateValue) {
  const day = Number(String(dateValue || '').slice(8, 10))
  return Math.max(1, Math.min(5, Math.ceil((day || 1) / 7)))
}

function stockIdentity(record = {}) {
  const stockListId = String(record.stock_list_id || record.id || '').trim()
  if (stockListId) return `list:${stockListId}`
  return `name:${String(record.item_name || '').trim().toLowerCase()}`
}

function countIndex(stockCounts) {
  const map = new Map()
  for (const count of stockCounts || []) {
    const outletId = String(count.outlet_id || '')
    const identity = stockIdentity(count)
    const date = String(count.count_date || '').slice(0, 10)
    if (!outletId || !identity || !date) continue
    map.set(`${outletId}|${identity}|${date}`, count)
    const nameIdentity = `name:${String(count.item_name || '').trim().toLowerCase()}`
    if (nameIdentity !== identity) map.set(`${outletId}|${nameIdentity}|${date}`, count)
  }
  return map
}

function latestCountInMonth(index, item, monthKey) {
  const outletId = String(item.outlet_id || '')
  const prefixes = [stockIdentity(item), `name:${String(item.item_name || '').trim().toLowerCase()}`]
    .map((identity) => `${outletId}|${identity}|${monthKey}`)
  let found = null
  for (const [key, value] of index.entries()) {
    if (!prefixes.some((prefix) => key.startsWith(prefix))) continue
    if (!found || String(value.count_date) > String(found.count_date)) found = value
  }
  return found
}

function weeklyCounts(index, item, monthKey) {
  const result = Array(5).fill(null)
  const outletId = String(item.outlet_id || '')
  const prefixes = [stockIdentity(item), `name:${String(item.item_name || '').trim().toLowerCase()}`]
    .map((identity) => `${outletId}|${identity}|${monthKey}`)
  for (const [key, value] of index.entries()) {
    if (!prefixes.some((prefix) => key.startsWith(prefix))) continue
    const week = weekOfMonth(value.count_date) - 1
    if (!result[week] || String(value.count_date) > String(result[week].count_date)) result[week] = value
  }
  return result
}

function borderStyle() {
  return {
    top: { style: 'thin', color: { argb: BORDER } },
    left: { style: 'thin', color: { argb: BORDER } },
    bottom: { style: 'thin', color: { argb: BORDER } },
    right: { style: 'thin', color: { argb: BORDER } },
  }
}

function styleTitle(sheet, range, title, subtitle = '') {
  sheet.mergeCells(range)
  const cell = sheet.getCell(range.split(':')[0])
  cell.value = title
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_BLACK } }
  cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 16 }
  cell.alignment = { vertical: 'middle', horizontal: 'left' }
  sheet.getRow(cell.row).height = 28
  if (subtitle) {
    const row = cell.row + 1
    sheet.getCell(row, 1).value = subtitle
    sheet.getCell(row, 1).font = { color: { argb: 'FF6B7280' }, italic: true, size: 10 }
  }
}

function styleHeaderRow(row) {
  row.height = 24
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_YELLOW } }
    cell.font = { color: { argb: BRAND_BLACK }, bold: true }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = borderStyle()
  })
}

function styleDataRange(sheet, startRow, endRow, startCol, endCol) {
  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      const cell = sheet.getCell(row, col)
      cell.border = borderStyle()
      cell.alignment = { vertical: 'middle', wrapText: true }
      if (row % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } }
    }
  }
}

function latestStockCount(item, stockCounts = []) {
  const identities = new Set([stockIdentity(item), `name:${String(item.item_name || '').trim().toLowerCase()}`])
  return (stockCounts || [])
    .filter((row) => String(row.outlet_id || '') === String(item.outlet_id || '') && identities.has(stockIdentity(row)))
    .sort((a, b) => String(b.count_date || '').localeCompare(String(a.count_date || '')))[0] || null
}

function reorderQuantity(item, actual) {
  const target = Number(item.target_stock_qty ?? item.target_qty ?? 0)
  const minimumOrder = Number(item.minimum_order_purchase_qty ?? item.minimum_order_qty ?? 0)
  const unitsPerPurchase = Math.max(1, Number(item.units_per_purchase_uom || item.default_units_per_purchase_uom || 1))
  if (!Number.isFinite(actual)) return ''
  const neededCountUnits = Math.max(0, target - actual)
  const neededPurchaseUnits = Math.ceil(neededCountUnits / unitsPerPurchase)
  return Math.max(neededPurchaseUnits, actual <= Number(item.min_threshold ?? item.minimum_qty ?? 0) ? minimumOrder : 0)
}

function dateText(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function startOfRosterWeek(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() - date.getDay())
  return date
}

function weeklyWindows(fromDate, toDate) {
  const first = startOfRosterWeek(fromDate)
  const last = new Date(`${toDate}T00:00:00`)
  if (!first || Number.isNaN(last.getTime())) return []
  const result = []
  const cursor = new Date(first)
  while (cursor <= last) {
    const end = new Date(cursor)
    end.setDate(end.getDate() + 6)
    result.push({
      start: dateText(cursor),
      end: dateText(end),
      label: `${formatDate(dateText(cursor))} - ${formatDate(dateText(end))}`,
    })
    cursor.setDate(cursor.getDate() + 7)
  }
  return result
}

function latestStockCountInWindow(item, stockCounts, start, end) {
  const identities = new Set([stockIdentity(item), `name:${String(item.item_name || '').trim().toLowerCase()}`])
  return (stockCounts || [])
    .filter((row) => {
      const date = String(row.count_date || '').slice(0, 10)
      return String(row.outlet_id || '') === String(item.outlet_id || '')
        && identities.has(stockIdentity(row))
        && date >= start && date <= end
    })
    .sort((a, b) => String(b.count_date || '').localeCompare(String(a.count_date || '')))[0] || null
}

function orderRowsForWindow({ inventory, stockCounts, week, sections, outletNames }) {
  const rows = []
  for (const item of inventory || []) {
    if (!sections.includes(sectionFor(item))) continue
    const latest = latestStockCountInWindow(item, stockCounts, week.start, week.end)
    if (!latest || latest.actual_qty === '' || latest.actual_qty == null || Number.isNaN(Number(latest.actual_qty))) continue
    const actual = Number(latest.actual_qty)
    const minimum = Number(item.min_threshold ?? item.minimum_qty ?? 0)
    if (minimum <= 0 || actual > minimum) continue
    rows.push({
      outlet: outletNames.get(String(item.outlet_id || '')) || item.outlet_id || '',
      item: item.item_name || '',
      actual,
      countUom: item.unit || item.count_uom || '',
      orderQty: reorderQuantity(item, actual),
      purchaseUom: item.purchase_uom || '',
      status: actual <= 0 ? 'URGENT' : 'ORDER',
      countDate: latest.count_date || '',
      countedBy: latest.counted_by || latest.counted_by_email || latest.created_by || '',
    })
  }
  return rows.sort((a, b) => String(a.outlet).localeCompare(String(b.outlet)) || String(a.item).localeCompare(String(b.item)))
}

function latestStationaryInRange(item, stockCounts, fromDate, toDate) {
  return latestStockCountInWindow(item, stockCounts, fromDate, toDate)
}

function addOrderPage(workbook, { fromDate, toDate, inventory = [], stockCounts = [], outlets = [] }) {
  const outletNames = outletNameMap(outlets)
  const sheet = workbook.addWorksheet('Order Page', { views: [{ state: 'frozen', ySplit: 2 }] })
  sheet.columns = [
    { key: 'item', width: 38 },
    { key: 'outlet', width: 28 },
    { key: 'current', width: 14 },
    { key: 'unit', width: 14 },
    { key: 'order', width: 16 },
    { key: 'purchase', width: 16 },
    { key: 'status', width: 14 },
    { key: 'date', width: 14 },
  ]
  sheet.mergeCells('A1:H1')
  const title = sheet.getCell('A1')
  title.value = 'WEEKLY STOCK ORDER PAGE'
  title.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_BLACK } }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  sheet.getRow(1).height = 28
  sheet.mergeCells('A2:H2')
  sheet.getCell('A2').value = `Generated from actual Stock Count records · ${formatDate(fromDate)} to ${formatDate(toDate)}`
  sheet.getCell('A2').alignment = { horizontal: 'center' }
  sheet.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } }

  const addSection = (heading, rows, dateLabel = '') => {
    const headingRow = sheet.addRow([heading, '', '', '', '', '', '', dateLabel])
    sheet.mergeCells(headingRow.number, 1, headingRow.number, 7)
    headingRow.height = 23
    headingRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_YELLOW } }
      cell.font = { bold: true, color: { argb: BRAND_BLACK } }
      cell.alignment = { vertical: 'middle' }
      cell.border = { top: { style: 'thin', color: { argb: BRAND_BLACK } }, bottom: { style: 'thin', color: { argb: BRAND_BLACK } } }
    })
    const header = sheet.addRow(['Item', 'Outlet', 'Current Qty', 'Count Unit', 'Need Order', 'Purchase Unit', 'Status', 'Count Date'])
    styleHeaderRow(header)
    if (!rows.length) {
      const empty = sheet.addRow(['No items need ordering in this section.', '', '', '', '', '', 'OK', ''])
      sheet.mergeCells(empty.number, 1, empty.number, 6)
      empty.getCell(7).font = { bold: true, color: { argb: 'FF047857' } }
    } else {
      rows.forEach((row) => {
        const output = sheet.addRow([row.item, row.outlet, row.actual, row.countUom, row.orderQty, row.purchaseUom, row.status, row.countDate])
        if (row.status === 'URGENT') output.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } }
        else output.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_YELLOW } }
        output.getCell(7).font = { bold: true }
      })
    }
    const spacer = sheet.addRow([])
    spacer.height = 6
  }

  const weeks = weeklyWindows(fromDate, toDate).slice(0, 5)
  weeks.forEach((week, index) => {
    const weekRow = sheet.addRow([`WEEK ${index + 1}`, '', '', '', '', '', '', week.label])
    sheet.mergeCells(weekRow.number, 1, weekRow.number, 7)
    weekRow.height = 25
    weekRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_BLACK } }
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.alignment = { vertical: 'middle' }
    })
    addSection('Inventory Order List', orderRowsForWindow({ inventory, stockCounts, week, sections: ['Inventory'], outletNames }), week.label)
    addSection('Utensil Order List', orderRowsForWindow({ inventory, stockCounts, week, sections: ['Untensil PG1', 'Utensil PG2'], outletNames }), week.label)
  })

  const stationaryRows = []
  for (const item of inventory || []) {
    if (sectionFor(item) !== 'Stationary') continue
    const latest = latestStationaryInRange(item, stockCounts, fromDate, toDate)
    if (!latest || latest.actual_qty === '' || latest.actual_qty == null || Number.isNaN(Number(latest.actual_qty))) continue
    const actual = Number(latest.actual_qty)
    const minimum = Number(item.min_threshold ?? item.minimum_qty ?? 0)
    if (minimum <= 0 || actual > minimum) continue
    stationaryRows.push({
      outlet: outletNames.get(String(item.outlet_id || '')) || item.outlet_id || '', item: item.item_name || '', actual,
      countUom: item.unit || item.count_uom || '', orderQty: reorderQuantity(item, actual), purchaseUom: item.purchase_uom || '',
      status: actual <= 0 ? 'URGENT' : 'ORDER', countDate: latest.count_date || '',
    })
  }
  addSection('Stationary Stock (MONTHLY)', stationaryRows.sort((a, b) => String(a.outlet).localeCompare(String(b.outlet)) || String(a.item).localeCompare(String(b.item))), `${formatDate(fromDate)} – ${formatDate(toDate)}`)

  styleDataRange(sheet, 3, Math.max(3, sheet.rowCount), 1, 8)
  sheet.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } }
  sheet.autoFilter = undefined
}

function addPerformanceSheets(workbook, { tasks = [], templates = [], users = [], outlets = [], asOfDate = '' }) {
  const performance = buildTaskPerformance({ tasks, templates, users, outlets, asOfDate })
  const definitions = [
    ['Outlet Performance', performance.outlets, false],
    ['Staff Performance', performance.people, true],
  ]
  for (const [name, rows, includeEmail] of definitions) {
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
    sheet.columns = [
      { header: includeEmail ? 'Staff' : 'Outlet', key: 'name', width: 30 },
      ...(includeEmail ? [{ header: 'Email', key: 'email', width: 30 }] : []),
      { header: 'Scheduled', key: 'scheduled', width: 12 },
      { header: 'Completed', key: 'completed', width: 12 },
      { header: 'Missed', key: 'missed', width: 12 },
      { header: 'Open', key: 'open', width: 10 },
      { header: 'Completion %', key: 'completion_rate', width: 15 },
      { header: 'Points', key: 'points', width: 12 },
      { header: 'Penalties', key: 'penalties', width: 12 },
      { header: 'Net Score', key: 'net_score', width: 12 },
    ]
    styleHeaderRow(sheet.getRow(1))
    rows.forEach((row) => sheet.addRow(row))
    if (!rows.length) sheet.addRow({ name: 'No task performance data in this period.' })
    styleDataRange(sheet, 2, Math.max(2, sheet.rowCount), 1, sheet.columnCount)
    sheet.autoFilter = { from: 'A1', to: sheet.getRow(1).getCell(sheet.columnCount).address }
  }

  const daily = workbook.addWorksheet('Daily Score', { views: [{ state: 'frozen', ySplit: 1 }] })
  daily.columns = [
    { header: 'Date', key: 'date', width: 14 }, { header: 'Scheduled', key: 'scheduled', width: 12 },
    { header: 'Completed', key: 'completed', width: 12 }, { header: 'Missed', key: 'missed', width: 12 },
    { header: 'Completion %', key: 'completion_rate', width: 15 }, { header: 'Points', key: 'points', width: 12 },
    { header: 'Penalties', key: 'penalties', width: 12 }, { header: 'Net Score', key: 'net_score', width: 12 },
  ]
  styleHeaderRow(daily.getRow(1))
  performance.daily.forEach((row) => daily.addRow(row))
  styleDataRange(daily, 2, Math.max(2, daily.rowCount), 1, 8)
  daily.autoFilter = { from: 'A1', to: 'H1' }
}

function addTrainingAttemptsSheet(workbook, { attempts = [], courses = [], outlets = [] }) {
  const outletNames = outletNameMap(outlets)
  const courseNames = new Map((courses || []).map((row) => [String(row.id || ''), row.title || row.id || '']))
  const sheet = workbook.addWorksheet('Training Attempts', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: 'Outlet', key: 'outlet_name', width: 28 }, { header: 'Staff', key: 'user_name', width: 22 },
    { header: 'Email', key: 'user_email', width: 30 }, { header: 'Course', key: 'course_name', width: 34 },
    { header: 'Score', key: 'score', width: 10 }, { header: 'Passed', key: 'passed', width: 10 },
    { header: 'Started At', key: 'started_at', width: 22 }, { header: 'Submitted At', key: 'submitted_at', width: 22 },
    { header: 'Duration (min)', key: 'duration_minutes', width: 16 },
  ]
  styleHeaderRow(sheet.getRow(1))
  attempts.forEach((row) => sheet.addRow({
    ...row,
    outlet_name: outletNames.get(String(row.outlet_id || '')) || row.outlet_id || '',
    course_name: courseNames.get(String(row.course_id || '')) || row.course_id || '',
    passed: row.passed === true || String(row.passed).toLowerCase() === 'true' ? 'YES' : 'NO',
    duration_minutes: minutesBetween(row.started_at, row.submitted_at),
  }))
  if (!attempts.length) sheet.addRow(['', '', '', 'No quiz attempts in this period.', '', '', '', '', ''])
  styleDataRange(sheet, 2, Math.max(2, sheet.rowCount), 1, 9)
  sheet.autoFilter = { from: 'A1', to: 'I1' }
}

function addSummarySheet(workbook, { fromDate, toDate, tasks, inventory, stockCounts, taskPhotos = [], taskTemplatePhotos = [], trainingAssignments = [], trainingProgress = [], outlets = [] }) {
  const sheet = workbook.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 3 }] })
  sheet.properties.defaultRowHeight = 20
  sheet.columns = [
    { key: 'label', width: 30 },
    { key: 'value', width: 18 },
    { key: 'notes', width: 48 },
  ]
  styleTitle(sheet, 'A1:C1', 'Stupiak’s Ops — Operations Report')
  sheet.getCell('A2').value = `Period: ${formatDate(fromDate)} to ${formatDate(toDate)}`
  sheet.getCell('A2').font = { color: { argb: 'FF6B7280' }, size: 10 }
  sheet.addRow([])
  const header = sheet.addRow(['Metric', 'Value', 'Notes'])
  styleHeaderRow(header)
  const done = tasks.filter((task) => task.status === 'done').length
  const photoRequired = tasks.filter((task) => task.photo_required === true || String(task.photo_required).toLowerCase() === 'true').length
  const photoCompleted = taskPhotos.filter((row) => row.photo_type === 'completion').length || tasks.filter((task) => task.completion_photo_url).length
  const samplePhotos = taskTemplatePhotos.length || tasks.filter((task) => task.reference_photo_url).length
  const trainingCompleted = trainingProgress.filter((row) => row.status === 'completed').length
  const stockListRows = outlets.map((outlet) => [
    `${outlet.name || outlet.code || outlet.id} list items`,
    inventory.filter((item) => String(item.outlet_id || '') === String(outlet.id || '')).length,
    'Enabled rows in OutletStockLists',
  ])
  const rows = [
    ['Outlets', outlets.length, outlets.map((row) => row.name || row.code || row.id).join(', ')],
    ['Tasks', tasks.length, 'Selected date range'],
    ['Tasks completed', done, `${tasks.length ? Math.round((done / tasks.length) * 100) : 0}% completion`],
    ['Photo-required tasks', photoRequired, `${photoCompleted} completion photos; ${samplePhotos} sample photos`],
    ...stockListRows,
    ['Stock count records', stockCounts.length, 'Actual counts only; no combined stock quantity'],
    ['Training assignments', trainingAssignments.length, `${trainingCompleted} completed`],
  ]
  rows.forEach((row) => sheet.addRow(row))
  styleDataRange(sheet, header.number + 1, header.number + rows.length, 1, 3)
  sheet.getColumn(2).numFmt = '0'
}

function identityMap(users = []) {
  return new Map(users.map((row) => [String(row.email || '').toLowerCase(), row.full_name || row.email || '']))
}

function outletNameMap(outlets = []) {
  return new Map(outlets.map((row) => [String(row.id || ''), row.name || row.code || row.id || '']))
}

function groupBy(rows = [], key) {
  const map = new Map()
  for (const row of rows) {
    const value = String(row?.[key] || '')
    if (!value) continue
    if (!map.has(value)) map.set(value, [])
    map.get(value).push(row)
  }
  return map
}

function addTasksSheet(workbook, tasks, users = [], outlets = [], taskPhotos = [], taskTemplatePhotos = []) {
  const names = identityMap(users)
  const outletNames = outletNameMap(outlets)
  const evidenceByTask = groupBy(taskPhotos, 'task_id')
  const samplesByTemplate = groupBy(taskTemplatePhotos, 'template_id')
  const sheet = workbook.addWorksheet('Tasks', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: 'Outlet', key: 'outlet_name', width: 28 },
    { header: 'Due Date', key: 'due_date', width: 14 },
    { header: 'Due Time', key: 'due_time', width: 11 },
    { header: 'Area', key: 'category', width: 12 },
    { header: 'Station', key: 'station', width: 20 },
    { header: 'Period', key: 'period', width: 14 },
    { header: 'Task', key: 'title', width: 34 },
    { header: 'Instructions', key: 'description', width: 42 },
    { header: 'Priority', key: 'priority', width: 12 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Assigned Role', key: 'assigned_to_role', width: 16 },
    { header: 'SOP ID', key: 'sop_id', width: 24 },
    { header: 'Template ID', key: 'template_id', width: 30 },
    { header: 'Sample Photos', key: 'sample_count', width: 14 },
    { header: 'Evidence Photos', key: 'evidence_count', width: 14 },
    { header: 'Created By Name', key: 'created_by_name', width: 22 },
    { header: 'Created By Email', key: 'created_by', width: 28 },
    { header: 'Completed By Name', key: 'completed_by_name', width: 22 },
    { header: 'Completed By Email', key: 'completed_by_email', width: 28 },
    { header: 'Completed At', key: 'completed_date', width: 22 },
    { header: 'Photo Required', key: 'photo_required', width: 15 },
    { header: 'Completion Notes', key: 'completion_notes', width: 36 },
  ]
  styleHeaderRow(sheet.getRow(1))
  tasks.forEach((task) => {
    const creatorEmail = String(task.created_by || '')
    const completionEmail = String(task.completed_by_email || '')
    const samples = (samplesByTemplate.get(String(task.template_id || '')) || [])
      .filter((row) => !row.outlet_id || String(row.outlet_id) === String(task.outlet_id || ''))
    const evidence = evidenceByTask.get(String(task.id || '')) || []
    sheet.addRow({
      ...task,
      outlet_name: outletNames.get(String(task.outlet_id || '')) || task.outlet_id || '',
      created_by_name: task.created_by_name || names.get(creatorEmail.toLowerCase()) || creatorEmail,
      completed_by_name: task.completed_by_name || names.get(completionEmail.toLowerCase()) || completionEmail,
      category: String(task.category || 'general').toUpperCase(),
      priority: String(task.priority || '').toUpperCase(),
      status: String(task.status || '').replaceAll('_', ' ').toUpperCase(),
      photo_required: task.photo_required === true || String(task.photo_required).toLowerCase() === 'true' ? 'YES' : 'NO',
      sample_count: samples.length || (task.reference_photo_url ? 1 : 0),
      evidence_count: evidence.length || (task.completion_photo_url ? 1 : 0),
    })
  })
  styleDataRange(sheet, 2, Math.max(2, sheet.rowCount), 1, 22)
  sheet.autoFilter = { from: 'A1', to: 'V1' }
}

async function imageData(url) {
  if (!url) return null
  try {
    const response = await fetch(url, { credentials: 'include' })
    if (!response.ok) return null
    const blob = await response.blob()
    if (!blob.type.startsWith('image/')) return null
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    const extension = blob.type.includes('png') ? 'png' : 'jpeg'
    return { base64, extension }
  } catch {
    return null
  }
}

async function addTaskPhotosSheet(workbook, tasks, taskPhotos = [], taskTemplatePhotos = [], outlets = []) {
  const outletNames = outletNameMap(outlets)
  const taskMap = new Map(tasks.map((task) => [String(task.id || ''), task]))
  const rows = []

  for (const task of tasks) {
    const samples = taskTemplatePhotos.filter((photo) => photo.template_id === task.template_id && (!photo.outlet_id || String(photo.outlet_id) === String(task.outlet_id || '')) && String(photo.enabled).toLowerCase() !== 'false')
    for (const photo of samples) rows.push({ ...photo, task_id: task.id, photo_type: 'sample', task })
    const evidence = taskPhotos.filter((photo) => photo.task_id === task.id && !photo.deleted_at)
    for (const photo of evidence) rows.push({ ...photo, task })
    if (!samples.length && task.reference_photo_url) rows.push({ task_id: task.id, photo_type: 'sample', file_url: task.reference_photo_url, file_name: task.reference_file_name, caption: 'Legacy sample photo', task })
    if (!evidence.length && task.completion_photo_url) rows.push({ task_id: task.id, photo_type: 'completion', file_url: task.completion_photo_url, file_name: task.completion_file_name, caption: task.completion_notes, uploaded_by_name: task.completed_by_name, uploaded_by_email: task.completed_by_email, uploaded_at: task.completed_date, task })
  }

  const sheet = workbook.addWorksheet('Task Photos', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: 'Outlet', width: 28 },
    { header: 'Due Date', width: 14 },
    { header: 'Area', width: 12 },
    { header: 'Station', width: 20 },
    { header: 'Task', width: 34 },
    { header: 'Photo Type', width: 15 },
    { header: 'Photo', width: 30 },
    { header: 'Caption', width: 34 },
    { header: 'Uploaded By', width: 22 },
    { header: 'Uploaded Email', width: 28 },
    { header: 'Uploaded At', width: 22 },
    { header: 'Source Link', width: 26 },
  ]
  styleHeaderRow(sheet.getRow(1))
  if (!rows.length) {
    sheet.addRow(['', '', '', '', 'No task photos in this period.', '', '', '', '', '', '', ''])
    styleDataRange(sheet, 2, 2, 1, 12)
    return
  }

  const maxEmbedded = 80
  for (let index = 0; index < rows.length; index += 1) {
    const photo = rows[index]
    const task = photo.task || taskMap.get(String(photo.task_id || '')) || {}
    const rowNumber = sheet.rowCount + 1
    const row = sheet.addRow([
      outletNames.get(String(task.outlet_id || photo.outlet_id || '')) || task.outlet_id || photo.outlet_id || '',
      task.due_date || '',
      String(task.category || 'general').toUpperCase(),
      task.station || '',
      task.title || '',
      String(photo.photo_type || 'evidence').replaceAll('_', ' ').toUpperCase(),
      photo.file_url ? 'Photo attached' : '',
      photo.caption || photo.file_name || '',
      photo.uploaded_by_name || task.completed_by_name || '',
      photo.uploaded_by_email || task.completed_by_email || '',
      photo.uploaded_at || task.completed_date || '',
      photo.file_url ? 'Open source' : '',
    ])
    row.height = 90
    if (photo.file_url) {
      row.getCell(12).value = { text: 'Open source', hyperlink: photo.file_url }
      if (index < maxEmbedded) {
        const image = await imageData(photo.file_url)
        if (image) {
          const imageId = workbook.addImage(image)
          sheet.addImage(imageId, { tl: { col: 6.05, row: rowNumber - 0.95 }, ext: { width: 175, height: 108 }, editAs: 'oneCell' })
        } else {
          row.getCell(7).value = { text: 'Open photo', hyperlink: photo.file_url }
        }
      }
    }
  }
  styleDataRange(sheet, 2, sheet.rowCount, 1, 12)
  sheet.autoFilter = { from: 'A1', to: 'L1' }
}

function sheetName(monthShort, section, outletCode = '') {
  const shortSection = {
    'Untensil PG1': 'Utensil1',
    'Utensil PG2': 'Utensil2',
    Stationary: 'Stationary',
    Inventory: 'Inventory',
  }[section] || section
  const prefix = safeFilePart(outletCode).slice(0, 8)
  return `${prefix ? `${prefix}-` : ''}${monthShort}-${shortSection}`.slice(0, 31)
}

function setupStockTitle(sheet, title, lastColumn) {
  styleTitle(sheet, `A1:${lastColumn}1`, title)
  sheet.getCell('A2').value = "Order follows the selected outlet's Master stock list. Do not alphabetically sort items."
  sheet.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' }, size: 10 }
}

function addInventoryStockSheet(workbook, month, items, index, outlet) {
  const sheet = workbook.addWorksheet(sheetName(month.short, 'Inventory', outlet?.id || outlet?.code), { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }] })
  setupStockTitle(sheet, `Inventory Listing — ${outlet?.name || outlet?.code || outlet?.id || 'Outlet'} — ${month.label}`, 'AA')
  sheet.mergeCells('A2:A3')
  sheet.getCell('A2').value = 'ITEM'
  const weekStartCols = [2, 7, 12, 17, 22]
  weekStartCols.forEach((start, idx) => {
    sheet.mergeCells(2, start, 2, start + 4)
    sheet.getCell(2, start).value = `WEEK ${idx + 1}`
    ;['Purchase Qty', 'Purchase UOM', 'Base Qty', 'Base UOM', 'Status'].forEach((label, offset) => { sheet.getCell(3, start + offset).value = label })
  })
  sheet.mergeCells('AA2:AA3')
  sheet.getCell('AA2').value = 'MIN'
  styleHeaderRow(sheet.getRow(2))
  styleHeaderRow(sheet.getRow(3))
  sheet.getColumn(1).width = 38
  for (let col = 2; col <= 26; col += 1) sheet.getColumn(col).width = col % 5 === 0 ? 13 : 11
  sheet.getColumn(27).width = 11

  items.forEach((item) => {
    const counts = weeklyCounts(index, item, month.key)
    const row = [item.item_name]
    counts.forEach((count) => {
      const actual = count?.actual_qty ?? ''
      const ratio = Number(item.units_per_purchase_uom || 1)
      const purchaseQty = actual === '' || actual == null ? '' : Number(actual) / (ratio > 0 ? ratio : 1)
      row.push(purchaseQty === '' ? '' : Number(purchaseQty.toFixed(2)), item.purchase_uom || item.unit || '', actual, item.unit || '', statusFor(actual, item.min_threshold))
    })
    row.push(Number(item.min_threshold || 0))
    sheet.addRow(row)
  })
  styleDataRange(sheet, 4, Math.max(4, sheet.rowCount), 1, 27)
  for (let row = 4; row <= sheet.rowCount; row += 1) {
    for (const col of [6, 11, 16, 21, 26]) {
      const cell = sheet.getCell(row, col)
      if (cell.value === 'ORDER') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD6D6' } }
      if (cell.value === 'OK') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDF5E3' } }
    }
  }
}

function addUtensilStockSheet(workbook, month, section, items, index, outlet) {
  const sheet = workbook.addWorksheet(sheetName(month.short, section, outlet?.id || outlet?.code), { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }] })
  setupStockTitle(sheet, `${section} Listing — ${outlet?.name || outlet?.code || outlet?.id || 'Outlet'} — ${month.label}`, 'Q')
  sheet.mergeCells('A2:A3')
  sheet.getCell('A2').value = 'ITEM'
  const starts = [2, 5, 8, 11, 14]
  starts.forEach((start, idx) => {
    sheet.mergeCells(2, start, 2, start + 2)
    sheet.getCell(2, start).value = `WEEK ${idx + 1}`
    ;['Quantity', 'Unit', 'Status'].forEach((label, offset) => { sheet.getCell(3, start + offset).value = label })
  })
  sheet.mergeCells('Q2:Q3')
  sheet.getCell('Q2').value = 'MINIMUM ORDER QUANTITY'
  styleHeaderRow(sheet.getRow(2))
  styleHeaderRow(sheet.getRow(3))
  sheet.getColumn(1).width = 48
  for (let col = 2; col <= 16; col += 1) sheet.getColumn(col).width = col % 3 === 1 ? 12 : 11
  sheet.getColumn(17).width = 18
  items.forEach((item) => {
    const counts = weeklyCounts(index, item, month.key)
    const row = [item.item_name]
    counts.forEach((count) => {
      const actual = count?.actual_qty ?? ''
      row.push(actual, item.unit || item.purchase_uom || '', statusFor(actual, item.min_threshold))
    })
    row.push(Number(item.min_threshold || 0))
    sheet.addRow(row)
  })
  styleDataRange(sheet, 4, Math.max(4, sheet.rowCount), 1, 17)
}

function addStationarySheet(workbook, month, items, index, outlet) {
  const sheet = workbook.addWorksheet(sheetName(month.short, 'Stationary', outlet?.id || outlet?.code), { views: [{ state: 'frozen', ySplit: 3 }] })
  setupStockTitle(sheet, `Stationary Listing — ${outlet?.name || outlet?.code || outlet?.id || 'Outlet'} — ${month.label}`, 'E')
  const header = sheet.getRow(3)
  ;['ITEM', 'Quantity', 'Unit', 'Status', 'Min Order'].forEach((label, idx) => { header.getCell(idx + 1).value = label })
  styleHeaderRow(header)
  sheet.columns = [{ width: 50 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 12 }]
  items.forEach((item) => {
    const count = latestCountInMonth(index, item, month.key)
    const actual = count?.actual_qty ?? ''
    sheet.addRow([item.item_name, actual, item.unit || item.purchase_uom || '', statusFor(actual, item.min_threshold), Number(item.min_threshold || 0)])
  })
  styleDataRange(sheet, 4, Math.max(4, sheet.rowCount), 1, 5)
}

function addStockSheets(workbook, { fromDate, toDate, inventory, stockCounts, outlets = [] }) {
  const index = countIndex(stockCounts)
  const outletRows = outlets.length
    ? outlets
    : [...new Set(inventory.map((item) => item.outlet_id).filter(Boolean))].map((id) => ({ id, code: id, name: id }))

  for (const outlet of outletRows) {
    const outletItems = inventory.filter((item) => String(item.outlet_id || '') === String(outlet.id || ''))
    const orderedGroups = new Map(SECTION_ORDER.map((section) => [section, []]))
    outletItems.forEach((item) => {
      const section = sectionFor(item)
      if (!orderedGroups.has(section)) orderedGroups.set(section, [])
      orderedGroups.get(section).push(item)
    })
    for (const month of monthKeys(fromDate, toDate)) {
      addInventoryStockSheet(workbook, month, orderedGroups.get('Inventory') || [], index, outlet)
      addUtensilStockSheet(workbook, month, 'Untensil PG1', orderedGroups.get('Untensil PG1') || [], index, outlet)
      addUtensilStockSheet(workbook, month, 'Utensil PG2', orderedGroups.get('Utensil PG2') || [], index, outlet)
      addStationarySheet(workbook, month, orderedGroups.get('Stationary') || [], index, outlet)
    }
  }
}


function addStockActivitySheet(workbook, stockCounts = [], outlets = []) {
  const outletNames = outletNameMap(outlets)
  const sheet = workbook.addWorksheet('Stock Activity', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: 'Count Date', key: 'count_date', width: 14 },
    { header: 'Outlet', key: 'outlet_name', width: 28 },
    { header: 'Stock List ID', key: 'stock_list_id', width: 38 },
    { header: 'Item ID', key: 'item_id', width: 34 },
    { header: 'Item', key: 'item_name', width: 42 },
    { header: 'Category', key: 'category', width: 24 },
    { header: 'Previous Count', key: 'expected_qty', width: 14 },
    { header: 'Actual Qty', key: 'actual_qty', width: 14 },
    { header: 'Unit', key: 'unit', width: 12 },
    { header: 'Variance', key: 'variance', width: 12 },
    { header: 'Profile Name', key: 'counted_by', width: 22 },
    { header: 'Email', key: 'counted_by_email', width: 30 },
    { header: 'Updated At', key: 'updated_date', width: 23 },
  ]
  styleHeaderRow(sheet.getRow(1))
  stockCounts.forEach((row) => sheet.addRow({
    ...row,
    outlet_name: outletNames.get(String(row.outlet_id || '')) || row.outlet_id || '',
    counted_by_email: row.counted_by_email || row.created_by || '',
  }))
  styleDataRange(sheet, 2, Math.max(2, sheet.rowCount), 1, 13)
  sheet.autoFilter = { from: 'A1', to: 'M1' }
}

function addActivitySheet(workbook, auditLogs = [], outlets = [], users = []) {
  const outletNames = outletNameMap(outlets)
  const names = identityMap(users)
  const sheet = workbook.addWorksheet('Activity Log', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: 'Date / Time', key: 'created_date', width: 23 },
    { header: 'Outlet', key: 'outlet_name', width: 28 },
    { header: 'Profile Name', key: 'actor_name', width: 22 },
    { header: 'Email', key: 'actor_email', width: 30 },
    { header: 'Action', key: 'action', width: 18 },
    { header: 'Entity', key: 'entity', width: 18 },
    { header: 'Record ID', key: 'entity_id', width: 38 },
    { header: 'Summary', key: 'summary', width: 32 },
  ]
  styleHeaderRow(sheet.getRow(1))
  auditLogs.forEach((row) => sheet.addRow({
    ...row,
    outlet_name: outletNames.get(String(row.outlet_id || '')) || row.outlet_id || '',
    actor_name: row.actor_name || names.get(String(row.actor_email || '').toLowerCase()) || row.actor_email || '',
  }))
  styleDataRange(sheet, 2, Math.max(2, sheet.rowCount), 1, 8)
  sheet.autoFilter = { from: 'A1', to: 'H1' }
}


function addTrainingProgressSheet(workbook, { assignments = [], progress = [], courses = [], outlets = [] }) {
  const outletNames = outletNameMap(outlets)
  const courseNames = new Map(courses.map((row) => [String(row.id || ''), row.title || row.id || '']))
  const progressMap = new Map()
  for (const row of progress) {
    const key = row.assignment_id || `${row.course_id}|${String(row.user_email || '').toLowerCase()}`
    progressMap.set(key, row)
  }
  const sheet = workbook.addWorksheet('Training Progress', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: 'Outlet', key: 'outlet_name', width: 28 },
    { header: 'Profile Name', key: 'user_name', width: 22 },
    { header: 'Email', key: 'user_email', width: 30 },
    { header: 'Course', key: 'course_name', width: 34 },
    { header: 'Assigned At', key: 'assigned_at', width: 22 },
    { header: 'Due Date', key: 'due_date', width: 14 },
    { header: 'Assignment Status', key: 'assignment_status', width: 18 },
    { header: 'Progress %', key: 'progress_percent', width: 13 },
    { header: 'Learning Status', key: 'learning_status', width: 17 },
    { header: 'Score', key: 'score', width: 10 },
    { header: 'Started At', key: 'started_at', width: 22 },
    { header: 'Completed At', key: 'completed_at', width: 22 },
    { header: 'Learning Duration (min)', key: 'duration_minutes', width: 20 },
  ]
  styleHeaderRow(sheet.getRow(1))
  const representedProgress = new Set()
  assignments.forEach((assignment) => {
    const key = assignment.id || `${assignment.course_id}|${String(assignment.user_email || '').toLowerCase()}`
    const fallbackKey = `${assignment.course_id}|${String(assignment.user_email || '').toLowerCase()}`
    const row = progressMap.get(key) || progressMap.get(fallbackKey) || {}
    if (row.id) representedProgress.add(row.id)
    sheet.addRow({
      outlet_name: outletNames.get(String(assignment.outlet_id || row.outlet_id || '')) || assignment.outlet_id || row.outlet_id || '',
      user_name: assignment.user_name || row.user_name || '',
      user_email: assignment.user_email || row.user_email || '',
      course_name: courseNames.get(String(assignment.course_id || row.course_id || '')) || assignment.course_id || row.course_id || '',
      assigned_at: assignment.assigned_at || '',
      due_date: assignment.due_date || '',
      assignment_status: String(assignment.status || '').replaceAll('_', ' ').toUpperCase(),
      progress_percent: Number(row.progress_percent || 0),
      learning_status: String(row.status || 'not started').replaceAll('_', ' ').toUpperCase(),
      score: row.score === '' || row.score == null ? '' : Number(row.score),
      started_at: row.started_at || '',
      completed_at: row.completed_at || '',
      duration_minutes: minutesBetween(row.started_at, row.completed_at),
    })
  })
  progress.filter((row) => !representedProgress.has(row.id)).forEach((row) => sheet.addRow({
    outlet_name: outletNames.get(String(row.outlet_id || '')) || row.outlet_id || '',
    user_name: row.user_name || '',
    user_email: row.user_email || '',
    course_name: courseNames.get(String(row.course_id || '')) || row.course_id || '',
    assigned_at: '',
    due_date: '',
    assignment_status: 'REQUIRED / SELF STARTED',
    progress_percent: Number(row.progress_percent || 0),
    learning_status: String(row.status || 'not started').replaceAll('_', ' ').toUpperCase(),
    score: row.score === '' || row.score == null ? '' : Number(row.score),
    started_at: row.started_at || '',
    completed_at: row.completed_at || '',
    duration_minutes: minutesBetween(row.started_at, row.completed_at),
  }))
  if (!assignments.length && !progress.length) sheet.addRow(['', '', '', 'No training activity in the selected outlets.', '', '', '', '', '', '', '', ''])
  styleDataRange(sheet, 2, Math.max(2, sheet.rowCount), 1, 13)
  sheet.autoFilter = { from: 'A1', to: 'M1' }
}

function addSopAcknowledgementSheet(workbook, { acknowledgements = [], sops = [], outlets = [] }) {
  const outletNames = outletNameMap(outlets)
  const sopNames = new Map(sops.map((row) => [String(row.id || ''), `${row.sop_code || ''} ${row.title || ''}`.trim()]))
  const sheet = workbook.addWorksheet('SOP Acknowledgements', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: 'Outlet', key: 'outlet_name', width: 28 },
    { header: 'Profile Name', key: 'user_name', width: 22 },
    { header: 'Email', key: 'user_email', width: 30 },
    { header: 'SOP', key: 'sop_name', width: 42 },
    { header: 'Acknowledged Version', key: 'acknowledged_version', width: 20 },
    { header: 'Acknowledged At', key: 'acknowledged_at', width: 22 },
    { header: 'Status', key: 'status', width: 16 },
  ]
  styleHeaderRow(sheet.getRow(1))
  acknowledgements.forEach((row) => sheet.addRow({
    ...row,
    outlet_name: outletNames.get(String(row.outlet_id || '')) || row.outlet_id || '',
    sop_name: sopNames.get(String(row.sop_id || '')) || row.sop_id || '',
    status: String(row.status || '').replaceAll('_', ' ').toUpperCase(),
  }))
  if (!acknowledgements.length) sheet.addRow(['', '', '', 'No SOP acknowledgements in the selected outlets.', '', '', ''])
  styleDataRange(sheet, 2, Math.max(2, sheet.rowCount), 1, 7)
  sheet.autoFilter = { from: 'A1', to: 'G1' }
}


export async function exportOperationsWorkbook({ type = 'full', fromDate, toDate, tasks = [], taskTemplates = [], taskPhotos = [], taskTemplatePhotos = [], inventory = [], stockCounts = [], users = [], auditLogs = [], outlets = [], trainingAssignments = [], trainingProgress = [], trainingCourses = [], trainingAcknowledgements = [], trainingAttempts = [], sops = [] }) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Stupiak’s Ops'
  workbook.company = "Stupiak's Pork Burger"
  workbook.created = new Date()
  workbook.modified = new Date()

  if (type === 'full' || type === 'stock') addOrderPage(workbook, { fromDate, toDate, inventory, stockCounts, outlets })
  if (type === 'full') addSummarySheet(workbook, { fromDate, toDate, tasks, taskPhotos, taskTemplatePhotos, inventory, stockCounts, trainingAssignments, trainingProgress, outlets })
  if (type === 'full' || type === 'tasks' || type === 'performance') {
    addPerformanceSheets(workbook, { tasks, templates: taskTemplates, users, outlets, asOfDate: toDate })
  }
  if (type === 'full' || type === 'tasks') {
    addTasksSheet(workbook, tasks, users, outlets, taskPhotos, taskTemplatePhotos)
    await addTaskPhotosSheet(workbook, tasks, taskPhotos, taskTemplatePhotos, outlets)
  }
  if (type === 'full' || type === 'stock') {
    addStockSheets(workbook, { fromDate, toDate, inventory, stockCounts, outlets })
    addStockActivitySheet(workbook, stockCounts, outlets)
  }
  if (type === 'full' || type === 'training') {
    addTrainingProgressSheet(workbook, { assignments: trainingAssignments, progress: trainingProgress, courses: trainingCourses, outlets })
    addSopAcknowledgementSheet(workbook, { acknowledgements: trainingAcknowledgements, sops, outlets })
    addTrainingAttemptsSheet(workbook, { attempts: trainingAttempts, courses: trainingCourses, outlets })
  }
  if (type === 'full' && auditLogs.length) addActivitySheet(workbook, auditLogs, outlets, users)

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const prefix = type === 'tasks' ? 'Task_Report' : type === 'stock' ? 'Stock_Report' : type === 'training' ? 'Training_Report' : type === 'performance' ? 'Performance_Report' : 'Operations_Report'
  anchor.href = url
  anchor.download = `Stupiaks_Ops_${prefix}_${safeFilePart(fromDate)}_${safeFilePart(toDate)}.xlsx`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
