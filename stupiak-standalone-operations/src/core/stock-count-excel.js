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

  const detectedWeeks = detectImportWeeks(sheet, state).filter(({ weekIndex }) => weekIndex >= 1 && weekIndex <= 5);
  const activeWeek = Number(state.lastEditedWeek || state.mobileWeek || state.data?.selectedWeek || 1);
  const targetWeeks = detectedWeeks.length
    ? uniqueWeeks(detectedWeeks)
    : [{ weekIndex: activeWeek, col: WEEK_GROUPS[Math.max(0, Math.min(4, activeWeek - 1))][0], date: '' }];

  let imported = 0;
  const importedWeeks = [];
  const dateOnlyWeeks = [];
  state.values[section.sheetName] = state.values[section.sheetName] || {};
  state.dirtyColumns = state.dirtyColumns || {};
  state.dirtyColumns[section.sheetName] = { ...(state.dirtyColumns[section.sheetName] || {}) };
  state.sheetWeekDates = state.sheetWeekDates || {};
  state.sheetWeekDates[section.sheetName] = { ...(state.sheetWeekDates[section.sheetName] || {}) };

  for (const targetWeek of targetWeeks) {
    const weekIndex = Number(targetWeek.weekIndex);
    const primaryCol = Number(targetWeek.col || WEEK_GROUPS[Math.max(0, Math.min(4, weekIndex - 1))][0]);
    const secondaryCol = primaryCol + 2;
    let importedThisWeek = 0;

    for (const row of section.rows || []) {
      const target = state.values[section.sheetName][row.row] || {};
      target[weekIndex] = target[weekIndex] || {};
      if (section.type === 'weekly-inventory') {
        const primary = cellNumberOrBlank(sheet, row.row, primaryCol);
        const secondary = row.hasSecondaryQuantity ? cellNumberOrBlank(sheet, row.row, secondaryCol) : undefined;
        if (primary !== '') { target[weekIndex].primary = primary; imported += 1; importedThisWeek += 1; }
        else target[weekIndex].primary = target[weekIndex].primary ?? '';
        if (row.hasSecondaryQuantity) target[weekIndex].secondary = secondary === undefined ? '' : secondary;
      } else {
        const qty = cellNumberOrBlank(sheet, row.row, primaryCol);
        if (qty !== '') { target[weekIndex].quantity = qty; imported += 1; importedThisWeek += 1; }
        else target[weekIndex].quantity = target[weekIndex].quantity ?? '';
      }
      state.values[section.sheetName][row.row] = target;
    }

    const date = targetWeek.date || detectWeekDate(sheet, primaryCol, state);
    if (date) state.sheetWeekDates[section.sheetName][weekIndex] = date;

    if (importedThisWeek > 0) {
      state.dirtyColumns[section.sheetName][weekIndex] = true;
      importedWeeks.push(weekIndex);
    } else if (date) {
      dateOnlyWeeks.push(weekIndex);
    }
  }

  const focusWeek = importedWeeks[0] || activeWeek || targetWeeks[0]?.weekIndex || 1;
  state.lastEditedWeek = focusWeek;
  state.mobileWeek = focusWeek;

  return { sectionName: section.sheetName, weekIndex: focusWeek, imported, importedWeeks, dateOnlyWeeks, matchedTab: sheet.name };
}

function uniqueWeeks(entries) {
  const seen = new Map();
  for (const entry of entries) {
    if (!seen.has(entry.weekIndex)) seen.set(entry.weekIndex, entry);
  }
  return Array.from(seen.values());
}

function detectImportWeeks(sheet, state) {
  const result = [];
  const monthKey = String(state.monthKey || state.businessDate || '').slice(0, 7);
  for (let i = 0; i < WEEK_GROUPS.length; i += 1) {
    const col = WEEK_GROUPS[i][0];
    const date = detectWeekDate(sheet, col, state);
    if (!date) continue;
    const weekIndex = weekIndexFromDate(date, monthKey) || i + 1;
    result.push({ weekIndex, col, date });
  }
  return result;
}

function weekIndexFromDate(isoDate, monthKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) return 0;
  const [year, month, day] = isoDate.split('-').map(Number);
  const currentMonth = `${year}-${String(month).padStart(2, '0')}`;
  const targetMonth = /^\d{4}-\d{2}$/.test(String(monthKey || '')) ? monthKey : currentMonth;
  const [targetYear, targetMonthNo] = targetMonth.split('-').map(Number);
  const gridStart = mondayOfWeek(new Date(targetYear, targetMonthNo - 1, 1));
  const target = new Date(year, month - 1, day);
  const diffDays = Math.floor((target - gridStart) / 86400000);
  const weekIndex = Math.floor(diffDays / 7) + 1;
  return weekIndex >= 1 && weekIndex <= 5 ? weekIndex : 0;
}

function mondayOfWeek(date) {
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff);
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
  state.stationaryDirty = imported > 0;
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

function detectWeekDate(sheet, col, state = null) {
  for (const row of [2, 1, 3]) {
    const raw = sheet.getRow(row).getCell(col)?.value;
    const iso = toIsoDate(raw, state);
    if (iso) return iso;
  }
  return '';
}

function toIsoDate(value, state = null) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value || '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return text;
  const dmy = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/.exec(text);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  const monthName = /^(\d{1,2})\s*-\s*([A-Za-z]{3,})$/.exec(text) || /^([A-Za-z]{3,})\s*(\d{1,2})$/.exec(text);
  if (monthName) {
    const day = Number(/^\d/.test(monthName[1]) ? monthName[1] : monthName[2]);
    const mon = /^\d/.test(monthName[1]) ? monthName[2] : monthName[1];
    const month = monthFromName(mon);
    const year = Number(String(state?.monthKey || state?.businessDate || new Date().getFullYear()).slice(0, 4));
    if (month && day) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return '';
}

function monthFromName(name) {
  const key = String(name || '').slice(0, 3).toLowerCase();
  return { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[key] || 0;
}
