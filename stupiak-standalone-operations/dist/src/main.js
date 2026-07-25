import { APP_VERSION } from './config.js?v=1.16.5';
import { callOperations, getSystemStatus } from './api/operations-client.js';
import { loadSettings } from './core/storage.js';
import { todayIso } from './core/dates.js';
import { homePage } from './pages/home.js';
import { cashPage, createCashState, initializeCashFromBootstrap, buildCashPayload, validateCash, cashTotal } from './pages/cash.js';
import { settingsPage } from './pages/settings.js';
import { stockPage, createStockState, initializeStockValues, buildStockPayload, validateStock, stockSaveReadiness } from './pages/stock.js?v=1.16.5';
import { dashboardPage, createDashboardState, dashboardPayload } from './pages/dashboard.js';
import { icon } from './ui/icons.js';
import { showToast } from './ui/toast.js';
import { parseStockSetupWorkbook, exportStockSetupWorkbook } from './core/stock-setup-excel.js?v=1.16.5';
import { importStockCountWorkbook } from './core/stock-count-excel.js?v=1.16.5';
import { exportStockPdf, exportStockExcel } from './core/stock-local-export.js?v=1.16.5';
import { readStockBootstrap, readLatestStockBootstrap, writeStockBootstrap, clearStockBootstrap, readStockDraft, saveStockDraft, applyStockDraft, clearStockDraft, readCashDraft, saveCashDraft, applyCashDraft, clearCashDraft, queueSubmission, queuedSubmissions, markSubmissionAttempt, removeQueuedSubmission } from './core/offline-workflow.js?v=1.16.5';

const app = document.querySelector('#app');
const state = {
  route: location.hash.replace('#/', '') || 'home',
  settings: loadSettings(),
  outletRef: readOutletRef(),
  outlet: '',
  systemStatus: null,
  stock: createStockState(),
  cash: createCashState(),
  dashboard: createDashboardState(),
  deferredPrompt: null
};

const activeSubmissionSyncs = new Set();
const recoveringStockSubmissions = new Set();
let stockExportInProgress = false;

function readOutletRef() {
  const params = new URLSearchParams(location.search);
  return String(params.get('outlet') || params.get('outletId') || params.get('site') || '').trim();
}

function cashCacheKey(outlet, businessDate) {
  return `stupiak.operations.cashBootstrap.v6:${String(outlet || 'missing')}:${String(businessDate || '')}`;
}

function readCashCache(outlet, businessDate) {
  if (!outlet) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(cashCacheKey(outlet, businessDate)) || 'null');
    return parsed?.data || null;
  } catch {
    return null;
  }
}

function writeCashCache(outlet, businessDate, data) {
  if (!outlet) return;
  try { localStorage.setItem(cashCacheKey(outlet, businessDate), JSON.stringify({ data, savedAt: Date.now() })); } catch {}
}

function clearCashCache(outlet, businessDate) {
  if (!outlet) return;
  try { localStorage.removeItem(cashCacheKey(outlet, businessDate)); } catch {}
}

function missingOutletMessage() {
  return 'Missing FeedMe Outlet ID. Open the outlet-specific Cash Count link from FeedMe Insights.';
}

function activeStockOutlet() {
  return state.outlet || 'RR-KCH';
}

function stockOfflineOutlet() {
  let remembered = '';
  try { remembered = localStorage.getItem(STOCK_OUTLET_ROUTE_STORAGE) || ''; } catch {}
  const route = state.outletRef || remembered || '';
  if (route) { try { localStorage.setItem(STOCK_OUTLET_ROUTE_STORAGE, route); } catch {} }
  return route || 'stock-default';
}

function cashOfflineOutlet() {
  return state.outletRef || state.outlet || 'cash-default';
}

const STOCK_OUTLET_ROUTE_STORAGE = 'stupiak.operations.stockOutletRoute.v1';
const STOCK_OUTLET_LABEL_PREFIX = 'stupiak.operations.stockOutletLabel.v1:';

function looksLikeOutletCode(value) {
  return /^[A-Z]{2,}(?:-[A-Z0-9]{2,})+$/.test(String(value || '').trim());
}

function isOpaqueOutlet(value) {
  return /^[a-f0-9]{20,}$/i.test(String(value || '').trim());
}

function rememberedStockOutlet(route) {
  const key = String(route || '').trim();
  if (!key) return '';
  try { return String(localStorage.getItem(STOCK_OUTLET_LABEL_PREFIX + key) || '').trim(); } catch { return ''; }
}

function rememberStockOutlet(route, label) {
  const key = String(route || '').trim();
  const next = String(label || '').trim();
  if (!key) return;
  try { localStorage.setItem(STOCK_OUTLET_ROUTE_STORAGE, key); } catch {}
  if (!next || next === key || isOpaqueOutlet(next)) return;
  const current = rememberedStockOutlet(key);
  if (current && looksLikeOutletCode(current) && !looksLikeOutletCode(next)) return;
  try { localStorage.setItem(STOCK_OUTLET_LABEL_PREFIX + key, next); } catch {}
}

function applyStockOutletIdentity(data, route) {
  const key = String(route || '').trim();
  const supplied = String(data?.outletCode || data?.outletName || data?.displayOutlet || '').trim();
  const backend = String(data?.outlet || '').trim();
  const backendLabel = backend && backend !== key && !isOpaqueOutlet(backend) ? backend : '';
  const label = supplied || rememberedStockOutlet(key) || backendLabel || key || 'Stock Count';
  if (data && typeof data === 'object') {
    data.outletId = key || data.outletId || '';
    data.outlet = label;
  }
  rememberStockOutlet(key, label);
  return label;
}

function cashShellForDate(outlet) {
  const previous = state.cash.data || {};
  return {
    ...previous,
    outlet: previous.outlet || state.outlet || outlet,
    events: [],
    summary: {},
    payments: (previous.payments || []).map((payment) => ({ ...payment, actual: '', remark: '' }))
  };
}

function blankStockValues() {
  const clearObject = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (value[key] && typeof value[key] === 'object') clearObject(value[key]);
      else value[key] = '';
    }
  };
  clearObject(state.stock.values || {});
  state.stock.weekDates = { 1: '', 2: '', 3: '', 4: '', 5: '' };
  state.stock.sheetWeekDates = { Inventory: { 1: '', 2: '', 3: '', 4: '', 5: '' }, 'Untensil PG1': { 1: '', 2: '', 3: '', 4: '', 5: '' }, 'Utensil PG2': { 1: '', 2: '', 3: '', 4: '', 5: '' } };
  state.stock.dirtyWeeks = {};
  state.stock.dirtyColumns = { Inventory: {}, 'Untensil PG1': {}, 'Utensil PG2': {} };
}

