import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const WEEKLY = ['Inventory', 'Untensil PG1', 'Utensil PG2'];
const rx = (source, pattern, replacement, label) => {
  if (!pattern.test(source)) {
    console.warn(`v1.12.0 patch skipped: ${label}`);
    return source;
  }
  pattern.lastIndex = 0;
  return source.replace(pattern, () => replacement);
};

export async function applyV1120IndependentTabDrafts(dist) {
  await patchStockPage(dist);
  await patchMain(dist);
  await patchDrafts(dist);
  await patchExport(dist);
  await patchCss(dist);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let s = await readFile(file, 'utf8');

  s = s.replace(
    `    weekDates: blankWeekDates(),\n    dirtyWeeks: {},`,
    `    weekDates: blankWeekDates(),\n    sheetWeekDates: blankSheetWeekDates(),\n    dirtyWeeks: {},\n    dirtyColumns: blankDirtyColumns(),\n    draftSavedAt: 0,\n    draftRecoveredAt: 0,`
  );

  s = s.replace(
    `  state.weekDates = blankWeekDates();\n  state.stationaryDate = '';`,
    `  state.weekDates = blankWeekDates();\n  state.sheetWeekDates = blankSheetWeekDates();\n  state.dirtyColumns = blankDirtyColumns();\n  state.stationaryDate = '';`
  );

  s = s.replace(
    `        if (!state.weekDates[week.index] && week.date) state.weekDates[week.index] = week.date;`,
    `        if (!state.sheetWeekDates[section.sheetName]) state.sheetWeekDates[section.sheetName] = blankWeekDates();\n        if (!state.sheetWeekDates[section.sheetName][week.index] && week.date) state.sheetWeekDates[section.sheetName][week.index] = week.date;`
  );

  s = s.replace(
    `  const today = todayIso();\n  const preferredWeek`,
    `  state.weekDates = { ...(state.sheetWeekDates.Inventory || blankWeekDates()) };\n  const today = todayIso();\n  const preferredWeek`
  );

  s = s.replace('const dirtyWeeks = dirtyWeekIndexes(state);', 'const dirtyWeeks = dirtyWeekIndexes(state, section.sheetName);');
  s = s.replace('completionProgress(state, WEEKLY_SECTIONS, focusWeek)', 'completionProgress(state, [section.sheetName], focusWeek)');
  s = s.replace(/weekHeader\(state, week\)/g, 'weekHeader(state, section.sheetName, week)');
  s = s.replace("const dirty = Boolean(state.dirtyWeeks[week.index]);", "const dirty = isDirtyColumn(state, 'Inventory', week.index);");
  s = s.replace("const dirty = Boolean(state.dirtyWeeks[week.index]);", "const dirty = isDirtyColumn(state, section.sheetName, week.index);");

  s = rx(
    s,
    /function weekHeader\(state, week\) \{[\s\S]*?\n\}(?=\n\nfunction orderPage)/,
    `function weekHeader(state, sheetName, week) {
  const period = week.periodLabel || week.rangeLabel || weekPeriodForIndex(state.monthKey || week.date || todayIso(), week.index);
  const bounds = weekBounds(state.monthKey, week.index);
  const dateValue = state.sheetWeekDates?.[sheetName]?.[week.index] || '';
  const current = currentWeekIndex(state.monthKey, todayIso()) === week.index && state.monthKey === todayIso().slice(0, 7);
  const dirty = isDirtyColumn(state, sheetName, week.index);
  return \`<th class="week-head week-date-head \${current ? 'current-week' : ''} \${dirty ? 'dirty-week-head' : ''} \${state.mobileWeek === week.index ? 'mobile-current' : ''}"><span>WEEK \${week.index}</span><small>\${period}</small><label class="week-date-control"><span>COUNT DATE · \${escapeHtml(sheetName)}</span><input type="date" data-week-date="\${week.index}" data-week-sheet="\${escapeHtml(sheetName)}" value="\${escapeHtml(dateValue)}" min="\${bounds.startIso}" max="\${bounds.endIso}"></label>\${dirty ? '<em>Changed in this tab</em>' : dateValue ? '<em>Saved date</em>' : ''}</th>\`;
}`,
    'week header'
  );

  s = rx(
    s,
    /export function buildStockPayload\(state\) \{[\s\S]*?\n\}(?=\n\nfunction buildSectionRows)/,
    `export function buildStockPayload(state) {
  const isMonthly = state.activeTab === 'Stationary';
  const submissionId = createId('stock');
  const common = { action: 'submitStockCount', submissionId, monthKey: state.monthKey || state.businessDate.slice(0, 7), countedBy: state.countedBy, sessionNote: state.sessionNote };
  if (isMonthly) return { ...common, businessDate: state.stationaryDate, selectedWeek: '', sectionName: 'Stationary', sections: { Stationary: buildSectionRows(state, 'Stationary', null) } };
  const sectionName = state.activeTab;
  const dirty = dirtyWeekIndexes(state, sectionName);
  const primaryWeek = dirty.includes(Number(state.lastEditedWeek)) ? Number(state.lastEditedWeek) : dirty[0];
  const ordered = [primaryWeek, ...dirty.filter((week) => week !== primaryWeek)];
  const weekColumns = ordered.map((weekIndex) => ({ weekIndex, businessDate: state.sheetWeekDates?.[sectionName]?.[weekIndex] || '', sheetName: sectionName, sections: { [sectionName]: buildSectionRows(state, sectionName, weekIndex) } }));
  return { ...common, businessDate: weekColumns[0]?.businessDate || '', selectedWeek: weekColumns[0]?.weekIndex || '', sectionName, sections: weekColumns[0]?.sections || {}, weekColumns };
}`,
    'payload'
  );

  s = rx(
    s,
    /export function validateStock\(state\) \{[\s\S]*?\n\}(?=\n\nfunction completionProgress)/,
    `export function validateStock(state) {
  if (!state.countedBy.trim()) return 'Enter the staff name before submitting.';
  if (state.activeTab === 'Stationary') {
    if (!state.stationaryDate) return 'Enter the Stationary count date.';
    for (const row of state.data.sections.find((entry) => entry.sheetName === 'Stationary')?.rows || []) {
      const value = state.values.Stationary?.[row.row]?.quantity;
      if (value === '' || value === null || value === undefined || Number(value) < 0) return \`Complete Stationary: \${row.item}\`;
    }
    return '';
  }
  const sectionName = state.activeTab;
  const dirty = dirtyWeekIndexes(state, sectionName);
  if (!dirty.length) return \`Edit at least one \${sectionName} Week column before saving.\`;
  const section = state.data.sections.find((entry) => entry.sheetName === sectionName);
  for (const weekIndex of dirty) {
    const countDate = state.sheetWeekDates?.[sectionName]?.[weekIndex] || '';
    if (!countDate) return \`Enter the \${sectionName} count date for Week \${weekIndex}.\`;
    if (!dateBelongsToWeek(state.monthKey, weekIndex, countDate)) return \`\${sectionName} Week \${weekIndex} count date must be within \${weekPeriodForIndex(state.monthKey, weekIndex)}.\`;
    for (const row of section?.rows || []) {
      const value = state.values[sectionName]?.[row.row]?.[weekIndex] || {};
      const main = section.type === 'weekly-inventory' ? value.primary : value.quantity;
      if (main === '' || main === null || main === undefined || Number(main) < 0) return \`Complete Week \${weekIndex} · \${sectionName}: \${row.item}\`;
      if (row.hasSecondaryQuantity && (value.secondary === '' || value.secondary === null || value.secondary === undefined || Number(value.secondary) < 0)) return \`Complete Week \${weekIndex} · \${sectionName}: \${row.item} secondary unit\`;
    }
  }
  return '';
}`,
    'validation'
  );

  s = rx(
    s,
    /function dirtyWeekIndexes\(state\) \{[\s\S]*?function latestWeekWithDate/,
    `function dirtyWeekIndexes(state, sheetName = state.activeTab) { return WEEK_INDEXES.filter((week) => Boolean(state.dirtyColumns?.[sheetName]?.[week])); }
function isDirtyColumn(state, sheetName, weekIndex) { return Boolean(state.dirtyColumns?.[sheetName]?.[weekIndex]); }
function blankWeekDates() { return { 1: '', 2: '', 3: '', 4: '', 5: '' }; }
function blankSheetWeekDates() { return Object.fromEntries(WEEKLY_SECTIONS.map((name) => [name, blankWeekDates()])); }
function blankDirtyColumns() { return Object.fromEntries(WEEKLY_SECTIONS.map((name) => [name, {}])); }
function latestWeekWithDate`,
    'helpers'
  );

  s = s.replace('submitSuccess(state.submitResult)', 'submitSuccess(state.submitResult, state)');
  s = s.replace("result.savedWeeks.map((entry) => 'W' + entry.weekIndex).join(', ')", "result.savedWeeks.map((entry) => (entry.sheetName ? entry.sheetName + ' · ' : '') + 'W' + entry.weekIndex).join(', ')");
  await writeFile(file, s);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let s = await readFile(file, 'utf8');
  s = s.replace(
    `  state.stock.weekDates = { 1: '', 2: '', 3: '', 4: '', 5: '' };\n  state.stock.dirtyWeeks = {};`,
    `  state.stock.weekDates = { 1: '', 2: '', 3: '', 4: '', 5: '' };\n  state.stock.sheetWeekDates = { Inventory: { 1: '', 2: '', 3: '', 4: '', 5: '' }, 'Untensil PG1': { 1: '', 2: '', 3: '', 4: '', 5: '' }, 'Utensil PG2': { 1: '', 2: '', 3: '', 4: '', 5: '' } };\n  state.stock.dirtyWeeks = {};\n  state.stock.dirtyColumns = { Inventory: {}, 'Untensil PG1': {}, 'Utensil PG2': {} };`
  );

  s = rx(
    s,
    /function bindStock\(\) \{[\s\S]*?\n\}(?=\n\nfunction markWeekDirtyInDom)/,
    `let stockDraftLifecycleBound = false;
function persistStockDraft() {
  saveStockDraft(state.stock, stockOfflineOutlet());
  state.stock.draftSavedAt = Date.now();
}
function ensureStockDraftLifecycle() {
  if (stockDraftLifecycleBound) return;
  stockDraftLifecycleBound = true;
  window.addEventListener('pagehide', persistStockDraft);
  window.addEventListener('beforeunload', persistStockDraft);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistStockDraft(); });
}
function bindStock() {
  ensureStockDraftLifecycle();
  document.querySelector('#stock-month')?.addEventListener('change', (event) => { persistStockDraft(); const monthKey = event.target.value || todayIso().slice(0, 7); state.stock.monthKey = monthKey; state.stock.businessDate = monthKey + '-01'; state.stock.submitResult = null; state.stock.dirtyColumns = { Inventory: {}, 'Untensil PG1': {}, 'Utensil PG2': {} }; loadStock(); });
  document.querySelector('#retry-stock')?.addEventListener('click', () => loadStock({ forceFresh: true }));
  document.querySelectorAll('[data-stock-tab]').forEach((element) => element.addEventListener('click', () => { state.stock.activeTab = element.dataset.stockTab; state.stock.submitResult = null; persistStockDraft(); render(); }));
  document.querySelectorAll('[data-mobile-week]').forEach((element) => element.addEventListener('click', () => { state.stock.mobileWeek = Number(element.dataset.mobileWeek); state.stock.lastEditedWeek = state.stock.mobileWeek; persistStockDraft(); render(); }));
  document.querySelector('#stock-search')?.addEventListener('input', (event) => { state.stock.search = event.target.value; persistStockDraft(); renderPreservingFocus('stock-search', state.stock.search.length); });
  document.querySelectorAll('[data-stock-sheet]').forEach((element) => element.addEventListener('input', (event) => {
    const { stockSheet, stockRow, stockWeek, stockField } = event.target.dataset; const rowNo = Number(stockRow);
    if (stockWeek) { const weekIndex = Number(stockWeek); if (!state.stock.values[stockSheet][rowNo][weekIndex]) state.stock.values[stockSheet][rowNo][weekIndex] = {}; state.stock.values[stockSheet][rowNo][weekIndex][stockField] = event.target.value; if (!state.stock.dirtyColumns[stockSheet]) state.stock.dirtyColumns[stockSheet] = {}; state.stock.dirtyColumns[stockSheet][weekIndex] = true; state.stock.lastEditedWeek = weekIndex; state.stock.mobileWeek = weekIndex; markWeekDirtyInDom(stockSheet, weekIndex); }
    else state.stock.values[stockSheet][rowNo][stockField] = event.target.value;
    updateLiveStockStatus(event.target); persistStockDraft();
  }));
  document.querySelectorAll('[data-week-date]').forEach((element) => element.addEventListener('change', (event) => { const weekIndex = Number(event.target.dataset.weekDate); const sheetName = event.target.dataset.weekSheet || state.stock.activeTab; if (!state.stock.sheetWeekDates[sheetName]) state.stock.sheetWeekDates[sheetName] = { 1: '', 2: '', 3: '', 4: '', 5: '' }; if (!state.stock.dirtyColumns[sheetName]) state.stock.dirtyColumns[sheetName] = {}; state.stock.sheetWeekDates[sheetName][weekIndex] = event.target.value; state.stock.dirtyColumns[sheetName][weekIndex] = true; state.stock.lastEditedWeek = weekIndex; state.stock.mobileWeek = weekIndex; persistStockDraft(); render(); }));
  document.querySelector('#stationary-count-date')?.addEventListener('change', (event) => { state.stock.stationaryDate = event.target.value; persistStockDraft(); });
  document.querySelector('#stock-counted-by')?.addEventListener('input', (event) => { state.stock.countedBy = event.target.value; persistStockDraft(); });
  document.querySelector('#stock-session-note')?.addEventListener('input', (event) => { state.stock.sessionNote = event.target.value; persistStockDraft(); });
  document.querySelector('#submit-stock')?.addEventListener('click', submitStock);
  document.querySelector('#export-stock-pdf')?.addEventListener('click', () => exportCurrentStock('pdf'));
  document.querySelector('#export-stock-excel')?.addEventListener('click', () => exportCurrentStock('excel'));
  document.querySelector('#export-stock-pdf-result')?.addEventListener('click', () => exportCurrentStock('pdf'));
  document.querySelector('#export-stock-excel-result')?.addEventListener('click', () => exportCurrentStock('excel'));
  document.querySelector('#retry-stock-save')?.addEventListener('click', retryStockSave);
  document.querySelector('#retry-stock-save-result')?.addEventListener('click', retryStockSave);
}`,
    'bindings'
  );

  s = rx(
    s,
    /function markWeekDirtyInDom\([\s\S]*?\n\}(?=\n\nfunction updateLiveStockStatus)/,
    `function markWeekDirtyInDom(sheetName, weekIndex) {
  document.querySelectorAll('[data-week-date="' + weekIndex + '"]').forEach((input) => { if ((input.dataset.weekSheet || state.stock.activeTab) === sheetName) input.closest('.week-head')?.classList.add('dirty-week-head'); });
  document.querySelectorAll('[data-stock-week="' + weekIndex + '"]').forEach((input) => { if (input.dataset.stockSheet === sheetName) input.closest('.week-cell')?.classList.add('dirty-week'); });
}`,
    'dirty DOM'
  );

  s = s.replace(
    `  state.stock.pendingStartedAt = Date.now();\n  state.stock.dirtyWeeks = {};\n  state.stock.submitResult = {`,
    `  state.stock.pendingStartedAt = Date.now();\n  const submittedSheet = payload.sectionName || state.stock.activeTab;\n  if (submittedSheet !== 'Stationary' && state.stock.dirtyColumns?.[submittedSheet]) state.stock.dirtyColumns[submittedSheet] = {};\n  state.stock.dirtyWeeks = {};\n  state.stock.submitResult = {`
  );
  s = s.replace(`(payload.weekColumns || []).map((entry) => ({ weekIndex: entry.weekIndex, businessDate: entry.businessDate }))`, `(payload.weekColumns || []).map((entry) => ({ weekIndex: entry.weekIndex, businessDate: entry.businessDate, sheetName: entry.sheetName || payload.sectionName }))`);
  s = s.replace(
    `  result.monthKey = result.monthKey || payload.monthKey || String(payload.businessDate || '').slice(0, 7);`,
    `  result.monthKey = result.monthKey || payload.monthKey || String(payload.businessDate || '').slice(0, 7);\n  result.sectionName = result.sectionName || payload.sectionName || '';\n  if (Array.isArray(result.savedWeeks)) result.savedWeeks = result.savedWeeks.map((entry, index) => ({ ...entry, sheetName: entry.sheetName || payload.weekColumns?.[index]?.sheetName || payload.sectionName || '' }));`
  );
  s = s.replace(`  const hasNewEdits = Object.keys(state.stock.dirtyWeeks || {}).some((key) => state.stock.dirtyWeeks[key]);`, `  const hasNewEdits = Object.values(state.stock.dirtyColumns || {}).some((weeks) => Object.values(weeks || {}).some(Boolean));`);
  await writeFile(file, s);
}

async function patchDrafts(dist) {
  const file = resolve(dist, 'src/core/offline-workflow.js');
  let s = await readFile(file, 'utf8');
  s = rx(
    s,
    /export function saveStockDraft\(state, outlet\) \{[\s\S]*?\n\}/,
    `export function saveStockDraft(state, outlet) {
  writeJson(stockDraftKey(outlet, state.businessDate), { draftVersion: 2, businessDate: state.businessDate, monthKey: state.monthKey, values: state.values, sheetWeekDates: state.sheetWeekDates, dirtyColumns: state.dirtyColumns, stationaryDate: state.stationaryDate, countedBy: state.countedBy, sessionNote: state.sessionNote, activeTab: state.activeTab, mobileWeek: state.mobileWeek, lastEditedWeek: state.lastEditedWeek, search: state.search, savedAt: Date.now() });
}`,
    'draft save'
  );
  s = rx(
    s,
    /export function applyStockDraft\(state, draft\) \{[\s\S]*?\n\}(?=\n\nexport function clearStockDraft)/,
    `export function applyStockDraft(state, draft) {
  if (!draft || draft.businessDate !== state.businessDate) return false;
  for (const [sheetName, rows] of Object.entries(draft.values || {})) { if (!state.values[sheetName]) continue; for (const [rowNo, fields] of Object.entries(rows || {})) { if (!state.values[sheetName][rowNo]) continue; const target = state.values[sheetName][rowNo]; for (const [key, value] of Object.entries(fields || {})) { if (value && typeof value === 'object' && target[key] && typeof target[key] === 'object') Object.assign(target[key], value); else target[key] = value; } } }
  const names = ['Inventory', 'Untensil PG1', 'Utensil PG2']; state.sheetWeekDates = state.sheetWeekDates || {}; state.dirtyColumns = state.dirtyColumns || {};
  for (const name of names) { state.sheetWeekDates[name] = { 1: '', 2: '', 3: '', 4: '', 5: '', ...(state.sheetWeekDates[name] || {}), ...((draft.sheetWeekDates || {})[name] || (!draft.sheetWeekDates ? (draft.weekDates || {}) : {})) }; state.dirtyColumns[name] = { ...(state.dirtyColumns[name] || {}), ...((draft.dirtyColumns || {})[name] || {}) }; }
  if (!draft.dirtyColumns && draft.dirtyWeeks) { const name = names.includes(draft.activeTab) ? draft.activeTab : 'Inventory'; state.dirtyColumns[name] = { ...state.dirtyColumns[name], ...draft.dirtyWeeks }; }
  state.monthKey = draft.monthKey || state.monthKey; state.weekDates = { ...(state.sheetWeekDates.Inventory || {}) }; state.dirtyWeeks = {}; state.lastEditedWeek = Number(draft.lastEditedWeek || state.lastEditedWeek || 1); state.stationaryDate = draft.stationaryDate || state.stationaryDate || ''; state.countedBy = draft.countedBy || ''; state.sessionNote = draft.sessionNote || ''; state.search = draft.search || ''; if (draft.activeTab) state.activeTab = draft.activeTab; if (draft.mobileWeek) state.mobileWeek = Number(draft.mobileWeek); state.draftRecoveredAt = Date.now(); state.draftSavedAt = Number(draft.savedAt || 0); return true;
}`,
    'draft restore'
  );
  await writeFile(file, s);
}

async function patchExport(dist) {
  const file = resolve(dist, 'src/core/stock-local-export.js');
  let s = await readFile(file, 'utf8');
  s = s.replace(`    weekDates: { ...(state.weekDates || {}) },`, `    sheetWeekDates: Object.fromEntries(${JSON.stringify(WEEKLY)}.map((name) => [name, { 1: '', 2: '', 3: '', 4: '', 5: '', ...(state.weekDates || {}), ...((state.sheetWeekDates || {})[name] || {}) }])) ,`);
  s = s.replace(`WEEK_INDEXES.some((week) => snapshot.weekDates[week])`, `Object.values(snapshot.sheetWeekDates || {}).some((dates) => WEEK_INDEXES.some((week) => dates?.[week]))`);
  s = s.replace('weekHeader(snapshot, idx + 1);', "weekHeader(snapshot, idx + 1, 'Inventory');");
  s = s.replace('weekHeader(snapshot, idx + 1);', 'weekHeader(snapshot, idx + 1, name);');
  s = s.replace('weekHeader(snapshot, week);', "weekHeader(snapshot, week, 'Inventory', false);");
  s = s.replace('Boolean(snapshot.weekDates[week])', 'Boolean(snapshot.sheetWeekDates?.Inventory?.[week])');
  s = s.replace('Boolean(snapshot.weekDates[week])', 'Boolean(snapshot.sheetWeekDates?.[name]?.[week])');
  s = s.replace('drawPdfHeader(page, bold, snapshot, y, margin, itemWidth, weekWidth, minWidth)', 'drawPdfHeader(page, bold, snapshot, name, y, margin, itemWidth, weekWidth, minWidth)');
  s = s.replace('Boolean(snapshot.weekDates[week]), value = item.weeks[week]', 'Boolean(snapshot.sheetWeekDates?.[name]?.[week]), value = item.weeks[week]');
  s = s.replace('function drawPdfHeader(page, bold, snapshot, y, margin, itemWidth, weekWidth, minWidth)', 'function drawPdfHeader(page, bold, snapshot, sectionName, y, margin, itemWidth, weekWidth, minWidth)');
  s = s.replace(/snapshot\.weekDates\[week\]/g, 'snapshot.sheetWeekDates?.[sectionName]?.[week]');
  s = rx(s, /function weekHeader\(snapshot,week\)\{[\s\S]*?\}/, `function weekHeader(snapshot,week,sectionName='Inventory',includeDate=true){const date=snapshot.sheetWeekDates?.[sectionName]?.[week]||'';return \`WEEK \${week}\\n\${weekPeriod(snapshot.monthKey,week)}\${includeDate&&date?\`\\nCounted \${formatDate(date)}\`:''}\`;}`, 'export dates');
  await writeFile(file, s);
}

async function patchCss(dist) {
  const file = resolve(dist, 'src/app.css');
  let s = await readFile(file, 'utf8');
  s += `\n/* v1.12.0 independent tab dates + browser autosave */\n.week-date-control>span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stock-submit-panel small:after{content:' · Draft autosaves on this device';color:#25845c;font-weight:750}\n`;
  await writeFile(file, s);
}
