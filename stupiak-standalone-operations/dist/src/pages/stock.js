import { STOCK_TABS } from '../config.js';
import { createId } from '../core/ids.js';
import { formatDate, monthPeriod, todayIso } from '../core/dates.js';
import { icon } from '../ui/icons.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEK_INDEXES = [1, 2, 3, 4, 5];
const WEEKLY_SECTIONS = ['Inventory', 'Untensil PG1', 'Utensil PG2'];

export function createStockState() {
  const today = todayIso();
  const monthKey = today.slice(0, 7);
  return {
    businessDate: `${monthKey}-01`,
    monthKey,
    weekDates: blankWeekDates(),
    sheetWeekDates: blankSheetWeekDates(),
    dirtyWeeks: {},
    dirtyColumns: blankDirtyColumns(),
    draftSavedAt: 0,
    draftRecoveredAt: 0,
    lastEditedWeek: currentWeekIndex(monthKey, today),
    stationaryDate: '',
    loading: false,
    syncing: false,
    syncError: '',
    error: '',
    data: null,
    activeTab: 'Inventory',
    mobileWeek: currentWeekIndex(monthKey, today),
    search: '',
    countedBy: '',
    sessionNote: '',
    values: {},
    submitting: false,
    submitBlocked: false,
    pendingSubmission: '',
    submitResult: null,
    lastSubmittedPayload: null
  };
}

export function initializeStockValues(state, data) {
  data.sections = (data.sections || []).map(sanitizeStockSectionRows);
  const monthKey = String(data.monthKey || state.businessDate || todayIso()).slice(0, 7);
  state.monthKey = monthKey;
  state.businessDate = `${monthKey}-01`;
  state.values = {};
  state.weekDates = blankWeekDates();
  state.sheetWeekDates = blankSheetWeekDates();
  state.dirtyColumns = blankDirtyColumns();
  state.stationaryDate = '';

  for (const section of data.sections || []) {
    state.values[section.sheetName] = {};
    for (const row of section.rows || []) {
      if (section.type === 'monthly-stationary') {
        state.values[section.sheetName][row.row] = {
          quantity: row.quantityValue === '' ? '' : row.quantityValue
        };
        if (!state.stationaryDate && row.date) state.stationaryDate = row.date;
        continue;
      }

      const weekValues = {};
      for (const week of row.weeks || []) {
        if (!state.sheetWeekDates[section.sheetName]) state.sheetWeekDates[section.sheetName] = blankWeekDates();
        if (!state.sheetWeekDates[section.sheetName][week.index] && week.date) state.sheetWeekDates[section.sheetName][week.index] = week.date;
        weekValues[week.index] = section.type === 'weekly-inventory'
          ? {
              primary: week.primaryValue === '' ? '' : week.primaryValue,
              secondary: week.secondaryValue === '' ? '' : week.secondaryValue
            }
          : { quantity: week.quantityValue === '' ? '' : week.quantityValue };
      }
      state.values[section.sheetName][row.row] = weekValues;
    }
  }

  state.weekDates = { ...(state.sheetWeekDates.Inventory || blankWeekDates()) };
  const today = todayIso();
  const preferredWeek = monthKey === today.slice(0, 7)
    ? currentWeekIndex(monthKey, today)
    : latestWeekWithDate(state.weekDates) || 1;
  data.selectedWeek = preferredWeek;
  state.mobileWeek = preferredWeek;
  state.lastEditedWeek = preferredWeek;
  state.dirtyWeeks = {};
  if (!state.countedBy && data.countedBy) state.countedBy = data.countedBy;
  state.submitResult = null;
}

export function stockPage(context, state) {
  const monthly = monthPeriod(state.businessDate);
  const outlet = state.data?.outlet || context.outlet || 'Stock Count';
  return `<section class="page stock-page stock-columns-page">
    <div class="page-heading stock-heading compact-heading">
      <div>
        <span class="eyebrow">STOCK COUNT</span>
        <h1>${escapeHtml(outlet)}</h1>
        <p>Each Week column has its own count date and saves independently into the monthly relation sheet.</p>
      </div>
      <div class="stock-heading-actions"><div class="stock-month-field"><label>Month<input id="stock-month" type="month" value="${escapeHtml(state.monthKey || state.businessDate.slice(0, 7))}"></label></div><button class="button secondary compact-refresh-button" id="refresh-stock-sheet" ${state.syncing ? 'disabled' : ''}>${state.syncing ? 'Refreshing…' : 'Refresh from Sheet'}</button></div>
    </div>
    ${state.draftNotice ? `<div class="sync-strip warning draft-isolated"><span class="sync-dot"></span><div><strong>Older browser draft isolated</strong><span>${escapeHtml(state.draftNotice)}</span></div></div>` : ''}
    ${stockSyncStatusMarkup(state)}
    ${state.data ? stockContent(state, monthly) : stockFirstLoadShell(state)}
  </section>`;
}

