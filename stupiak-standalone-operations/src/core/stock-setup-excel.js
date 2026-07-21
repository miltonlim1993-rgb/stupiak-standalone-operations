const ALL_SETUP_SHEETS = ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary'];
const DB_SETUP_SHEETS = ['Stock Setup DB', '_StockSetup'];

export async function parseStockSetupWorkbook(file, outlet = 'RR-KCH') {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) throw new Error('Excel engine is still loading. Please try again.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const dbSheet = DB_SETUP_SHEETS.map((name) => findWorksheet(workbook, name)).find(Boolean);
  if (dbSheet) return parseDbSetup(dbSheet, file, outlet);

  const sheets = [
    parseInventory(findWorksheet(workbook, 'Inventory')),
    parseUtensil(findWorksheet(workbook, 'Untensil PG1'), 'Untensil PG1'),
    parseUtensil(findWorksheet(workbook, 'Utensil PG2'), 'Utensil PG2'),
    parseStationary(findWorksheet(workbook, 'Stationary'))
  ].filter((sheet) => sheet.rows.length);

  validateSheets(sheets, workbook);
  return {
    version: 2,
    outlet,
    workbookName: file.name || 'Stock Setup Excel',
    importedAt: new Date().toISOString(),
    sheets,
    orderPage: { values: [] }
  };
}

