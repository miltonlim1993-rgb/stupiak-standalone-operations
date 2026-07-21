const INVENTORY_GROUPS = [[2, 6], [7, 11], [12, 16], [17, 21], [22, 26]];
const UTENSIL_GROUPS = [[2, 4], [5, 7], [8, 10], [11, 13], [14, 16]];
const DB_COUNT_SHEETS = ['Stock Count DB', '_StockCount'];

export async function importStockCountWorkbook(file, state) {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) throw new Error('Excel engine is still loading. Try again.');
  if (!state?.data) throw new Error('Open Stock Count before importing.');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const dbSheet = DB_COUNT_SHEETS.map((name) => findWorksheet(workbook, name)).find(Boolean);
  if (dbSheet) return importDbSheet(dbSheet, state);

  const results = [];
  const importedWeeks = new Set();
  let imported = 0;
  let staff = '';

  for (const section of state.data.sections || []) {
    const sheet = findWorksheet(workbook, section.sheetName);
    if (!sheet) continue;
    const result = section.sheetName === 'Stationary'
      ? importStationary(sheet, state, section)
      : importWeekly(sheet, state, section);
    if (result.imported > 0 || result.dateOnlyWeeks.length) results.push(result);
    imported += result.imported;
    result.importedWeeks.forEach((week) => importedWeeks.add(week));
    staff ||= result.countedBy || '';
  }

  if (!results.length) {
    const tabs = (workbook.worksheets || []).map((sheet) => sheet.name).join(', ') || 'none';
    throw new Error(`No Stock Count values found. Excel tabs: ${tabs}`);
  }

  if (!String(state.countedBy || '').trim() && staff) state.countedBy = staff;
  const focus = results.find((result) => result.imported > 0) || results[0];
  if (focus.weekIndex) {
    state.lastEditedWeek = focus.weekIndex;
    state.mobileWeek = focus.weekIndex;
  }

  return {
    sectionName: `${results.length} tabs`,
    imported,
    importedWeeks: Array.from(importedWeeks).sort((a, b) => a - b),
    importedSections: results,
    weekIndex: focus.weekIndex || 0,
    matchedTabs: results.map((result) => result.matchedTab)
  };
}

function importWeekly(sheet, state, section) {
  const groups = section.type === 'weekly-inventory' ? INVENTORY_GROUPS : UTENSIL_GROUPS;
  const sourceRows = itemRowMap(sheet);
  const weeks = detectWeeks(sheet, state, section, sourceRows, groups);
  const importedWeeks = [];
  const dateOnlyWeeks = [];
  let imported = 0;

  state.values[section.sheetName] = state.values[section.sheetName] || {};
  state.dirtyColumns = state.dirtyColumns || {};
  state.dirtyColumns[section.sheetName] = { ...(state.dirtyColumns[section.sheetName] || {}) };
  state.sheetWeekDates = state.sheetWeekDates || {};
  state.sheetWeekDates[section.sheetName] = { ...(state.sheetWeekDates[section.sheetName] || {}) };

  for (const targetWeek of weeks) {
    const weekIndex = targetWeek.weekIndex;
    const primaryCol = targetWeek.col;
    let importedThisWeek = 0;

    for (const row of section.rows || []) {
      const sourceRow = sourceRows.get(normalizeItem(row.item)) || fallbackRow(sheet, row.row, row.item);
      if (!sourceRow) continue;
      const target = state.values[section.sheetName][row.row] || {};
      target[weekIndex] = target[weekIndex] || {};

      if (section.type === 'weekly-inventory') {
        const primary = numberOrBlank(sheet, sourceRow, primaryCol);
        const secondary = row.hasSecondaryQuantity ? numberOrBlank(sheet, sourceRow, primaryCol + 2) : '';
        if (primary !== '') {
          target[weekIndex].primary = primary;
          imported += 1;
          importedThisWeek += 1;
        }
        if (row.hasSecondaryQuantity && secondary !== '') target[weekIndex].secondary = secondary;
      } else {
        const quantity = numberOrBlank(sheet, sourceRow, primaryCol);
        if (quantity !== '') {
          target[weekIndex].quantity = quantity;
          imported += 1;
          importedThisWeek += 1;
        }
      }
      state.values[section.sheetName][row.row] = target;
    }

    if (targetWeek.date) state.sheetWeekDates[section.sheetName][weekIndex] = targetWeek.date;
    if (importedThisWeek > 0) {
      state.dirtyColumns[section.sheetName][weekIndex] = true;
      importedWeeks.push(weekIndex);
    } else if (targetWeek.date) {
      dateOnlyWeeks.push(weekIndex);
    }
  }

  return {
    sectionName: section.sheetName,
    imported,
    importedWeeks,
    dateOnlyWeeks,
    weekIndex: importedWeeks[0] || weeks[0]?.weekIndex || 0,
    countedBy: detectStaff(sheet),
    matchedTab: sheet.name
  };
}