function stockContent(state, monthly) {
  return `<div class="stock-toolbar compact-stock-toolbar">
      <div class="sheet-tabs">${STOCK_TABS.map((tab) => `<button class="${state.activeTab === tab ? 'active' : ''}" data-stock-tab="${tab}">${tab}</button>`).join('')}</div>
      ${state.activeTab !== 'Order Page' ? `<label class="search-box">${icon('search', 17)}<input id="stock-search" value="${escapeHtml(state.search)}" placeholder="Search item"></label>` : ''}
    </div>
    ${state.activeTab === 'Order Page' ? liveOrderPageV1162(state) : sectionPage(state, weekly, monthly)}
    ${state.submitResult ? submitSuccess(state.submitResult, state) : ''}`;
}

function sectionPage(state, monthly) {
  const section = (state.data.sections || []).find((entry) => entry.sheetName === state.activeTab);
  if (!section) return `<div class="empty-state">Section not found.</div>`;
  const isMonthly = section.type === 'monthly-stationary';
  const filteredRows = section.rows.filter((row) => row.item.toLowerCase().includes(state.search.trim().toLowerCase()));
  const dirtyWeeks = dirtyWeekIndexes(state, section.sheetName);
  const focusWeek = state.lastEditedWeek || state.mobileWeek || 1;
  const progress = isMonthly
    ? completionProgress(state, ['Stationary'])
    : completionProgress(state, [section.sheetName], focusWeek);
  const saveLabel = isMonthly
    ? 'Save stationary to Sheet'
    : dirtyWeeks.length
      ? `Save ${dirtyWeeks.length} Week column${dirtyWeeks.length === 1 ? '' : 's'} to Sheet`
      : 'Edit a Week column to save';
  const readiness = stockSaveReadiness(state);

  return `<div class="section-meta stock-section-meta">
      <div><span>${isMonthly ? 'Monthly count' : `Focused column · Week ${focusWeek}`}</span><strong>${isMonthly ? monthly.rangeLabel : weekPeriodForIndex(state.monthKey, focusWeek)}</strong></div>
      <div class="stock-meta-actions">
        ${isMonthly ? `<label class="inline-count-date"><span>Count date</span><input id="stationary-count-date" type="date" value="${escapeHtml(state.stationaryDate)}"></label>` : `<div class="changed-week-copy"><span>Changed columns</span><strong>${dirtyWeeks.length ? dirtyWeeks.map((week) => `W${week}`).join(', ') : 'None'}</strong></div>`}
        <div class="progress-copy"><span>${progress.completed}/${progress.total} completed</span><div class="progress-track"><i style="width:${progress.total ? progress.completed / progress.total * 100 : 0}%"></i></div></div>
      </div>
    </div>
    ${section.type === 'weekly-inventory' ? inventoryTable(state, section, filteredRows) : section.type === 'weekly-utensil' ? utensilTable(state, section, filteredRows) : stationaryTable(state, section, filteredRows)}
    <div class="stock-submit-panel compact-submit-panel">
      <div class="form-grid two"><label>Counted by<input id="stock-counted-by" value="${escapeHtml(state.countedBy)}" placeholder="Staff name"></label><label>Session note<input id="stock-session-note" value="${escapeHtml(state.sessionNote)}" placeholder="Optional note"></label></div>
      <div class="submit-row"><div><strong>Save and export</strong><small>Save to D1. Export follows Excel. <span id="stock-readiness" class="stock-readiness ${readiness.ready ? 'ready' : 'missing'}">${escapeHtml(readiness.summary)}</span></small></div><div class="stock-action-buttons"><input id="stock-count-import-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden><button class="button secondary compact-stock-action" id="import-stock-count">Import</button><button class="button secondary danger-soft compact-stock-action" id="clear-stock-data">Clear</button><button class="button secondary compact-stock-action" id="export-stock-pdf" ${state.exportingFormat ? 'disabled' : ''}>${state.exportingFormat === 'pdf' ? 'Preparing PDF…' : 'Export PDF'}</button><button class="button secondary compact-stock-action" id="export-stock-excel" ${state.exportingFormat ? 'disabled' : ''}>${state.exportingFormat === 'excel' ? 'Preparing Excel…' : 'Export Excel'}</button><button class="button primary compact-stock-action" id="submit-stock" ${state.submitting || state.submitBlocked || state.pendingSubmission || !readiness.ready ? 'disabled' : ''}>${state.pendingSubmission || state.submitting ? 'Saving…' : state.submitBlocked ? 'Waiting…' : 'Save'}</button></div></div>
    </div>`;
}

