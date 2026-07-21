const REQUIRED_SECTIONS = ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary'];
const DB_SHEET_NAMES = ['Stock Setup DB', '_StockSetup'];
const HEADERS = ['Outlet', 'Section', 'Sort', 'Item Key', 'Item', 'Primary Unit', 'Secondary Unit', 'Conversion', 'Minimum', 'Active'];

export async function parseStockSetupWorkbook(file, fallbackOutlet = 'RR-KCH') {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) throw new Error('Excel engine is loading. Try again.');
  if (!file) throw new Error('Select a Stock Setup Excel file.');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = DB_SHEET_NAMES.map((name) => findWorksheet(workbook, name)).find(Boolean);
  if (!sheet) {
    const tabs = (workbook.worksheets || []).map((entry) => entry.name).join(', ') || 'none';
    throw new Error(`Use the Stock Setup DB format. Sheet "Stock Setup DB" was not found. Found: ${tabs}`);
  }

  const headerRow = findHeaderRow(sheet);
  const headers = buildHeaderMap(sheet, headerRow);
  const grouped = new Map(REQUIRED_SECTIONS.map((name) => [name, []]));
  const itemKeys = new Set();
  let outlet = String(fallbackOutlet || 'RR-KCH').trim() || 'RR-KCH';

  for (let rowNo = headerRow + 1; rowNo <= Math.min(sheet.rowCount || 0, 10000); rowNo += 1) {
    const item = readText(sheet, rowNo, headers, ['item']);
    const section = canonicalSection(readText(sheet, rowNo, headers, ['section']));
    if (!item && !section) continue;
    if (!section) throw new Error(`Row ${rowNo}: Section must be Inventory, Untensil PG1, Utensil PG2 or Stationary.`);
    if (!item) throw new Error(`Row ${rowNo}: Item is required.`);

    const rows = grouped.get(section);
    const sort = positiveNumber(readValue(sheet, rowNo, headers, ['sort'])) || rows.length + 1;
    const key = readText(sheet, rowNo, headers, ['item key']) || makeItemKey(section, sort, item);
    if (itemKeys.has(key)) throw new Error(`Row ${rowNo}: duplicate Item Key "${key}".`);
    itemKeys.add(key);

    const primaryUnit = readText(sheet, rowNo, headers, ['primary unit']) || 'Pack';
    const secondaryUnit = readText(sheet, rowNo, headers, ['secondary unit']);
    const rowOutlet = readText(sheet, rowNo, headers, ['outlet']);
    if (rowOutlet) outlet = rowOutlet;

    rows.push({
      row: rows.length + 3,
      sort,
      itemKey: key,
      item,
      minimum: numberValue(readValue(sheet, rowNo, headers, ['minimum'])),
      unit: primaryUnit,
      primaryUnit,
      secondaryUnit,
      conversion: positiveNumber(readValue(sheet, rowNo, headers, ['conversion'])) || 1,
      hasSecondaryQuantity: Boolean(secondaryUnit),
      active: booleanValue(readValue(sheet, rowNo, headers, ['active']), true)
    });
  }

  const sheets = REQUIRED_SECTIONS.map((sheetName) => {
    const rows = grouped.get(sheetName)
      .sort((a, b) => a.sort - b.sort || a.item.localeCompare(b.item))
      .map((row, index) => ({ ...row, row: index + 3, sort: index + 1 }));
    return { sheetName, type: sectionType(sheetName), rows };
  });

  const missing = sheets.filter((entry) => !entry.rows.length).map((entry) => entry.sheetName);
  if (missing.length) throw new Error(`Stock Setup DB is incomplete. Missing data: ${missing.join(', ')}.`);

  return {
    version: 3,
    outlet,
    workbookName: file.name || 'Stock Setup DB.xlsx',
    importedAt: new Date().toISOString(),
    sheets,
    orderPage: { values: [] }
  };
}