function importStationary(sheet, state, section) {
  const sourceRows = itemRowMap(sheet);
  let imported = 0;
  state.values.Stationary = state.values.Stationary || {};
  for (const row of section.rows || []) {
    const sourceRow = sourceRows.get(normalizeItem(row.item)) || fallbackRow(sheet, row.row, row.item);
    if (!sourceRow) continue;
    const quantity = numberOrBlank(sheet, sourceRow, 2);
    if (quantity === '') continue;
    state.values.Stationary[row.row] = { quantity };
    imported += 1;
  }
  if (imported > 0) state.stationaryDirty = true;
  const date = detectAnyDate(sheet, state);
  if (date) state.stationaryDate = date;
  return {
    sectionName: 'Stationary',
    imported,
    importedWeeks: [],
    dateOnlyWeeks: [],
    weekIndex: 0,
    countedBy: detectStaff(sheet),
    matchedTab: sheet.name
  };
}

function importDbSheet(sheet, state) {
  const headerRow = findHeaderRow(sheet, ['section', 'item']);
  if (!headerRow) throw new Error('Stock Count DB headers not found.');
  const headers = headerMap(sheet, headerRow);
  const sections = new Map((state.data.sections || []).map((section) => [canonicalSection(section.sheetName), section]));
  const rowsBySection = new Map();
  for (const section of state.data.sections || []) rowsBySection.set(section.sheetName, new Map((section.rows || []).map((row) => [normalizeItem(row.item), row])));

  let imported = 0;
  const importedWeeks = new Set();
  const importedSections = new Set();
  let firstWeek = 0;
  let staff = '';

  for (let rowNo = headerRow + 1; rowNo <= Math.min(sheet.rowCount || 0, 10000); rowNo += 1) {
    const sectionName = canonicalSection(byHeaderText(sheet, rowNo, headers, ['section', 'tab', 'sheet']));
    const itemName = byHeaderText(sheet, rowNo, headers, ['item']);
    const section = sections.get(sectionName);
    const row = rowsBySection.get(sectionName)?.get(normalizeItem(itemName));
    if (!section || !row) continue;

    const countDate = toIsoDate(byHeaderValue(sheet, rowNo, headers, ['count date', 'date']), state);
    staff ||= byHeaderText(sheet, rowNo, headers, ['staff name', 'counted by', 'staff']);

    if (sectionName === 'Stationary') {
      const quantity = parseNumber(byHeaderValue(sheet, rowNo, headers, ['quantity', 'primary qty', 'qty']));
      if (quantity === '') continue;
      state.values.Stationary = state.values.Stationary || {};
      state.values.Stationary[row.row] = { quantity };
      state.stationaryDirty = true;
      if (countDate) state.stationaryDate = countDate;
      imported += 1;
      importedSections.add(sectionName);
      continue;
    }

    const week = clampWeek(Number(byHeaderText(sheet, rowNo, headers, ['week', 'week index'])));
    if (!week) continue;
    state.values[sectionName] = state.values[sectionName] || {};
    state.values[sectionName][row.row] = state.values[sectionName][row.row] || {};
    state.values[sectionName][row.row][week] = state.values[sectionName][row.row][week] || {};

    if (section.type === 'weekly-inventory') {
      const primary = parseNumber(byHeaderValue(sheet, rowNo, headers, ['primary qty', 'quantity', 'qty']));
      const secondary = parseNumber(byHeaderValue(sheet, rowNo, headers, ['secondary qty', 'qty 2']));
      if (primary === '') continue;
      state.values[sectionName][row.row][week].primary = primary;
      if (secondary !== '') state.values[sectionName][row.row][week].secondary = secondary;
    } else {
      const quantity = parseNumber(byHeaderValue(sheet, rowNo, headers, ['quantity', 'primary qty', 'qty']));
      if (quantity === '') continue;
      state.values[sectionName][row.row][week].quantity = quantity;
    }

    state.dirtyColumns = state.dirtyColumns || {};
    state.dirtyColumns[sectionName] = state.dirtyColumns[sectionName] || {};
    state.dirtyColumns[sectionName][week] = true;
    state.sheetWeekDates = state.sheetWeekDates || {};
    state.sheetWeekDates[sectionName] = state.sheetWeekDates[sectionName] || {};
    if (countDate) state.sheetWeekDates[sectionName][week] = countDate;
    imported += 1;
    importedWeeks.add(week);
    importedSections.add(sectionName);
    firstWeek ||= week;
  }

  if (!String(state.countedBy || '').trim() && staff) state.countedBy = staff;
  if (firstWeek) {
    state.lastEditedWeek = firstWeek;
    state.mobileWeek = firstWeek;
  }
  return {
    sectionName: `${importedSections.size} tabs`,
    imported,
    importedWeeks: Array.from(importedWeeks).sort((a, b) => a - b),
    importedSections: Array.from(importedSections),
    weekIndex: firstWeek,
    matchedTabs: [sheet.name]
  };
}

