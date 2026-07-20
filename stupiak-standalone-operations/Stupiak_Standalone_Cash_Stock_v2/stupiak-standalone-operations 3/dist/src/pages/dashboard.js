import { formatDate, parseIsoDate, todayIso } from '../core/dates.js';
import { icon } from '../ui/icons.js';

export function createDashboardState() {
  const today = todayIso();
  return {
    service: 'stock',
    dateFrom: `${today.slice(0, 7)}-01`,
    dateTo: today,
    loading: false,
    error: '',
    data: null,
    itemQuery: '',
    category: 'all',
    status: 'all',
    phase: 'all',
    stockView: 'latest'
  };
}

export function dashboardPayload(state, outlet) {
  return {
    action: state.service === 'cash' ? 'getStandaloneCashDashboard' : 'getStockDashboard',
    dateFrom: state.dateFrom,
    dateTo: state.dateTo,
    outlet
  };
}

export function dashboardPage(context, state) {
  return `<section class="page dashboard-page">
    <div class="page-heading dashboard-heading">
      <div><span class="eyebrow">OPERATIONS DASHBOARD</span><h1>${escapeHtml(context.outlet || state.data?.outlet || 'Outlet overview')}</h1><p>Monthly overview and custom date-range history for Stock Count and Cash Count.</p></div>
      <button class="button secondary" id="refresh-dashboard">${icon('refresh', 17)} Refresh</button>
    </div>
    ${dashboardFilters(state)}
    ${state.loading ? loadingMarkup() : state.error ? errorMarkup(state.error) : state.data ? dashboardContent(state) : emptyMarkup()}
  </section>`;
}

function dashboardFilters(state) {
  return `<div class="dashboard-filter-panel">
    <div class="dashboard-service-tabs segmented">
      <button class="${state.service === 'stock' ? 'active' : ''}" data-dashboard-service="stock">${icon('stock',17)} Stock</button>
      <button class="${state.service === 'cash' ? 'active' : ''}" data-dashboard-service="cash">${icon('cash',17)} Cash</button>
    </div>
    <div class="dashboard-date-range">
      <label>From<input id="dashboard-date-from" type="date" value="${state.dateFrom}"></label>
      <span class="range-arrow">→</span>
      <label>To<input id="dashboard-date-to" type="date" value="${state.dateTo}"></label>
      <button class="button primary" id="apply-dashboard-range">Apply</button>
    </div>
    <div class="quick-ranges">
      <button data-dashboard-range="month">This month</button>
      <button data-dashboard-range="3months">Last 3 months</button>
      <button data-dashboard-range="ytd">Year to date</button>
    </div>
  </div>`;
}

function dashboardContent(state) {
  return state.service === 'cash' ? cashDashboard(state) : stockDashboard(state);
}