export async function exportStockSetupWorkbook(setup, filename = 'Stock_Setup_DB.xlsx') {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) throw new Error('Excel engine is loading. Try again.');
  if (!setup || !Array.isArray(setup.sheets)) throw new Error('No Stock Setup is available to export.');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Stupiak Operations';
  const sheet = workbook.addWorksheet('Stock Setup DB');
  sheet.addRow(HEADERS);
  const outlet = String(setup.outlet || 'RR-KCH');

  for (const sectionName of REQUIRED_SECTIONS) {
    const section = setup.sheets.find((entry) => canonicalSection(entry?.sheetName) === sectionName);
    for (const [index, row] of (section?.rows || []).entries()) {
      sheet.addRow([
        outlet,
        sectionName,
        Number(row.sort || index + 1),
        String(row.itemKey || makeItemKey(sectionName, index + 1, row.item)),
        String(row.item || ''),
        String(row.primaryUnit || row.unit || ''),
        String(row.secondaryUnit || ''),
        Number(row.conversion || 1),
        Number(row.minimum || 0),
        row.active !== false
      ]);
    }
  }

  styleDbSheet(sheet);
  const guide = workbook.addWorksheet('Guide');
  guide.addRows([
    ['Stock Setup DB', 'Edit only the Stock Setup DB sheet.'],
    ['Section', 'Inventory / Untensil PG1 / Utensil PG2 / Stationary'],
    ['Sort', 'Controls the item order in Stock Count.'],
    ['Item Key', 'Keep unique. Do not change it after counts exist.'],
    ['Primary / Secondary Unit', 'Secondary Unit is optional.'],
    ['Minimum', 'Used for OK / Order status.'],
    ['Active', 'TRUE shows the item; FALSE hides it.']
  ]);
  guide.columns = [{ width: 28 }, { width: 72 }];
  guide.getColumn(1).font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

function findHeaderRow(sheet) {
  for (let rowNo = 1; rowNo <= Math.min(sheet.rowCount || 0, 30); rowNo += 1) {
    const values = [];
    sheet.getRow(rowNo).eachCell({ includeEmpty: true }, (cell) => values.push(normalize(cellDisplay(cell.value))));
    if (values.includes('section') && values.includes('item')) return rowNo;
  }
  throw new Error('Stock Setup DB headers were not found. Use the exported template.');
}

function buildHeaderMap(sheet, rowNo) {
  const map = new Map();
  sheet.getRow(rowNo).eachCell({ includeEmpty: true }, (cell, col) => {
    const key = normalize(cellDisplay(cell.value));
    if (key) map.set(key, col);
  });
  for (const required of ['section', 'item']) {
    if (!map.has(required)) throw new Error(`Missing required column: ${required}.`);
  }
  return map;
}

function readValue(sheet, rowNo, headers, names) {
  for (const name of names) {
    const col = headers.get(normalize(name));
    if (col) return sheet.getCell(rowNo, col).value;
  }
  return '';
}

function readText(sheet, rowNo, headers, names) {
  return cellDisplay(readValue(sheet, rowNo, headers, names)).trim();
}

function findWorksheet(workbook, expectedName) {
  const expected = normalize(expectedName);
  return workbook.getWorksheet(expectedName)
    || (workbook.worksheets || []).find((sheet) => normalize(sheet.name) === expected)
    || null;
}

function canonicalSection(value) {
  const name = normalize(value);
  if (name === 'inventory') return 'Inventory';
  if (/^u?n?tensil\s*pg\s*1$/.test(name)) return 'Untensil PG1';
  if (/^u?n?tensil\s*pg\s*2$/.test(name)) return 'Utensil PG2';
  if (/^stationary$|^stationery$/.test(name)) return 'Stationary';
  return '';
}

function sectionType(name) {
  if (name === 'Stationary') return 'monthly-stationary';
  if (name === 'Inventory') return 'weekly-inventory';
  return 'weekly-utensil';
}

function cellDisplay(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value.result !== undefined) return cellDisplay(value.result);
    if (value.text !== undefined) return String(value.text || '');
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    return '';
  }
  return String(value);
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function numberValue(value) {
  const parsed = Number(String(cellDisplay(value)).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveNumber(value) {
  const parsed = numberValue(value);
  return parsed > 0 ? parsed : 0;
}

function booleanValue(value, fallback) {
  if (typeof value === 'boolean') return value;
  const text = normalize(cellDisplay(value));
  if (!text) return fallback;
  if (['false', 'no', '0', 'inactive', 'disabled'].includes(text)) return false;
  if (['true', 'yes', '1', 'active', 'enabled'].includes(text)) return true;
  return fallback;
}

function makeItemKey(section, sort, item) {
  const prefix = normalize(section).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slug = normalize(item).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36);
  return `${prefix}-${String(sort).padStart(3, '0')}-${slug || 'item'}`;
}

function styleDbSheet(sheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = 'A1:J1';
  sheet.columns = [
    { width: 14 }, { width: 18 }, { width: 8 }, { width: 36 }, { width: 48 },
    { width: 16 }, { width: 18 }, { width: 12 }, { width: 12 }, { width: 10 }
  ];
  const header = sheet.getRow(1);
  header.height = 24;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3F3F3F' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.eachRow((row, rowNo) => {
    if (rowNo === 1) return;
    row.alignment = { vertical: 'middle' };
    if (rowNo % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F1' } };
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
