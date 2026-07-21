const WEEKLY_SHEETS = ['Inventory', 'Untensil PG1', 'Utensil PG2'];
const ALL_SETUP_SHEETS = ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary'];

export async function parseStockSetupWorkbook(file, outlet = 'RR-KCH') {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) throw new Error('Excel engine is still loading. Please try again in a few seconds.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const sheets = [];
  const inventory = parseInventorySheet(workbook.getWorksheet('Inventory'));
  if (inventory.rows.length) sheets.push(inventory);
  for (const name of ['Untensil PG1', 'Utensil PG2']) {
    const parsed = parseUtensilSheet(workbook.getWorksheet(name), name);
    if (parsed.rows.length) sheets.push(parsed);
  }
  const stationary = parseStationarySheet(workbook.getWorksheet('Stationary'));
  if (stationary.rows.length) sheets.push(stationary);

  if (!sheets.length) throw new Error('No valid Stock setup rows found. Keep the Excel tab names: Inventory, Untensil PG1, Utensil PG2, Stationary.');

  return {
    version: 1,
    outlet,
    workbookName: file.name || 'Stock Setup Excel',
    importedAt: new Date().toISOString(),
    sheets,
    orderPage: parseOrderPage(workbook.getWorksheet('Order Page'))
  };
}

