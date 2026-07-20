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

  source = replaceRequired(
    source,
    "  outlet: '',\n  systemStatus: null,",
    "  outletRef: readOutletRef(),\n  outlet: '',\n  systemStatus: null,",
    'outlet reference state'
  );

  source = replaceRequired(
    source,
    'function shell(content) {',
    `function readOutletRef() {
  const storageKey = 'stupiak.operations.outletRef';
  const params = new URLSearchParams(location.search);
  const value = String(params.get('outlet') || params.get('outletId') || params.get('site') || '').trim();
  if (value) {
    try { localStorage.setItem(storageKey, value); } catch {}
    return value;
  }
  try { return String(localStorage.getItem(storageKey) || '').trim(); } catch { return ''; }
}

function cashCacheKey(outlet, businessDate) {
  return \`stupiak.operations.cashBootstrap.v2:${'${'}String(outlet || 'default')}:${'${'}String(businessDate || '')}\`;
}

function readCashCache(outlet, businessDate) {
  try {
    const raw = localStorage.getItem(cashCacheKey(outlet, businessDate));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeCashCache(outlet, businessDate, data) {
  try {
    localStorage.setItem(cashCacheKey(outlet, businessDate), JSON.stringify({ data, savedAt: Date.now() }));
  } catch {}
}

function clearCashCache(outlet, businessDate) {
  try { localStorage.removeItem(cashCacheKey(outlet, businessDate)); } catch {}
}

function shell(content) {`,
    'outlet reference and cash cache helpers'
  );

  source = replaceRequired(
    source,
    "    const outlet = state.outlet || state.systemStatus?.outletName || '';",
    "    const outlet = state.outletRef || state.outlet || state.systemStatus?.outletName || '';",
    'cash load outlet reference'
  );

  source = replaceRequired(
    source,
    "    const dashboardOutlet = state.outlet || state.systemStatus?.outletName || '';",
    "    const dashboardOutlet = state.outletRef || state.outlet || state.systemStatus?.outletName || '';",
    'dashboard outlet reference'
  );

  source = replaceRequired(
    source,
    "  const cashOutlet = state.outlet || state.cash.data?.outlet || state.systemStatus?.outletName || '';",
    "  const cashOutlet = state.cash.data?.outlet || state.outletRef || state.outlet || state.systemStatus?.outletName || '';",
    'cash submit outlet reference'
  );

  source = replaceRequired(
    source,
    "  state.outlet = status?.outletName || state.outlet;",
    "  state.outlet = state.outletRef || status?.outletName || state.outlet;",
    'system status outlet preference'
  );

  source = replaceRegexRequired(
    source,
    /async function loadCash\(options = \{\}\) \{[\s\S]*?\n\}\n\nasync function loadDashboard/,
    `async function loadCash(options = {}) {
  const preservedResult = options.preserveResult ? state.cash.result : null;
  const outlet = state.outletRef || state.outlet || state.systemStatus?.outletName || '';
  const forceFresh = Boolean(options.forceFresh || options.refresh);
  const cached = forceFresh ? null : readCashCache(outlet, state.cash.businessDate);

  state.cash.error = '';
  if (!options.preserveResult) state.cash.result = null;

  if (cached) {
    initializeCashFromBootstrap(state.cash, cached);
    state.outlet = cached.outlet || outlet || state.outlet;
    if (preservedResult) state.cash.result = preservedResult;
    state.cash.loading = false;
    render();
  } else {
    state.cash.loading = true;
    render();
  }

  try {
    if (forceFresh) clearCashCache(outlet, state.cash.businessDate);
    const data = await callOperations('cash', {
      action: 'getStandaloneCashBootstrap',
      businessDate: state.cash.businessDate,
      outlet,
      refresh: forceFresh
    }, state.settings, { timeoutMs: cached ? 8000 : 12000 });
    state.outlet = data.outlet || outlet || state.outlet;
    initializeCashFromBootstrap(state.cash, data);
    writeCashCache(outlet || data.outlet || '', state.cash.businessDate, data);
    if (preservedResult) state.cash.result = preservedResult;
  } catch (error) {
    if (!cached) {
      state.cash.error = error.message;
      state.cash.data = null;
    } else {
      showToast('Using saved device cache. Tap Retry to force refresh.', 'warning');
    }
  } finally {
    state.cash.loading = false;
    render();
  }
}

async function loadDashboard`,
    'cash bootstrap local-cache loader'
  );

  source = replaceRequired(
    source,
    "  document.querySelector('#retry-cash')?.addEventListener('click', () => loadCash());",
    "  document.querySelector('#retry-cash')?.addEventListener('click', () => loadCash({ forceFresh: true }));",
    'cash retry force refresh'
  );

  source = replaceRequired(
    source,
    "    setTimeout(() => loadCash({ preserveResult: true }), 250);",
    "    clearCashCache(cashOutlet, state.cash.businessDate);\n    setTimeout(() => loadCash({ preserveResult: true, forceFresh: true }), 250);",
    'post-submit force refresh'
  );

  await writeFile(file, source);
}