function inventoryTable(state, section, rows) {
  return `<div class="week-selector mobile-only">${WEEK_INDEXES.map((week) => `<button class="${state.mobileWeek === week ? 'active' : ''}" data-mobile-week="${week}">W${week}</button>`).join('')}</div>
  <div class="sheet-table-wrap stock-grid-wrap"><table class="sheet-table stock-grid inventory-grid multi-date-grid"><thead><tr><th class="item-col">ITEM</th>${section.rows[0]?.weeks.map((week) => weekHeader(state, section.sheetName, week)).join('') || ''}<th class="minimum-col">MIN</th></tr></thead><tbody>${rows.map((row) => `<tr><th class="item-col"><strong>${escapeHtml(row.item)}</strong>${row.hasSecondaryQuantity ? `<small>1 ${escapeHtml(row.weeks[0]?.primaryUnit)} = ${row.conversion} ${escapeHtml(row.weeks[0]?.secondaryUnit)}</small>` : ''}</th>${row.weeks.map((week) => inventoryWeekCell(state, row, week)).join('')}<td class="minimum-col"><strong>${displayNumber(row.minimum)}</strong></td></tr>`).join('')}</tbody></table></div>`;
}

function inventoryWeekCell(state, row, week) {
  const value = state.values.Inventory?.[row.row]?.[week.index] || { primary: '', secondary: '' };
  const status = inventoryStatus(row, value);
  const dirty = isDirtyColumn(state, 'Inventory', week.index);
  return `<td class="week-cell editable-week ${dirty ? 'dirty-week' : ''} ${state.mobileWeek === week.index ? 'mobile-current' : ''}"><div class="quantity-line large-quantity-line"><input aria-label="${escapeHtml(row.item)} ${escapeHtml(week.primaryUnit)}" type="number" min="0" step="0.01" inputmode="decimal" data-stock-sheet="Inventory" data-stock-row="${row.row}" data-stock-week="${week.index}" data-stock-field="primary" value="${escapeHtml(value.primary)}" placeholder="0"><span>${escapeHtml(week.primaryUnit)}</span>${row.hasSecondaryQuantity ? `<input aria-label="${escapeHtml(row.item)} ${escapeHtml(week.secondaryUnit)}" type="number" min="0" step="0.01" inputmode="decimal" data-stock-sheet="Inventory" data-stock-row="${row.row}" data-stock-week="${week.index}" data-stock-field="secondary" value="${escapeHtml(value.secondary)}" placeholder="0"><span>${escapeHtml(week.secondaryUnit)}</span>` : ''}</div><span class="row-status ${statusClass(status)}">${status || 'OK'}</span></td>`;
}

function utensilTable(state, section, rows) {
  return `<div class="week-selector mobile-only">${WEEK_INDEXES.map((week) => `<button class="${state.mobileWeek === week ? 'active' : ''}" data-mobile-week="${week}">W${week}</button>`).join('')}</div><div class="sheet-table-wrap stock-grid-wrap"><table class="sheet-table stock-grid multi-date-grid"><thead><tr><th class="item-col">ITEM</th>${section.rows[0]?.weeks.map((week) => weekHeader(state, section.sheetName, week)).join('') || ''}<th class="minimum-col">MIN</th></tr></thead><tbody>${rows.map((row) => `<tr><th class="item-col"><strong>${escapeHtml(row.item)}</strong></th>${row.weeks.map((week) => { const value = state.values[section.sheetName]?.[row.row]?.[week.index]?.quantity ?? ''; const status = utensilStatus(section.sheetName, row, Number(value || 0)); const dirty = isDirtyColumn(state, section.sheetName, week.index); return `<td class="week-cell editable-week ${dirty ? 'dirty-week' : ''} ${state.mobileWeek === week.index ? 'mobile-current' : ''}"><div class="quantity-line large-quantity-line"><input type="number" min="0" step="0.01" inputmode="decimal" data-stock-sheet="${section.sheetName}" data-stock-row="${row.row}" data-stock-week="${week.index}" data-stock-field="quantity" value="${escapeHtml(value)}" placeholder="0"><span>${escapeHtml(week.unit)}</span></div><span class="row-status ${statusClass(status)}">${status || 'OK'}</span></td>`; }).join('')}<td class="minimum-col"><strong>${displayNumber(row.minimum)}</strong></td></tr>`).join('')}</tbody></table></div>`;
}

