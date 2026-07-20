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
    dirtyWeeks: {},
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
  const monthKey = String(data.monthKey || state.businessDate || todayIso()).slice(0, 7);
  state.monthKey = monthKey;
  state.businessDate = `${monthKey}-01`;
  state.values = {};
  state.weekDates = blankWeekDates();
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
        if (!state.weekDates[week.index] && week.date) state.weekDates[week.index] = week.date;
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

  const today = todayIso();
  const preferredWeek = monthKey === today.slice(0, 7)
    ? currentWeekIndex(monthKey, today)
    : latestWeekWithDate(state.weekDates) || 1;
  data.selectedWeek = preferredWeek;
  state.mobileWeek = preferredWeek;
  state.lastEditedWeek = preferredWeek;
  state.dirtyWeeks = {};
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
      <div class="stock-month-field"><label>Month<input id="stock-month" type="month" value="${escapeHtml(state.monthKey || state.businessDate.slice(0, 7))}"></label></div>
    </div>
    ${stockSyncStatusMarkup(state)}
    ${state.data ? stockContent(state, monthly) : stockFirstLoadShell(state)}
  </section>`;
}

function stockContent(state, monthly) {
  return `<div class="stock-toolbar compact-stock-toolbar">
      <div class="sheet-tabs">${STOCK_TABS.map((tab) => `<button class="${state.activeTab === tab ? 'active' : ''}" data-stock-tab="${tab}">${tab}</button>`).join('')}</div>
      ${state.activeTab !== 'Order Page' ? `<label class="search-box">${icon('search', 17)}<input id="stock-search" value="${escapeHtml(state.search)}" placeholder="Search item"></label>` : ''}
    </div>
    ${state.activeTab === 'Order Page' ? orderPage(state.data.orderPage) : sectionPage(state, monthly)}
    ${state.submitResult ? submitSuccess(state.submitResult) : ''}`;
}

function sectionPage(state, monthly) {
  const section = (state.data.sections || []).find((entry) => entry.sheetName === state.activeTab);
  if (!section) return `<div class="empty-state">Section not found.</div>`;
  const isMonthly = section.type === 'monthly-stationary';
  const filteredRows = section.rows.filter((row) => row.item.toLowerCase().includes(state.search.trim().toLowerCase()));
  const dirtyWeeks = dirtyWeekIndexes(state);
  const focusWeek = state.lastEditedWeek || state.mobileWeek || 1;
  const progress = isMonthly
    ? completionProgress(state, ['Stationary'])
    : completionProgress(state, WEEKLY_SECTIONS, focusWeek);
  const saveLabel = isMonthly
    ? 'Save stationary count'
    : dirtyWeeks.length
      ? `Save ${dirtyWeeks.length} changed week${dirtyWeeks.length === 1 ? '' : 's'}`
      : 'Edit a Week column to save';

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
      <div class="submit-row"><div><strong>${isMonthly ? 'Monthly stationary' : 'Independent Week columns'}</strong><small>${isMonthly ? 'Saves Stationary only.' : 'Only changed Week columns are written. Each column uses its own count date.'}</small></div><button class="button primary" id="submit-stock" ${state.submitting || state.submitBlocked || (!isMonthly && !dirtyWeeks.length) ? 'disabled' : ''}>${state.submitting ? 'Syncing…' : state.submitBlocked ? 'Waiting for month data…' : saveLabel}</button></div>
    </div>`;
}

function inventoryTable(state, section, rows) {
  return `<div class="week-selector mobile-only">${WEEK_INDEXES.map((week) => `<button class="${state.mobileWeek === week ? 'active' : ''}" data-mobile-week="${week}">W${week}</button>`).join('')}</div>
  <div class="sheet-table-wrap stock-grid-wrap"><table class="sheet-table stock-grid inventory-grid multi-date-grid"><thead><tr><th class="item-col">ITEM</th>${section.rows[0]?.weeks.map((week) => weekHeader(state, week)).join('') || ''}<th class="minimum-col">MIN</th></tr></thead><tbody>${rows.map((row) => `<tr><th class="item-col"><strong>${escapeHtml(row.item)}</strong>${row.hasSecondaryQuantity ? `<small>1 ${escapeHtml(row.weeks[0]?.primaryUnit)} = ${row.conversion} ${escapeHtml(row.weeks[0]?.secondaryUnit)}</small>` : ''}</th>${row.weeks.map((week) => inventoryWeekCell(state, row, week)).join('')}<td class="minimum-col"><strong>${displayNumber(row.minimum)}</strong></td></tr>`).join('')}</tbody></table></div>`;
}