function isCurrentStockPayload(payload) {
  const payloadMonth = String(payload.monthKey || payload.businessDate || '').slice(0, 7);
  const currentMonth = String(state.stock.monthKey || state.stock.businessDate || '').slice(0, 7);
  return payloadMonth === currentMonth;
}

function isCurrentCashPayload(payload) {
  return payload.businessDate === state.cash.businessDate && String(payload.outlet || '') === String(state.outletRef || '');
}

function shell(content) {
  const nav = [['home', 'home', 'Home'], ['dashboard', 'dashboard', 'Dashboard'], ['cash', 'cash', 'Cash Count'], ['stock', 'stock', 'Stock Count'], ['settings', 'settings', 'Dev Settings']];
  return `<div class="app-shell no-top-panel">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">S</div><div><strong>Stupiak</strong><span>Operations</span></div></div>
      <nav>${nav.map(([route, ico, label]) => `<a class="${state.route === route ? 'active' : ''}" data-route="${route}" href="#/${route}">${icon(ico)}<span>${label}</span></a>`).join('')}</nav>
      <div class="sidebar-foot"><button id="install-app" class="install-button" ${state.deferredPrompt ? '' : 'hidden'}>Install App</button><span>v${APP_VERSION}</span></div>
    </aside>
    <main class="main">${content}</main>
    <nav class="bottom-nav">${nav.map(([route, ico, label]) => `<a class="${state.route === route ? 'active' : ''}" data-route="${route}" href="#/${route}">${icon(ico)}<span>${label.replace(' Count', '')}</span></a>`).join('')}</nav>
  </div>`;
}

function render() {
  const context = { settings: state.settings, outlet: state.outlet || state.outletRef, systemStatus: state.systemStatus };
  const page = state.route === 'dashboard'
    ? dashboardPage(context, state.dashboard)
    : state.route === 'cash'
      ? cashPage(context, state.cash)
      : state.route === 'stock'
        ? stockPage(context, state.stock)
        : state.route === 'settings'
          ? settingsPage(context)
          : homePage(context);
  app.innerHTML = shell(page);
  bindCommon();
  if (state.route === 'dashboard') bindDashboard();
  if (state.route === 'stock') bindStock();
  if (state.route === 'cash') bindCash();
  if (state.route === 'settings') bindSettings();
}

function navigate(route) {
  if (!route) return;
  if (state.route === 'stock' && route !== 'stock') {
    try { persistStockDraft(); } catch (_) {}
  }
  state.route = route;
  const targetHash = `#/${route}`;
  if (location.hash !== targetHash) location.hash = targetHash;
  try {
    render();
  } catch (error) {
    console.error('Route render failed:', route, error);
    showToast(error?.message || 'Unable to open this page.', 'error');
  }
  if (route === 'stock' && !state.stock.data && !state.stock.loading) loadStock();
  if (route === 'cash' && !state.cash.data && !state.cash.loading) loadCash();
  if (route === 'dashboard' && !state.dashboard.data && !state.dashboard.loading) loadDashboard();
}

function bindCommon() {
  document.querySelectorAll('[data-route]').forEach((element) => element.addEventListener('click', () => navigate(element.dataset.route)));
  document.querySelector('#install-app')?.addEventListener('click', async () => {
    if (!state.deferredPrompt) return;
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    render();
  });
}

async function loadStock(options = {}) {
  const forceFresh = Boolean(options.forceFresh || options.refresh);
  const preserveResult = Boolean(options.preserveResult);
  const preservedResult = preserveResult ? state.stock.submitResult : null;
  const outlet = stockOfflineOutlet();
  const requestedMonth = String(state.stock.businessDate || '').slice(0, 7);
  state.stock.loading = false;
  state.stock.error = '';
  state.stock.syncError = '';
  state.stock.syncing = true;
  if (!preserveResult) state.stock.submitResult = null;

  const exactCache = forceFresh ? null : readStockBootstrap(outlet, state.stock.businessDate);
  const cached = exactCache || state.stock.data || readLatestStockBootstrap(outlet);
  if (cached) {
    state.stock.data = cached;
    state.outlet = applyStockOutletIdentity(cached, outlet);
    initializeStockValues(state.stock, cached);
    state.stock.monthKey = requestedMonth;
    state.stock.businessDate = requestedMonth + '-01';
    const cachedMonth = String(cached.monthKey || '').slice(0, 7);
    state.stock.submitBlocked = Boolean(cachedMonth && cachedMonth !== requestedMonth && !exactCache);
    if (state.stock.submitBlocked) blankStockValues();
    applyStockDraft(state.stock, readStockDraft(outlet, state.stock.businessDate));
  } else {
    state.stock.submitBlocked = true;
  }
  if (preservedResult) state.stock.submitResult = preservedResult;
  if (cached && !forceFresh) state.stock.syncing = false;
  render();

  try {
    const data = await callOperations('stock', { action: 'getBootstrap', outlet, businessDate: state.stock.businessDate, refresh: forceFresh }, state.settings, { timeoutMs: forceFresh ? 60000 : 15000 });
    state.stock.data = data;
    state.outlet = applyStockOutletIdentity(data, outlet);
    writeStockBootstrap(outlet, state.stock.businessDate, data);
    initializeStockValues(state.stock, data);
    state.stock.monthKey = requestedMonth;
    state.stock.businessDate = requestedMonth + '-01';
    state.stock.sheetLoadedAt = Date.now();
    applyStockDraft(state.stock, readStockDraft(outlet, state.stock.businessDate));
    state.stock.submitBlocked = false;
    if (preservedResult) state.stock.submitResult = preservedResult;
  } catch (error) {
    state.stock.syncError = error.message;
    if (!state.stock.data) state.stock.error = 'The item list has not been cached on this device yet.';
  } finally {
    state.stock.syncing = false;
    state.stock.loading = false;
    render();
  }
}

