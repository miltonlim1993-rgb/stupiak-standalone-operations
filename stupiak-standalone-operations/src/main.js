import { APP_VERSION } from './config.js';
import { callOperations, getSystemStatus } from './api/operations-client.js';
import { loadSettings } from './core/storage.js';
import { todayIso } from './core/dates.js';
import { homePage } from './pages/home.js';
import { cashPage, createCashState, initializeCashFromBootstrap, buildCashPayload, validateCash, cashTotal } from './pages/cash.js';
import { settingsPage } from './pages/settings.js';
import { stockPage, createStockState, initializeStockValues, buildStockPayload, validateStock } from './pages/stock.js';
import { dashboardPage, createDashboardState, dashboardPayload } from './pages/dashboard.js';
import { icon } from './ui/icons.js';
import { showToast } from './ui/toast.js';

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

function shell(content) {
  const nav = [['home', 'home', 'Home'], ['dashboard', 'dashboard', 'Dashboard'], ['cash', 'cash', 'Cash Count'], ['stock', 'stock', 'Stock Count'], ['settings', 'settings', 'Dev Settings']];
  return `<div class="app-shell no-top-panel">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">S</div><div><strong>Stupiak</strong><span>Operations</span></div></div>
      <nav>${nav.map(([route, ico, label]) => `<button class="${state.route === route ? 'active' : ''}" data-route="${route}">${icon(ico)}<span>${label}</span></button>`).join('')}</nav>
      <div class="sidebar-foot"><button id="install-app" class="install-button" ${state.deferredPrompt ? '' : 'hidden'}>Install App</button><span>v${APP_VERSION}</span></div>
    </aside>
    <main class="main">${content}</main>
    <nav class="bottom-nav">${nav.map(([route, ico, label]) => `<button class="${state.route === route ? 'active' : ''}" data-route="${route}">${icon(ico)}<span>${label.replace(' Count', '')}</span></button>`).join('')}</nav>
  </div>`;
}

