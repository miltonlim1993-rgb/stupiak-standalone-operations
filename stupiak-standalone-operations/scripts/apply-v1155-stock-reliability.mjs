import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceExact(source, search, replacement, label) {
  if (!source.includes(search)) {
    console.warn(`v1.15.5 patch skipped: ${label}`);
    return source;
  }
  return source.replace(search, replacement);
}

export async function applyV1155StockReliability(dist) {
  await patchOfflineWorkflow(dist);
  await patchMain(dist);
  await patchStockSetupParser(dist);
  await patchStockPage(dist);
}

async function patchOfflineWorkflow(dist) {
  const file = resolve(dist, 'src/core/offline-workflow.js');
  let source = await readFile(file, 'utf8');

  if (!source.includes('export function clearStockBootstrap')) {
    source = replaceExact(
      source,
      `export function writeStockBootstrap(outlet, businessDate, data) {
  writeJson(stockBootstrapKey(outlet, businessDate), data);
  writeJson(latestStockBootstrapKey(outlet), data);
}`,
      `export function writeStockBootstrap(outlet, businessDate, data) {
  writeJson(stockBootstrapKey(outlet, businessDate), data);
  writeJson(latestStockBootstrapKey(outlet), data);
}

export function clearStockBootstrap(outlet, businessDate) {
  removeKey(stockBootstrapKey(outlet, businessDate));
  removeKey(latestStockBootstrapKey(outlet));
}`,
      'clear stock bootstrap helper'
    );
  }

  await writeFile(file, source);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = source.replace('writeStockBootstrap, readStockDraft', 'writeStockBootstrap, clearStockBootstrap, readStockDraft');
  source = source.replace(/const outlet = activeStockOutlet\(\);/g, 'const outlet = stockOfflineOutlet();');

  source = replaceExact(
    source,
    `  clearStockStateValues();
  persistStockDraft();
  render();`,
    `  clearStockStateValues();
  clearStockDraft(outlet, state.stock.businessDate);
  clearStockBootstrap(outlet, state.stock.businessDate);
  state.stock.pendingSubmission = '';
  state.stock.syncError = '';
  state.stock.submitResult = null;
  render();`,
    'clear should remove local draft and bootstrap cache'
  );

  source = replaceExact(
    source,
    `      showToast('Current month stock data cleared');`,
    `      clearStockDraft(outlet, state.stock.businessDate);
      clearStockBootstrap(outlet, state.stock.businessDate);
      showToast('Current month stock data cleared');`,
    'clear success removes cache again'
  );

  await writeFile(file, source);
}