function stockDashboard(state) {
  const data = state.data || {};
  const summary = data.summary || {};
  const latestItems = filterLatestItems(data.latestItems || [], state);
  const historyItems = filterHistoryItems(data.items || [], state);
  const rows = state.stockView === 'history' ? historyItems : latestItems;
  return `<div class="dashboard-stack">
    <div class="metric-grid">
      ${metricCard('Monthly files', summary.monthlyFiles || 0, `${summary.monthsInRange || 0} month(s) in range`, 'folder')}
      ${metricCard('Count sessions', summary.sessionCount || 0, `${summary.submittedDays || 0} submitted day(s)`, 'calendar')}
      ${metricCard('Items tracked', summary.uniqueItems || 0, `${summary.itemRecordCount || 0} count records`, 'stock')}
      ${metricCard('Need attention', summary.attentionItemCount || 0, 'Latest quantity is at/below minimum', 'alert', summary.attentionItemCount ? 'warning' : 'good')}
    </div>
    ${monthlyActivity(data.months || [], 'stock')}
    <div class="dashboard-two-column">
      ${monthCards(data.months || [], 'stock')}
      ${stockSessionPanel(data.sessions || [])}
    </div>
    <div class="dashboard-data-panel">
      <div class="data-panel-head">
        <div><span class="eyebrow">STOCK DETAIL</span><h2>${state.stockView === 'history' ? 'Count history' : 'Latest quantity by item'}</h2></div>
        <div class="segmented compact"><button class="${state.stockView === 'latest' ? 'active' : ''}" data-stock-dashboard-view="latest">Latest</button><button class="${state.stockView === 'history' ? 'active' : ''}" data-stock-dashboard-view="history">All history</button></div>
      </div>
      <div class="detail-filters">
        <label class="search-box dashboard-search">${icon('search',16)}<input id="dashboard-item-search" value="${escapeHtml(state.itemQuery)}" placeholder="Search stock item"></label>
        <select id="dashboard-category"><option value="all">All categories</option>${(data.categories || []).map((category)=>`<option value="${escapeHtml(category)}" ${state.category === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}</select>
        <select id="dashboard-status"><option value="all">All statuses</option><option value="attention" ${state.status === 'attention' ? 'selected' : ''}>Need attention</option><option value="ok" ${state.status === 'ok' ? 'selected' : ''}>OK</option></select>
      </div>
      ${state.stockView === 'history' ? stockHistoryTable(rows) : latestStockTable(rows)}
    </div>
  </div>`;
}

function cashDashboard(state) {
  const data = state.data || {};
  const summary = data.summary || {};
  const events = (data.events || []).filter((event)=>state.phase === 'all' || event.phase === state.phase);
  return `<div class="dashboard-stack">
    <div class="metric-grid">
      ${metricCard('Recorded days', summary.dayCount || 0, `${summary.completeDays || 0} complete opening + closing`, 'calendar')}
      ${metricCard('Closing cash', money(summary.closingTotal || 0), `${summary.closingCount || 0} closing record(s)`, 'cash')}
      ${metricCard('Handovers', summary.handoverCount || 0, `${money(summary.handoverVariance || 0)} net variance`, 'swap', Math.abs(Number(summary.handoverVariance || 0)) > 0.009 ? 'warning' : 'good')}
      ${metricCard('Missing close', summary.missingClosingDays || 0, 'Days with activity but no closing', 'alert', summary.missingClosingDays ? 'warning' : 'good')}
    </div>
    ${monthlyActivity(data.months || [], 'cash')}
    <div class="dashboard-two-column">
      ${monthCards(data.months || [], 'cash')}
      ${cashDailyPanel(data.days || [])}
    </div>
    <div class="dashboard-data-panel">
      <div class="data-panel-head"><div><span class="eyebrow">CASH DETAIL</span><h2>Opening, handover and closing history</h2></div><select id="dashboard-phase"><option value="all">All phases</option><option value="opening" ${state.phase === 'opening' ? 'selected' : ''}>Opening</option><option value="handover" ${state.phase === 'handover' ? 'selected' : ''}>Handover</option><option value="closing" ${state.phase === 'closing' ? 'selected' : ''}>Closing</option></select></div>
      ${cashEventTable(events)}
    </div>
  </div>`;
}

function metricCard(label, value, note, iconName, tone = '') {
  return `<article class="metric-card ${tone}"><div class="metric-icon">${icon(iconName,20)}</div><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
}

function monthlyActivity(months, type) {
  const existing = months.filter((month)=>month.exists !== false);
  const max = Math.max(1, ...existing.map((month)=>type === 'cash' ? Number(month.eventCount || 0) : Number(month.sessionCount || 0)));
  return `<section class="activity-panel"><div class="data-panel-head"><div><span class="eyebrow">MONTHLY OVERVIEW</span><h2>${type === 'cash' ? 'Cash activity by month' : 'Stock count activity by month'}</h2></div><small>${months.length} month(s)</small></div><div class="activity-bars">${months.map((month)=>{const value=type === 'cash' ? Number(month.eventCount || 0) : Number(month.sessionCount || 0);const secondary=type === 'cash' ? Number(month.closingCount || 0) : Number(month.attentionCount || 0);return `<div class="activity-column ${month.exists === false ? 'missing' : ''}" title="${escapeHtml(month.monthKey)}"><div class="bar-value">${value}</div><div class="bar-track"><i style="height:${Math.max(value ? 8 : 0, value/max*100)}%"></i><b style="height:${Math.min(100, secondary/max*100)}%"></b></div><span>${monthLabelShort(month.monthKey)}</span></div>`;}).join('')}</div><div class="chart-legend"><span><i></i>${type === 'cash' ? 'Events' : 'Sessions'}</span><span><i class="secondary"></i>${type === 'cash' ? 'Closing records' : 'Attention records'}</span></div></section>`;
}

function monthCards(months, type) {
  return `<section class="month-panel"><div class="data-panel-head"><div><span class="eyebrow">MONTH FILES</span><h2>Every month</h2></div></div><div class="month-card-list">${months.map((month)=>`<article class="month-summary-card ${month.exists === false ? 'missing' : ''}"><div><span>${monthLabel(month.monthKey)}</span><strong>${month.exists === false ? 'No file yet' : type === 'cash' ? `${month.eventCount || 0} events` : `${month.sessionCount || 0} sessions`}</strong><small>${month.exists === false ? 'Created automatically when needed' : type === 'cash' ? `${month.dayCount || 0} recorded days · ${money(month.closingTotal || 0)} closing` : `${month.itemRecordCount || 0} item records · ${month.attentionCount || 0} attention`}</small></div>${month.spreadsheetUrl ? `<a href="${escapeHtml(month.spreadsheetUrl)}" target="_blank" rel="noopener" title="Open file">${icon('external',17)}</a>` : ''}</article>`).join('')}</div></section>`;
}

