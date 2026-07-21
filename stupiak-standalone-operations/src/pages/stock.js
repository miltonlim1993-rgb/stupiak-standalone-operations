import { STOCK_TABS } from '../config.js';
import { createId } from '../core/ids.js';
import { formatDate, monthPeriod, todayIso, weekPeriod } from '../core/dates.js';
import { icon } from '../ui/icons.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function createStockState() {
  return { businessDate: todayIso(), loading: false, error: '', data: null, activeTab: 'Inventory', mobileWeek: 1, search: '', countedBy: '', sessionNote: '', values: {}, submitting: false, submitResult: null };
}

export function initializeStockValues(state, data) {
  const selectedWeek = weekPeriod(state.businessDate).index;
  data.selectedWeek = selectedWeek;
  state.values = {};
  for (const section of data.sections || []) {
    state.values[section.sheetName] = {};
    for (const row of section.rows || []) {
      if (section.type === 'monthly-stationary') {
        state.values[section.sheetName][row.row] = { quantity: row.quantityValue === '' ? '' : row.quantityValue };
      } else {
        const week = row.weeks.find((entry) => entry.index === selectedWeek) || row.weeks[0];
        state.values[section.sheetName][row.row] = section.type === 'weekly-inventory'
          ? { primary: week.primaryValue === '' ? '' : week.primaryValue, secondary: week.secondaryValue === '' ? '' : week.secondaryValue }
          : { quantity: week.quantityValue === '' ? '' : week.quantityValue };
      }
    }
  }
  state.mobileWeek = selectedWeek;
  state.submitResult = null;
}

export function stockPage(context, state) {
  const weekly = weekPeriod(state.businessDate);
  const monthly = monthPeriod(state.businessDate);
  return `<section class="page stock-page">
    <div class="page-heading stock-heading"><div><span class="eyebrow">STOCK COUNT</span><h1>${escapeHtml(state.data?.outlet || context.outlet || 'Connecting…')}</h1><p>Original spreadsheet order, units, minimum levels and calendar Week 1–5 structure.</p></div><div class="date-field"><label>Count date<input id="stock-date" type="date" value="${state.businessDate}"></label></div></div>
    <div class="period-banner">
      <div class="period-main"><span class="period-status">CURRENT PERIOD</span><strong>${weekly.label}</strong><small>${weekly.rangeLabel}</small></div>
      <div class="period-facts"><div><span>Writes to</span><strong>${weekly.label}</strong></div><div><span>Monthly file</span><strong>${escapeHtml(state.data?.monthKey || state.businessDate.slice(0,7))}</strong></div><div><span>Next period</span><strong>${formatDate(weekly.nextStart, {year:false})} – ${formatDate(weekly.nextEnd)}</strong></div></div>
    </div>
    ${state.loading ? loadingMarkup() : state.error ? errorMarkup(state.error) : state.data ? stockContent(state, weekly, monthly) : emptyMarkup()}
  </section>`;
}

function stockContent(state, weekly, monthly) {
  return `<div class="stock-toolbar">
      <div class="sheet-tabs">${STOCK_TABS.map((tab) => `<button class="${state.activeTab === tab ? 'active' : ''}" data-stock-tab="${tab}">${tab}</button>`).join('')}</div>
      ${state.activeTab !== 'Order Page' ? `<label class="search-box">${icon('search',17)}<input id="stock-search" value="${escapeHtml(state.search)}" placeholder="Search item"></label>` : ''}
    </div>
    ${state.activeTab === 'Order Page' ? orderPage(state) : sectionPage(state, weekly, monthly)}
    ${state.submitResult ? submitSuccess(state.submitResult) : ''}`;
}