function render() {
  const context = { settings: state.settings, outlet: state.outlet, systemStatus: state.systemStatus };
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
  state.route = route;
  location.hash = `#/${route}`;
  render();
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

async function loadStock() {
  state.stock.loading = true;
  state.stock.error = '';
  state.stock.submitResult = null;
  render();
  try {
    const data = await callOperations('stock', { action: 'getBootstrap', businessDate: state.stock.businessDate }, state.settings);
    state.stock.data = data;
    state.outlet = data.outlet || state.outlet;
    initializeStockValues(state.stock, data);
  } catch (error) {
    state.stock.error = error.message;
  } finally {
    state.stock.loading = false;
    render();
  }
}

async function loadCash(options = {}) {
  const preservedResult = options.preserveResult ? state.cash.result : null;
  const outlet = state.outletRef || '';
  const forceFresh = Boolean(options.forceFresh || options.refresh);
  state.cash.error = '';
  if (!options.preserveResult) state.cash.result = null;
  if (!outlet) {
    state.cash.loading = false;
    state.cash.data = null;
    state.cash.error = missingOutletMessage();
    render();
    return;
  }

  const cached = forceFresh ? null : readCashCache(outlet, state.cash.businessDate);
  if (cached) {
    initializeCashFromBootstrap(state.cash, cached);
    state.outlet = cached.outlet || outlet;
    if (preservedResult) state.cash.result = preservedResult;
    state.cash.loading = false;
    render();
  } else {
    state.cash.loading = true;
    render();
  }

  try {
    if (forceFresh) clearCashCache(outlet, state.cash.businessDate);
    const data = await callOperations('cash', { action: 'getStandaloneCashBootstrap', businessDate: state.cash.businessDate, outlet, refresh: forceFresh }, state.settings, { timeoutMs: cached ? 8000 : 12000 });
    state.outlet = data.outlet || outlet;
    initializeCashFromBootstrap(state.cash, data);
    writeCashCache(outlet, state.cash.businessDate, data);
    if (preservedResult) state.cash.result = preservedResult;
  } catch (error) {
    if (!cached) {
      state.cash.error = error.message;
      state.cash.data = null;
    } else {
      showToast('Showing saved device cache. Press Retry for a fresh read.', 'warning');
    }
  } finally {
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

function bindStock() {
  document.querySelector('#stock-date')?.addEventListener('change', (event) => {
    state.stock.businessDate = event.target.value || todayIso();
    state.stock.data = null;
    loadStock();
  });
  document.querySelector('#retry-stock')?.addEventListener('click', loadStock);
  document.querySelectorAll('[data-stock-tab]').forEach((element) => element.addEventListener('click', () => {
    state.stock.activeTab = element.dataset.stockTab;
    state.stock.submitResult = null;
    render();
  }));
  document.querySelectorAll('[data-mobile-week]').forEach((element) => element.addEventListener('click', () => {
    state.stock.mobileWeek = Number(element.dataset.mobileWeek);
    render();
  }));
  document.querySelector('#stock-search')?.addEventListener('input', (event) => {
    state.stock.search = event.target.value;
    renderPreservingFocus('stock-search', state.stock.search.length);
  });
  document.querySelectorAll('[data-stock-sheet]').forEach((element) => element.addEventListener('input', (event) => {
    const { stockSheet, stockRow, stockField } = event.target.dataset;
    state.stock.values[stockSheet][Number(stockRow)][stockField] = event.target.value;
    updateLiveStockStatus(event.target);
  }));
  document.querySelector('#stock-counted-by')?.addEventListener('input', (event) => { state.stock.countedBy = event.target.value; });
  document.querySelector('#stock-session-note')?.addEventListener('input', (event) => { state.stock.sessionNote = event.target.value; });
  document.querySelector('#submit-stock')?.addEventListener('click', submitStock);
  document.querySelector('#stock-whatsapp')?.addEventListener('click', openStockWhatsApp);
}

function updateLiveStockStatus(input) {
  const cell = input.closest('.week-cell') || input.closest('tr');
  if (!cell) return;
  const sheet = input.dataset.stockSheet;
  const rowNo = Number(input.dataset.stockRow);
  const section = state.stock.data.sections.find((entry) => entry.sheetName === sheet);
  const row = section.rows.find((entry) => entry.row === rowNo);
  const value = state.stock.values[sheet][rowNo];
  let status = '';
  if (section.type === 'weekly-inventory') status = Number(value.primary || 0) * row.conversion + Number(value.secondary || 0) <= row.minimum ? 'Order' : '';
  else if (sheet === 'Utensil PG2' && rowNo === 9) status = Number(value.quantity || 0) <= 0 ? 'No More Use' : '';
  else if (sheet === 'Utensil PG2' && rowNo === 36) status = Number(value.quantity || 0) <= 4 ? 'Spare Item' : '';
  else status = Number(value.quantity || 0) <= row.minimum ? 'Order' : '';
  const badge = cell.querySelector('.row-status');
  if (badge) {
    badge.textContent = status || 'OK';
    badge.className = `row-status ${status ? 'attention' : 'ok'}`;
  }
}

async function submitStock() {
  const error = validateStock(state.stock);
  if (error) return showToast(error, 'error');
  state.stock.submitting = true;
  state.stock.submitResult = null;
  render();
  try {
    const result = await callOperations('stock', buildStockPayload(state.stock), state.settings);
    state.stock.submitResult = result;
    showToast('Stock count saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.stock.submitting = false;
    render();
  }
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
    state.cash.data = null;
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
  if (state.systemStatus && !state.systemStatus.cashGasConfigured) return showToast('Cash connection is missing from Cloudflare Production Variables.', 'error');
  const cashOutlet = state.outletRef || '';
  if (!cashOutlet) return showToast(missingOutletMessage(), 'error');
  const validationError = validateCash(state.cash);
  if (validationError) return showToast(validationError, 'error');

  state.cash.submitting = true;
  state.cash.result = null;
  render();
  try {
    const payload = buildCashPayload(state.cash, cashOutlet);
    const result = await callOperations('cash', payload, state.settings);
    result.phase = state.cash.phase;
    result.displayTotal = state.cash.phase === 'handover' ? payload.incomingTotal : payload.countedTotal;
    if (!result.whatsappShareUrl) result.whatsappShareUrl = buildCashWhatsapp(result, payload);
    state.cash.result = result;
    showToast('Cash count saved');
    clearCashCache(cashOutlet, state.cash.businessDate);
    setTimeout(() => loadCash({ preserveResult: true, forceFresh: true }), 250);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.cash.submitting = false;
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

function bindSettings() {
  document.querySelector('#test-stock')?.addEventListener('click', async () => {
    const result = document.querySelector('#stock-test-result');
    result.textContent = 'Testing…';
    result.className = 'connection-result loading';
    try {
      const response = await callOperations('stock', { action: 'getBootstrap', businessDate: todayIso() }, state.settings);
      result.textContent = `Connected · ${response.outlet} · Week ${response.selectedWeek}`;
      result.className = 'connection-result success';
      state.outlet = response.outlet;
    } catch (error) {
      result.textContent = error.message;
      result.className = 'connection-result error';
    }
  });
}

function renderPreservingFocus(id, position) {
  render();
  const input = document.getElementById(id);
  input?.focus();
  input?.setSelectionRange(position, position);
}

window.addEventListener('hashchange', () => {
  state.route = location.hash.replace('#/', '') || 'home';
  render();
  if (state.route === 'stock' && !state.stock.data && !state.stock.loading) loadStock();
  if (state.route === 'cash' && !state.cash.data && !state.cash.loading) loadCash();
  if (state.route === 'dashboard' && !state.dashboard.data && !state.dashboard.loading) loadDashboard();
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
getSystemStatus().then((status) => {
  state.systemStatus = status;
  state.outlet = state.outletRef || state.outlet;
  render();
});