function stationaryTable(state, section, rows) {
  return `<div class="sheet-table-wrap stationary-wrap"><table class="sheet-table stationary-table compact-stationary-table"><thead><tr><th class="item-col">ITEM</th><th>QUANTITY</th><th>UNIT</th><th>STATUS</th><th>MIN</th></tr></thead><tbody>${rows.map((row) => { const value = state.values.Stationary?.[row.row]?.quantity ?? ''; const status = Number(value || 0) <= row.minimum ? 'Order' : ''; return `<tr><th class="item-col"><strong>${escapeHtml(row.item)}</strong></th><td><input class="stationary-quantity-input" type="number" min="0" step="0.01" inputmode="decimal" data-stock-sheet="Stationary" data-stock-row="${row.row}" data-stock-field="quantity" value="${escapeHtml(value)}" placeholder="0"></td><td>${escapeHtml(row.unit)}</td><td><span class="row-status ${statusClass(status)}">${status || 'OK'}</span></td><td><strong>${displayNumber(row.minimum)}</strong></td></tr>`; }).join('')}</tbody></table></div>`;
}

function weekHeader(state, sheetName, week) {
  const period = week.periodLabel || week.rangeLabel || weekPeriodForIndex(state.monthKey || week.date || todayIso(), week.index);
  const bounds = weekBounds(state.monthKey, week.index);
  const dateValue = state.sheetWeekDates?.[sheetName]?.[week.index] || '';
  const current = currentWeekIndex(state.monthKey, todayIso()) === week.index && state.monthKey === todayIso().slice(0, 7);
  const dirty = isDirtyColumn(state, sheetName, week.index);
  const staff = String(week.countedBy || '').trim();
  const savedMeta = dateValue ? '<em>Saved date' + (staff ? ' · ' + escapeHtml(staff) : '') + '</em>' : staff ? '<em>By ' + escapeHtml(staff) + '</em>' : '';
  return `<th class="week-head week-date-head ${current ? 'current-week' : ''} ${dirty ? 'dirty-week-head' : ''} ${state.mobileWeek === week.index ? 'mobile-current' : ''}"><span>WEEK ${week.index}</span><small>${period}</small><label class="week-date-control"><span>COUNT DATE · ${escapeHtml(sheetName)}</span><input type="date" data-week-date="${week.index}" data-week-sheet="${escapeHtml(sheetName)}" value="${escapeHtml(dateValue)}" min="${bounds.startIso}" max="${bounds.endIso}"></label>${dirty ? '<em>Changed in this tab</em>' : savedMeta}</th>`;
}


function orderPage(state) {
  return liveOrderPageV1162(state);
}

function liveOrderPageV1162(state) {
  const weeks = [1, 2, 3, 4, 5].map((weekIndex) => ({
    weekIndex,
    inventory: liveOrderGroupForWeekV1162(state, ['Inventory'], weekIndex),
    utensils: liveOrderGroupForWeekV1162(state, ['Untensil PG1', 'Utensil PG2'], weekIndex)
  }));
  const stationary = liveStationaryOrderGroupV1162(state);
  return `<div class="sheet-table-wrap order-wrap live-order-wrap"><table class="sheet-table order-table live-order-table"><tbody>
    ${weeks.map((week) => `<tr class="order-week-row"><th colspan="3">Week ${week.weekIndex}</th></tr>
      <tr><th>Inventory Order List</th><td class="order-date-cell">${liveOrderDateTextV1162(week.inventory)}</td><td>${liveOrderItemsTextV1162(week.inventory)}</td></tr>
      <tr><th>Utensil Order List</th><td class="order-date-cell">${liveOrderDateTextV1162(week.utensils)}</td><td>${liveOrderItemsTextV1162(week.utensils)}</td></tr>`).join('')}
    <tr class="order-week-row stationary-order-row"><th colspan="3">Stationary Stock (MONTHLY)</th></tr>
    <tr><th>Stationary Order List</th><td class="order-date-cell">${stationary.dateText}</td><td>${liveOrderItemsTextV1162(stationary)}</td></tr>
  </tbody></table></div>`;
}

