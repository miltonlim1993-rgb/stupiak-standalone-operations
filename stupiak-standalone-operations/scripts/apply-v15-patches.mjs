import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.5 build patch failed: ${label}`);
  return source.replace(search, replacement);
}
function replaceRegexRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`v1.5 build patch failed: ${label}`);
  return source.replace(pattern, replacement);
}

export async function applyV15Patches(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(source, "  outlet: '',\n  systemStatus: null,", "  outletRef: readOutletRef(),\n  outlet: '',\n  systemStatus: null,", 'outlet state');

  source = replaceRequired(source, 'function shell(content) {', `function readOutletRef() {
  const params = new URLSearchParams(location.search);
  return String(params.get('outlet') || params.get('outletId') || params.get('site') || '').trim();
}
function cashCacheKey(outlet, businessDate) {
  return \`stupiak.operations.cashBootstrap.v5:${'${'}String(outlet || 'missing')}:${'${'}String(businessDate || '')}\`;
}
function readCashCache(outlet, businessDate) {
  if (!outlet) return null;
  try { const parsed = JSON.parse(localStorage.getItem(cashCacheKey(outlet, businessDate)) || 'null'); return parsed?.data || null; } catch { return null; }
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
function shell(content) {`, 'helpers');

  source = replaceRegexRequired(source, /async function loadCash\(options = \{\}\) \{[\s\S]*?\n\}\n\nasync function loadDashboard/, `async function loadCash(options = {}) {
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
    state.outlet = cached.outlet || state.outlet;
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
    if (!cached) { state.cash.error = error.message; state.cash.data = null; }
    else showToast('Showing saved device cache. Press Retry for a fresh read.', 'warning');
  } finally {
    state.cash.loading = false;
    render();
  }
}

async function loadDashboard`, 'cash loader');

  source = replaceRegexRequired(source, /async function loadDashboard\(\) \{[\s\S]*?\n\}\n\nfunction bindDashboard/, `async function loadDashboard() {
  state.dashboard.loading = true;
  state.dashboard.error = '';
  render();
  try {
    const dashboardOutlet = state.dashboard.service === 'cash' ? state.outletRef || '' : state.outletRef || state.outlet || state.systemStatus?.outletName || '';
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

function bindDashboard`, 'dashboard loader');

  source = replaceRequired(source, "  const cashOutlet = state.outlet || state.cash.data?.outlet || state.systemStatus?.outletName || '';", "  const cashOutlet = state.outletRef || '';\n  if (!cashOutlet) { showToast(missingOutletMessage(), 'error'); return; }", 'submit outlet');
  source = replaceRequired(source, "  state.outlet = status?.outletName || state.outlet;", "  state.outlet = state.outletRef || state.outlet;", 'system outlet');
  source = replaceRequired(source, "  document.querySelector('#retry-cash')?.addEventListener('click', () => loadCash());", "  document.querySelector('#retry-cash')?.addEventListener('click', () => loadCash({ forceFresh: true }));", 'retry');
  source = replaceRequired(source, "    setTimeout(() => loadCash({ preserveResult: true }), 250);", "    clearCashCache(cashOutlet, state.cash.businessDate);\n    setTimeout(() => loadCash({ preserveResult: true, forceFresh: true }), 250);", 'after submit');

  await writeFile(file, source);
}