function sectionPage(state, weekly, monthly) {
  const section = (state.data.sections || []).find((entry) => entry.sheetName === state.activeTab);
  if (!section) return `<div class="empty-state">Section not found.</div>`;
  const isMonthly = section.type === 'monthly-stationary';
  const filteredRows = section.rows.filter((row) => row.item.toLowerCase().includes(state.search.trim().toLowerCase()));
  const progress = completionProgress(state, isMonthly ? ['Stationary'] : ['Inventory','Untensil PG1','Utensil PG2']);
  return `<div class="section-meta">
      <div><span>${isMonthly ? 'Monthly period' : `Editable column · Week ${state.data.selectedWeek}`}</span><strong>${isMonthly ? monthly.rangeLabel : weekly.rangeLabel}</strong></div>
      <div class="progress-copy"><span>${progress.completed}/${progress.total} completed</span><div class="progress-track"><i style="width:${progress.total ? progress.completed/progress.total*100 : 0}%"></i></div></div>
    </div>
    ${section.type === 'weekly-inventory' ? inventoryTable(state, section, filteredRows) : section.type === 'weekly-utensil' ? utensilTable(state, section, filteredRows) : stationaryTable(state, section, filteredRows)}
    <div class="stock-submit-panel">
      <div class="form-grid two"><label>Counted by<input id="stock-counted-by" value="${escapeHtml(state.countedBy)}" placeholder="Staff name"></label><label>Session note<input id="stock-session-note" value="${escapeHtml(state.sessionNote)}" placeholder="Optional note"></label></div>
      <div class="submit-row"><div><strong>${isMonthly ? 'Submit monthly stationary' : 'Submit complete weekly count'}</strong><small>${isMonthly ? 'Writes Stationary only.' : 'Writes Inventory and both Utensil sheets together.'}</small></div><button class="button primary" id="submit-stock" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Submitting…' : 'Submit Stock Count'}</button></div>
    </div>`;
}

function inventoryTable(state, section, rows) {
  return `<div class="week-selector mobile-only">${[1,2,3,4,5].map((i)=>`<button class="${state.mobileWeek===i?'active':''}" data-mobile-week="${i}">W${i}</button>`).join('')}</div>
  <div class="sheet-table-wrap"><table class="sheet-table stock-grid inventory-grid"><thead><tr><th class="item-col">ITEM</th>${section.rows[0]?.weeks.map((week)=>weekHeader(week, state.data.selectedWeek, state.mobileWeek, state.data.monthKey)).join('') || ''}<th class="minimum-col">MIN</th></tr></thead><tbody>${rows.map((row)=>`<tr><th class="item-col"><strong>${escapeHtml(row.item)}</strong>${row.hasSecondaryQuantity ? `<small>1 ${escapeHtml(row.weeks[0]?.primaryUnit)} = ${row.conversion} ${escapeHtml(row.weeks[0]?.secondaryUnit)}</small>`:''}</th>${row.weeks.map((week)=>inventoryWeekCell(state,row,week)).join('')}<td class="minimum-col">${row.minimum}</td></tr>`).join('')}</tbody></table></div>`;
}

function inventoryWeekCell(state,row,week) {
  const value = state.values.Inventory?.[row.row] || {};
  const editable = week.index === state.data.selectedWeek;
  const status = editable ? inventoryStatus(row, value) : week.status;
  return `<td class="week-cell ${editable?'current-week':''} ${state.mobileWeek===week.index?'mobile-current':''}"><div class="quantity-line">${editable ? `<input aria-label="${escapeHtml(row.item)} ${escapeHtml(week.primaryUnit)}" type="number" min="0" step="0.01" data-stock-sheet="Inventory" data-stock-row="${row.row}" data-stock-field="primary" value="${value.primary}"><span>${escapeHtml(week.primaryUnit)}</span>${row.hasSecondaryQuantity?`<input type="number" min="0" step="0.01" data-stock-sheet="Inventory" data-stock-row="${row.row}" data-stock-field="secondary" value="${value.secondary}"><span>${escapeHtml(week.secondaryUnit)}</span>`:''}` : `<strong>${displayNumber(week.primaryValue)}</strong><span>${escapeHtml(week.primaryUnit)}</span>${row.hasSecondaryQuantity?`<strong>${displayNumber(week.secondaryValue)}</strong><span>${escapeHtml(week.secondaryUnit)}</span>`:''}`}</div><span class="row-status ${statusClass(status)}">${status || 'OK'}</span></td>`;
}