function liveOrderGroupForWeekV1162(state, sheetNames, weekIndex) {
  const items = [];
  const dates = [];
  let counted = false;
  for (const sheetName of sheetNames) {
    const section = (state.data?.sections || []).find((entry) => entry.sheetName === sheetName);
    if (!section) continue;
    const date = state.sheetWeekDates?.[sheetName]?.[weekIndex] || section.rows?.[0]?.weeks?.find((entry) => Number(entry.index) === Number(weekIndex))?.date || '';
    const dirty = Boolean(state.dirtyColumns?.[sheetName]?.[weekIndex]);
    if (!date && !dirty) continue;
    counted = true;
    if (date) dates.push({ sheetName, date });
    for (const row of section.rows || []) {
      const week = (row.weeks || []).find((entry) => Number(entry.index) === Number(weekIndex));
      const rowValues = state.values?.[sheetName]?.[row.row] || {};
      const live = rowValues?.[weekIndex] && typeof rowValues[weekIndex] === 'object'
        ? rowValues[weekIndex]
        : Number(weekIndex) === Number(state.data?.selectedWeek) ? rowValues : null;
      const status = live
        ? section.type === 'weekly-inventory'
          ? inventoryStatus(row, live)
          : utensilStatus(sheetName, row, Number(live.quantity || 0))
        : String(week?.status || '');
      if (status === 'Order') items.push(row.item);
    }
  }
  return { items: [...new Set(items)], dates, counted };
}

function liveStationaryOrderGroupV1162(state) {
  const section = (state.data?.sections || []).find((entry) => entry.sheetName === 'Stationary');
  if (!section) return { items: [], counted: false, dateText: 'Not counted' };
  const date = String(state.stationaryDate || section.countDate || section.date || '').trim();
  const hasSaved = (section.rows || []).some((row) => row.quantityValue !== '' && row.quantityValue !== null && row.quantityValue !== undefined);
  const hasLive = (section.rows || []).some((row) => {
    const value = state.values?.Stationary?.[row.row]?.quantity;
    return value !== '' && value !== null && value !== undefined;
  });
  const counted = Boolean(date || hasSaved || hasLive);
  const items = counted ? (section.rows || []).filter((row) => {
    const live = state.values?.Stationary?.[row.row]?.quantity;
    const quantity = live !== '' && live !== null && live !== undefined ? Number(live) : Number(row.quantityValue || 0);
    return quantity <= Number(row.minimum || 0);
  }).map((row) => row.item) : [];
  return { items, counted, dateText: date ? `Counted ${escapeHtml(formatDate(date))}` : counted ? 'Counted' : 'Not counted' };
}

function liveOrderDateTextV1162(group) {
  if (!group.counted) return '<span class="order-none">Not counted</span>';
  if (!group.dates.length) return 'Counted';
  const unique = [...new Set(group.dates.map((entry) => entry.date))];
  if (unique.length === 1) return `Counted ${escapeHtml(formatDate(unique[0]))}`;
  return group.dates.map((entry) => `${escapeHtml(entry.sheetName === 'Untensil PG1' ? 'PG1' : entry.sheetName === 'Utensil PG2' ? 'PG2' : entry.sheetName)} ${escapeHtml(formatDate(entry.date))}`).join('<br>');
}

function liveOrderItemsTextV1162(group) {
  if (!group.counted) return '<span class="order-none">Not counted</span>';
  return group.items.length ? group.items.map(escapeHtml).join(', ') : '<span class="order-none">No order</span>';
}