async function loadCash(options = {}) {
  const preservedResult = options.preserveResult ? state.cash.result : null;
  const outlet = state.outletRef || '';
  const forceFresh = Boolean(options.forceFresh || options.refresh);
  state.cash.loading = false;
  state.cash.error = '';
  state.cash.syncError = '';
  state.cash.syncing = true;
  if (!options.preserveResult) state.cash.result = null;

  if (!outlet) {
    state.cash.syncing = false;
    state.cash.error = missingOutletMessage();
    state.cash.data = state.cash.data || cashShellForDate('');
    render();
    return;
  }

  const cached = forceFresh ? null : readCashCache(outlet, state.cash.businessDate);
  initializeCashFromBootstrap(state.cash, cached || cashShellForDate(outlet));
  applyCashDraft(state.cash, readCashDraft(outlet, state.cash.businessDate));
  state.outlet = state.cash.data?.outlet || outlet;
  rememberStockOutlet(outlet, state.outlet);
  if (preservedResult) state.cash.result = preservedResult;
  render();

  try {
    if (forceFresh) clearCashCache(outlet, state.cash.businessDate);
    const data = await callOperations('cash', { action: 'getStandaloneCashBootstrap', businessDate: state.cash.businessDate, outlet, refresh: forceFresh }, state.settings, { timeoutMs: 15000 });
    state.outlet = data.outlet || outlet;
    rememberStockOutlet(outlet, state.outlet);
    initializeCashFromBootstrap(state.cash, data);
    writeCashCache(outlet, state.cash.businessDate, data);
    applyCashDraft(state.cash, readCashDraft(outlet, state.cash.businessDate));
    if (preservedResult) state.cash.result = preservedResult;
  } catch (error) {
    state.cash.syncError = error.message;
  } finally {
    state.cash.syncing = false;
    state.cash.loading = false;
    render();
  }
}

async function loadDashboard() {
  state.dashboard.loading = true;
  state.dashboard.error = '';
  render();
  try {
    const dashboardOutlet = state.dashboard.service === 'cash'
      ? state.outletRef || ''
      : state.outletRef || state.outlet || state.systemStatus?.outletName || '';
    if (state.dashboard.service === 'cash' && !dashboardOutlet) throw new Error(missingOutletMessage());
    const data = await callOperations(state.dashboard.service, dashboardPayload(state.dashboard, dashboardOutlet), state.settings);
    state.dashboard.data = data;
    state.outlet = data.outlet || state.outlet;
  } catch (error) {
    state.dashboard.error = error.message;
    state.dashboard.data = null;
  } finally {
    state.dashboard.loading = false;
    render();
  }
}

function bindDashboard() {
  document.querySelector('#refresh-dashboard')?.addEventListener('click', loadDashboard);
  document.querySelector('#retry-dashboard')?.addEventListener('click', loadDashboard);
  document.querySelectorAll('[data-dashboard-service]').forEach((element) => element.addEventListener('click', () => {
    const service = element.dataset.dashboardService;
    if (state.dashboard.service === service) return;
    state.dashboard.service = service;
    state.dashboard.data = null;
    state.dashboard.error = '';
    state.dashboard.phase = 'all';
    loadDashboard();
  }));
  document.querySelector('#dashboard-date-from')?.addEventListener('change', (event) => { state.dashboard.dateFrom = event.target.value; });
  document.querySelector('#dashboard-date-to')?.addEventListener('change', (event) => { state.dashboard.dateTo = event.target.value; });
  document.querySelector('#apply-dashboard-range')?.addEventListener('click', () => {
    if (!state.dashboard.dateFrom || !state.dashboard.dateTo) return showToast('Select both dates.', 'error');
    if (state.dashboard.dateFrom > state.dashboard.dateTo) return showToast('From date cannot be after To date.', 'error');
    loadDashboard();
  });
  document.querySelectorAll('[data-dashboard-range]').forEach((element) => element.addEventListener('click', () => {
    setDashboardQuickRange(element.dataset.dashboardRange);
    loadDashboard();
  }));
  document.querySelector('#dashboard-item-search')?.addEventListener('input', (event) => {
    state.dashboard.itemQuery = event.target.value;
    renderPreservingFocus('dashboard-item-search', state.dashboard.itemQuery.length);
  });
  document.querySelector('#dashboard-category')?.addEventListener('change', (event) => { state.dashboard.category = event.target.value; render(); });
  document.querySelector('#dashboard-status')?.addEventListener('change', (event) => { state.dashboard.status = event.target.value; render(); });
  document.querySelector('#dashboard-phase')?.addEventListener('change', (event) => { state.dashboard.phase = event.target.value; render(); });
  document.querySelectorAll('[data-stock-dashboard-view]').forEach((element) => element.addEventListener('click', () => {
    state.dashboard.stockView = element.dataset.stockDashboardView;
    render();
  }));
}

function setDashboardQuickRange(range) {
  const today = todayIso();
  const now = new Date(`${today}T00:00:00`);
  state.dashboard.dateTo = today;
  if (range === 'month') state.dashboard.dateFrom = `${today.slice(0, 7)}-01`;
  else if (range === 'ytd') state.dashboard.dateFrom = `${today.slice(0, 4)}-01-01`;
  else {
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    state.dashboard.dateFrom = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
  }
}