function inventoryWeekCell(state, row, week) {
  const value = state.values.Inventory?.[row.row]?.[week.index] || { primary: '', secondary: '' };
  const status = inventoryStatus(row, value);
  const dirty = Boolean(state.dirtyWeeks[week.index]);
  return `<td class="week-cell editable-week ${dirty ? 'dirty-week' : ''} ${state.mobileWeek === week.index ? 'mobile-current' : ''}"><div class="quantity-line large-quantity-line"><input aria-label="${escapeHtml(row.item)} ${escapeHtml(week.primaryUnit)}" type="number" min="0" step="0.01" inputmode="decimal" data-stock-sheet="Inventory" data-stock-row="${row.row}" data-stock-week="${week.index}" data-stock-field="primary" value="${escapeHtml(value.primary)}" placeholder="0"><span>${escapeHtml(week.primaryUnit)}</span>${row.hasSecondaryQuantity ? `<input aria-label="${escapeHtml(row.item)} ${escapeHtml(week.secondaryUnit)}" type="number" min="0" step="0.01" inputmode="decimal" data-stock-sheet="Inventory" data-stock-row="${row.row}" data-stock-week="${week.index}" data-stock-field="secondary" value="${escapeHtml(value.secondary)}" placeholder="0"><span>${escapeHtml(week.secondaryUnit)}</span>` : ''}</div><span class="row-status ${statusClass(status)}">${status || 'OK'}</span></td>`;
}

function utensilTable(state, section, rows) {
  return `<div class="week-selector mobile-only">${WEEK_INDEXES.map((week) => `<button class="${state.mobileWeek === week ? 'active' : ''}" data-mobile-week="${week}">W${week}</button>`).join('')}</div><div class="sheet-table-wrap stock-grid-wrap"><table class="sheet-table stock-grid multi-date-grid"><thead><tr><th class="item-col">ITEM</th>${section.rows[0]?.weeks.map((week) => weekHeader(state, week)).join('') || ''}<th class="minimum-col">MIN</th></tr></thead><tbody>${rows.map((row) => `<tr><th class="item-col"><strong>${escapeHtml(row.item)}</strong></th>${row.weeks.map((week) => { const value = state.values[section.sheetName]?.[row.row]?.[week.index]?.quantity ?? ''; const status = utensilStatus(section.sheetName, row, Number(value || 0)); const dirty = Boolean(state.dirtyWeeks[week.index]); return `<td class="week-cell editable-week ${dirty ? 'dirty-week' : ''} ${state.mobileWeek === week.index ? 'mobile-current' : ''}"><div class="quantity-line large-quantity-line"><input type="number" min="0" step="0.01" inputmode="decimal" data-stock-sheet="${section.sheetName}" data-stock-row="${row.row}" data-stock-week="${week.index}" data-stock-field="quantity" value="${escapeHtml(value)}" placeholder="0"><span>${escapeHtml(week.unit)}</span></div><span class="row-status ${statusClass(status)}">${status || 'OK'}</span></td>`; }).join('')}<td class="minimum-col"><strong>${displayNumber(row.minimum)}</strong></td></tr>`).join('')}</tbody></table></div>`;
}

function stationaryTable(state, section, rows) {
  return `<div class="sheet-table-wrap stationary-wrap"><table class="sheet-table stationary-table compact-stationary-table"><thead><tr><th class="item-col">ITEM</th><th>QUANTITY</th><th>UNIT</th><th>STATUS</th><th>MIN</th></tr></thead><tbody>${rows.map((row) => { const value = state.values.Stationary?.[row.row]?.quantity ?? ''; const status = Number(value || 0) <= row.minimum ? 'Order' : ''; return `<tr><th class="item-col"><strong>${escapeHtml(row.item)}</strong></th><td><input class="stationary-quantity-input" type="number" min="0" step="0.01" inputmode="decimal" data-stock-sheet="Stationary" data-stock-row="${row.row}" data-stock-field="quantity" value="${escapeHtml(value)}" placeholder="0"></td><td>${escapeHtml(row.unit)}</td><td><span class="row-status ${statusClass(status)}">${status || 'OK'}</span></td><td><strong>${displayNumber(row.minimum)}</strong></td></tr>`; }).join('')}</tbody></table></div>`;
}