function submitSuccess(result, state) {
  const savedLabel = Array.isArray(result.savedWeeks) && result.savedWeeks.length
    ? result.savedWeeks.map((entry) => (entry.sheetName ? entry.sheetName + ' · ' : '') + 'W' + entry.weekIndex).join(', ')
    : result.weekIndex ? 'W' + result.weekIndex : '';
  const pending = Boolean(result.localPending || state.pendingSubmission);
  const failed = Boolean(pending && state.pendingError);
  const d1MirrorPending = Boolean(!pending && result.dataSource === 'cloudflare-d1' && result.gasSyncStatus !== 'synced');
  const title = failed ? 'Save not completed' : pending ? 'Saving to Cloudflare' : d1MirrorPending ? 'Saved fast · Google Sheet syncing' : 'Saved to D1';
  const detail = failed
    ? escapeHtml(state.pendingError)
    : pending
      ? 'Keep this page open until Cloudflare confirms the save.'
      : d1MirrorPending
        ? 'Cloudflare D1 has confirmed the save. You may continue working while Google Sheet updates in the background.'
        : 'Relation save confirmed. PDF and Excel can be exported separately.';
  const openSheet = result.spreadsheetUrl
    ? `<a class="button secondary" href="${escapeHtml(result.spreadsheetUrl)}" target="_blank" rel="noopener">Open Monthly Sheet ${icon('external', 16)}</a>`
    : '';
  const retry = failed ? '<button class="button primary" id="retry-stock-save-result">Retry Save</button>' : '';
  const savingState = pending
    ? `<div class="stock-save-lock-state ${failed ? 'failed' : ''}"><span class="sync-dot"></span><strong>${failed ? 'Waiting for Retry' : 'Saving — keep page open'}</strong></div>`
    : '';
  return `<article class="submit-success stock-success separated-stock-success ${pending ? 'stock-save-locked' : ''} ${failed ? 'stock-save-failed' : ''}"><div class="success-icon">${failed ? '!' : pending ? '…' : icon('check')}</div><div><span>${title}</span><strong>${escapeHtml(result.outlet || '')}${savedLabel ? ' · ' + escapeHtml(savedLabel) : ''}</strong><small>${detail}</small></div><div class="success-actions">${openSheet}<button class="button secondary" id="export-stock-pdf-result" ${state.exportingFormat ? 'disabled' : ''}>Export PDF</button><button class="button secondary" id="export-stock-excel-result" ${state.exportingFormat ? 'disabled' : ''}>Export Excel</button>${retry}</div>${savingState}</article>`;
}

export function buildStockPayload(state) {
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
}

function buildSectionRows(state, name, weekIndex) {
  const section = state.data.sections.find((entry) => entry.sheetName === name);
  return (section?.rows || []).map((row) => {
    const value = weekIndex === null
      ? state.values[name]?.[row.row] || {}
      : state.values[name]?.[row.row]?.[weekIndex] || {};
    return {
      row: row.row,
      ...(section.type === 'weekly-inventory'
        ? {
            primary: value.primary,
            ...(row.hasSecondaryQuantity ? { secondary: value.secondary } : {})
          }
        : { quantity: value.quantity })
    };
  });
}