let stockDraftLifecycleBound = false;
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
  mountStockMonthInline();
  bindStockMonthControl('#stock-month');
  bindStockMonthControl('#stock-month-inline');
  document.querySelector('#retry-stock')?.addEventListener('click', () => loadStock({ forceFresh: true }));

  document.querySelectorAll('[data-stock-tab]').forEach((element) => element.addEventListener('click', () => { state.stock.activeTab = element.dataset.stockTab; state.stock.submitResult = null; persistStockDraft(); render(); }));
  document.querySelectorAll('[data-mobile-week]').forEach((element) => element.addEventListener('click', () => { state.stock.mobileWeek = Number(element.dataset.mobileWeek); state.stock.lastEditedWeek = state.stock.mobileWeek; persistStockDraft(); render(); }));
  document.querySelector('#stock-search')?.addEventListener('input', (event) => { state.stock.search = event.target.value; persistStockDraft(); renderPreservingFocus('stock-search', state.stock.search.length); });
  document.querySelectorAll('[data-stock-sheet]').forEach((element) => element.addEventListener('input', (event) => {
    const { stockSheet, stockRow, stockWeek, stockField } = event.target.dataset; const rowNo = Number(stockRow);
    if (stockWeek) { const weekIndex = Number(stockWeek); if (!state.stock.values[stockSheet][rowNo][weekIndex]) state.stock.values[stockSheet][rowNo][weekIndex] = {}; state.stock.values[stockSheet][rowNo][weekIndex][stockField] = event.target.value; if (!state.stock.dirtyColumns[stockSheet]) state.stock.dirtyColumns[stockSheet] = {}; state.stock.dirtyColumns[stockSheet][weekIndex] = true; state.stock.lastEditedWeek = weekIndex; state.stock.mobileWeek = weekIndex; markWeekDirtyInDom(stockSheet, weekIndex); }
    else { state.stock.values[stockSheet][rowNo][stockField] = event.target.value; if (stockSheet === 'Stationary') state.stock.stationaryDirty = true; }
    updateLiveStockStatus(event.target); persistStockDraft(); refreshStockSaveReadiness();
  }));
  document.querySelectorAll('[data-stock-sheet]').forEach((element) => element.addEventListener('keydown', handleStockKeyboard));
  document.querySelectorAll('[data-week-date]').forEach((element) => element.addEventListener('change', (event) => { const weekIndex = Number(event.target.dataset.weekDate); const sheetName = event.target.dataset.weekSheet || state.stock.activeTab; if (!state.stock.sheetWeekDates[sheetName]) state.stock.sheetWeekDates[sheetName] = { 1: '', 2: '', 3: '', 4: '', 5: '' }; if (!state.stock.dirtyColumns[sheetName]) state.stock.dirtyColumns[sheetName] = {}; state.stock.sheetWeekDates[sheetName][weekIndex] = event.target.value; state.stock.dirtyColumns[sheetName][weekIndex] = true; state.stock.lastEditedWeek = weekIndex; state.stock.mobileWeek = weekIndex; persistStockDraft(); render(); }));
  document.querySelector('#stationary-count-date')?.addEventListener('change', (event) => { state.stock.stationaryDate = event.target.value; state.stock.stationaryDirty = true; persistStockDraft(); });
  document.querySelector('#stock-counted-by')?.addEventListener('input', (event) => { state.stock.countedBy = event.target.value; persistStockDraft(); refreshStockSaveReadiness(); });
  document.querySelector('#stock-session-note')?.addEventListener('input', (event) => { state.stock.sessionNote = event.target.value; persistStockDraft(); });
  document.querySelector('#submit-stock')?.addEventListener('click', submitStock);
  document.querySelector('#import-stock-count')?.addEventListener('click', () => document.querySelector('#stock-count-import-file')?.click());
  document.querySelector('#stock-count-import-file')?.addEventListener('change', (event) => importCurrentStockCountExcel(event.target.files?.[0]));
  document.querySelector('#clear-stock-data')?.addEventListener('click', clearCurrentStockData);
  document.querySelector('#export-stock-pdf')?.addEventListener('click', () => exportCurrentStock('pdf'));
  document.querySelector('#export-stock-excel')?.addEventListener('click', () => exportCurrentStock('excel'));
  document.querySelector('#export-stock-pdf-result')?.addEventListener('click', () => exportCurrentStock('pdf'));
  document.querySelector('#export-stock-excel-result')?.addEventListener('click', () => exportCurrentStock('excel'));
  document.querySelector('#retry-stock-save')?.addEventListener('click', retryStockSave);
  document.querySelector('#retry-stock-save-result')?.addEventListener('click', retryStockSave);
}

function refreshStockSaveReadiness() {
  const readiness = stockSaveReadiness(state.stock);
  const status = document.querySelector('#stock-readiness');
  if (status) {
    status.textContent = readiness.summary;
    status.className = 'stock-readiness ' + (readiness.ready ? 'ready' : 'missing');
  }
  const button = document.querySelector('#submit-stock');
  if (button && !state.stock.submitting && !state.stock.submitBlocked && !state.stock.pendingSubmission) {
    button.disabled = !readiness.ready;
  }
}

function markWeekDirtyInDom(sheetName, weekIndex) {
  document.querySelectorAll('[data-week-date="' + weekIndex + '"]').forEach((input) => { if ((input.dataset.weekSheet || state.stock.activeTab) === sheetName) input.closest('.week-head')?.classList.add('dirty-week-head'); });
  document.querySelectorAll('[data-stock-week="' + weekIndex + '"]').forEach((input) => { if (input.dataset.stockSheet === sheetName) input.closest('.week-cell')?.classList.add('dirty-week'); });
}