function utensilTable(state, section, rows) {
  return `<div class="week-selector mobile-only">${[1,2,3,4,5].map((i)=>`<button class="${state.mobileWeek===i?'active':''}" data-mobile-week="${i}">W${i}</button>`).join('')}</div><div class="sheet-table-wrap"><table class="sheet-table stock-grid"><thead><tr><th class="item-col">ITEM</th>${section.rows[0]?.weeks.map((week)=>weekHeader(week,state.data.selectedWeek,state.mobileWeek,state.data.monthKey)).join('')||''}<th class="minimum-col">MIN</th></tr></thead><tbody>${rows.map((row)=>`<tr><th class="item-col"><strong>${escapeHtml(row.item)}</strong></th>${row.weeks.map((week)=>{const value=state.values[section.sheetName]?.[row.row]?.quantity; const editable=week.index===state.data.selectedWeek; const status=editable?utensilStatus(section.sheetName,row,Number(value||0)):week.status; return `<td class="week-cell ${editable?'current-week':''} ${state.mobileWeek===week.index?'mobile-current':''}"><div class="quantity-line">${editable?`<input type="number" min="0" step="0.01" data-stock-sheet="${section.sheetName}" data-stock-row="${row.row}" data-stock-field="quantity" value="${value}"><span>${escapeHtml(week.unit)}</span>`:`<strong>${displayNumber(week.quantityValue)}</strong><span>${escapeHtml(week.unit)}</span>`}</div><span class="row-status ${statusClass(status)}">${status||'OK'}</span></td>`}).join('')}<td class="minimum-col">${row.minimum}</td></tr>`).join('')}</tbody></table></div>`;
}

function stationaryTable(state, section, rows) {
  return `<div class="sheet-table-wrap stationary-wrap"><table class="sheet-table stationary-table"><thead><tr><th class="item-col">ITEM</th><th>QUANTITY</th><th>UNIT</th><th>STATUS</th><th>MIN</th></tr></thead><tbody>${rows.map((row)=>{const value=state.values.Stationary?.[row.row]?.quantity; const status=Number(value||0)<=row.minimum?'Order':''; return `<tr><th class="item-col"><strong>${escapeHtml(row.item)}</strong></th><td><input type="number" min="0" step="0.01" data-stock-sheet="Stationary" data-stock-row="${row.row}" data-stock-field="quantity" value="${value}"></td><td>${escapeHtml(row.unit)}</td><td><span class="row-status ${statusClass(status)}">${status||'OK'}</span></td><td>${row.minimum}</td></tr>`}).join('')}</tbody></table></div>`;
}

function weekHeader(week, selected, mobileWeek, monthKey) {
  const period = week.periodLabel || week.rangeLabel || weekPeriodForIndex(monthKey || week.date || todayIso(), week.index);
  return `<th class="week-head ${week.index===selected?'current-week':''} ${mobileWeek===week.index?'mobile-current':''}"><span>WEEK ${week.index}</span><small>${period}</small>${week.date?`<em>Saved ${formatDate(week.date,{year:false})}</em>`:''}</th>`;
}

function weekPeriodForIndex(monthKeyOrDate,index){
  const monthKey = String(monthKeyOrDate || todayIso()).slice(0,7);
  const monthStart = new Date(`${monthKey}-01T00:00:00`);
  const gridStart = startOfCalendarWeek(monthStart);
  const start = addDays(gridStart, (Number(index || 1) - 1) * 7);
  const end = addDays(start, 6);
  return `${formatDate(start,{year:false})}–${formatDate(end,{year:false})}`;
}

function startOfCalendarWeek(date){const result=new Date(date.getFullYear(),date.getMonth(),date.getDate()); const offset=(result.getDay()+6)%7; result.setDate(result.getDate()-offset); return result;}
function addDays(date,days){const result=new Date(date.getFullYear(),date.getMonth(),date.getDate()); result.setTime(result.getTime()+Number(days||0)*MS_PER_DAY); return result;}

function orderPage(state) {
  return liveOrderPageV1162(state);
}

function liveOrderPageV1162(state) {
  const weeks = [1,2,3,4,5].map((weekIndex) => ({
    weekIndex,
    inventory: orderGroupForWeek(state, ['Inventory'], weekIndex),
    utensils: orderGroupForWeek(state, ['Untensil PG1', 'Utensil PG2'], weekIndex)
  }));
  const stationary = stationaryOrderGroup(state);
  return `<div class="sheet-table-wrap order-wrap live-order-wrap"><table class="sheet-table order-table live-order-table"><tbody>
    ${weeks.map((week) => `<tr class="order-week-row"><th colspan="3">Week ${week.weekIndex}</th></tr>
      <tr><th>Inventory Order List</th><td class="order-date-cell">${orderGroupDateText(week.inventory)}</td><td>${orderGroupItemsText(week.inventory)}</td></tr>
      <tr><th>Utensil Order List</th><td class="order-date-cell">${orderGroupDateText(week.utensils)}</td><td>${orderGroupItemsText(week.utensils)}</td></tr>`).join('')}
    <tr class="order-week-row stationary-order-row"><th colspan="3">Stationary Stock (MONTHLY)</th></tr>
    <tr><th>Stationary Order List</th><td class="order-date-cell">${stationary.dateText}</td><td>${orderGroupItemsText(stationary)}</td></tr>
  </tbody></table></div>`;
}

