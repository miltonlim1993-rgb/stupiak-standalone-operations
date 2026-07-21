import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1125SidebarUnlock(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  const navigateStart = source.indexOf('function navigate(route) {');
  const bindCommonStart = source.indexOf('\n\nfunction bindCommon()', navigateStart);
  if (navigateStart < 0 || bindCommonStart < 0) {
    throw new Error('v1.12.5 patch failed: navigation block not found');
  }

  const navigate = `function navigate(route) {
  if (!route || route === state.route) return;
  if (state.route === 'stock') {
    try { persistStockDraft(); } catch (_) {}
  }
  state.route = route;
  location.hash = \`#/\${route}\`;
  render();
  if (route === 'stock' && !state.stock.data && !state.stock.loading) loadStock();
  if (route === 'cash' && !state.cash.data && !state.cash.loading) loadCash();
  if (route === 'dashboard' && !state.dashboard.data && !state.dashboard.loading) loadDashboard();
}`;

  source = source.slice(0, navigateStart) + navigate + source.slice(bindCommonStart);

  const hashStart = source.indexOf("window.addEventListener('hashchange', () => {");
  const nextWindowListener = hashStart >= 0
    ? source.indexOf("\n\nwindow.addEventListener('", hashStart + 1)
    : -1;
  if (hashStart < 0 || nextWindowListener < 0) {
    throw new Error('v1.12.5 patch failed: hashchange block not found');
  }

  const hashchange = `window.addEventListener('hashchange', () => {
  const nextRoute = location.hash.replace('#/', '') || 'home';
  if (nextRoute === state.route) return;
  if (state.route === 'stock') {
    try { persistStockDraft(); } catch (_) {}
  }
  state.route = nextRoute;
  render();
  if (state.route === 'stock' && !state.stock.data && !state.stock.loading) loadStock();
  if (state.route === 'cash' && !state.cash.data && !state.cash.loading) loadCash();
  if (state.route === 'dashboard' && !state.dashboard.data && !state.dashboard.loading) loadDashboard();
});`;

  source = source.slice(0, hashStart) + hashchange + source.slice(nextWindowListener);
  await writeFile(file, source);
}