export function stockSaveReadiness(state) {
  const sectionName = state.activeTab;
  const section = state.data?.sections?.find((entry) => entry.sheetName === sectionName);
  const entered = (value) => value !== '' && value !== null && value !== undefined && Number(value) >= 0;
  if (!section) return { ready: false, summary: 'Section is not ready', error: 'Stock section is not available.' };

  if (sectionName === 'Stationary') {
    const rows = section.rows || [];
    let completed = 0;
    let firstMissing = '';
    for (const row of rows) {
      const value = state.values?.Stationary?.[row.row]?.quantity;
      if (entered(value)) completed += 1;
      else if (!firstMissing) firstMissing = row.item;
    }
    const parts = [`${completed}/${rows.length} entered`];
    if (!state.stationaryDate) parts.push('select count date');
    if (!String(state.countedBy || '').trim()) parts.push('enter staff name');
    const ready = Boolean(state.stationaryDate && String(state.countedBy || '').trim() && completed === rows.length);
    const error = !state.stationaryDate
      ? 'Enter the Stationary count date.'
      : completed !== rows.length
        ? `Complete Stationary: ${firstMissing}`
        : !String(state.countedBy || '').trim()
          ? 'Enter the staff name before saving.'
          : '';
    return { ready, summary: `Stationary · ${parts.join(' · ')}`, error };
  }

  const dirty = dirtyWeekIndexes(state, sectionName);
  if (!dirty.length) return { ready: false, summary: 'Edit a Week column to save', error: `Edit at least one ${sectionName} Week column before saving.` };

  let total = 0;
  let completed = 0;
  let firstMissing = '';
  let firstMissingWeek = dirty[0];
  let firstMissingDate = 0;
  let invalidDateWeek = 0;

  for (const weekIndex of dirty) {
    const countDate = state.sheetWeekDates?.[sectionName]?.[weekIndex] || '';
    if (!countDate && !firstMissingDate) firstMissingDate = weekIndex;
    else if (countDate && !dateBelongsToWeek(state.monthKey, weekIndex, countDate) && !invalidDateWeek) invalidDateWeek = weekIndex;

    for (const row of section.rows || []) {
      total += 1;
      const value = state.values?.[sectionName]?.[row.row]?.[weekIndex] || {};
      const main = section.type === 'weekly-inventory' ? value.primary : value.quantity;
      const complete = entered(main) && (!row.hasSecondaryQuantity || entered(value.secondary));
      if (complete) completed += 1;
      else if (!firstMissing) {
        firstMissing = row.hasSecondaryQuantity && entered(main) && !entered(value.secondary)
          ? `${row.item} secondary unit`
          : row.item;
        firstMissingWeek = weekIndex;
      }
    }
  }

  const label = dirty.length === 1 ? `Week ${dirty[0]}` : `${dirty.length} Week columns`;
  const parts = [`${completed}/${total} entered`];
  if (firstMissingDate) parts.push('select count date');
  if (invalidDateWeek) parts.push('fix count date');
  if (!String(state.countedBy || '').trim()) parts.push('enter staff name');
  const ready = Boolean(!firstMissingDate && !invalidDateWeek && completed === total && String(state.countedBy || '').trim());
  const error = firstMissingDate
    ? `Enter the ${sectionName} count date for Week ${firstMissingDate}.`
    : invalidDateWeek
      ? `${sectionName} Week ${invalidDateWeek} count date must be within ${weekPeriodForIndex(state.monthKey, invalidDateWeek)}.`
      : completed !== total
        ? `Complete Week ${firstMissingWeek} · ${sectionName}: ${firstMissing}`
        : !String(state.countedBy || '').trim()
          ? 'Enter the staff name before saving.'
          : '';
  return { ready, summary: `${label} · ${parts.join(' · ')}`, error };
}

export function validateStock(state) {
  const readiness = stockSaveReadiness(state);
  return readiness.ready ? '' : readiness.error;
}

function completionProgress(state, names, weekIndex = null) {
  let total = 0;
  let completed = 0;
  for (const name of names) {
    const section = state.data.sections.find((entry) => entry.sheetName === name);
    if (!section) continue;
    for (const row of section.rows) {
      total += 1;
      const value = weekIndex === null
        ? state.values[name]?.[row.row] || {}
        : state.values[name]?.[row.row]?.[weekIndex] || {};
      const main = section.type === 'weekly-inventory' ? value.primary : value.quantity;
      const secondaryOk = !row.hasSecondaryQuantity || value.secondary !== '';
      if (main !== '' && main !== null && main !== undefined && secondaryOk) completed += 1;
    }
  }
  return { total, completed };
}

function sanitizeStockSectionRows(section) {
  const sourceRows = Array.isArray(section?.rows) ? section.rows.slice().sort((a, b) => Number(a.row || 0) - Number(b.row || 0)) : [];
  const rows = [];
  let previousRow = null;
  for (const sourceRow of sourceRows) {
    const item = String(sourceRow?.item || '').trim();
    if (!item) continue;
    const commaCount = (item.match(/,/g) || []).length;
    const footerLike = commaCount >= 4 || item.length > 180;
    const gap = previousRow === null ? 0 : Number(sourceRow.row || 0) - previousRow;
    if (footerLike || (gap >= 4 && commaCount >= 2)) break;
    const row = { ...sourceRow };
    if (Array.isArray(sourceRow.weeks)) {
      row.weeks = sourceRow.weeks.map((week) => {
        if (week?.date) return { ...week };
        return {
          ...week,
          primaryValue: '',
          secondaryValue: '',
          quantityValue: '',
          status: ''
        };
      });
    }
    rows.push(row);
    previousRow = Number(sourceRow.row || 0);
  }
  return { ...section, rows };
}

