import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1151StockD1Operator(dist) {
  await patchStockPage(dist);
  await patchMain(dist);
  await patchStyles(dist);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(/Refreshing monthly Sheet in the background/g, '');
  source = source.replace(/Google Sheet sync is unavailable/g, '');
  source = source.replace(/Request took longer than 60 seconds\. Tap Retry\./g, '');
  source = source.replace(/Save writes to _StockRelation\. PDF and Excel follow the RR-KCH Inventory Listing workbook layout\.?/g, 'Save to D1. Export follows Excel.');
  source = source.replace(/Save writes to _StockRelation/g, 'Save to D1');
  source = source.replace(/Saving to _StockRelation/g, 'Saving to D1');
  source = source.replace(/Saved to _StockRelation/g, 'Saved to D1');
  source = source.replace(/Save to Sheet/g, 'Save');
  source = source.replace(/Saving to Sheet…/g, 'Saving…');

  if (!source.includes('id="import-stock-count"')) {
    source = source.replace(
      /<div class="stock-action-buttons">/,
      `<div class="stock-action-buttons"><input id="stock-count-import-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden><button class="button secondary compact-stock-action" id="import-stock-count">Import</button><button class="button secondary danger-soft compact-stock-action" id="clear-stock-data">Clear</button>`
    );
  }

  source = source.replace(/<button class="button primary" id="submit-stock"/g, '<button class="button primary compact-stock-action" id="submit-stock"');
  source = source.replace(/<button class="button secondary" id="export-stock-pdf"/g, '<button class="button secondary compact-stock-action" id="export-stock-pdf"');
  source = source.replace(/<button class="button secondary" id="export-stock-excel"/g, '<button class="button secondary compact-stock-action" id="export-stock-excel"');

  await writeFile(file, source);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  if (!source.includes("./core/stock-count-excel.js")) {
    source = source.replace(
      "import { parseStockSetupWorkbook, exportStockSetupWorkbook } from './core/stock-setup-excel.js';",
      "import { parseStockSetupWorkbook, exportStockSetupWorkbook } from './core/stock-setup-excel.js';\nimport { importStockCountWorkbook } from './core/stock-count-excel.js';"
    );
  }

  // Hard remove auto Google Sheet refreshing. Use exact blocks so object literals inside loadStock({ ... }) do not leave orphan braces.
  const autoFocusRefresh = `  window.addEventListener('focus', () => {
    if (state.route === 'stock' && !state.stock.syncing && Date.now() - Number(state.stock.sheetLoadedAt || 0) > 15000) {
      loadStock({ forceFresh: true, preserveResult: true });
    }
  });`;
  source = source.replace(autoFocusRefresh, '');

  const autoVisibilityRefresh = `  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { persistStockDraft(); return; }
    if (state.route === 'stock' && !state.stock.syncing && Date.now() - Number(state.stock.sheetLoadedAt || 0) > 15000) {
      loadStock({ forceFresh: true, preserveResult: true });
    }
  });`;
  source = source.replace(
    autoVisibilityRefresh,
    `  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistStockDraft(); });`
  );

  const refreshButtonHandler = `  document.querySelector('#refresh-stock-sheet')?.addEventListener('click', () => {
    persistStockDraft();
    showToast('Refreshing from Google Sheet…');
    loadStock({ forceFresh: true, preserveResult: true });
  });`;
  source = source.replace(refreshButtonHandler, '');

  source = source.replace(
    /document\.querySelector\('#stock-month'\)\?\.addEventListener\('change', \(event\) => \{[\s\S]*?loadStock\(\); \}\);/,
    `bindStockMonthControl('#stock-month');\n  bindStockMonthControl('#stock-month-inline');`
  );

  if (!source.includes('function mountStockMonthInline')) {
    const helpers = `
function mountStockMonthInline() {
  const toolbar = document.querySelector('.stock-toolbar');
  if (!toolbar || document.querySelector('#stock-month-inline')) return;
  const holder = document.createElement('label');
  holder.className = 'stock-month-inline';
  holder.innerHTML = '<span>Month</span><input id="stock-month-inline" type="month" value="' + String(state.stock.monthKey || state.stock.businessDate.slice(0, 7)) + '">';
  const search = toolbar.querySelector('.search-box');
  if (search) search.before(holder);
  else toolbar.appendChild(holder);
}

function bindStockMonthControl(selector) {
  document.querySelector(selector)?.addEventListener('change', (event) => {
    persistStockDraft();
    const monthKey = event.target.value || todayIso().slice(0, 7);
    state.stock.monthKey = monthKey;
    state.stock.businessDate = monthKey + '-01';
    state.stock.submitResult = null;
    state.stock.dirtyColumns = { Inventory: {}, 'Untensil PG1': {}, 'Utensil PG2': {} };
    loadStock();
  });
}

function simplifyStockError(message) {
  return String(message || '').replace(/^Complete Week \d+ · /, '').replace(/^Complete /, '').replace(/^Enter the /, '').replace(/ before saving\.$/, '').replace(/ before submitting\.$/, '');
}

function flashStockInput(input) {
  if (!input) return false;
  input.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  setTimeout(() => input.focus?.(), 50);
  input.classList.add('stock-missing-flash');
  setTimeout(() => input.classList.remove('stock-missing-flash'), 1600);
  return true;
}

function focusFirstMissingStock() {
  const active = state.stock.activeTab;
  if (!String(state.stock.countedBy || '').trim()) return flashStockInput(document.querySelector('#stock-counted-by'));
  if (active === 'Stationary') return flashStockInput(document.querySelector('[data-stock-sheet="Stationary"][value=""], [data-stock-sheet="Stationary"]'));
  const dirty = Object.entries(state.stock.dirtyColumns?.[active] || {}).filter(([, value]) => Boolean(value)).map(([week]) => Number(week));
  const weekIndex = dirty[0] || Number(state.stock.lastEditedWeek || state.stock.mobileWeek || state.stock.data?.selectedWeek || 1);
  const dateInput = document.querySelector('[data-week-date="' + weekIndex + '"][data-week-sheet="' + active + '"]');
  if (dateInput && !dateInput.value) return flashStockInput(dateInput);
  const inputs = Array.from(document.querySelectorAll('[data-stock-sheet="' + active + '"][data-stock-week="' + weekIndex + '"]'));
  const missing = inputs.find((input) => input.value === '' || input.value === null || input.value === undefined);
  return flashStockInput(missing || inputs[0] || document.querySelector('#submit-stock'));
}

function handleStockKeyboard(event) {
  if (event.key !== 'Tab') return;
  const current = event.target;
  if (!current?.dataset?.stockSheet || !current.dataset.stockWeek) return;
  const sheet = current.dataset.stockSheet;
  const week = current.dataset.stockWeek;
  const field = current.dataset.stockField;
  const inputs = Array.from(document.querySelectorAll('[data-stock-sheet="' + sheet + '"][data-stock-week="' + week + '"][data-stock-field="' + field + '"]')).filter((input) => !input.disabled && input.offsetParent !== null);
  const index = inputs.indexOf(current);
  if (index < 0) return;
  event.preventDefault();
  const next = inputs[index + (event.shiftKey ? -1 : 1)] || inputs[event.shiftKey ? inputs.length - 1 : 0];
  flashStockInput(next);
}

async function importCurrentStockCountExcel(file) {
  if (!file) return;
  try {
    const result = await importStockCountWorkbook(file, state.stock);
    persistStockDraft();
    render();
    showToast('Imported ' + result.imported + ' rows to ' + result.sectionName + (result.weekIndex ? ' W' + result.weekIndex : ''));
  } catch (error) {
    showToast(error?.message || 'Unable to import count Excel.', 'error');
  }
}

function clearStockStateValues() {
  for (const [sheetName, rows] of Object.entries(state.stock.values || {})) {
    for (const rowValue of Object.values(rows || {})) {
      for (const key of Object.keys(rowValue || {})) {
        if (rowValue[key] && typeof rowValue[key] === 'object') {
          for (const field of Object.keys(rowValue[key])) rowValue[key][field] = '';
        } else rowValue[key] = '';
      }
    }
  }
  state.stock.sheetWeekDates = { Inventory: { 1: '', 2: '', 3: '', 4: '', 5: '' }, 'Untensil PG1': { 1: '', 2: '', 3: '', 4: '', 5: '' }, 'Utensil PG2': { 1: '', 2: '', 3: '', 4: '', 5: '' } };
  state.stock.stationaryDate = '';
  state.stock.dirtyColumns = { Inventory: {}, 'Untensil PG1': {}, 'Utensil PG2': {} };
  state.stock.submitResult = null;
}

async function clearCurrentStockData() {
  if (!confirm('Clear this month Stock Count data from this device and D1?')) return;
  const outlet = activeStockOutlet();
  const monthKey = state.stock.monthKey || state.stock.businessDate.slice(0, 7);
  clearStockStateValues();
  persistStockDraft();
  render();
  try {
    await callOperations('stock', { action: 'clearStockCounts', outlet, monthKey, businessDate: state.stock.businessDate }, state.settings, { timeoutMs: 12000 });
    showToast('Current month stock data cleared');
  } catch (error) {
    showToast(error?.message || 'D1 clear failed. Local screen was cleared.', 'error');
  }
}
`;
    source = source.replace('\nfunction renderPreservingFocus', `${helpers}\nfunction renderPreservingFocus`);
  }

  source = source.replace(
    `function bindStock() {
  ensureStockDraftLifecycle();`,
    `function bindStock() {
  ensureStockDraftLifecycle();
  mountStockMonthInline();`
  );

  source = source.replace(
    `  document.querySelector('#submit-stock')?.addEventListener('click', submitStock);`,
    `  document.querySelector('#submit-stock')?.addEventListener('click', submitStock);
  document.querySelector('#import-stock-count')?.addEventListener('click', () => document.querySelector('#stock-count-import-file')?.click());
  document.querySelector('#stock-count-import-file')?.addEventListener('change', (event) => importCurrentStockCountExcel(event.target.files?.[0]));
  document.querySelector('#clear-stock-data')?.addEventListener('click', clearCurrentStockData);`
  );

  source = source.replace(
    `  document.querySelectorAll('[data-week-date]').forEach((element) => element.addEventListener('change',`,
    `  document.querySelectorAll('[data-stock-sheet]').forEach((element) => element.addEventListener('keydown', handleStockKeyboard));
  document.querySelectorAll('[data-week-date]').forEach((element) => element.addEventListener('change',`
  );

  source = source.replace(
    `  if (error) return showToast(error, 'error');`,
    `  if (error) { focusFirstMissingStock(); return showToast('* ' + simplifyStockError(error), 'error'); }`
  );

  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `
/* v1.15.1 Stock D1-only operator UX */
.stock-page .sync-strip,.stock-page .draft-isolated,#refresh-stock-sheet,.stock-heading-actions,.stock-heading>.date-field{display:none!important}.stock-toolbar{display:flex;align-items:center;gap:8px;justify-content:space-between}.stock-toolbar .sheet-tabs{flex:1}.stock-month-inline{height:38px;display:inline-flex;align-items:center;gap:6px;padding:0 9px;border:1px solid #dedbd3;border-radius:10px;background:#fff;font-size:11px;font-weight:800;color:#6d6f6a;white-space:nowrap}.stock-month-inline input{border:0;outline:0;font-weight:850;min-width:115px;background:transparent}.stock-action-buttons{gap:6px!important}.stock-action-buttons .compact-stock-action{min-width:0!important;height:34px!important;padding:7px 10px!important;font-size:12px!important}.danger-soft{background:#fff1ed!important;border-color:#efc5bd!important;color:#9e3429!important}.stock-submit-panel small{font-size:11px!important}.stock-submit-panel small:after{content:''!important}.stock-readiness{margin-left:6px!important}.stock-missing-flash{animation:stockMissingFlash 1.2s ease-in-out 2!important;box-shadow:0 0 0 3px rgba(198,54,43,.25)!important;border-color:#c6362b!important}@keyframes stockMissingFlash{0%,100%{background:#fff}40%{background:#fff2a8}}@media(max-width:900px){.stock-toolbar{align-items:stretch;flex-wrap:wrap}.stock-month-inline,.stock-toolbar .search-box{flex:1}.stock-action-buttons{display:flex!important;flex-wrap:wrap}.stock-action-buttons .button{flex:1 1 auto!important}}
`;
  await writeFile(file, source);
}
