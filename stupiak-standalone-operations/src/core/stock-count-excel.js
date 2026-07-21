const WEEK_GROUPS = [[2, 6], [7, 11], [12, 16], [17, 21], [22, 26]];

export async function importStockCountWorkbook(file, state) {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) throw new Error('Excel engine is still loading. Try again in a few seconds.');
  if (!state?.data) throw new Error('Open Stock Count data before importing count Excel.');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const sectionName = state.activeTab || 'Inventory';
  const section = (state.data.sections || []).find((entry) => entry.sheetName === sectionName);
  if (!section) throw new Error(`No ${sectionName} section is loaded.`);

  if (sectionName === 'Stationary') return importStationary(workbook, state, section);
  return importWeeklySection(workbook, state, section);
}

function importWeeklySection(workbook, state, section) {
  const sheet = findWorksheet(workbook, section.sheetName);
  if (!sheet) throw missingSheetError(workbook, section.sheetName);

  const weekIndex = Number(state.lastEditedWeek || state.mobileWeek || state.data?.selectedWeek || 1);
  const group = WEEK_GROUPS[Math.max(0, Math.min(4, weekIndex - 1))];
  const primaryCol = group[0];
  const secondaryCol = primaryCol + 2;
  let imported = 0;

  state.values[section.sheetName] = state.values[section.sheetName] || {};
  for (const row of section.rows || []) {
    const target = state.values[section.sheetName][row.row] || {};
    target[weekIndex] = target[weekIndex] || {};
    if (section.type === 'weekly-inventory') {
      const primary = cellNumberOrBlank(sheet, row.row, primaryCol);
      const secondary = row.hasSecondaryQuantity ? cellNumberOrBlank(sheet, row.row, secondaryCol) : undefined;
      if (primary !== '') { target[weekIndex].primary = primary; imported += 1; }
      else target[weekIndex].primary = target[weekIndex].primary ?? '';
      if (row.hasSecondaryQuantity) target[weekIndex].secondary = secondary === undefined ? '' : secondary;
    } else {
      const qty = cellNumberOrBlank(sheet, row.row, primaryCol);
      if (qty !== '') { target[weekIndex].quantity = qty; imported += 1; }
      else target[weekIndex].quantity = target[weekIndex].quantity ?? '';
    }
    state.values[section.sheetName][row.row] = target;
  }

  state.dirtyColumns = state.dirtyColumns || {};
  state.dirtyColumns[section.sheetName] = { ...(state.dirtyColumns[section.sheetName] || {}), [weekIndex]: true };
  state.lastEditedWeek = weekIndex;
  state.mobileWeek = weekIndex;

  const headerDate = detectWeekDate(sheet, primaryCol);
  if (headerDate) {
    state.sheetWeekDates = state.sheetWeekDates || {};
    state.sheetWeekDates[section.sheetName] = { ...(state.sheetWeekDates[section.sheetName] || {}), [weekIndex]: headerDate };
  }

  return { sectionName: section.sheetName, weekIndex, imported, matchedTab: sheet.name };
}

function importStationary(workbook, state, section) {
  const sheet = findWorksheet(workbook, 'Stationary');
  if (!sheet) throw missingSheetError(workbook, 'Stationary');
  let imported = 0;
  state.values.Stationary = state.values.Stationary || {};
  for (const row of section.rows || []) {
    const quantity = cellNumberOrBlank(sheet, row.row, 2);
    state.values.Stationary[row.row] = { quantity };
    if (quantity !== '') imported += 1;
  }
  state.stationaryDirty = true;
  return { sectionName: 'Stationary', weekIndex: 0, imported, matchedTab: sheet.name };
}

function findWorksheet(workbook, expectedName) {
  const expected = normalizeSheetName(expectedName);
  const direct = workbook.getWorksheet(expectedName);
  if (direct) return direct;

  const sheets = workbook.worksheets || [];
  return sheets.find((sheet) => normalizeSheetName(sheet.name) === expected)
    || sheets.find((sheet) => normalizeSheetName(sheet.name).includes(expected) || expected.includes(normalizeSheetName(sheet.name)))
    || aliasWorksheet(sheets, expected);
}

function aliasWorksheet(sheets, expected) {
  if (expected === 'untensil pg1' || expected === 'utensil pg1') {
    return sheets.find((sheet) => /u?n?tensil\s*pg\s*1/i.test(normalizeSheetName(sheet.name)));
  }
  if (expected === 'utensil pg2') {
    return sheets.find((sheet) => /u?n?tensil\s*pg\s*2/i.test(normalizeSheetName(sheet.name)));
  }
  if (expected === 'inventory') {
    return sheets.find((sheet) => /inventory/i.test(normalizeSheetName(sheet.name)));
  }
  if (expected === 'stationary') {
    return sheets.find((sheet) => /stationary|stationery/i.test(normalizeSheetName(sheet.name)));
  }
  return null;
}

function normalizeSheetName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function missingSheetError(workbook, expectedName) {
  const tabs = (workbook.worksheets || []).map((sheet) => sheet.name).filter(Boolean).join(', ') || 'none';
  return new Error(`This Excel cannot find ${expectedName}. Tabs found: ${tabs}`);
}

function cellNumberOrBlank(sheet, row, col) {
  const cell = sheet.getRow(row).getCell(col);
  const raw = cell?.result ?? cell?.value;
  if (raw === '' || raw === null || raw === undefined) return '';
  if (typeof raw === 'object' && raw.text) return parseNumber(raw.text);
  if (typeof raw === 'object' && raw.richText) return parseNumber(raw.richText.map((part) => part.text || '').join(''));
  return parseNumber(raw);
}

function parseNumber(value) {
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!text) return '';
  const number = Number(text);
  return Number.isFinite(number) ? number : '';
}

function detectWeekDate(sheet, col) {
  for (const row of [2, 3]) {
    const raw = sheet.getRow(row).getCell(col)?.value;
    const iso = toIsoDate(raw);
    if (iso) return iso;
  }
  return '';
}

function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value || '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return text;
  const dmy = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/.exec(text);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return '';
}