function updateLiveStockStatus(input) {
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

async function submitStock() {
  if (state.stock.submitBlocked) return showToast('This month is still syncing. The form stays open, but submission waits for the correct monthly file.', 'warning');
  const error = validateStock(state.stock);
  if (error) { focusFirstMissingStock(); return showToast('* ' + simplifyStockError(error), 'error'); }

  const payload = buildStockPayload(state.stock);
  payload.outlet = stockOfflineOutlet();
  queueSubmission('stock', payload);
  saveStockDraft(state.stock, stockOfflineOutlet());
  state.stock.lastSubmittedPayload = payload;
  state.stock.pendingSubmission = payload.submissionId;
  state.stock.submitting = false;
  state.stock.syncError = '';
  state.stock.pendingError = '';
  state.stock.pendingStartedAt = Date.now();
  const submittedSheet = payload.sectionName || state.stock.activeTab;
  if (submittedSheet !== 'Stationary' && state.stock.dirtyColumns?.[submittedSheet]) state.stock.dirtyColumns[submittedSheet] = {};
  state.stock.dirtyWeeks = {};
  state.stock.submitResult = {
    localPending: true,
    submissionId: payload.submissionId,
    outlet: state.stock.data?.outlet || state.outlet || state.outletRef || 'Outlet',
    monthKey: payload.monthKey,
    weekIndex: payload.selectedWeek,
    savedWeeks: (payload.weekColumns || []).map((entry) => ({ weekIndex: entry.weekIndex, businessDate: entry.businessDate, sheetName: entry.sheetName || payload.sectionName })),
    spreadsheetName: 'Waiting for Google Sheet confirmation'
  };
  render();
  showToast('Saved on this device. Writing directly to the relation sheet.');
  syncStockSubmission(payload);
}

async function syncStockSubmission(payload, options = {}) {
  const id = payload.submissionId;
  if (!id || activeSubmissionSyncs.has(id)) return;
  activeSubmissionSyncs.add(id);
  markSubmissionAttempt(id);
  if (isCurrentStockPayload(payload)) {
    state.stock.pendingSubmission = id;
    state.stock.pendingError = '';
    state.stock.pendingStartedAt = state.stock.pendingStartedAt || Date.now();
    state.stock.submitting = true;
    render();
  }

  try {
    const existing = await checkStockSubmissionStatus(payload);
    if (existing?.saved) {
      removeQueuedSubmission(id);
      if (isCurrentStockPayload(payload)) applyStockSaveResult(payload, existing, options);
      return;
    }

    const result = await callOperations('stock', payload, state.settings, { timeoutMs: 30000 });
    if (!result?.saved) throw new Error(result?.error || 'Stock GAS did not confirm the relation save.');
    removeQueuedSubmission(id);
    if (isCurrentStockPayload(payload)) applyStockSaveResult(payload, result, options);
  } catch (error) {
    const confirmed = await recoverStockSubmission(payload, options, error);
    if (!confirmed && isCurrentStockPayload(payload)) {
      state.stock.pendingSubmission = id;
      state.stock.pendingError = String(error?.message || error || 'No confirmation was returned by Stock GAS.');
      state.stock.syncError = state.stock.pendingError;
      if (!options.quiet) showToast('Stock save was not confirmed. Use Retry Save.', 'error');
    }
  } finally {
    activeSubmissionSyncs.delete(id);
    if (isCurrentStockPayload(payload)) state.stock.submitting = false;
    render();
  }
}

async function checkStockSubmissionStatus(payload) {
  try {
    return await callOperations('stock', {
      action: 'getStockSubmissionStatus',
      outlet: payload.outlet || stockOfflineOutlet(),
      submissionId: payload.submissionId,
      businessDate: payload.businessDate,
      monthKey: payload.monthKey || String(payload.businessDate || '').slice(0, 7)
    }, state.settings, { timeoutMs: 12000 });
  } catch (_) {
    return null;
  }
}

function retryStockSave() {
  const id = state.stock.pendingSubmission;
  if (!id) return;
  const item = queuedSubmissions().find((entry) => entry.service === 'stock' && entry.id === id);
  if (!item?.payload) {
    state.stock.pendingError = 'The queued save payload is missing. Re-enter the changed Week column and save again.';
    state.stock.syncError = state.stock.pendingError;
    render();
    return;
  }
  state.stock.pendingError = '';
  state.stock.syncError = '';
  state.stock.pendingStartedAt = Date.now();
  state.stock.submitting = true;
  render();
  syncStockSubmission(item.payload, { quiet: false });
}

function applyStockSaveResult(payload, result, options = {}) {
  result.monthKey = result.monthKey || payload.monthKey || String(payload.businessDate || '').slice(0, 7);
  result.sectionName = result.sectionName || payload.sectionName || '';
  if (Array.isArray(result.savedWeeks)) result.savedWeeks = result.savedWeeks.map((entry, index) => ({ ...entry, sheetName: entry.sheetName || payload.weekColumns?.[index]?.sheetName || payload.sectionName || '' }));
  result.sharePreparing = false;
  result.shareError = '';
  state.stock.lastSubmittedPayload = payload;
  state.stock.submitResult = result;
  state.stock.pendingSubmission = '';
  state.stock.pendingError = '';
  state.stock.pendingStartedAt = 0;
  state.stock.syncError = '';

  const hasNewEdits = Object.values(state.stock.dirtyColumns || {}).some((weeks) => Object.values(weeks || {}).some(Boolean));
  if (hasNewEdits) saveStockDraft(state.stock, stockOfflineOutlet());
  else clearStockDraft(stockOfflineOutlet(), (payload.monthKey || String(payload.businessDate || '').slice(0, 7)) + '-01');

  if (!options.quiet) showToast('Stock count saved to _StockRelation.');
  render();
  // Keep the current local table. A forced bootstrap refresh would reopen the full
  // monthly workbook and compete with PDF/XLSX preparation.
}

async function recoverStockSubmission(payload, options = {}, originalError = null) {
  const id = payload.submissionId;
  if (!id || recoveringStockSubmissions.has(id)) return false;
  recoveringStockSubmissions.add(id);
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 700 : 1500));
      const status = await checkStockSubmissionStatus(payload);
      if (status?.saved) {
        removeQueuedSubmission(id);
        if (isCurrentStockPayload(payload)) applyStockSaveResult(payload, status, options);
        return true;
      }
    }
    if (isCurrentStockPayload(payload)) {
      state.stock.pendingError = String(originalError?.message || originalError || 'No relation-save confirmation was found.');
      state.stock.syncError = state.stock.pendingError;
      render();
    }
    return false;
  } finally {
    recoveringStockSubmissions.delete(id);
  }
}

async function prepareStockSharePackage(payload, savedResult = state.stock.submitResult, options = {}) {
  if (!payload?.submissionId || !savedResult) return;
  const currentId = payload.submissionId;
  savedResult.sharePreparing = true;
  savedResult.shareError = '';
  if (state.stock.submitResult?.submissionId === currentId) render();
  try {
    const share = await callOperations('stock', {
      action: 'prepareStockShare',
      submissionId: currentId,
      businessDate: payload.businessDate,
      selectedWeek: payload.selectedWeek,
      monthKey: payload.monthKey || String(payload.businessDate || '').slice(0, 7),
      countedBy: payload.countedBy
    }, state.settings, { timeoutMs: 15000 });
    Object.assign(savedResult, share, { sharePreparing: false, shareError: '' });
    if (state.stock.submitResult?.submissionId === currentId) {
      state.stock.submitResult = savedResult;
      if (!options.quiet) showToast('PDF, Excel and WhatsApp message are ready');
    }
  } catch (error) {
    savedResult.sharePreparing = false;
    savedResult.shareError = error.message || 'Unable to prepare PDF and Excel.';
    if (state.stock.submitResult?.submissionId === currentId && !options.quiet) {
      showToast('Stock is saved. PDF and Excel can be retried separately.', 'warning');
    }
  } finally {
    if (state.stock.submitResult?.submissionId === currentId) render();
  }
}

function retryStockSharePackage() {
  const result = state.stock.submitResult;
  const payload = state.stock.lastSubmittedPayload || (result ? {
    submissionId: result.submissionId,
    businessDate: result.businessDate || state.stock.businessDate,
    selectedWeek: result.weekIndex || state.stock.data?.selectedWeek,
    monthKey: result.monthKey || state.stock.monthKey || String(state.stock.businessDate || '').slice(0, 7),
    countedBy: state.stock.countedBy
  } : null);
  if (!result || !payload) return;
  prepareStockSharePackage(payload, result);
}

function openStockWhatsApp() {
  const result = state.stock.submitResult;
  if (!result?.whatsappShareUrl) return;
  window.open(result.whatsappShareUrl, '_blank', 'noopener,noreferrer');
  callOperations('stock', { action: 'markWhatsAppOpened', submissionId: result.submissionId, businessDate: state.stock.businessDate }, state.settings).catch(() => {});
}