function weekHeader(state, week) {
  const period = week.periodLabel || week.rangeLabel || weekPeriodForIndex(state.monthKey || week.date || todayIso(), week.index);
  const bounds = weekBounds(state.monthKey, week.index);
  const dateValue = state.weekDates[week.index] || '';
  const current = currentWeekIndex(state.monthKey, todayIso()) === week.index && state.monthKey === todayIso().slice(0, 7);
  const dirty = Boolean(state.dirtyWeeks[week.index]);
  return `<th class="week-head week-date-head ${current ? 'current-week' : ''} ${dirty ? 'dirty-week-head' : ''} ${state.mobileWeek === week.index ? 'mobile-current' : ''}"><span>WEEK ${week.index}</span><small>${period}</small><label class="week-date-control"><span>COUNT DATE</span><input type="date" data-week-date="${week.index}" value="${escapeHtml(dateValue)}" min="${bounds.startIso}" max="${bounds.endIso}"></label>${dirty ? '<em>Changed</em>' : dateValue ? '<em>Saved date</em>' : ''}</th>`;
}

function orderPage(orderPageData) {
  const rows = orderPageData?.values || [];
  return `<div class="order-note">${icon('alert')} <div><strong>Order Page is read-only</strong><span>It follows the monthly spreadsheet calculation and layout.</span></div></div><div class="sheet-table-wrap order-wrap"><table class="sheet-table order-table"><tbody>${rows.map((row, rowIndex) => `<tr>${row.map((cell, colIndex) => `<${rowIndex < 3 || colIndex === 0 ? 'th' : 'td'}>${escapeHtml(cell)}</${rowIndex < 3 || colIndex === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function submitSuccess(result) {
  const shareStatus = result.sharePreparing
    ? `<div class="share-preparing"><span class="sync-dot"></span><div><strong>Preparing PDF and Excel</strong><small>Stock is already saved. File export continues separately.</small></div></div>`
    : result.shareError
      ? `<div class="share-preparing warning"><div><strong>Stock saved, export not ready</strong><small>${escapeHtml(result.shareError)}</small></div><button class="button secondary" id="stock-prepare-share">Retry PDF & Excel</button></div>`
      : '';
  const fileActions = [
    result.pdfUrl ? `<a class="button secondary" href="${escapeHtml(result.pdfUrl)}" target="_blank" rel="noopener">Open PDF ${icon('external', 16)}</a>` : '',
    result.excelUrl ? `<a class="button secondary" href="${escapeHtml(result.excelUrl)}" target="_blank" rel="noopener">Open Excel ${icon('external', 16)}</a>` : '',
    result.whatsappShareUrl ? `<button class="button whatsapp" id="stock-whatsapp">${icon('whatsapp', 18)} Send to WhatsApp</button>` : ''
  ].filter(Boolean).join('');
  const savedLabel = Array.isArray(result.savedWeeks) && result.savedWeeks.length
    ? result.savedWeeks.map((entry) => `W${entry.weekIndex}`).join(', ')
    : `Week ${result.weekIndex}`;
  return `<article class="submit-success stock-success"><div class="success-icon">${icon('check')}</div><div><span>Stock count saved</span><strong>${escapeHtml(result.outlet)} · ${escapeHtml(savedLabel)}</strong><small>${result.orderCount} item(s) require attention · ${escapeHtml(result.spreadsheetName)}</small></div><div class="success-actions"><a class="button secondary" href="${result.spreadsheetUrl}" target="_blank" rel="noopener">Open Monthly Sheet ${icon('external', 16)}</a>${fileActions}</div>${shareStatus}</article>`;
}

export function buildStockPayload(state) {
  const isMonthly = state.activeTab === 'Stationary';
  const submissionId = createId('stock');
  const common = {
    action: 'submitStockCount',
    submissionId,
    monthKey: state.monthKey || state.businessDate.slice(0, 7),
    countedBy: state.countedBy,
    sessionNote: state.sessionNote
  };

  if (isMonthly) {
    const sections = { Stationary: buildSectionRows(state, 'Stationary', null) };
    return {
      ...common,
      businessDate: state.stationaryDate,
      selectedWeek: '',
      sections
    };
  }

  const dirty = dirtyWeekIndexes(state);
  const primaryWeek = dirty.includes(Number(state.lastEditedWeek)) ? Number(state.lastEditedWeek) : dirty[0];
  const ordered = [primaryWeek, ...dirty.filter((week) => week !== primaryWeek)];
  const weekColumns = ordered.map((weekIndex) => ({
    weekIndex,
    businessDate: state.weekDates[weekIndex],
    sections: Object.fromEntries(WEEKLY_SECTIONS.map((name) => [name, buildSectionRows(state, name, weekIndex)]))
  }));
  return {
    ...common,
    businessDate: weekColumns[0]?.businessDate || '',
    selectedWeek: weekColumns[0]?.weekIndex || '',
    sections: weekColumns[0]?.sections || {},
    weekColumns
  };
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

export function validateStock(state) {
  if (!state.countedBy.trim()) return 'Enter the staff name before submitting.';
  if (state.activeTab === 'Stationary') {
    if (!state.stationaryDate) return 'Enter the Stationary count date.';
    for (const row of state.data.sections.find((entry) => entry.sheetName === 'Stationary')?.rows || []) {
      const value = state.values.Stationary?.[row.row]?.quantity;
      if (value === '' || value === null || value === undefined || Number(value) < 0) return `Complete Stationary: ${row.item}`;
    }
    return '';
  }

  const dirty = dirtyWeekIndexes(state);
  if (!dirty.length) return 'Edit at least one Week column before saving.';
  for (const weekIndex of dirty) {
    const countDate = state.weekDates[weekIndex];
    if (!countDate) return `Enter the count date for Week ${weekIndex}.`;
    if (!dateBelongsToWeek(state.monthKey, weekIndex, countDate)) {
      return `Week ${weekIndex} count date must be within ${weekPeriodForIndex(state.monthKey, weekIndex)}.`;
    }
    for (const name of WEEKLY_SECTIONS) {
      const section = state.data.sections.find((entry) => entry.sheetName === name);
      if (!section) continue;
      for (const row of section.rows) {
        const value = state.values[name]?.[row.row]?.[weekIndex] || {};
        const main = section.type === 'weekly-inventory' ? value.primary : value.quantity;
        if (main === '' || main === null || main === undefined || Number(main) < 0) return `Complete Week ${weekIndex} · ${name}: ${row.item}`;
        if (row.hasSecondaryQuantity && (value.secondary === '' || value.secondary === null || value.secondary === undefined || Number(value.secondary) < 0)) return `Complete Week ${weekIndex} · ${name}: ${row.item} secondary unit`;
      }
    }
  }
  return '';
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

function dirtyWeekIndexes(state) {
  return WEEK_INDEXES.filter((week) => Boolean(state.dirtyWeeks?.[week]));
}

function blankWeekDates() {
  return { 1: '', 2: '', 3: '', 4: '', 5: '' };
}

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
  if (state.pendingSubmission) return '<div class="sync-strip pending"><span class="sync-dot"></span><div><strong>Stock count saved on this device</strong><span>Upload continues in the background. The entered quantities are not lost.</span></div></div>';
  if (state.syncing) return '<div class="sync-strip syncing"><span class="sync-dot"></span><div><strong>Refreshing monthly Sheet in the background</strong><span>The current form stays visible and editable.</span></div></div>';
  if (error) return '<div class="sync-strip warning"><span class="sync-dot"></span><div><strong>Google Sheet sync is unavailable</strong><span>The form and draft remain on this device.</span></div><button id="retry-stock">Retry sync</button></div>';
  return '';
}

function stockFirstLoadShell(state) {
  return '<div class="stock-first-shell"><div class="sheet-tabs">' + STOCK_TABS.map((tab) => '<button class="' + (state.activeTab === tab ? 'active' : '') + '" data-stock-tab="' + tab + '">' + tab + '</button>').join('') + '</div><div class="first-connect-card"><div><strong>Preparing the item list in the background</strong><span>This first device load needs one successful read. After that, the Stock Count UI opens instantly from the device cache.</span></div></div></div>';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}
