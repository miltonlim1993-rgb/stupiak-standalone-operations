import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1150StockSetup(dist) {
  await patchMain(dist);
  await patchStyles(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  if (!source.includes("./core/stock-setup-excel.js")) {
    source = source.replace(
      "import { showToast } from './ui/toast.js';",
      "import { showToast } from './ui/toast.js';\nimport { parseStockSetupWorkbook, exportStockSetupWorkbook } from './core/stock-setup-excel.js';"
    );
  }

  if (!source.includes('function activeStockOutlet()')) {
    source = source.replace(
      `function missingOutletMessage() {\n  return 'Missing FeedMe Outlet ID. Open the outlet-specific Cash Count link from FeedMe Insights.';\n}`,
      `function missingOutletMessage() {\n  return 'Missing FeedMe Outlet ID. Open the outlet-specific Cash Count link from FeedMe Insights.';\n}\n\nfunction activeStockOutlet() {\n  return state.outlet || 'RR-KCH';\n}`
    );
  }

  source = source.replace(
    /const data = await callOperations\('stock', \{ action: 'getBootstrap', businessDate: state\.stock\.businessDate([^}]*)\}, state\.settings(?:, \{ timeoutMs: cached \? 8000 : 12000 \})?\);/g,
    "const data = await callOperations('stock', { action: 'getBootstrap', businessDate: state.stock.businessDate, monthKey: state.stock.monthKey || state.stock.businessDate.slice(0, 7), outlet: activeStockOutlet()$1 }, state.settings);"
  );

  if (!source.includes('async function importStockSetupExcel')) {
    const helpers = `
async function importStockSetupExcel(file) {
  if (!file) return;
  const result = document.querySelector('#stock-setup-result');
  if (result) { result.textContent = 'Reading Excel…'; result.className = 'connection-result loading'; }
  try {
    const outlet = activeStockOutlet();
    const setup = await parseStockSetupWorkbook(file, outlet);
    if (!setup || !Array.isArray(setup.sheets)) {
      throw new Error('The Stock Setup Excel was read, but no setup data was produced. Export a fresh Stock Setup DB file and import it again.');
    }
    const validSheets = setup.sheets.filter((sheet) => sheet && Array.isArray(sheet.rows) && sheet.rows.length);
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
      result.textContent = \`Imported · \${response.sheetCount || validSheets.length} tabs · \${response.itemCount || validSheets.reduce((sum, sheet) => sum + sheet.rows.length, 0)} items · Ready\`;
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
    const outlet = activeStockOutlet();
    const response = await callOperations('stock', { action: 'getStockSetup', outlet }, state.settings, { timeoutMs: 12000 });
    if (!response.setup) throw new Error('No Stock Setup found in D1. Import your Excel setup first.');
    await exportStockSetupWorkbook(response.setup, \`\${outlet}_Stock_Setup.xlsx\`);
    if (result) { result.textContent = 'Exported current D1 setup as Excel.'; result.className = 'connection-result success'; }
    showToast('Stock setup Excel exported');
  } catch (error) {
    if (result) { result.textContent = error.message; result.className = 'connection-result error'; }
    showToast(error.message, 'error');
  }
}
`;
    source = source.replace('\nfunction renderPreservingFocus', `${helpers}\nfunction renderPreservingFocus`);
  }

  if (!source.includes("#import-stock-setup")) {
    source = source.replace(
      `function bindSettings() {`,
      `function bindSettings() {\n  document.querySelector('#import-stock-setup')?.addEventListener('click', () => document.querySelector('#stock-setup-file')?.click());\n  document.querySelector('#stock-setup-file')?.addEventListener('change', (event) => importStockSetupExcel(event.target.files?.[0]));\n  document.querySelector('#export-stock-setup')?.addEventListener('click', exportCurrentStockSetupExcel);`
    );
  }

  source = source.replace(/setTimeout\(\(\) => loadStock\(\{[^)]*\}\),\s*\d+\);/g, "");
  source = source.replace(/Google Sheet sync is unavailable/g, 'Drive archive is separate from outlet save');
  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `\n/* v1.15.0 Stock setup import/export */\n.stock-setup-actions{display:flex;gap:8px;flex-wrap:wrap}.stock-setup-actions .button{height:38px;padding:8px 12px;font-size:12px}.stock-setup-block .connection-result{margin-top:8px}.settings-block.stock-setup-block{border-color:#e0c46d;background:linear-gradient(180deg,#fffdf6,#fff)}\n`;
  await writeFile(file, source);
}