async function patchStockSetupParser(dist) {
  const file = resolve(dist, 'src/core/stock-setup-excel.js');
  let source = await readFile(file, 'utf8');

  source = source.replace("parseInventorySheet(workbook.getWorksheet('Inventory'))", "parseInventorySheet(findStockWorksheet(workbook, 'Inventory'))");
  source = source.replace('parseUtensilSheet(workbook.getWorksheet(name), name)', 'parseUtensilSheet(findStockWorksheet(workbook, name), name)');
  source = source.replace("parseStationarySheet(workbook.getWorksheet('Stationary'))", "parseStationarySheet(findStockWorksheet(workbook, 'Stationary'))");
  source = source.replace("parseOrderPage(workbook.getWorksheet('Order Page'))", "parseOrderPage(findStockWorksheet(workbook, 'Order Page'))");

  if (!source.includes('function findStockWorksheet')) {
    source = replaceExact(
      source,
      `function parseInventorySheet(sheet) {`,
      `function findStockWorksheet(workbook, expectedName) {
  const expected = normalizeSheetName(expectedName);
  return workbook.getWorksheet(expectedName)
    || (workbook.worksheets || []).find((sheet) => normalizeSheetName(sheet.name) === expected)
    || (workbook.worksheets || []).find((sheet) => normalizeSheetName(sheet.name).includes(expected) || expected.includes(normalizeSheetName(sheet.name)))
    || aliasStockWorksheet(workbook.worksheets || [], expected);
}

function aliasStockWorksheet(sheets, expected) {
  if (expected === 'inventory') return sheets.find((sheet) => /inventory/i.test(normalizeSheetName(sheet.name)));
  if (expected === 'untensil pg1' || expected === 'utensil pg1') return sheets.find((sheet) => /u?n?tensil\\s*pg\\s*1/i.test(normalizeSheetName(sheet.name)));
  if (expected === 'utensil pg2') return sheets.find((sheet) => /u?n?tensil\\s*pg\\s*2/i.test(normalizeSheetName(sheet.name)));
  if (expected === 'stationary') return sheets.find((sheet) => /stationary|stationery/i.test(normalizeSheetName(sheet.name)));
  if (expected === 'order page') return sheets.find((sheet) => /order/i.test(normalizeSheetName(sheet.name)));
  return null;
}

function normalizeSheetName(value) {
  return String(value || '').normalize('NFKC').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim().toLowerCase();
}

function parseInventorySheet(sheet) {`,
      'flexible setup worksheet matching'
    );
  }

  source = replaceExact(
    source,
    `  if (!sheets.length) throw new Error('No valid Stock setup rows found. Keep the Excel tab names: Inventory, Untensil PG1, Utensil PG2, Stationary.');`,
    `  const foundSheets = new Set(sheets.map((sheet) => sheet.sheetName));
  const missingSheets = ALL_SETUP_SHEETS.filter((name) => !foundSheets.has(name));
  if (missingSheets.length) throw new Error('Stock Setup Excel incomplete. Missing tabs: ' + missingSheets.join(', ') + '. Upload the original RR-KCH Inventory Listing workbook, not an exported partial setup.');
  if (!sheets.length) throw new Error('No valid Stock setup rows found. Keep the Excel tab names: Inventory, Untensil PG1, Utensil PG2, Stationary.');`,
    'reject partial stock setup import'
  );

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = replaceExact(
    source,
    `  state.submitResult = null;`,
    `  if (!state.countedBy && data.countedBy) state.countedBy = data.countedBy;
  state.submitResult = null;`,
    'restore counted by from D1 bootstrap'
  );

  source = replaceExact(
    source,
    `  const dirty = isDirtyColumn(state, sheetName, week.index);
  return \`<th class="week-head week-date-head \${current ? 'current-week' : ''} \${dirty ? 'dirty-week-head' : ''} \${state.mobileWeek === week.index ? 'mobile-current' : ''}"><span>WEEK \${week.index}</span><small>\${period}</small><label class="week-date-control"><span>COUNT DATE · \${escapeHtml(sheetName)}</span><input type="date" data-week-date="\${week.index}" data-week-sheet="\${escapeHtml(sheetName)}" value="\${escapeHtml(dateValue)}" min="\${bounds.startIso}" max="\${bounds.endIso}"></label>\${dirty ? '<em>Changed in this tab</em>' : dateValue ? '<em>Saved date</em>' : ''}</th>\`;
}`,
    `  const dirty = isDirtyColumn(state, sheetName, week.index);
  const staff = String(week.countedBy || '').trim();
  const savedMeta = dateValue ? '<em>Saved date' + (staff ? ' · ' + escapeHtml(staff) : '') + '</em>' : staff ? '<em>By ' + escapeHtml(staff) + '</em>' : '';
  return \`<th class="week-head week-date-head \${current ? 'current-week' : ''} \${dirty ? 'dirty-week-head' : ''} \${state.mobileWeek === week.index ? 'mobile-current' : ''}"><span>WEEK \${week.index}</span><small>\${period}</small><label class="week-date-control"><span>COUNT DATE · \${escapeHtml(sheetName)}</span><input type="date" data-week-date="\${week.index}" data-week-sheet="\${escapeHtml(sheetName)}" value="\${escapeHtml(dateValue)}" min="\${bounds.startIso}" max="\${bounds.endIso}"></label>\${dirty ? '<em>Changed in this tab</em>' : savedMeta}</th>\`;
}`,
    'week header staff metadata'
  );

  await writeFile(file, source);
}