function bindCash() {
  document.querySelector('#cash-date')?.addEventListener('change', (event) => {
    state.cash.businessDate = event.target.value || todayIso();
    state.cash.result = null;
    loadCash();
  });
  document.querySelector('#retry-cash')?.addEventListener('click', () => loadCash({ forceFresh: true }));
  document.querySelectorAll('[data-cash-phase]').forEach((element) => element.addEventListener('click', () => {
    state.cash.phase = element.dataset.cashPhase;
    state.cash.result = null;
    render();
  }));
  document.querySelectorAll('[data-cash-scope]').forEach((element) => {
    element.addEventListener('focus', (event) => {
      if (event.target.value === '0') event.target.value = '';
      event.target.select?.();
    });
    element.addEventListener('input', (event) => {
      const scope = event.target.dataset.cashScope;
      const denomination = event.target.dataset.denomination;
      const cleaned = String(event.target.value || '').replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
      if (event.target.value !== cleaned) event.target.value = cleaned;
      state.cash[scope][denomination] = cleaned;
      updateCashInputPreview(event.target);
    });
  });
  document.querySelectorAll('[data-cash-other]').forEach((element) => {
    element.addEventListener('focus', (event) => event.target.select?.());
    element.addEventListener('input', (event) => {
      const key = `${event.target.dataset.cashOther}Other`;
      const cleaned = normalizeMoneyInput(event.target.value);
      if (event.target.value !== cleaned) event.target.value = cleaned;
      state.cash[key] = cleaned;
      updateCashInputPreview(event.target);
    });
  });
  document.querySelector('#cash-counted-by')?.addEventListener('input', (event) => { state.cash.staff[state.cash.phase] = event.target.value; });
  document.querySelector('#cash-from-staff')?.addEventListener('input', (event) => { state.cash.handover.fromStaff = event.target.value; });
  document.querySelector('#cash-to-staff')?.addEventListener('input', (event) => { state.cash.handover.toStaff = event.target.value; });
  document.querySelector('#cash-remark')?.addEventListener('input', (event) => { state.cash.remarks[state.cash.phase] = event.target.value; });
  document.querySelectorAll('[data-payment-actual]').forEach((element) => {
    element.addEventListener('focus', (event) => event.target.select?.());
    element.addEventListener('input', (event) => {
      const id = event.target.dataset.paymentActual;
      const cleaned = normalizeMoneyInput(event.target.value);
      if (event.target.value !== cleaned) event.target.value = cleaned;
      state.cash.payments[id].actual = cleaned;
      updatePaymentInputPreview(event.target, id);
    });
  });
  document.querySelectorAll('[data-payment-remark]').forEach((element) => element.addEventListener('input', (event) => {
    const id = event.target.dataset.paymentRemark;
    state.cash.payments[id].remark = event.target.value;
  }));
  document.querySelector('#submit-cash')?.addEventListener('click', submitCash);
  document.querySelector('.cash-page')?.addEventListener('input', () => saveCashDraft(state.cash, cashOfflineOutlet()));
}

function normalizeMoneyInput(value) {
  const raw = String(value || '').replace(/[^0-9.]/g, '');
  const firstDot = raw.indexOf('.');
  if (firstDot < 0) return raw.replace(/^0+(?=\d)/, '');
  const whole = raw.slice(0, firstDot).replace(/^0+(?=\d)/, '') || '0';
  const decimals = raw.slice(firstDot + 1).replace(/\./g, '').slice(0, 2);
  return `${whole}.${decimals}`;
}

function scopeTotal(scope) {
  return cashTotal(state.cash[scope] || {}, state.cash[`${scope}Other`] || 0);
}

function updateCashInputPreview(input) {
  const scope = input.dataset.cashScope || input.dataset.cashOther;
  if (!scope) return;
  if (input.dataset.denomination) {
    const subtotal = Number(input.value || 0) * Number(input.dataset.denomination || 0);
    const small = input.closest('.denomination')?.querySelector('small');
    if (small) small.textContent = `RM ${subtotal.toFixed(2)}`;
  }
  const total = scopeTotal(scope);
  const card = input.closest('.cash-card');
  const cardTotal = card?.querySelector('.money-total');
  if (cardTotal) cardTotal.textContent = `RM ${total.toFixed(2)}`;
  if (state.cash.phase === 'handover') {
    const outgoing = scopeTotal('outgoing');
    const incoming = scopeTotal('incoming');
    const variance = incoming - outgoing;
    const varianceCard = document.querySelector('.variance-card');
    if (varianceCard) {
      varianceCard.classList.toggle('warning', Math.abs(variance) > 0.009);
      varianceCard.classList.toggle('ok', Math.abs(variance) <= 0.009);
      const strong = varianceCard.querySelector('strong');
      if (strong) strong.textContent = `${variance >= 0 ? '+' : '−'} RM ${Math.abs(variance).toFixed(2)}`;
    }
  } else {
    const controlTotal = document.querySelector('.cash-control-panel > strong');
    if (controlTotal) controlTotal.textContent = `RM ${total.toFixed(2)}`;
  }
}

function updatePaymentInputPreview(input, id) {
  const actualText = state.cash.payments[id]?.actual;
  const actual = actualText === '' || actualText === null || actualText === undefined ? null : Number(actualText);
  const card = input.closest('.payment-method-card');
  const status = card?.querySelector('.payment-status');
  if (status) {
    status.textContent = actual === null ? 'Pending' : 'Entered';
    status.className = `payment-status ${actual === null ? 'pending' : 'matched'}`;
  }
  const total = (state.cash.data?.payments || []).reduce((sum, item) => {
    const value = state.cash.payments[item.id]?.actual;
    return sum + (value === '' || value === null || value === undefined ? 0 : Number(value || 0));
  }, 0);
  const totalNode = document.querySelector('.payment-total-box strong');
  if (totalNode) totalNode.textContent = `RM ${total.toFixed(2)}`;
}

async function submitCash() {
  const cashOutlet = state.outletRef || '';
  if (!cashOutlet) return showToast(missingOutletMessage(), 'error');
  const validationError = validateCash(state.cash);
  if (validationError) return showToast(validationError, 'error');

  const payload = buildCashPayload(state.cash, cashOutlet);
  queueSubmission('cash', payload);
  saveCashDraft(state.cash, cashOutlet);
  state.cash.pendingSubmission = payload.eventId;
  state.cash.submitting = true;
  state.cash.syncError = '';
  state.cash.result = null;
  render();
  showToast('Saved on this device. Uploading in the background.');
  syncCashSubmission(payload);
}

async function syncCashSubmission(payload, options = {}) {
  const id = payload.eventId;
  if (!id || activeSubmissionSyncs.has(id)) return;
  activeSubmissionSyncs.add(id);
  markSubmissionAttempt(id);
  try {
    const result = await callOperations('cash', payload, state.settings, { timeoutMs: 120000 });
    removeQueuedSubmission(id);
    if (isCurrentCashPayload(payload)) {
      result.phase = payload.phase;
      result.displayTotal = payload.phase === 'handover' ? payload.incomingTotal : payload.countedTotal;
      state.cash.result = result;
      state.cash.pendingSubmission = '';
      state.cash.syncError = '';
      clearCashCache(payload.outlet, payload.businessDate);
      clearCashDraft(payload.outlet, payload.businessDate);
      if (!options.quiet) showToast('Cash count uploaded to Google Sheet');
      setTimeout(() => loadCash({ preserveResult: true, forceFresh: true }), 250);
    }
  } catch (error) {
    if (isCurrentCashPayload(payload)) {
      state.cash.pendingSubmission = id;
      state.cash.syncError = 'Saved on this device. Automatic upload will retry when the connection is available.';
      if (!options.quiet) showToast('Saved on this device. Upload is still pending.', 'warning');
    }
  } finally {
    activeSubmissionSyncs.delete(id);
    if (isCurrentCashPayload(payload)) state.cash.submitting = false;
    render();
  }
}