function orderGroupForWeek(state, sheetNames, weekIndex) {
  const items = [];
  const dates = [];
  let counted = false;
  for (const sheetName of sheetNames) {
    const section = (state.data?.sections || []).find((entry) => entry.sheetName === sheetName);
    if (!section) continue;
    const date = sheetWeekDate(state, section, weekIndex);
    const dirty = Boolean(state.dirtyColumns?.[sheetName]?.[weekIndex]);
    const sectionCounted = Boolean(date || dirty);
    if (!sectionCounted) continue;
    counted = true;
    if (date) dates.push({ sheetName, date });
    for (const row of section.rows || []) {
      const week = (row.weeks || []).find((entry) => Number(entry.index) === Number(weekIndex));
      const liveValue = rowWeekValue(state, section, row, weekIndex);
      const status = liveValue
        ? section.type === 'weekly-inventory'
          ? inventoryStatus(row, liveValue)
          : utensilStatus(sheetName, row, Number(liveValue.quantity || 0))
        : String(week?.status || '');
      if (status === 'Order') items.push(row.item);
    }
  }
  return { items: [...new Set(items)], dates, counted };
}

function stationaryOrderGroup(state) {
  const section = (state.data?.sections || []).find((entry) => entry.sheetName === 'Stationary');
  if (!section) return { items: [], counted: false, dateText: 'Not counted' };
  const date = String(state.stationaryDate || section.countDate || section.date || '').trim();
  const hasSavedValues = (section.rows || []).some((row) => row.quantityValue !== '' && row.quantityValue !== null && row.quantityValue !== undefined);
  const hasLiveValues = (section.rows || []).some((row) => {
    const value = state.values?.Stationary?.[row.row]?.quantity;
    return value !== '' && value !== null && value !== undefined;
  });
  const counted = Boolean(date || hasSavedValues || hasLiveValues);
  const items = counted ? (section.rows || []).filter((row) => {
    const live = state.values?.Stationary?.[row.row]?.quantity;
    const quantity = live !== '' && live !== null && live !== undefined ? Number(live) : Number(row.quantityValue || 0);
    return quantity <= Number(row.minimum || 0);
  }).map((row) => row.item) : [];
  return { items, counted, dateText: date ? `Counted ${escapeHtml(formatDate(date))}` : counted ? 'Counted' : 'Not counted' };
}

function rowWeekValue(state, section, row, weekIndex) {
  const rowValues = state.values?.[section.sheetName]?.[row.row];
  if (!rowValues || typeof rowValues !== 'object') return null;
  const nested = rowValues[weekIndex];
  if (nested && typeof nested === 'object') return nested;
  if (Number(weekIndex) === Number(state.data?.selectedWeek)) return rowValues;
  return null;
}

function sheetWeekDate(state, section, weekIndex) {
  const stateDate = state.sheetWeekDates?.[section.sheetName]?.[weekIndex];
  if (stateDate) return stateDate;
  const firstRow = section.rows?.[0];
  const week = (firstRow?.weeks || []).find((entry) => Number(entry.index) === Number(weekIndex));
  return String(week?.date || '').trim();
}

function orderGroupDateText(group) {
  if (!group.counted) return '<span class="order-none">Not counted</span>';
  if (!group.dates.length) return 'Counted';
  const uniqueDates = [...new Set(group.dates.map((entry) => entry.date))];
  if (uniqueDates.length === 1) return `Counted ${escapeHtml(formatDate(uniqueDates[0]))}`;
  return group.dates.map((entry) => `${escapeHtml(shortSectionName(entry.sheetName))} ${escapeHtml(formatDate(entry.date))}`).join('<br>');
}

