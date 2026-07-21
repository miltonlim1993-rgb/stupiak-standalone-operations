import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1161StockOrderOutlet(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  if (!source.includes('const STOCK_OUTLET_ROUTE_STORAGE')) {
    const anchor = 'function cashShellForDate(outlet) {';
    const helpers = `const STOCK_OUTLET_ROUTE_STORAGE = 'stupiak.operations.stockOutletRoute.v1';
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

`;
    if (source.includes(anchor)) source = source.replace(anchor, helpers + anchor);
    else console.warn('v1.16.1: cashShellForDate anchor not found');
  }

  source = source.replace(
    `function stockOfflineOutlet() {\n  return state.outletRef || state.outlet || 'stock-default';\n}`,
    `function stockOfflineOutlet() {\n  let remembered = '';\n  try { remembered = localStorage.getItem(STOCK_OUTLET_ROUTE_STORAGE) || ''; } catch {}\n  const route = state.outletRef || remembered || '';\n  if (route) { try { localStorage.setItem(STOCK_OUTLET_ROUTE_STORAGE, route); } catch {} }\n  return route || 'stock-default';\n}`
  );

  source = patchFunction(source, 'async function loadStock', 'async function loadCash', (block) => block
    .replace(/state\.outlet = cached\.outlet \|\| state\.outlet;/g, 'state.outlet = applyStockOutletIdentity(cached, outlet);')
    .replace(/state\.outlet = data\.outlet \|\| state\.outlet;/g, 'state.outlet = applyStockOutletIdentity(data, outlet);'));

  source = patchFunction(source, 'async function loadCash', 'async function loadDashboard', (block) => block
    .replace(/state\.outlet = state\.cash\.data\?\.outlet \|\| outlet;/g, "state.outlet = state.cash.data?.outlet || outlet;\n  rememberStockOutlet(outlet, state.outlet);")
    .replace(/state\.outlet = data\.outlet \|\| outlet;/g, "state.outlet = data.outlet || outlet;\n    rememberStockOutlet(outlet, state.outlet);"));

  source = patchFunction(source, 'async function importStockSetupExcel', 'async function exportCurrentStockSetupExcel', (block) => block
    .replace(
      `    const setup = await parseStockSetupWorkbook(file, outlet);`,
      `    const setup = await parseStockSetupWorkbook(file, outlet);\n    if (!setup || !Array.isArray(setup.sheets)) throw new Error('The selected Excel file did not produce Stock Setup data.');\n    rememberStockOutlet(outlet, setup.outletCode || setup.outletName || setup.outlet);`
    )
    .replace(
      `    const validSheets = setup.sheets.filter((sheet) => sheet && Array.isArray(sheet.rows) && sheet.rows.length);`,
      `    const validSheets = (Array.isArray(setup?.sheets) ? setup.sheets : []).filter((sheet) => sheet && Array.isArray(sheet.rows) && sheet.rows.length);`
    ));

  source = patchFunction(source, 'async function exportCurrentStockSetupExcel', 'function renderPreservingFocus', (block) => block
    .replace(
      `    if (!response.setup) throw new Error('No Stock Setup found in D1. Import your Excel setup first.');\n    await exportStockSetupWorkbook(response.setup, \`${'${'}outlet}_Stock_Setup.xlsx\`);`,
      `    if (!response?.setup || !Array.isArray(response.setup.sheets)) throw new Error('No Stock Setup found in D1. Import your original Excel workbook first.');\n    const label = rememberedStockOutlet(outlet) || response.setup.outletCode || response.setup.outletName || response.setup.outlet || outlet;\n    const setupForExport = { ...response.setup, outlet: label, outletCode: label };\n    await exportStockSetupWorkbook(setupForExport, \`${'${'}label}_Stock_Setup.xlsx\`);`
    ));

  source = source.replace(
    /state\.outlet = state\.outletRef \|\| state\.outlet;/g,
    `state.outlet = rememberedStockOutlet(state.outletRef) || state.outlet || state.outletRef;`
  );

  await writeFile(file, source);
}

function patchFunction(source, startMarker, endMarker, transform) {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    console.warn(`v1.16.1: ${startMarker} not found`);
    return source;
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    console.warn(`v1.16.1: ${endMarker} not found`);
    return source;
  }
  return source.slice(0, start) + transform(source.slice(start, end)) + source.slice(end);
}