function detectWeeks(sheet, state, section, sourceRows, groups) {
  const result = [];
  const monthKey = String(state.monthKey || state.businessDate || '').slice(0, 7);
  for (let index = 0; index < groups.length; index += 1) {
    const col = groups[index][0];
    const date = detectWeekDate(sheet, col, state);
    const hasData = sectionHasData(sheet, section, sourceRows, col);
    if (!date && !hasData) continue;
    result.push({ weekIndex: date ? weekFromDate(date, monthKey) || index + 1 : index + 1, col, date });
  }
  const unique = new Map();
  for (const entry of result) if (!unique.has(entry.weekIndex)) unique.set(entry.weekIndex, entry);
  return Array.from(unique.values());
}

function sectionHasData(sheet, section, sourceRows, col) {
  for (const row of section.rows || []) {
    const sourceRow = sourceRows.get(normalizeItem(row.item));
    if (!sourceRow) continue;
    if (numberOrBlank(sheet, sourceRow, col) !== '') return true;
    if (section.type === 'weekly-inventory' && row.hasSecondaryQuantity && numberOrBlank(sheet, sourceRow, col + 2) !== '') return true;
  }
  return false;
}

function itemRowMap(sheet) {
  const map = new Map();
  for (let rowNo = 1; rowNo <= Math.min(sheet.rowCount || 0, 2000); rowNo += 1) {
    const item = cellText(sheet.getRow(rowNo).getCell(1));
    if (!validItem(item)) continue;
    const key = normalizeItem(item);
    if (!map.has(key)) map.set(key, rowNo);
  }
  return map;
}

function fallbackRow(sheet, rowNo, expected) {
  if (!rowNo || rowNo > (sheet.rowCount || 0)) return 0;
  return normalizeItem(cellText(sheet.getRow(rowNo).getCell(1))) === normalizeItem(expected) ? rowNo : 0;
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
  if (/u?n?tensil pg 1|u?n?tensil pg1/.test(expected)) return sheets.find((sheet) => /u?n?tensil\s*pg\s*1/i.test(normalize(sheet.name)));
  if (/u?n?tensil pg 2|u?n?tensil pg2/.test(expected)) return sheets.find((sheet) => /u?n?tensil\s*pg\s*2/i.test(normalize(sheet.name)));
  if (expected === 'inventory') return sheets.find((sheet) => /^inventory(?:\s|$)/i.test(normalize(sheet.name)));
  if (expected === 'stationary') return sheets.find((sheet) => /stationary|stationery/i.test(normalize(sheet.name)));
  if (expected === 'stock count db' || expected === '_stockcount') return sheets.find((sheet) => /stock\s*count\s*(db)?/i.test(normalize(sheet.name)));
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

function validItem(value) {
  const item = String(value || '').trim();
  if (!item || item.length > 300 || /^item$/i.test(item) || /^week\s*\d+/i.test(item) || /^quantity/i.test(item) || /^status$/i.test(item)) return false;
  return (item.match(/,/g) || []).length <= 8;
}

function numberOrBlank(sheet, row, col) { return parseNumber(sheet.getRow(row).getCell(col)?.result ?? sheet.getRow(row).getCell(col)?.value); }
function parseNumber(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.result !== undefined) return parseNumber(value.result);
    if (value.text !== undefined) return parseNumber(value.text);
    if (Array.isArray(value.richText)) return parseNumber(value.richText.map((part) => part.text || '').join(''));
    return '';
  }
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : '';
}