function dirtyWeekIndexes(state, sheetName = state.activeTab) { return WEEK_INDEXES.filter((week) => Boolean(state.dirtyColumns?.[sheetName]?.[week])); }
function isDirtyColumn(state, sheetName, weekIndex) { return Boolean(state.dirtyColumns?.[sheetName]?.[weekIndex]); }
function blankWeekDates() { return { 1: '', 2: '', 3: '', 4: '', 5: '' }; }
function blankSheetWeekDates() { return Object.fromEntries(WEEKLY_SECTIONS.map((name) => [name, blankWeekDates()])); }
function blankDirtyColumns() { return Object.fromEntries(WEEKLY_SECTIONS.map((name) => [name, {}])); }
function latestWeekWithDate(weekDates) {
  for (let week = 5; week >= 1; week -= 1) if (weekDates?.[week]) return week;
  return 0;
}

function currentWeekIndex(monthKey, dateText) {
  const date = String(dateText || todayIso());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 1;
  const bounds = WEEK_INDEXES.map((week) => weekBounds(monthKey, week));
  const found = bounds.find((entry) => date >= entry.startIso && date <= entry.endIso);
  return found?.weekIndex || 1;
}

function weekBounds(monthKey, weekIndex) {
  const month = String(monthKey || todayIso().slice(0, 7));
  const monthStart = new Date(`${month}-01T00:00:00`);
  const gridStart = startOfCalendarWeek(monthStart);
  const start = addDays(gridStart, (Number(weekIndex || 1) - 1) * 7);
  const end = addDays(start, 6);
  return {
    weekIndex: Number(weekIndex),
    start,
    end,
    startIso: localIso(start),
    endIso: localIso(end)
  };
}

function dateBelongsToWeek(monthKey, weekIndex, dateText) {
  const bounds = weekBounds(monthKey, weekIndex);
  return dateText >= bounds.startIso && dateText <= bounds.endIso;
}

function weekPeriodForIndex(monthKeyOrDate, index) {
  const monthKey = String(monthKeyOrDate || todayIso()).slice(0, 7);
  const { start, end } = weekBounds(monthKey, index);
  return `${formatDate(start, { year: false })}–${formatDate(end, { year: false })}`;
}

function startOfCalendarWeek(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - offset);
  return result;
}

function addDays(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setTime(result.getTime() + Number(days || 0) * MS_PER_DAY);
  return result;
}

function localIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function inventoryStatus(row, value) {
  const primary = Number(value.primary || 0);
  const secondary = Number(value.secondary || 0);
  return primary * row.conversion + secondary <= row.minimum ? 'Order' : '';
}

function utensilStatus(name, row, quantity) {
  if (name === 'Utensil PG2' && row.row === 9) return quantity <= 0 ? 'No More Use' : '';
  if (name === 'Utensil PG2' && row.row === 36) return quantity <= 4 ? 'Spare Item' : '';
  return quantity <= row.minimum ? 'Order' : '';
}

function statusClass(status) { return status ? 'attention' : 'ok'; }
function displayNumber(value) { return value === '' ? '—' : value; }

function stockSyncStatusMarkup(state) {
  const error = state.syncError || state.error;
  if (state.pendingSubmission && state.pendingError) return '<div class="sync-strip warning"><span class="sync-dot"></span><div><strong>Stock save not confirmed</strong><span>' + escapeHtml(state.pendingError) + '</span></div><button id="retry-stock-save">Retry Save</button></div>';
  if (state.pendingSubmission) return '<div class="sync-strip pending"><span class="sync-dot"></span><div><strong>Saving directly to _StockRelation</strong><span>Keep this page open until the Submission ID is confirmed.</span></div></div>';
  if (state.syncing) return '<div class="sync-strip syncing"><span class="sync-dot"></span><div><strong></strong><span>The current form stays visible and editable.</span></div></div>';
  if (error) return '<div class="sync-strip warning"><span class="sync-dot"></span><div><strong></strong><span>' + escapeHtml(error) + '</span></div><button id="retry-stock">Retry sync</button></div>';
  return '';
}

function stockFirstLoadShell(state) {
  return '<div class="stock-first-shell"><div class="sheet-tabs">' + STOCK_TABS.map((tab) => '<button class="' + (state.activeTab === tab ? 'active' : '') + '" data-stock-tab="' + tab + '">' + tab + '</button>').join('') + '</div><div class="first-connect-card"><div><strong>Preparing the item list in the background</strong><span>This first device load needs one successful read. After that, the Stock Count UI opens instantly from the device cache.</span></div></div></div>';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}
