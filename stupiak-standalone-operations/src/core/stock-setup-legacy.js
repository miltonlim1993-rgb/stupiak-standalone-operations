const REQUIRED_SECTIONS = ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary'];
const INVENTORY_GROUPS = [[2, 6], [7, 11], [12, 16], [17, 21], [22, 26]];
const UTENSIL_GROUPS = [[2, 4], [5, 7], [8, 10], [11, 13], [14, 16]];

export function parseLegacyStockSetupWorkbook(workbook, fallbackOutlet = 'RR-KCH', filename = 'Stock Setup.xlsx') {
  const sourceSheets = {
    Inventory: findSheet(workbook, 'Inventory'),
    'Untensil PG1': findSheet(workbook, 'Untensil PG1'),
    'Utensil PG2': findSheet(workbook, 'Utensil PG2'),
    Stationary: findSheet(workbook, 'Stationary')
  };
  const missing = REQUIRED_SECTIONS.filter((name) => !sourceSheets[name]);
  if (missing.length) {
    const found = (workbook.worksheets || []).map((sheet) => sheet.name).join(', ') || 'none';
    throw new Error(`Stock Setup tabs missing: ${missing.join(', ')}. Found: ${found}`);
  }

  const outletCode = deriveOutletCode(filename, workbook)
    || (isReadableOutlet(fallbackOutlet) ? String(fallbackOutlet).trim() : '')
    || 'RR-KCH';
  const sheets = [
    parseInventory(sourceSheets.Inventory),
    parseUtensil(sourceSheets['Untensil PG1'], 'Untensil PG1'),
    parseUtensil(sourceSheets['Utensil PG2'], 'Utensil PG2'),
    parseStationary(sourceSheets.Stationary)
  ];
  return {
    version: 4,
    outletId: String(fallbackOutlet || '').trim(),
    outletCode,
    outlet: outletCode,
    workbookName: filename,
    importedAt: new Date().toISOString(),
    sheets,
    orderPage: parseLegacyOrderPage(workbook)
  };
}

export function parseLegacyOrderPage(workbook) {
  const sheet = findSheet(workbook, 'Order Page');
  const values = [];
  if (!sheet) return { values };
  const maxRow = Math.min(sheet.rowCount || 0, 500);
  const maxCol = Math.min(sheet.columnCount || 1, 40);
  for (let rowNo = 1; rowNo <= maxRow; rowNo += 1) {
    const row = [];
    let used = false;
    for (let col = 1; col <= maxCol; col += 1) {
      const value = display(sheet.getCell(rowNo, col).value);
      if (value !== '') used = true;
      row.push(value);
    }
    if (used) values.push(trimTrailingBlanks(row));
  }
  return { values };
}

export function writeLegacySetupSheets(workbook, setup) {
  writeOrderPage(workbook, setup?.orderPage?.values || []);
  for (const name of REQUIRED_SECTIONS) {
    const section = (setup?.sheets || []).find((entry) => canonicalSection(entry?.sheetName) === name);
    if (!section) continue;
    if (name === 'Inventory') writeInventory(workbook, section);
    else if (name === 'Stationary') writeStationary(workbook, section);
    else writeUtensil(workbook, section);
  }
}

function parseInventory(sheet) {
  const rows = [];
  const start = Math.max(4, (findItemHeaderRow(sheet) || 2) + 2);
  for (let rowNo = start; rowNo <= Math.min(sheet.rowCount || 0, 1000); rowNo += 1) {
    const item = text(sheet, rowNo, 1);
    if (!validItem(item)) continue;
    const primaryUnit = firstUnit(sheet, rowNo, INVENTORY_GROUPS.map(([col]) => col + 1)) || 'Pack';
    const secondaryUnit = firstUnit(sheet, rowNo, INVENTORY_GROUPS.map(([col]) => col + 3));
    rows.push({
      row: rows.length + 4,
      sort: rows.length + 1,
      itemKey: itemKey('Inventory', item),
      item,
      minimum: number(sheet, rowNo, 27),
      unit: primaryUnit,
      primaryUnit,
      secondaryUnit,
      hasSecondaryQuantity: Boolean(secondaryUnit),
      conversion: 1,
      active: true
    });
  }
  return { sheetName: 'Inventory', type: 'weekly-inventory', rows };
}

function parseUtensil(sheet, sheetName) {
  const rows = [];
  const start = Math.max(4, (findItemHeaderRow(sheet) || 2) + 2);
  for (let rowNo = start; rowNo <= Math.min(sheet.rowCount || 0, 1000); rowNo += 1) {
    const item = text(sheet, rowNo, 1);
    if (!validItem(item)) continue;
    const unit = firstUnit(sheet, rowNo, UTENSIL_GROUPS.map(([col]) => col + 1)) || 'Pack';
    rows.push({
      row: rows.length + 4,
      sort: rows.length + 1,
      itemKey: itemKey(sheetName, item),
      item,
      minimum: number(sheet, rowNo, 17),
      unit,
      primaryUnit: unit,
      secondaryUnit: '',
      hasSecondaryQuantity: false,
      conversion: 1,
      active: true
    });
  }
  return { sheetName, type: 'weekly-utensil', rows };
}