function stockSessionPanel(sessions) {
  const rows = sessions.slice().sort((a,b)=>String(b.businessDate).localeCompare(String(a.businessDate))).slice(0,12);
  return `<section class="session-panel"><div class="data-panel-head"><div><span class="eyebrow">SUBMISSIONS</span><h2>Recent stock sessions</h2></div><small>${sessions.length} total</small></div><div class="timeline-list">${rows.length ? rows.map((row)=>`<article><span class="timeline-dot"></span><div><strong>${formatDate(row.businessDate)} · Week ${row.weekIndex || '—'}</strong><small>${escapeHtml(row.countedBy || 'Legacy record')} · ${row.itemCount || row.changedCellCount || 0} item(s)</small></div><span class="timeline-count ${Number(row.orderCount || 0) ? 'warning' : ''}">${row.orderCount || 0} attention</span></article>`).join('') : '<div class="mini-empty">No stock submissions in this range.</div>'}</div></section>`;
}

function cashDailyPanel(days) {
  const rows = days.slice().sort((a,b)=>String(b.businessDate).localeCompare(String(a.businessDate))).slice(0,12);
  return `<section class="session-panel"><div class="data-panel-head"><div><span class="eyebrow">DAILY CONTROL</span><h2>Recent cash days</h2></div><small>${days.length} total</small></div><div class="timeline-list cash-days">${rows.length ? rows.map((row)=>`<article><span class="timeline-dot ${row.complete ? 'complete' : 'warning'}"></span><div><strong>${formatDate(row.businessDate)}</strong><small>Open ${displayMoney(row.openingTotal)} · Close ${displayMoney(row.closingTotal)} · ${row.handoverCount || 0} handover</small></div><span class="timeline-count ${Math.abs(Number(row.handoverVariance || 0)) > 0.009 ? 'warning' : ''}">${money(row.handoverVariance || 0)}</span></article>`).join('') : '<div class="mini-empty">No cash records in this range.</div>'}</div></section>`;
}

function latestStockTable(rows) {
  return `<div class="dashboard-table-wrap"><table class="dashboard-table"><thead><tr><th>Item</th><th>Category</th><th>Latest count</th><th>Quantity</th><th>Minimum</th><th>Change</th><th>Status</th></tr></thead><tbody>${rows.length ? rows.map((row)=>`<tr><td><strong>${escapeHtml(row.item)}</strong><small>${escapeHtml(row.primaryUnit || row.unit || '')}</small></td><td>${escapeHtml(row.category)}</td><td>${formatDate(row.businessDate)}<small>${escapeHtml(row.countedBy || '')}</small></td><td><strong>${escapeHtml(row.quantityText || number(row.baseQty))}</strong></td><td>${number(row.minimum)}</td><td class="delta ${Number(row.delta || 0) < 0 ? 'down' : Number(row.delta || 0) > 0 ? 'up' : ''}">${row.previousBaseQty === null || row.previousBaseQty === undefined ? '—' : signed(row.delta)}</td><td><span class="row-status ${attention(row.status) ? 'attention' : 'ok'}">${escapeHtml(row.status || 'OK')}</span></td></tr>`).join('') : '<tr><td colspan="7"><div class="mini-empty">No matching stock items.</div></td></tr>'}</tbody></table></div>`;
}

function stockHistoryTable(rows) {
  return `<div class="dashboard-table-wrap"><table class="dashboard-table"><thead><tr><th>Date</th><th>Item</th><th>Category</th><th>Week</th><th>Quantity</th><th>Minimum</th><th>Status</th><th>Counted by</th></tr></thead><tbody>${rows.length ? rows.slice(0,1000).map((row)=>`<tr><td>${formatDate(row.businessDate)}</td><td><strong>${escapeHtml(row.item)}</strong></td><td>${escapeHtml(row.category)}</td><td>${row.weekIndex ? `W${row.weekIndex}` : 'Monthly'}</td><td>${escapeHtml(row.quantityText || number(row.baseQty))}</td><td>${number(row.minimum)}</td><td><span class="row-status ${attention(row.status) ? 'attention' : 'ok'}">${escapeHtml(row.status || 'OK')}</span></td><td>${escapeHtml(row.countedBy || 'Legacy sheet')}</td></tr>`).join('') : '<tr><td colspan="8"><div class="mini-empty">No matching stock history.</div></td></tr>'}</tbody></table></div>`;
}