function buildCashWhatsapp(result, payload) {
  const total = payload.phase === 'handover'
    ? `Outgoing RM ${payload.outgoingTotal.toFixed(2)} / Incoming RM ${payload.incomingTotal.toFixed(2)}`
    : `RM ${payload.countedTotal.toFixed(2)}`;
  const paymentLines = (payload.payments || []).map((payment) => `*${payment.name}:* RM ${Number(payment.actual || 0).toFixed(2)}`);
  const message = [
    '💵 *CASH COUNT SUBMITTED*',
    '',
    `*Outlet:* ${payload.outlet}`,
    `*Date:* ${payload.businessDate}`,
    `*Phase:* ${payload.phase}`,
    `*Amount:* ${total}`,
    ...paymentLines,
    payload.remark ? `*Note:* ${payload.remark}` : '',
    result.spreadsheetUrl ? `*Sheet:* ${result.spreadsheetUrl}` : ''
  ].filter(Boolean).join('\n');
  return `https://api.whatsapp.com/send?text=${encodeURIComponent(message)}`;
}

function retryPendingSubmissions() {
  const queue = queuedSubmissions();
  for (const item of queue) {
    if (item.service === 'stock') {
      if (isCurrentStockPayload(item.payload)) state.stock.pendingSubmission = item.id;
      syncStockSubmission(item.payload, { quiet: true });
    } else if (item.service === 'cash') {
      if (isCurrentCashPayload(item.payload)) state.cash.pendingSubmission = item.id;
      syncCashSubmission(item.payload, { quiet: true });
    }
  }
  if (queue.length) render();
}

function bindSettings() {
  document.querySelector('#import-stock-setup')?.addEventListener('click', () => document.querySelector('#stock-setup-file')?.click());
  document.querySelector('#stock-setup-file')?.addEventListener('change', (event) => importStockSetupExcel(event.target.files?.[0]));
  document.querySelector('#export-stock-setup')?.addEventListener('click', exportCurrentStockSetupExcel);
  document.querySelector('#test-stock')?.addEventListener('click', async () => {
    const result = document.querySelector('#stock-test-result');
    result.textContent = 'Testing…';
    result.className = 'connection-result loading';
    try {
      const response = await callOperations('stock', { action: 'getBootstrap', businessDate: todayIso(), outlet: state.outletRef }, state.settings);
      result.textContent = `Connected · ${response.outlet} · Week ${response.selectedWeek}`;
      result.className = 'connection-result success';
      state.outlet = response.outlet;
    } catch (error) {
      result.textContent = error.message;
      result.className = 'connection-result error';
    }
  });
}

async function importStockSetupExcel(file) {
  if (!file) return;
  const result = document.querySelector('#stock-setup-result');
  if (result) { result.textContent = 'Reading Excel…'; result.className = 'connection-result loading'; }
  try {
    const outlet = stockOfflineOutlet();
    const setup = await parseStockSetupWorkbook(file, outlet);
    if (!setup || !Array.isArray(setup.sheets)) throw new Error('The selected Excel file did not produce Stock Setup data.');
    rememberStockOutlet(outlet, setup.outletCode || setup.outletName || setup.outlet);
    if (!setup || !Array.isArray(setup.sheets)) {
      throw new Error('The Stock Setup Excel was read, but no setup data was produced. Export a fresh Stock Setup DB file and import it again.');
    }
    const validSheets = (Array.isArray(setup?.sheets) ? setup.sheets : []).filter((sheet) => sheet && Array.isArray(sheet.rows) && sheet.rows.length);
    const required = ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary'];
    const found = new Set(validSheets.map((sheet) => String(sheet.sheetName || '')));
    const missing = required.filter((name) => !found.has(name));
    if (missing.length) throw new Error('Stock Setup is incomplete: ' + missing.join(', '));
    const setupJson = JSON.stringify({ ...setup, sheets: validSheets });
    if (!setupJson || setupJson === '{}') throw new Error('Stock Setup could not be prepared for D1.');
    if (result) result.textContent = 'Saving setup to D1…';
    const response = await callOperations('stock', {
      action: 'importStockSetup',
      outlet,
      monthKey: state.stock.monthKey || state.stock.businessDate.slice(0, 7),
      businessDate: state.stock.businessDate,
      setup: JSON.parse(setupJson),
      setupJson
    }, state.settings, { timeoutMs: 20000 });
    state.stock.data = null;
    state.stock.error = '';
    if (result) {
      result.textContent = `Imported · ${response.sheetCount || validSheets.length} tabs · ${response.itemCount || validSheets.reduce((sum, sheet) => sum + sheet.rows.length, 0)} items · Ready`;
      result.className = 'connection-result success';
    }
    showToast('Stock setup imported');
    if (state.route === 'stock') loadStock({ forceFresh: true });
  } catch (error) {
    if (result) { result.textContent = error.message; result.className = 'connection-result error'; }
    showToast(error.message, 'error');
  }
}

async function exportCurrentStockSetupExcel() {
  const result = document.querySelector('#stock-setup-result');
  if (result) { result.textContent = 'Preparing Excel…'; result.className = 'connection-result loading'; }
  try {
    const outlet = stockOfflineOutlet();
    const response = await callOperations('stock', { action: 'getStockSetup', outlet }, state.settings, { timeoutMs: 12000 });
    if (!response?.setup || !Array.isArray(response.setup.sheets)) throw new Error('No Stock Setup found in D1. Import your original Excel workbook first.');
    const label = rememberedStockOutlet(outlet) || response.setup.outletCode || response.setup.outletName || response.setup.outlet || outlet;
    const setupForExport = { ...response.setup, outlet: label, outletCode: label };
    await exportStockSetupWorkbook(setupForExport, `${label}_Stock_Setup.xlsx`);
    if (result) { result.textContent = 'Exported current D1 setup as Excel.'; result.className = 'connection-result success'; }
    showToast('Stock setup Excel exported');
  } catch (error) {
    if (result) { result.textContent = error.message; result.className = 'connection-result error'; }
    showToast(error.message, 'error');
  }
}

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
  return String(message || '').replace(/^Complete Week d+ · /, '').replace(/^Complete /, '').replace(/^Enter the /, '').replace(/ before saving.$/, '').replace(/ before submitting.$/, '');
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
    const weeks = Array.isArray(result.importedWeeks) && result.importedWeeks.length ? ' W' + result.importedWeeks.join(', W') : (result.weekIndex ? ' W' + result.weekIndex : '');
    showToast(result.imported ? ('Imported ' + result.imported + ' rows to ' + result.sectionName + weeks) : ('No quantity found in ' + result.sectionName + '. Check the week columns.'));
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
  state.stock.weekDates = { 1: '', 2: '', 3: '', 4: '', 5: '' };
  state.stock.stationaryDate = '';
  state.stock.dirtyColumns = { Inventory: {}, 'Untensil PG1': {}, 'Utensil PG2': {} };
  state.stock.dirtyWeeks = {};
  state.stock.submitResult = null;
  state.stock.pendingSubmission = '';
  state.stock.syncError = '';
}