export async function exportStockSetupWorkbook(setup, filename = 'stock-setup.xlsx') {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) throw new Error('Excel engine is still loading. Please try again.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Stupiak Operations';
  const sheet = workbook.addWorksheet('Stock Setup DB');
  sheet.addRow(['Outlet', 'Section', 'Sort', 'Item Key', 'Item', 'Primary Unit', 'Secondary Unit', 'Conversion', 'Minimum', 'Active']);
  const outlet = String(setup?.outlet || 'RR-KCH');
  for (const sectionName of ALL_SETUP_SHEETS) {
    const section = (setup?.sheets || []).find((entry) => canonicalSection(entry.sheetName) === sectionName);
    (section?.rows || []).forEach((row, index) => sheet.addRow([
      outlet,
      sectionName,
      Number(row.sort || index + 1),
      String(row.itemKey || itemKey(sectionName, index + 1)),
      String(row.item || ''),
      String(row.primaryUnit || row.unit || ''),
      String(row.secondaryUnit || ''),
      Number(row.conversion || 1),
      Number(row.minimum || 0),
      row.active !== false
    ]));
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = 'A1:J1';
  sheet.columns = [{ width: 12 }, { width: 17 }, { width: 8 }, { width: 14 }, { width: 46 }, { width: 15 }, { width: 17 }, { width: 12 }, { width: 11 }, { width: 9 }];
  styleSheet(sheet);
  const guide = workbook.addWorksheet('Guide');
  guide.addRows([
    ['Stock Setup DB', 'Edit only the Stock Setup DB tab.'],
    ['Section', 'Inventory / Untensil PG1 / Utensil PG2 / Stationary'],
    ['Sort', 'Controls the item order shown in Stock Count.'],
    ['Item Key', 'Keep unique and do not change after counts exist.'],
    ['Minimum', 'Used for OK / Order.'],
    ['Active', 'TRUE shows the item; FALSE hides it.']
  ]);
  guide.columns = [{ width: 24 }, { width: 65 }];
  guide.getColumn(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

function parseDbSetup(sheet, file, outlet) {
  const headerRow = findHeaderRow(sheet, ['section', 'item']);
  if (!headerRow) throw new Error('Stock Setup DB headers not found.');
  const headers = headerMap(sheet, headerRow);
  const groups = new Map(ALL_SETUP_SHEETS.map((name) => [name, []]));
  for (let rowNo = headerRow + 1; rowNo <= Math.min(sheet.rowCount || 0, 3000); rowNo += 1) {
    const section = canonicalSection(byHeaderText(sheet, rowNo, headers, ['section', 'tab', 'sheet']));
    const item = byHeaderText(sheet, rowNo, headers, ['item']);
    if (!section || !validItem(item)) continue;
    const rows = groups.get(section);
    const sort = positive(byHeaderValue(sheet, rowNo, headers, ['sort', 'order', 'sequence'])) || rows.length + 1;
    const primaryUnit = byHeaderText(sheet, rowNo, headers, ['primary unit', 'unit']) || 'Pack';
    const secondaryUnit = byHeaderText(sheet, rowNo, headers, ['secondary unit', 'unit 2']);
    rows.push({
      row: rows.length + 3,
      sort,
      itemKey: byHeaderText(sheet, rowNo, headers, ['item key', 'item id', 'key']) || itemKey(section, sort),
      item,
      minimum: numeric(byHeaderValue(sheet, rowNo, headers, ['minimum', 'min', 'minimum order'])),
      unit: primaryUnit,
      primaryUnit,
      secondaryUnit,
      conversion: positive(byHeaderValue(sheet, rowNo, headers, ['conversion', 'ratio'])) || 1,
      hasSecondaryQuantity: Boolean(secondaryUnit),
      active: boolValue(byHeaderValue(sheet, rowNo, headers, ['active', 'enabled']), true)
    });
  }
  const sheets = ALL_SETUP_SHEETS.map((sheetName) => ({
    sheetName,
    type: sectionType(sheetName),
    rows: groups.get(sheetName).sort((a, b) => a.sort - b.sort).map((row, index) => ({ ...row, row: index + 3 }))
  })).filter((entry) => entry.rows.length);
  validateSheets(sheets, { worksheets: [sheet] });
  return {
    version: 2,
    outlet: byHeaderText(sheet, headerRow + 1, headers, ['outlet']) || outlet,
    workbookName: file.name || 'Stock Setup DB',
    importedAt: new Date().toISOString(),
    sheets,
    orderPage: { values: [] }
  };
}

function parseInventory(sheet) {
  const rows = collectLegacyRows(sheet, (rowNo) => {
    const item = text(sheet, rowNo, 1);
    const units = unitsAcross(sheet, rowNo, [[2, 6], [7, 11], [12, 16], [17, 21], [22, 26]]);
    if (!validItem(item) || (!units.length && !hasNumber(sheet, rowNo, 27))) return null;
    return {
      item,
      minimum: numberAt(sheet, rowNo, 27),
      primaryUnit: units[0] || 'Pack',
      secondaryUnit: units[1] || '',
      hasSecondaryQuantity: units.length > 1
    };
  });
  return finishLegacySection('Inventory', rows);
}

function parseUtensil(sheet, sheetName) {
  const rows = collectLegacyRows(sheet, (rowNo) => {
    const item = text(sheet, rowNo, 1);
    const units = unitsAcross(sheet, rowNo, [[2, 4], [5, 7], [8, 10], [11, 13], [14, 16]]);
    if (!validItem(item) || (!units.length && !hasNumber(sheet, rowNo, 17))) return null;
    return { item, minimum: numberAt(sheet, rowNo, 17), primaryUnit: units[0] || 'Pack', secondaryUnit: '', hasSecondaryQuantity: false };
  });
  return finishLegacySection(sheetName, rows);
}

function parseStationary(sheet) {
  const rows = collectLegacyRows(sheet, (rowNo) => {
    const item = text(sheet, rowNo, 1);
    const unit = text(sheet, rowNo, 3);
    if (!validItem(item) || (!unit && !hasNumber(sheet, rowNo, 5))) return null;
    return { item, minimum: numberAt(sheet, rowNo, 5), primaryUnit: unit || 'PCS', secondaryUnit: '', hasSecondaryQuantity: false };
  });
  return finishLegacySection('Stationary', rows);
}

function collectLegacyRows(sheet, parser) {
  if (!sheet) return [];
  const rows = [];
  let started = false;
  let blankRun = 0;
  for (let rowNo = 1; rowNo <= Math.min(sheet.rowCount || 0, 1000); rowNo += 1) {
    const parsed = parser(rowNo);
    if (!parsed) {
      if (started && ++blankRun >= 3) break;
      continue;
    }
    started = true;
    blankRun = 0;
    rows.push(parsed);
  }
  return rows;
}

function finishLegacySection(sheetName, sourceRows) {
  return {
    sheetName,
    type: sectionType(sheetName),
    rows: sourceRows.map((row, index) => ({
      row: index + 3,
      sort: index + 1,
      itemKey: itemKey(sheetName, index + 1),
      item: row.item,
      minimum: row.minimum || 0,
      unit: row.primaryUnit,
      primaryUnit: row.primaryUnit,
      secondaryUnit: row.secondaryUnit || '',
      conversion: 1,
      hasSecondaryQuantity: Boolean(row.hasSecondaryQuantity),
      active: true
    }))
  };
}

function validateSheets(sheets, workbook) {
  const found = new Set(sheets.filter((sheet) => sheet.rows?.length).map((sheet) => sheet.sheetName));
  const missing = ALL_SETUP_SHEETS.filter((name) => !found.has(name));
  if (missing.length) {
    const tabs = (workbook.worksheets || []).map((sheet) => sheet.name).join(', ') || 'none';
    throw new Error(`Stock setup incomplete. Missing: ${missing.join(', ')}. Excel tabs: ${tabs}`);
  }
}

function findWorksheet(workbook, expectedName) {
  const expected = normalize(expectedName);
  const sheets = workbook.worksheets || [];
  return workbook.getWorksheet(expectedName)
    || sheets.find((sheet) => normalize(sheet.name) === expected)
    || sheets.find((sheet) => normalize(sheet.name).includes(expected) || expected.includes(normalize(sheet.name)))
    || aliasSheet(sheets, expected)
    || null;
}

function aliasSheet(sheets, expected) {
  if (expected === 'inventory') return sheets.find((sheet) => /^inventory(?:\s|$)/i.test(normalize(sheet.name)));
  if (/u?n?tensil pg 1|u?n?tensil pg1/.test(expected)) return sheets.find((sheet) => /u?n?tensil\s*pg\s*1/i.test(normalize(sheet.name)));
  if (/u?n?tensil pg 2|u?n?tensil pg2/.test(expected)) return sheets.find((sheet) => /u?n?tensil\s*pg\s*2/i.test(normalize(sheet.name)));
  if (expected === 'stationary') return sheets.find((sheet) => /stationary|stationery/i.test(normalize(sheet.name)));
  if (expected === 'stock setup db' || expected === '_stocksetup') return sheets.find((sheet) => /stock\s*setup\s*(db)?/i.test(normalize(sheet.name)));
  return null;
}

function canonicalSection(value) {
  const name = normalize(value);
  if (name === 'inventory') return 'Inventory';
  if (/u?n?tensil\s*pg\s*1/.test(name)) return 'Untensil PG1';
  if (/u?n?tensil\s*pg\s*2/.test(name)) return 'Utensil PG2';
  if (/stationary|stationery/.test(name)) return 'Stationary';
  return '';
}

function sectionType(name) {
  return name === 'Stationary' ? 'monthly-stationary' : name === 'Inventory' ? 'weekly-inventory' : 'weekly-utensil';
}

function validItem(value) {
  const item = String(value || '').trim();
  if (!item || item.length > 300 || /^\[object\s+object\]$/i.test(item)) return false;
  if (/^item$/i.test(item) || /^week\s*\d+/i.test(item) || /^quantity/i.test(item) || /^status$/i.test(item)) return false;
  return (item.match(/,/g) || []).length <= 8;
}

function unitsAcross(sheet, rowNo, groups) {
  const values = [];
  for (const [start, end] of groups) for (let col = start; col <= end; col += 1) {
    const value = text(sheet, rowNo, col);
    if (!value || ['order', 'ok', 'status', 'no more use', 'spare item'].includes(value.toLowerCase())) continue;
    if (/^\d+(?:\.\d+)?$/.test(value.replace(/,/g, ''))) continue;
    if (!values.includes(value)) values.push(value);
  }
  return values.slice(0, 2);
}

function text(sheet, row, col) { return display(sheet?.getCell(row, col)?.value).trim(); }
function numberAt(sheet, row, col) { return numeric(sheet?.getCell(row, col)?.value); }
function hasNumber(sheet, row, col) {
  const raw = sheet?.getCell(row, col)?.value;
  const value = typeof raw === 'object' && raw?.result !== undefined ? raw.result : raw;
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}
function numeric(raw) {
  const value = typeof raw === 'object' && raw?.result !== undefined ? raw.result : raw;
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}
function positive(value) { const number = numeric(value); return number > 0 ? number : 0; }
function boolValue(value, fallback) {
  if (typeof value === 'boolean') return value;
  const textValue = String(value ?? '').trim().toLowerCase();
  if (!textValue) return fallback;
  if (['false', 'no', '0', 'inactive', 'disabled'].includes(textValue)) return false;
  if (['true', 'yes', '1', 'active', 'enabled'].includes(textValue)) return true;
  return fallback;
}
function display(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.result !== undefined) return display(value.result);
    if (value.text !== undefined) return String(value.text || '');
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    return '';
  }
  return String(value);
}
function normalize(value) { return String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function normalizeHeader(value) { return normalize(value).replace(/[_-]+/g, ' '); }
function findHeaderRow(sheet, required) {
  for (let rowNo = 1; rowNo <= Math.min(sheet.rowCount || 0, 20); rowNo += 1) {
    const values = [];
    for (let col = 1; col <= Math.min(sheet.columnCount || 30, 30); col += 1) values.push(normalizeHeader(display(sheet.getCell(rowNo, col).value)));
    if (required.every((header) => values.includes(header))) return rowNo;
  }
  return 0;
}
function headerMap(sheet, rowNo) {
  const map = new Map();
  for (let col = 1; col <= Math.min(sheet.columnCount || 50, 50); col += 1) {
    const header = normalizeHeader(display(sheet.getCell(rowNo, col).value));
    if (header) map.set(header, col);
  }
  return map;
}
function byHeaderValue(sheet, rowNo, headers, names) {
  for (const name of names) { const col = headers.get(normalizeHeader(name)); if (col) return sheet.getCell(rowNo, col).value; }
  return '';
}
function byHeaderText(sheet, rowNo, headers, names) { return display(byHeaderValue(sheet, rowNo, headers, names)).trim(); }
function itemKey(section, sort) {
  const prefix = section === 'Inventory' ? 'INV' : section === 'Untensil PG1' ? 'UP1' : section === 'Utensil PG2' ? 'UP2' : 'STA';
  return `${prefix}-${String(sort).padStart(3, '0')}`;
}
function styleSheet(sheet) {
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3D3D3D' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  for (let rowNo = 2; rowNo <= sheet.rowCount; rowNo += 1) {
    sheet.getRow(rowNo).height = 22;
    sheet.getRow(rowNo).eachCell((cell) => { cell.alignment = { vertical: 'middle', wrapText: true }; });
  }
}
function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1200);
}