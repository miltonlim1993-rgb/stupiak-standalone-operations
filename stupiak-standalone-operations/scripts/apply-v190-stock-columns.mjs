import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRegexRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`v1.9.0 patch failed: ${label}`);
  pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

export async function applyV190StockColumns(dist, root) {
  await copyFile(resolve(root, 'src/pages/stock-v190.js'), resolve(dist, 'src/pages/stock.js'));
  await patchMain(dist);
  await patchOfflineWorkflow(dist);
  await patchStyles(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRegexRequired(
    source,
    /function blankStockValues\(\) \{[\s\S]*?\n\}\n\nfunction isCurrentStockPayload\(payload\) \{[\s\S]*?\n\}/,
    `function blankStockValues() {
  const clearObject = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (value[key] && typeof value[key] === 'object') clearObject(value[key]);
      else value[key] = '';
    }
  };
  clearObject(state.stock.values || {});
  state.stock.weekDates = { 1: '', 2: '', 3: '', 4: '', 5: '' };
  state.stock.dirtyWeeks = {};
}

function isCurrentStockPayload(payload) {
  const payloadMonth = String(payload.monthKey || payload.businessDate || '').slice(0, 7);
  const currentMonth = String(state.stock.monthKey || state.stock.businessDate || '').slice(0, 7);
  return payloadMonth === currentMonth;
}`,
    'stock offline helpers'
  );

  source = replaceRegexRequired(
    source,
    /function bindStock\(\) \{[\s\S]*?\n\}\n\nfunction updateLiveStockStatus/,
    `function bindStock() {
  document.querySelector('#stock-month')?.addEventListener('change', (event) => {
    const monthKey = event.target.value || todayIso().slice(0, 7);
    state.stock.monthKey = monthKey;
    state.stock.businessDate = monthKey + '-01';
    state.stock.submitResult = null;
    state.stock.dirtyWeeks = {};
    loadStock();
  });
  document.querySelector('#retry-stock')?.addEventListener('click', () => loadStock({ forceFresh: true }));
  document.querySelectorAll('[data-stock-tab]').forEach((element) => element.addEventListener('click', () => {
    state.stock.activeTab = element.dataset.stockTab;
    state.stock.submitResult = null;
    render();
  }));
  document.querySelectorAll('[data-mobile-week]').forEach((element) => element.addEventListener('click', () => {
    state.stock.mobileWeek = Number(element.dataset.mobileWeek);
    state.stock.lastEditedWeek = state.stock.mobileWeek;
    render();
  }));
  document.querySelector('#stock-search')?.addEventListener('input', (event) => {
    state.stock.search = event.target.value;
    renderPreservingFocus('stock-search', state.stock.search.length);
  });
  document.querySelectorAll('[data-stock-sheet]').forEach((element) => element.addEventListener('input', (event) => {
    const { stockSheet, stockRow, stockWeek, stockField } = event.target.dataset;
    const rowNo = Number(stockRow);
    if (stockWeek) {
      const weekIndex = Number(stockWeek);
      if (!state.stock.values[stockSheet][rowNo][weekIndex]) state.stock.values[stockSheet][rowNo][weekIndex] = {};
      state.stock.values[stockSheet][rowNo][weekIndex][stockField] = event.target.value;
      state.stock.dirtyWeeks[weekIndex] = true;
      state.stock.lastEditedWeek = weekIndex;
      markWeekDirtyInDom(weekIndex);
    } else {
      state.stock.values[stockSheet][rowNo][stockField] = event.target.value;
    }
    updateLiveStockStatus(event.target);
  }));
  document.querySelectorAll('[data-week-date]').forEach((element) => element.addEventListener('change', (event) => {
    const weekIndex = Number(event.target.dataset.weekDate);
    state.stock.weekDates[weekIndex] = event.target.value;
    state.stock.dirtyWeeks[weekIndex] = true;
    state.stock.lastEditedWeek = weekIndex;
    state.stock.mobileWeek = weekIndex;
    saveStockDraft(state.stock, stockOfflineOutlet());
    render();
  }));
  document.querySelector('#stationary-count-date')?.addEventListener('change', (event) => {
    state.stock.stationaryDate = event.target.value;
    saveStockDraft(state.stock, stockOfflineOutlet());
  });
  document.querySelector('#stock-counted-by')?.addEventListener('input', (event) => { state.stock.countedBy = event.target.value; });
  document.querySelector('#stock-session-note')?.addEventListener('input', (event) => { state.stock.sessionNote = event.target.value; });
  document.querySelector('#submit-stock')?.addEventListener('click', submitStock);
  document.querySelector('#stock-whatsapp')?.addEventListener('click', openStockWhatsApp);
  document.querySelector('#stock-prepare-share')?.addEventListener('click', retryStockSharePackage);
  document.querySelector('.stock-page')?.addEventListener('input', () => saveStockDraft(state.stock, stockOfflineOutlet()));
}

function markWeekDirtyInDom(weekIndex) {
  document.querySelector('[data-week-date="' + weekIndex + '"]')?.closest('.week-head')?.classList.add('dirty-week-head');
  document.querySelectorAll('[data-stock-week="' + weekIndex + '"]').forEach((input) => input.closest('.week-cell')?.classList.add('dirty-week'));
}

function updateLiveStockStatus`,
    'stock bindings'
  );

  source = replaceRegexRequired(
    source,
    /function updateLiveStockStatus\(input\) \{[\s\S]*?\n\}\n\nasync function submitStock/,
    `function updateLiveStockStatus(input) {
  const cell = input.closest('.week-cell') || input.closest('tr');
  if (!cell) return;
  const sheet = input.dataset.stockSheet;
  const rowNo = Number(input.dataset.stockRow);
  const weekIndex = input.dataset.stockWeek ? Number(input.dataset.stockWeek) : null;
  const section = state.stock.data.sections.find((entry) => entry.sheetName === sheet);
  const row = section.rows.find((entry) => entry.row === rowNo);
  const value = weekIndex
    ? state.stock.values[sheet][rowNo][weekIndex]
    : state.stock.values[sheet][rowNo];
  let status = '';
  if (section.type === 'weekly-inventory') status = Number(value.primary || 0) * row.conversion + Number(value.secondary || 0) <= row.minimum ? 'Order' : '';
  else if (sheet === 'Utensil PG2' && rowNo === 9) status = Number(value.quantity || 0) <= 0 ? 'No More Use' : '';
  else if (sheet === 'Utensil PG2' && rowNo === 36) status = Number(value.quantity || 0) <= 4 ? 'Spare Item' : '';
  else status = Number(value.quantity || 0) <= row.minimum ? 'Order' : '';
  const badge = cell.querySelector('.row-status');
  if (badge) {
    badge.textContent = status || 'OK';
    badge.className = 'row-status ' + (status ? 'attention' : 'ok');
  }
}

async function submitStock`,
    'live stock status'
  );

  source = source.replace(
    `      result.sharePreparing = true;\n      result.shareError = '';`,
    `      result.monthKey = result.monthKey || payload.monthKey || String(payload.businessDate || '').slice(0, 7);\n      result.sharePreparing = true;\n      result.shareError = '';`
  );

  source = source.replace(
    `      clearStockDraft(stockOfflineOutlet(), payload.businessDate);`,
    `      clearStockDraft(stockOfflineOutlet(), (payload.monthKey || String(payload.businessDate || '').slice(0, 7)) + '-01');`
  );

  source = source.replace(
    `      selectedWeek: payload.selectedWeek,\n      countedBy: payload.countedBy`,
    `      selectedWeek: payload.selectedWeek,\n      monthKey: payload.monthKey || String(payload.businessDate || '').slice(0, 7),\n      countedBy: payload.countedBy`
  );

  source = source.replace(
    `    selectedWeek: result.weekIndex || state.stock.data?.selectedWeek,\n    countedBy: state.stock.countedBy`,
    `    selectedWeek: result.weekIndex || state.stock.data?.selectedWeek,\n    monthKey: result.monthKey || state.stock.monthKey || String(state.stock.businessDate || '').slice(0, 7),\n    countedBy: state.stock.countedBy`
  );

  await writeFile(file, source);
}

async function patchOfflineWorkflow(dist) {
  const file = resolve(dist, 'src/core/offline-workflow.js');
  let source = await readFile(file, 'utf8');

  source = replaceRegexRequired(
    source,
    /export function saveStockDraft\(state, outlet\) \{[\s\S]*?\n\}/,
    `export function saveStockDraft(state, outlet) {
  writeJson(stockDraftKey(outlet, state.businessDate), {
    businessDate: state.businessDate,
    monthKey: state.monthKey,
    values: state.values,
    weekDates: state.weekDates,
    dirtyWeeks: state.dirtyWeeks,
    lastEditedWeek: state.lastEditedWeek,
    stationaryDate: state.stationaryDate,
    countedBy: state.countedBy,
    sessionNote: state.sessionNote,
    activeTab: state.activeTab,
    mobileWeek: state.mobileWeek,
    savedAt: Date.now()
  });
}`,
    'stock draft save'
  );

  source = replaceRegexRequired(
    source,
    /export function applyStockDraft\(state, draft\) \{[\s\S]*?\n\}/,
    `export function applyStockDraft(state, draft) {
  if (!draft || draft.businessDate !== state.businessDate) return false;
  for (const [sheetName, rows] of Object.entries(draft.values || {})) {
    if (!state.values[sheetName]) continue;
    for (const [rowNo, fields] of Object.entries(rows || {})) {
      if (!state.values[sheetName][rowNo]) continue;
      const targetRow = state.values[sheetName][rowNo];
      for (const [fieldKey, fieldValue] of Object.entries(fields || {})) {
        if (fieldValue && typeof fieldValue === 'object' && targetRow[fieldKey] && typeof targetRow[fieldKey] === 'object') {
          Object.assign(targetRow[fieldKey], fieldValue);
        } else {
          targetRow[fieldKey] = fieldValue;
        }
      }
    }
  }
  state.monthKey = draft.monthKey || state.monthKey;
  state.weekDates = { ...state.weekDates, ...(draft.weekDates || {}) };
  state.dirtyWeeks = { ...(draft.dirtyWeeks || {}) };
  state.lastEditedWeek = Number(draft.lastEditedWeek || state.lastEditedWeek || 1);
  state.stationaryDate = draft.stationaryDate || state.stationaryDate || '';
  state.countedBy = draft.countedBy || '';
  state.sessionNote = draft.sessionNote || '';
  if (draft.activeTab) state.activeTab = draft.activeTab;
  if (draft.mobileWeek) state.mobileWeek = Number(draft.mobileWeek);
  return true;
}`,
    'stock draft apply'
  );

  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `\n/* v1.9.0 independent Week count dates */
.stock-columns-page{max-width:1760px;padding-top:24px}.compact-heading{margin-bottom:14px;align-items:end}.compact-heading h1{margin-bottom:4px}.stock-month-field label{display:grid;gap:6px;font-size:11px;font-weight:800;color:#646661;text-transform:uppercase;letter-spacing:.08em}.stock-month-field input{min-width:170px;border:1px solid var(--line);border-radius:10px;background:#fff;padding:10px 12px;color:var(--ink);font-weight:800}.compact-stock-toolbar{margin-bottom:8px}.stock-section-meta{padding:9px 12px;min-height:54px}.stock-meta-actions{display:flex;align-items:center;gap:20px}.changed-week-copy span,.changed-week-copy strong{display:block}.changed-week-copy strong{font-size:13px;margin-top:3px}.inline-count-date{display:flex!important;align-items:center;gap:8px!important}.inline-count-date span{white-space:nowrap}.inline-count-date input{border:1px solid var(--line);border-radius:8px;padding:7px 9px;background:#fff;color:var(--ink);font-weight:800}.stock-grid-wrap{border-radius:0}.multi-date-grid{min-width:1220px;table-layout:fixed}.multi-date-grid .item-col{width:250px;min-width:250px;max-width:250px}.multi-date-grid .week-head{width:180px;min-width:180px;padding:8px 9px}.multi-date-grid .minimum-col{width:68px;min-width:68px}.week-date-head>span{font-size:14px;letter-spacing:.04em}.week-date-head>small{font-size:11px;margin:2px 0 7px}.week-date-control{display:grid;gap:4px;margin-top:5px}.week-date-control>span{font-size:8px;letter-spacing:.12em;color:#d5d5d2}.week-date-control input{width:100%;border:1px solid rgba(255,255,255,.22);border-radius:7px;background:#fff;color:#171819;padding:7px 6px;font-size:11px;font-weight:800}.week-head.current-week{background:#6e5b24}.week-head.dirty-week-head{background:#8e6500}.week-head em{margin-top:4px;font-size:9px}.sheet-table.multi-date-grid th,.sheet-table.multi-date-grid td{padding:6px 8px}.sheet-table.multi-date-grid tbody tr{height:50px}.sheet-table.multi-date-grid tbody .item-col strong{font-size:12px;line-height:1.25}.sheet-table.multi-date-grid tbody .item-col small{font-size:9px;margin-top:2px}.editable-week{background:#f7f6f2!important}.sheet-table tbody tr:nth-child(even) .editable-week{background:#edede9!important}.editable-week.dirty-week{background:#fff5d8!important}.large-quantity-line{display:grid;grid-template-columns:minmax(62px,82px) auto;gap:4px 6px;align-items:center;min-height:38px}.large-quantity-line input{width:82px;height:38px;padding:6px 8px;border-radius:8px;text-align:center;font-size:18px;font-weight:850;line-height:1;color:#111}.large-quantity-line span{font-size:10px;font-weight:700}.large-quantity-line input:nth-of-type(2){grid-column:1}.row-status{margin-top:2px;padding:2px 6px}.compact-submit-panel{padding:12px 14px;position:sticky;bottom:0;z-index:9;box-shadow:0 -10px 28px rgba(20,22,21,.06)}.compact-submit-panel .form-grid.two{grid-template-columns:minmax(180px,.65fr) minmax(260px,1.35fr)}.compact-submit-panel input{padding:9px 10px}.compact-submit-panel .submit-row{margin-top:10px;padding-top:10px}.compact-submit-panel .button.primary{min-width:210px}.compact-stationary-table td,.compact-stationary-table th{padding:7px 10px}.stationary-quantity-input{width:120px!important;height:40px;text-align:center;font-size:18px;font-weight:850}.stock-success{grid-template-columns:auto minmax(220px,1fr) auto}.share-preparing{grid-column:1/-1}@media(max-width:1100px){.stock-columns-page{padding-left:18px;padding-right:18px}.multi-date-grid{min-width:1120px}.multi-date-grid .item-col{width:220px;min-width:220px;max-width:220px}.multi-date-grid .week-head{width:170px;min-width:170px}}@media(max-width:760px){.compact-heading{align-items:start}.stock-month-field{width:100%;margin-top:12px}.stock-month-field input{width:100%}.stock-meta-actions{gap:10px}.multi-date-grid{min-width:0}.multi-date-grid .item-col{width:48%;min-width:170px;max-width:210px}.multi-date-grid .week-head{width:52%;min-width:175px}.multi-date-grid .week-head:not(.mobile-current),.multi-date-grid .week-cell:not(.mobile-current){display:none}.multi-date-grid .minimum-col{display:none}.large-quantity-line input{width:92px}.compact-submit-panel{position:static}.compact-submit-panel .form-grid.two{grid-template-columns:1fr}.compact-submit-panel .submit-row{align-items:stretch;flex-direction:column;gap:10px}.compact-submit-panel .button.primary{width:100%}.stock-success{grid-template-columns:auto 1fr}.stock-success .success-actions{grid-column:1/-1;flex-wrap:wrap}}
`;
  await writeFile(file, source);
}