function cashEventTable(events) {
  return `<div class="dashboard-table-wrap"><table class="dashboard-table"><thead><tr><th>Date</th><th>Phase</th><th>Sequence</th><th>Staff</th><th>Amount</th><th>Variance</th><th>Remark</th><th>File</th></tr></thead><tbody>${events.length ? events.slice(0,1000).map((row)=>`<tr><td>${formatDate(row.businessDate)}<small>${timeText(row.savedAt)}</small></td><td><span class="phase-badge ${escapeHtml(row.phase)}">${escapeHtml(row.phase)}</span></td><td>${row.sequence || '—'}</td><td>${escapeHtml(row.phase === 'handover' ? `${row.fromStaff || '—'} → ${row.toStaff || '—'}` : row.countedBy || '—')}</td><td>${row.phase === 'handover' ? `${money(row.outgoingTotal || 0)} → ${money(row.incomingTotal || 0)}` : money(row.countedTotal || 0)}</td><td class="delta ${Number(row.variance || 0) < 0 ? 'down' : Number(row.variance || 0) > 0 ? 'up' : ''}">${row.phase === 'handover' ? signed(row.variance || 0, true) : '—'}</td><td>${escapeHtml(row.remark || '')}</td><td>${row.spreadsheetUrl ? `<a href="${escapeHtml(row.spreadsheetUrl)}" target="_blank" rel="noopener">Open</a>` : '—'}</td></tr>`).join('') : '<tr><td colspan="8"><div class="mini-empty">No matching cash events.</div></td></tr>'}</tbody></table></div>`;
}

function filterLatestItems(rows, state) {
  const query = state.itemQuery.trim().toLowerCase();
  return rows.filter((row)=>{
    if (query && !String(row.item || '').toLowerCase().includes(query)) return false;
    if (state.category !== 'all' && row.category !== state.category) return false;
    if (state.status === 'attention' && !attention(row.status)) return false;
    if (state.status === 'ok' && attention(row.status)) return false;
    return true;
  });
}

function filterHistoryItems(rows, state) {
  const query = state.itemQuery.trim().toLowerCase();
  return rows.filter((row)=>{
    if (query && !String(row.item || '').toLowerCase().includes(query)) return false;
    if (state.category !== 'all' && row.category !== state.category) return false;
    if (state.status === 'attention' && !attention(row.status)) return false;
    if (state.status === 'ok' && attention(row.status)) return false;
    return true;
  }).sort((a,b)=>String(b.businessDate).localeCompare(String(a.businessDate)) || String(a.category).localeCompare(String(b.category)) || String(a.item).localeCompare(String(b.item)));
}

function loadingMarkup(){return `<div class="loading-state"><span class="spinner"></span><strong>Building dashboard…</strong><small>Reading the monthly files inside the selected range.</small></div>`;}
function errorMarkup(error){return `<div class="error-state">${icon('alert')}<div><strong>Unable to load dashboard</strong><span>${escapeHtml(error)}</span></div><button class="button secondary" id="retry-dashboard">Retry</button></div>`;}
function emptyMarkup(){return `<div class="empty-state"><strong>Dashboard is ready.</strong><span>Select a date range and press Apply.</span></div>`;}
function attention(status){return Boolean(status && String(status).toLowerCase() !== 'ok');}
function money(value){return `RM ${Number(value || 0).toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2})}`;}
function displayMoney(value){return value === '' || value === null || value === undefined ? '—' : money(value);}
function number(value){return Number(value || 0).toLocaleString('en-MY',{maximumFractionDigits:4});}
function signed(value, currency=false){const n=Number(value||0);const text=`${n>0?'+':''}${n.toLocaleString('en-MY',{minimumFractionDigits:currency?2:0,maximumFractionDigits:currency?2:4})}`;return currency?`RM ${text}`:text;}
function monthLabel(key){const date=parseIsoDate(`${key}-01`);return new Intl.DateTimeFormat('en-MY',{month:'long',year:'numeric'}).format(date);}
function monthLabelShort(key){const date=parseIsoDate(`${key}-01`);return new Intl.DateTimeFormat('en-MY',{month:'short'}).format(date);}
function timeText(value){if(!value)return '';const date=new Date(value);return Number.isNaN(date.getTime())?'':new Intl.DateTimeFormat('en-MY',{hour:'2-digit',minute:'2-digit'}).format(date);}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