function detectWeekDate(sheet, col, state) {
  for (const row of [1, 2, 3]) {
    const date = toIsoDate(sheet.getRow(row).getCell(col)?.value, state);
    if (date) return date;
  }
  return '';
}

function detectAnyDate(sheet, state) {
  for (let row = 1; row <= Math.min(sheet.rowCount || 0, 10); row += 1) for (let col = 1; col <= Math.min(sheet.columnCount || 0, 15); col += 1) {
    const date = toIsoDate(sheet.getRow(row).getCell(col)?.value, state);
    if (date) return date;
  }
  return '';
}

function detectStaff(sheet) {
  for (let row = 1; row <= Math.min(sheet.rowCount || 0, 100); row += 1) for (let col = 1; col <= Math.min(sheet.columnCount || 0, 30); col += 1) {
    const label = cellText(sheet.getRow(row).getCell(col)).toLowerCase();
    if (!/^(counted by|staff name|staff)$/.test(label)) continue;
    const right = cellText(sheet.getRow(row).getCell(col + 1));
    const below = cellText(sheet.getRow(row + 1).getCell(col));
    return right || below || '';
  }
  return '';
}

function weekFromDate(isoDate, monthKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) return 0;
  const [year, month, day] = isoDate.split('-').map(Number);
  const targetMonth = /^\d{4}-\d{2}$/.test(String(monthKey || '')) ? monthKey : `${year}-${String(month).padStart(2, '0')}`;
  const [targetYear, targetMonthNo] = targetMonth.split('-').map(Number);
  const start = monday(new Date(targetYear, targetMonthNo - 1, 1));
  const diff = Math.floor((new Date(year, month - 1, day) - start) / 86400000);
  const week = Math.floor(diff / 7) + 1;
  return week >= 1 && week <= 5 ? week : 0;
}

function monday(date) {
  const day = date.getDay();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + (day === 0 ? -6 : 1 - day));
}

function toIsoDate(value, state) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  if (typeof value === 'number' && value > 20000 && value < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000).toISOString().slice(0, 10);
  if (typeof value === 'object' && value) {
    if (value.result !== undefined) return toIsoDate(value.result, state);
    if (value.text !== undefined) return toIsoDate(value.text, state);
  }
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const dmy = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/.exec(text);
  if (dmy) return `${dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const named = /^(\d{1,2})\s*-\s*([A-Za-z]{3,})$/.exec(text) || /^([A-Za-z]{3,})\s*(\d{1,2})$/.exec(text);
  if (named) {
    const day = Number(/^\d/.test(named[1]) ? named[1] : named[2]);
    const month = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[String(/^\d/.test(named[1]) ? named[2] : named[1]).slice(0, 3).toLowerCase()];
    const year = Number(String(state?.monthKey || state?.businessDate || new Date().getFullYear()).slice(0, 4));
    if (month && day) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return '';
}

function cellText(cell) {
  const value = cell?.result ?? cell?.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.result !== undefined) return cellText({ value: value.result });
    if (value.text !== undefined) return String(value.text || '').trim();
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('').trim();
    return '';
  }
  return String(value).trim();
}

function normalize(value) { return String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function normalizeItem(value) { return normalize(value).replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); }
function normalizeHeader(value) { return normalize(value).replace(/[_-]+/g, ' '); }
function clampWeek(value) { return value >= 1 && value <= 5 ? value : 0; }
function findHeaderRow(sheet, required) {
  for (let rowNo = 1; rowNo <= Math.min(sheet.rowCount || 0, 20); rowNo += 1) {
    const values = [];
    for (let col = 1; col <= Math.min(sheet.columnCount || 30, 30); col += 1) values.push(normalizeHeader(cellText(sheet.getRow(rowNo).getCell(col))));
    if (required.every((header) => values.includes(header))) return rowNo;
  }
  return 0;
}
function headerMap(sheet, rowNo) {
  const map = new Map();
  for (let col = 1; col <= Math.min(sheet.columnCount || 50, 50); col += 1) {
    const header = normalizeHeader(cellText(sheet.getRow(rowNo).getCell(col)));
    if (header) map.set(header, col);
  }
  return map;
}
function byHeaderValue(sheet, rowNo, headers, names) {
  for (const name of names) { const col = headers.get(normalizeHeader(name)); if (col) return sheet.getRow(rowNo).getCell(col).value; }
  return '';
}
function byHeaderText(sheet, rowNo, headers, names) { return cellText({ value: byHeaderValue(sheet, rowNo, headers, names) }); }