export async function exportStockSetupWorkbook(setup, filename = 'stock-setup.xlsx') {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) throw new Error('Excel engine is still loading. Please try again in a few seconds.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Stupiak Operations';
  workbook.created = new Date();

  writeOrderPage(workbook, setup?.orderPage?.values || []);
  for (const sheetName of ALL_SETUP_SHEETS) {
    const sheet = (setup?.sheets || []).find((entry) => entry.sheetName === sheetName);
    if (!sheet) continue;
    if (sheetName === 'Inventory') writeInventorySetupSheet(workbook, sheet);
    else if (sheetName === 'Stationary') writeStationarySetupSheet(workbook, sheet);
    else writeUtensilSetupSheet(workbook, sheet);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

function parseInventorySheet(sheet) {
  const rows = [];
  if (!sheet) return { sheetName: 'Inventory', type: 'weekly-inventory', rows };
  const maxRow = Math.min(sheet.rowCount || 0, 500);
  for (let rowNo = 4; rowNo <= maxRow; rowNo += 1) {
    const item = text(sheet, rowNo, 1);
    if (!item) continue;
    const units = unitsAcrossGroups(sheet, rowNo, [[2, 6], [7, 11], [12, 16], [17, 21], [22, 26]]);
    const minimum = number(sheet, rowNo, 27);
    rows.push({
      row: rowNo,
      item,
      minimum,
      primaryUnit: units[0] || 'Pack',
      secondaryUnit: units[1] || '',
      hasSecondaryQuantity: units.length > 1,
      conversion: 1,
      active: true
    });
  }
  return { sheetName: 'Inventory', type: 'weekly-inventory', rows };
}

function parseUtensilSheet(sheet, sheetName) {
  const rows = [];
  if (!sheet) return { sheetName, type: 'weekly-utensil', rows };
  const maxRow = Math.min(sheet.rowCount || 0, 500);
  for (let rowNo = 4; rowNo <= maxRow; rowNo += 1) {
    const item = text(sheet, rowNo, 1);
    if (!item) continue;
    const units = unitsAcrossGroups(sheet, rowNo, [[2, 4], [5, 7], [8, 10], [11, 13], [14, 16]]);
    rows.push({
      row: rowNo,
      item,
      minimum: number(sheet, rowNo, 17),
      unit: units[0] || 'Pack',
      primaryUnit: units[0] || 'Pack',
      active: true
    });
  }
  return { sheetName, type: 'weekly-utensil', rows };
}

function parseStationarySheet(sheet) {
  const rows = [];
  if (!sheet) return { sheetName: 'Stationary', type: 'monthly-stationary', rows };
  const maxRow = Math.min(sheet.rowCount || 0, 500);
  for (let rowNo = 4; rowNo <= maxRow; rowNo += 1) {
    const item = text(sheet, rowNo, 1);
    if (!item) continue;
    rows.push({
      row: rowNo,
      item,
      minimum: number(sheet, rowNo, 5),
      unit: text(sheet, rowNo, 3) || 'PCS',
      primaryUnit: text(sheet, rowNo, 3) || 'PCS',
      active: true
    });
  }
  return { sheetName: 'Stationary', type: 'monthly-stationary', rows };
}

function parseOrderPage(sheet) {
  const values = [];
  if (!sheet) return { values };
  const maxRow = Math.min(sheet.rowCount || 0, 200);
  const maxCol = Math.min(sheet.columnCount || 1, 20);
  for (let rowNo = 1; rowNo <= maxRow; rowNo += 1) {
    const row = [];
    let used = false;
    for (let col = 1; col <= maxCol; col += 1) {
      const value = display(sheet.getCell(rowNo, col).value);
      if (value) used = true;
      row.push(value);
    }
    if (used) values.push(row);
  }
  return { values };
}

function unitsAcrossGroups(sheet, rowNo, groups) {
  const seen = [];
  for (const [start, end] of groups) {
    for (let col = start; col <= end; col += 1) {
      const value = text(sheet, rowNo, col);
      if (!value || isStatusText(value)) continue;
      if (!seen.includes(value)) seen.push(value);
    }
  }
  return seen.slice(0, 2);
}

function isStatusText(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['order', 'ok', 'status', 'no more use', 'spare item'].includes(normalized);
}

function text(sheet, row, col) {
  return display(sheet.getCell(row, col).value).trim();
}

function number(sheet, row, col) {
  const raw = sheet.getCell(row, col).value;
  const value = typeof raw === 'object' && raw && raw.result !== undefined ? raw.result : raw;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function display(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.result !== undefined) return display(value.result);
    if (value.text !== undefined) return String(value.text || '');
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if (value.formula) return '';
  }
  return String(value);
}

function writeOrderPage(workbook, values) {
  const sheet = workbook.addWorksheet('Order Page');
  if (values.length) sheet.addRows(values);
  else sheet.addRows([['Week 1'], ['Inventory Order List'], [''], ['Utensil Order List']]);
  sheet.getColumn(1).width = 36;
  styleTitle(sheet.getCell(1, 1));
}

function writeInventorySetupSheet(workbook, setupSheet) {
  const sheet = workbook.addWorksheet('Inventory');
  sheet.mergeCells('A1:AA1');
  sheet.getCell('A1').value = 'Inventory listing 2026';
  styleTitle(sheet.getCell('A1'));
  sheet.getCell('A2').value = 'ITEM';
  styleHeaderRow(sheet, 2, 27);
  const groups = [[2, 6], [7, 11], [12, 16], [17, 21], [22, 26]];
  groups.forEach(([start], index) => {
    sheet.getCell(2, start).value = `WEEK ${index + 1}`;
    sheet.getCell(3, start).value = 'Quantity';
    sheet.getCell(3, start + 1).value = 'Unit';
    sheet.getCell(3, start + 2).value = 'Quantity';
    sheet.getCell(3, start + 3).value = 'Unit';
    sheet.getCell(3, start + 4).value = 'Status';
  });
  sheet.getCell('AA2').value = 'MIN';
  (setupSheet.rows || []).forEach((row, index) => {
    const r = index + 4;
    sheet.getCell(r, 1).value = row.item;
    groups.forEach(([start]) => {
      sheet.getCell(r, start + 1).value = row.primaryUnit || row.unit || '';
      if (row.hasSecondaryQuantity) sheet.getCell(r, start + 3).value = row.secondaryUnit || '';
      sheet.getCell(r, start + 4).value = 'Order';
    });
    sheet.getCell(r, 27).value = row.minimum || 0;
  });
  finishSetupSheet(sheet, 27);
}

function writeUtensilSetupSheet(workbook, setupSheet) {
  const sheet = workbook.addWorksheet(setupSheet.sheetName);
  sheet.mergeCells('A1:Q1');
  sheet.getCell('A1').value = 'Untensil Inventory listing 2026 (WEEKLY STOCK)';
  styleTitle(sheet.getCell('A1'));
  sheet.getCell('A2').value = 'ITEM';
  styleHeaderRow(sheet, 2, 17);
  const groups = [[2, 4], [5, 7], [8, 10], [11, 13], [14, 16]];
  groups.forEach(([start], index) => {
    sheet.getCell(2, start).value = `WEEK ${index + 1}`;
    sheet.getCell(3, start).value = 'Quantity';
    sheet.getCell(3, start + 1).value = 'Unit';
    sheet.getCell(3, start + 2).value = 'Status';
  });
  sheet.getCell('Q2').value = 'Minimum Order Quantity';
  (setupSheet.rows || []).forEach((row, index) => {
    const r = index + 4;
    sheet.getCell(r, 1).value = row.item;
    groups.forEach(([start]) => {
      sheet.getCell(r, start + 1).value = row.unit || row.primaryUnit || '';
      sheet.getCell(r, start + 2).value = 'Order';
    });
    sheet.getCell(r, 17).value = row.minimum || 0;
  });
  finishSetupSheet(sheet, 17);
}

function writeStationarySetupSheet(workbook, setupSheet) {
  const sheet = workbook.addWorksheet('Stationary');
  sheet.mergeCells('A1:E1');
  sheet.getCell('A1').value = 'Stationary Intensity listing 2026 (MONTHLY STOCK)';
  styleTitle(sheet.getCell('A1'));
  sheet.getRow(2).values = ['ITEM', 'Quantity', 'Unit', 'Status', 'Min Order'];
  styleHeaderRow(sheet, 2, 5);
  (setupSheet.rows || []).forEach((row, index) => {
    const r = index + 3;
    sheet.getCell(r, 1).value = row.item;
    sheet.getCell(r, 3).value = row.unit || row.primaryUnit || '';
    sheet.getCell(r, 4).value = 'Order';
    sheet.getCell(r, 5).value = row.minimum || 0;
  });
  finishSetupSheet(sheet, 5);
}

function styleTitle(cell) {
  cell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3D3D3D' } };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

function styleHeaderRow(sheet, rowNo, maxCol) {
  const row = sheet.getRow(rowNo);
  for (let col = 1; col <= maxCol; col += 1) {
    const cell = row.getCell(col);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3D3D3D' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  }
}

function finishSetupSheet(sheet, maxCol) {
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];
  sheet.getColumn(1).width = 46;
  for (let col = 2; col <= maxCol; col += 1) sheet.getColumn(col).width = col % 3 === 0 ? 11 : 9;
  sheet.eachRow((row, rowNo) => {
    row.height = rowNo <= 3 ? 24 : 22;
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        left: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        right: { style: 'thin', color: { argb: 'FFFFFFFF' } }
      };
      if (rowNo > 3) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowNo % 2 ? 'FFE8E8E8' : 'FFD3D3D3' } };
    });
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