function orderGroupItemsText(group) {
  if (!group.counted) return '<span class="order-none">Not counted</span>';
  return group.items.length ? group.items.map(escapeHtml).join(', ') : '<span class="order-none">No order</span>';
}

function shortSectionName(name) {
  if (name === 'Untensil PG1') return 'PG1';
  if (name === 'Utensil PG2') return 'PG2';
  return name;
}

function submitSuccess(result) {
  return `<article class="submit-success stock-success"><div class="success-icon">${icon('check')}</div><div><span>Stock count saved</span><strong>${escapeHtml(result.outlet)} · Week ${result.weekIndex}</strong><small>${result.orderCount} item(s) require attention · ${escapeHtml(result.spreadsheetName)}</small></div><div class="success-actions"><a class="button secondary" href="${result.spreadsheetUrl}" target="_blank" rel="noopener">Open Monthly Sheet ${icon('external',16)}</a><button class="button whatsapp" id="stock-whatsapp">${icon('whatsapp',18)} Send to WhatsApp</button></div></article>`;
}

export function buildStockPayload(state) {
  const isMonthly = state.activeTab === 'Stationary';
  const sections = {};
  const names = isMonthly ? ['Stationary'] : ['Inventory','Untensil PG1','Utensil PG2'];
  for (const name of names) {
    const section = state.data.sections.find((entry)=>entry.sheetName===name);
    sections[name] = section.rows.map((row)=>({ row: row.row, ...(section.type==='weekly-inventory'?{primary:state.values[name][row.row].primary, ...(row.hasSecondaryQuantity?{secondary:state.values[name][row.row].secondary}:{})}:{quantity:state.values[name][row.row].quantity}) }));
  }
  return { action:'submitStockCount', submissionId:createId('stock'), businessDate:state.businessDate, countedBy:state.countedBy, sessionNote:state.sessionNote, selectedWeek: state.data?.selectedWeek || weekPeriod(state.businessDate).index, sections };
}

export function validateStock(state) {
  if (!state.countedBy.trim()) return 'Enter the staff name before submitting.';
  const names = state.activeTab === 'Stationary' ? ['Stationary'] : ['Inventory','Untensil PG1','Utensil PG2'];
  for (const name of names) {
    const section = state.data.sections.find((entry)=>entry.sheetName===name);
    for (const row of section.rows) {
      const value = state.values[name][row.row];
      const main = section.type==='weekly-inventory'?value.primary:value.quantity;
      if (main===''||main===null||Number(main)<0) return `Complete ${name}: ${row.item}`;
      if (row.hasSecondaryQuantity && (value.secondary===''||value.secondary===null||Number(value.secondary)<0)) return `Complete ${name}: ${row.item} secondary unit`;
    }
  }
  return '';
}

function completionProgress(state,names){let total=0,completed=0; for(const name of names){const section=state.data.sections.find((entry)=>entry.sheetName===name); if(!section)continue; for(const row of section.rows){total++; const value=state.values[name]?.[row.row]||{}; const main=section.type==='weekly-inventory'?value.primary:value.quantity; const secondaryOk=!row.hasSecondaryQuantity||value.secondary!==''; if(main!==''&&secondaryOk)completed++;}} return{total,completed};}
function inventoryStatus(row,value){const p=Number(value.primary||0),s=Number(value.secondary||0); return p*row.conversion+s<=row.minimum?'Order':'';}
function utensilStatus(name,row,quantity){if(name==='Utensil PG2'&&row.row===9)return quantity<=0?'No More Use':'';if(name==='Utensil PG2'&&row.row===36)return quantity<=4?'Spare Item':'';return quantity<=row.minimum?'Order':'';}
function statusClass(status){return status?'attention':'ok';}
function displayNumber(value){return value===''?'—':value;}
function loadingMarkup(){return `<div class="loading-state"><span class="spinner"></span><strong>Opening monthly stock file…</strong><small>The GAS will create this month automatically when needed.</small></div>`;}
function errorMarkup(error){return `<div class="error-state">${icon('alert')}<div><strong>Unable to load Stock Count</strong><span>${escapeHtml(error)}</span></div><button class="button secondary" id="retry-stock">Retry</button></div>`;}
function emptyMarkup(){return `<div class="empty-state"><strong>Stock Count is ready to connect.</strong><span>Save the GAS URL and secret in Dev Settings.</span></div>`;}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