function parseStationary(sheet) {
  const rows = [];
  const start = Math.max(3, (findItemHeaderRow(sheet) || 2) + 1);
  for (let rowNo = start; rowNo <= Math.min(sheet.rowCount || 0, 1000); rowNo += 1) {
    const item = text(sheet, rowNo, 1);
    if (!validItem(item)) continue;
    const unit = firstUnit(sheet, rowNo, [3, 2]) || 'PCS';
    rows.push({
      row: rows.length + 3,
      sort: rows.length + 1,
      itemKey: itemKey('Stationary', item),
      item,
      minimum: number(sheet, rowNo, 5),
      unit,
      primaryUnit: unit,
      secondaryUnit: '',
      hasSecondaryQuantity: false,
      conversion: 1,
      active: true
    });
  }
  return { sheetName: 'Stationary', type: 'monthly-stationary', rows };
}

function findItemHeaderRow(sheet) {
  for (let row = 1; row <= Math.min(sheet.rowCount || 0, 20); row += 1) {
    if (normalize(text(sheet, row, 1)) === 'item') return row;
  }
  return 0;
}

function firstUnit(sheet, row, columns) {
  for (const col of columns) {
    const value = text(sheet, row, col);
    if (looksLikeUnit(value)) return value;
  }
  return '';
}

function looksLikeUnit(value) {
  const raw = String(value || '').trim();
  if (!raw || /^[-+]?\d+(?:\.\d+)?$/.test(raw)) return false;
  return !['order', 'ok', 'status', 'quantity', 'unit', 'no more use', 'spare item'].includes(normalize(raw));
}

function validItem(value) {
  const name = normalize(value);
  return Boolean(name)
    && name !== 'item'
    && name !== 'items'
    && name !== '[object object]'
    && !name.startsWith('inventory listing')
    && !name.startsWith('untensil inventory')
    && !name.startsWith('utensil inventory')
    && !name.startsWith('stationary inventory');
}

function findSheet(workbook, expectedName) {
  const expected = normalize(expectedName);
  const sheets = workbook.worksheets || [];
  return workbook.getWorksheet(expectedName)
    || sheets.find((sheet) => normalize(sheet.name) === expected)
    || aliasSheet(sheets, expected)
    || null;
}

function aliasSheet(sheets, expected) {
  if (expected === 'inventory') return sheets.find((sheet) => /^inventory(?:\s|$)/i.test(normalize(sheet.name)));
  if (/u?n?tensil pg ?1/.test(expected)) return sheets.find((sheet) => /u?n?tensil\s*pg\s*1/i.test(normalize(sheet.name)));
  if (/u?n?tensil pg ?2/.test(expected)) return sheets.find((sheet) => /u?n?tensil\s*pg\s*2/i.test(normalize(sheet.name)));
  if (expected === 'stationary') return sheets.find((sheet) => /stationary|stationery/i.test(normalize(sheet.name)));
  if (expected === 'order page') return sheets.find((sheet) => /order\s*page|^order$/i.test(normalize(sheet.name)));
  return null;
}

function deriveOutletCode(filename, workbook) {
  const candidates = [String(filename || '').replace(/\.[^.]+$/, '')];
  for (const sheet of workbook.worksheets || []) {
    for (let row = 1; row <= Math.min(sheet.rowCount || 0, 3); row += 1) {
      for (let col = 1; col <= Math.min(sheet.columnCount || 0, 5); col += 1) candidates.push(text(sheet, row, col));
    }
  }
  for (const candidate of candidates) {
    const match = String(candidate || '').toUpperCase().match(/\b[A-Z]{2,}(?:-[A-Z0-9]{2,})+\b/);
    if (match) return match[0];
  }
  return '';
}

function isReadableOutlet(value) {
  const raw = String(value || '').trim();
  return Boolean(raw) && !/^[a-f0-9]{20,}$/i.test(raw) && raw !== 'stock-default';
}

function canonicalSection(value) {
  const name = normalize(value);
  if (name === 'inventory') return 'Inventory';
  if (/^u?n?tensil\s*pg\s*1$/.test(name)) return 'Untensil PG1';
  if (/^u?n?tensil\s*pg\s*2$/.test(name)) return 'Utensil PG2';
  if (/^stationary$|^stationery$/.test(name)) return 'Stationary';
  return '';
}

function text(sheet, row, col) {
  return display(sheet.getCell(row, col).value).trim();
}

function number(sheet, row, col) {
  const parsed = Number(String(display(sheet.getCell(row, col).value)).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function display(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value.result !== undefined) return display(value.result);
    if (value.text !== undefined) return String(value.text || '');
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if (value.formula) return value.result !== undefined ? display(value.result) : `=${value.formula}`;
    return '';
  }
  return String(value);
}