function clearStockLocalMonth(outlet, businessDate, monthKey) {
  clearStockDraft(outlet, businessDate);
  try {
    const safe = String(outlet || 'default').trim() || 'default';
    const prefix = 'stupiak.operations.offline.v7';
    const keys = [
      prefix + ':stockBootstrap:' + safe + ':' + monthKey,
      prefix + ':stockBootstrapLatest:' + safe,
      prefix + ':stockDraft:' + safe + ':' + businessDate
    ];
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
}

async function clearCurrentStockData() {
  if (!confirm('Clear this month Stock Count data from this device and D1?')) return;
  const outlet = stockOfflineOutlet();
  const monthKey = state.stock.monthKey || state.stock.businessDate.slice(0, 7);
  const businessDate = state.stock.businessDate || (monthKey + '-01');
  clearStockLocalMonth(outlet, businessDate, monthKey);
  clearStockStateValues();
  render();
  try {
    await callOperations('stock', { action: 'clearStockCounts', outlet, monthKey, businessDate }, state.settings, { timeoutMs: 12000 });
    clearStockLocalMonth(outlet, businessDate, monthKey);
    showToast('Stock data cleared');
  } catch (error) {
    showToast(error?.message || 'D1 clear failed. Local screen was cleared.', 'error');
  }
}

function renderPreservingFocus(id, position) {
  render();
  const input = document.getElementById(id);
  input?.focus();
  input?.setSelectionRange(position, position);
}

function installStockActionBridgeV1165() {
  if (window.__stupiakStockActionBridgeV1165) return;
  window.__stupiakStockActionBridgeV1165 = true;

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('button');
    if (!button || state.route !== 'stock') return;
    const action = button.id;
    if (!['submit-stock', 'export-stock-pdf', 'export-stock-excel', 'export-stock-pdf-result', 'export-stock-excel-result', 'import-stock-count', 'clear-stock-data'].includes(action)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.disabled) return;

    if (action === 'submit-stock') {
      Promise.resolve(submitStock()).catch((error) => showToast(error?.message || 'Save failed.', 'error'));
      return;
    }
    if (action === 'export-stock-pdf' || action === 'export-stock-pdf-result') {
      Promise.resolve(exportCurrentStock('pdf')).catch((error) => showToast(error?.message || 'PDF export failed.', 'error'));
      return;
    }
    if (action === 'export-stock-excel' || action === 'export-stock-excel-result') {
      Promise.resolve(exportCurrentStock('excel')).catch((error) => showToast(error?.message || 'Excel export failed.', 'error'));
      return;
    }
    if (action === 'import-stock-count') {
      document.querySelector('#stock-count-import-file')?.click();
      return;
    }
    if (action === 'clear-stock-data') {
      Promise.resolve(clearCurrentStockData()).catch((error) => showToast(error?.message || 'Clear failed.', 'error'));
    }
  }, true);

  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== 'stock-count-import-file') return;
    event.stopImmediatePropagation();
    const file = input.files?.[0];
    if (!file) return;
    Promise.resolve(importCurrentStockCountExcel(file))
      .catch((error) => showToast(error?.message || 'Import failed.', 'error'))
      .finally(() => { input.value = ''; });
  }, true);
}

installStockActionBridgeV1165();


// v1.16.6 native route bridge
document.addEventListener('click', (event) => {
  const link = event.target?.closest?.('[data-route]');
  if (!link) return;
  const route = String(link.dataset.route || '').trim();
  if (!route) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  navigate(route);
}, true);

window.addEventListener('hashchange', () => {
  const nextRoute = location.hash.replace('#/', '') || 'home';
  if (state.route === 'stock' && nextRoute !== 'stock') {
    try { persistStockDraft(); } catch (_) {}
  }
  state.route = nextRoute;
  try {
    render();
  } catch (error) {
    console.error('Hash route render failed:', nextRoute, error);
    showToast(error?.message || 'Unable to open this page.', 'error');
  }
  if (nextRoute === 'stock' && !state.stock.data && !state.stock.loading) loadStock();
  if (nextRoute === 'cash' && !state.cash.data && !state.cash.loading) loadCash();
  if (nextRoute === 'dashboard' && !state.dashboard.data && !state.dashboard.loading) loadDashboard();
});

window.addEventListener('beforeunload', (event) => {
  if (!isStockSavePending()) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.deferredPrompt = event;
  render();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

render();
if (state.route === 'stock') loadStock();
if (state.route === 'cash') loadCash();
if (state.route === 'dashboard') loadDashboard();
retryPendingSubmissions();
window.addEventListener('online', retryPendingSubmissions);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retryPendingSubmissions(); });
getSystemStatus().then((status) => {
  state.systemStatus = status;
  state.outlet = rememberedStockOutlet(state.outletRef) || state.outlet || state.outletRef;
  render();
});


function isStockSavePending() {
  const id = state.stock.pendingSubmission;
  if (state.stock.submitting) return true;
  if (!id || state.stock.pendingError) return false;
  return typeof activeSubmissionSyncs !== 'undefined' && activeSubmissionSyncs.has(id);
}


// v1.16.5 final Stock action fallback
document.addEventListener('click', (event) => {
  const button = event.target?.closest?.('#submit-stock, #export-stock-pdf, #export-stock-excel');
  if (!button || button.disabled) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (button.id === 'submit-stock') {
    Promise.resolve(submitStock()).catch((error) => showToast(error?.message || 'Unable to save Stock Count.', 'error'));
    return;
  }
  if (button.id === 'export-stock-pdf') {
    Promise.resolve(exportCurrentStock('pdf')).catch((error) => showToast(error?.message || 'Unable to export PDF.', 'error'));
    return;
  }
  if (button.id === 'export-stock-excel') {
    Promise.resolve(exportCurrentStock('excel')).catch((error) => showToast(error?.message || 'Unable to export Excel.', 'error'));
  }
}, true);
