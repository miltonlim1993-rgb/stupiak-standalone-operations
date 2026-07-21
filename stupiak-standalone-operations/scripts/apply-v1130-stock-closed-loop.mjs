import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const WEEKLY = ['Inventory', 'Untensil PG1', 'Utensil PG2'];

export async function applyV1130StockClosedLoop(dist) {
  await patchOfflineWorkflow(dist);
  await patchMain(dist);
  await patchStockPage(dist);
  await patchStyles(dist);
}

async function patchOfflineWorkflow(dist) {
  const file = resolve(dist, 'src/core/offline-workflow.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    /export function saveStockDraft\(state, outlet\) \{[\s\S]*?\n\}(?=\n\nexport function applyStockDraft)/,
    `export function saveStockDraft(state, outlet) {
  const dirtyColumns = state.dirtyColumns || {};
  const values = {};
  for (const sheetName of ${JSON.stringify(WEEKLY)}) {
    const dirtyWeeks = Object.entries(dirtyColumns[sheetName] || {}).filter(([, dirty]) => Boolean(dirty)).map(([week]) => Number(week));
    if (!dirtyWeeks.length) continue;
    values[sheetName] = {};
    for (const [rowNo, rowValues] of Object.entries(state.values?.[sheetName] || {})) {
      const kept = {};
      for (const weekIndex of dirtyWeeks) {
        if (rowValues?.[weekIndex] !== undefined) kept[weekIndex] = structuredCloneSafe(rowValues[weekIndex]);
      }
      if (Object.keys(kept).length) values[sheetName][rowNo] = kept;
    }
  }
  if (state.stationaryDirty) values.Stationary = structuredCloneSafe(state.values?.Stationary || {});
  writeJson(stockDraftKey(outlet, state.businessDate), {
    draftVersion: 3,
    businessDate: state.businessDate,
    monthKey: state.monthKey,
    values,
    sheetWeekDates: structuredCloneSafe(state.sheetWeekDates || {}),
    dirtyColumns: structuredCloneSafe(dirtyColumns),
    stationaryDate: state.stationaryDate,
    stationaryDirty: Boolean(state.stationaryDirty),
    countedBy: state.countedBy,
    sessionNote: state.sessionNote,
    activeTab: state.activeTab,
    mobileWeek: state.mobileWeek,
    lastEditedWeek: state.lastEditedWeek,
    search: state.search,
    savedAt: Date.now()
  });
}

function structuredCloneSafe(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}`
  );

  source = source.replace(
    /export function applyStockDraft\(state, draft\) \{[\s\S]*?\n\}(?=\n\nexport function clearStockDraft)/,
    `export function applyStockDraft(state, draft) {
  if (!draft || draft.businessDate !== state.businessDate) return false;

  state.countedBy = draft.countedBy || state.countedBy || '';
  state.sessionNote = draft.sessionNote || state.sessionNote || '';
  state.search = draft.search || '';
  if (draft.activeTab) state.activeTab = draft.activeTab;
  if (draft.mobileWeek) state.mobileWeek = Number(draft.mobileWeek);
  state.lastEditedWeek = Number(draft.lastEditedWeek || state.lastEditedWeek || 1);
  state.draftSavedAt = Number(draft.savedAt || 0);
  state.draftRecoveredAt = Date.now();

  if (Number(draft.draftVersion || 0) < 3) {
    state.draftNotice = 'An older full-sheet draft was isolated so it cannot overwrite newer Google Sheet data.';
    state.dirtyColumns = { Inventory: {}, 'Untensil PG1': {}, 'Utensil PG2': {} };
    state.stationaryDirty = false;
    return true;
  }

  state.draftNotice = '';
  state.dirtyColumns = state.dirtyColumns || { Inventory: {}, 'Untensil PG1': {}, 'Utensil PG2': {} };
  state.sheetWeekDates = state.sheetWeekDates || { Inventory: {}, 'Untensil PG1': {}, 'Utensil PG2': {} };

  for (const sheetName of ${JSON.stringify(WEEKLY)}) {
    const draftDirty = draft.dirtyColumns?.[sheetName] || {};
    state.dirtyColumns[sheetName] = { ...(state.dirtyColumns[sheetName] || {}) };
    state.sheetWeekDates[sheetName] = { ...(state.sheetWeekDates[sheetName] || {}) };
    for (const [weekKey, dirty] of Object.entries(draftDirty)) {
      if (!dirty) continue;
      const weekIndex = Number(weekKey);
      state.dirtyColumns[sheetName][weekIndex] = true;
      if (draft.sheetWeekDates?.[sheetName]?.[weekIndex]) state.sheetWeekDates[sheetName][weekIndex] = draft.sheetWeekDates[sheetName][weekIndex];
      for (const [rowNo, rowValues] of Object.entries(draft.values?.[sheetName] || {})) {
        const draftValue = rowValues?.[weekIndex];
        if (draftValue === undefined || !state.values?.[sheetName]?.[rowNo]) continue;
        state.values[sheetName][rowNo][weekIndex] = structuredCloneSafe(draftValue);
      }
    }
  }

  if (draft.stationaryDirty) {
    for (const [rowNo, value] of Object.entries(draft.values?.Stationary || {})) {
      if (state.values?.Stationary?.[rowNo]) state.values.Stationary[rowNo] = structuredCloneSafe(value);
    }
    state.stationaryDate = draft.stationaryDate || state.stationaryDate || '';
    state.stationaryDirty = true;
  }

  state.weekDates = { ...(state.sheetWeekDates?.Inventory || {}) };
  return true;
}`
  );

  await writeFile(file, source);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    `    applyStockDraft(state.stock, readStockDraft(outlet, state.stock.businessDate));\n    state.stock.submitBlocked = false;`,
    `    state.stock.sheetLoadedAt = Date.now();\n    applyStockDraft(state.stock, readStockDraft(outlet, state.stock.businessDate));\n    state.stock.submitBlocked = false;`
  );

  source = source.replace(
    `  document.querySelector('#retry-stock')?.addEventListener('click', () => loadStock({ forceFresh: true }));`,
    `  document.querySelector('#retry-stock')?.addEventListener('click', () => loadStock({ forceFresh: true }));\n  document.querySelector('#refresh-stock-sheet')?.addEventListener('click', () => { persistStockDraft(); showToast('Refreshing from Google Sheet…'); loadStock({ forceFresh: true, preserveResult: true }); });`
  );

  source = source.replace(
    `  document.querySelector('#stationary-count-date')?.addEventListener('change', (event) => { state.stock.stationaryDate = event.target.value; persistStockDraft(); });`,
    `  document.querySelector('#stationary-count-date')?.addEventListener('change', (event) => { state.stock.stationaryDate = event.target.value; state.stock.stationaryDirty = true; persistStockDraft(); });`
  );

  source = source.replace(
    `    else state.stock.values[stockSheet][rowNo][stockField] = event.target.value;`,
    `    else { state.stock.values[stockSheet][rowNo][stockField] = event.target.value; if (stockSheet === 'Stationary') state.stock.stationaryDirty = true; }`
  );

  source = source.replace(
    `  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistStockDraft(); });`,
    `  document.addEventListener('visibilitychange', () => {\n    if (document.visibilityState === 'hidden') { persistStockDraft(); return; }\n    if (state.route === 'stock' && !state.stock.syncing && Date.now() - Number(state.stock.sheetLoadedAt || 0) > 15000) loadStock({ forceFresh: true, preserveResult: true });\n  });`
  );

  source = source.replace(
    `  window.addEventListener('pagehide', persistStockDraft);`,
    `  window.addEventListener('pagehide', persistStockDraft);\n  window.addEventListener('focus', () => { if (state.route === 'stock' && !state.stock.syncing && Date.now() - Number(state.stock.sheetLoadedAt || 0) > 15000) loadStock({ forceFresh: true, preserveResult: true }); });`
  );

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    `<div class="stock-month-field"><label>Month<input id="stock-month" type="month" value="\${escapeHtml(state.monthKey || state.businessDate.slice(0, 7))}"></label></div>`,
    `<div class="stock-heading-actions"><div class="stock-month-field"><label>Month<input id="stock-month" type="month" value="\${escapeHtml(state.monthKey || state.businessDate.slice(0, 7))}"></label></div><button class="button secondary compact-refresh-button" id="refresh-stock-sheet" \${state.syncing ? 'disabled' : ''}>\${state.syncing ? 'Refreshing…' : 'Refresh from Sheet'}</button></div>`
  );

  source = source.replace(
    `${'${stockSyncStatusMarkup(state)}'}`,
    `${'${state.draftNotice ? `<div class="sync-strip warning draft-isolated"><span class="sync-dot"></span><div><strong>Older browser draft isolated</strong><span>${escapeHtml(state.draftNotice)}</span></div></div>` : \'\'}${stockSyncStatusMarkup(state)}'}`
  );

  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `
/* v1.13.0 server-first Stock closed loop */
.stock-heading-actions{display:flex;align-items:end;gap:8px}.compact-refresh-button{height:39px;padding:8px 11px!important;font-size:12px!important;white-space:nowrap}.draft-isolated{border-color:#d8a83d;background:#fff9e9}@media(max-width:720px){.stock-heading-actions{width:100%;align-items:stretch}.stock-heading-actions .stock-month-field{flex:1}.compact-refresh-button{align-self:end}}
`;
  await writeFile(file, source);
}