function normalize(value) {
  return String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function itemKey(section, item) {
  const a = normalize(section).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const b = normalize(item).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  return `${a}:${b || 'item'}`;
}

function trimTrailingBlanks(row) {
  const copy = [...row];
  while (copy.length && copy[copy.length - 1] === '') copy.pop();
  return copy;
}

function writeOrderPage(workbook, values) {
  const sheet = workbook.addWorksheet('Order Page');
  if (Array.isArray(values) && values.length) sheet.addRows(values);
  else sheet.addRows([['ORDER PAGE'], ['Import the original outlet workbook once to preserve this page.']]);
  sheet.getColumn(1).width = 36;
  styleTitle(sheet.getCell(1, 1));
}

function writeInventory(workbook, setup) {
  const sheet = workbook.addWorksheet('Inventory');
  sheet.mergeCells('A1:AA1');
  sheet.getCell('A1').value = 'Inventory listing 2026';
  styleTitle(sheet.getCell('A1'));
  sheet.getCell('A2').value = 'ITEM';
  styleHeader(sheet, 2, 27);
  INVENTORY_GROUPS.forEach(([start], index) => {
    sheet.getCell(2, start).value = `WEEK ${index + 1}`;
    ['Quantity', 'Unit', 'Quantity', 'Unit', 'Status'].forEach((value, offset) => { sheet.getCell(3, start + offset).value = value; });
  });
  sheet.getCell('AA2').value = 'MIN';
  (setup.rows || []).forEach((row, index) => {
    const r = index + 4;
    sheet.getCell(r, 1).value = row.item;
    INVENTORY_GROUPS.forEach(([start]) => {
      sheet.getCell(r, start + 1).value = row.primaryUnit || row.unit || '';
      if (row.hasSecondaryQuantity) sheet.getCell(r, start + 3).value = row.secondaryUnit || '';
      sheet.getCell(r, start + 4).value = 'Order';
    });
    sheet.getCell(r, 27).value = row.minimum || 0;
  });
  finishSheet(sheet, 27);
}

function writeUtensil(workbook, setup) {
  const sheet = workbook.addWorksheet(setup.sheetName);
  sheet.mergeCells('A1:Q1');
  sheet.getCell('A1').value = 'Utensil Inventory listing 2026 (WEEKLY STOCK)';
  styleTitle(sheet.getCell('A1'));
  sheet.getCell('A2').value = 'ITEM';
  styleHeader(sheet, 2, 17);
  UTENSIL_GROUPS.forEach(([start], index) => {
    sheet.getCell(2, start).value = `WEEK ${index + 1}`;
    ['Quantity', 'Unit', 'Status'].forEach((value, offset) => { sheet.getCell(3, start + offset).value = value; });
  });
  sheet.getCell('Q2').value = 'Minimum Order Quantity';
  (setup.rows || []).forEach((row, index) => {
    const r = index + 4;
    sheet.getCell(r, 1).value = row.item;
    UTENSIL_GROUPS.forEach(([start]) => {
      sheet.getCell(r, start + 1).value = row.unit || row.primaryUnit || '';
      sheet.getCell(r, start + 2).value = 'Order';
    });
    sheet.getCell(r, 17).value = row.minimum || 0;
  });
  finishSheet(sheet, 17);
}

function writeStationary(workbook, setup) {
  const sheet = workbook.addWorksheet('Stationary');
  sheet.mergeCells('A1:E1');
  sheet.getCell('A1').value = 'Stationary Inventory listing 2026 (MONTHLY STOCK)';
  styleTitle(sheet.getCell('A1'));
  sheet.getRow(2).values = ['ITEM', 'Quantity', 'Unit', 'Status', 'Min Order'];
  styleHeader(sheet, 2, 5);
  (setup.rows || []).forEach((row, index) => {
    const r = index + 3;
    sheet.getCell(r, 1).value = row.item;
    sheet.getCell(r, 3).value = row.unit || row.primaryUnit || '';
    sheet.getCell(r, 4).value = 'Order';
    sheet.getCell(r, 5).value = row.minimum || 0;
  });
  finishSheet(sheet, 5);
}

function styleTitle(cell) {
  cell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3D3D3D' } };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

function styleHeader(sheet, rowNo, maxCol) {
  for (let col = 1; col <= maxCol; col += 1) {
    const cell = sheet.getCell(rowNo, col);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3D3D3D' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  }
}

function finishSheet(sheet, maxCol) {
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];
  sheet.getColumn(1).width = 46;
  for (let col = 2; col <= maxCol; col += 1) sheet.getColumn(col).width = col % 3 === 0 ? 11 : 9;
  sheet.eachRow((row, rowNo) => {
    row.height = rowNo <= 3 ? 24 : 22;
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (rowNo > 3) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowNo % 2 ? 'FFE8E8E8' : 'FFD3D3D3' } };
    });
  });
}
