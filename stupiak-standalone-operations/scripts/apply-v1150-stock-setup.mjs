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
      `function missingOutletMessage() {\n  return 'Missing FeedMe Outlet ID. Open the outlet-specific Cash Count link from FeedMe Insights.';\n}\n\nfunction activeStockOutlet() {\n  return state.outlet || state.outletRef || 'RR-KCH';\n}`
    );
  }

  source = source.replace(
    /const data = await callOperations\('stock', \{ action: 'getBootstrap', businessDate: state\.stock\.businessDate([^}]*)\}, state\.settings(?:, \{ timeoutMs: cached \? 8000 : 12000 \})?\);/g,
    "const data = await callOperations('stock', { action: 'getBootstrap', businessDate: state.stock.businessDate, monthKey: state.stock.monthKey || state.stock.businessDate.slice(0, 7), outlet: activeStockOutlet()$1 }, state.settings);"
  );

  if (!source.includes('async function importStockSetupExcel')) {
    const helpers = `\nasync function importStockSetupExcel(file) {\n  if (!file) return;\n  const result = document.querySelector('#stock-setup-result');\n  if (result) { result.textContent = 'Reading Excel…'; result.className = 'connection-result loading'; }\n  try {\n    const outlet = activeStockOutlet();\n    const setup = await parseStockSetupWorkbook(file, outlet);\n    if (result) result.textContent = 'Saving setup to D1…';\n    const response = await callOperations('stock', {\n      action: 'importStockSetup',\n      outlet,\n      monthKey: state.stock.monthKey || state.stock.businessDate.slice(0, 7),\n      businessDate: state.stock.businessDate,\n      setup\n    }, state.settings, { timeoutMs: 20000 });\n    state.stock.data = null;\n    state.stock.error = '';\n    if (result) {\n      result.textContent = \`Imported · \${response.sheetCount || setup.sheets.length} tabs · \${response.itemCount || 0} items · D1 is now the live Stock source\`;\n      result.className = 'connection-result success';\n    }\n    showToast('Stock setup imported to D1');\n    if (state.route === 'stock') loadStock({ forceFresh: true });\n  } catch (error) {\n    if (result) { result.textContent = error.message; result.className = 'connection-result error'; }\n    showToast(error.message, 'error');\n  }\n}\n\nasync function exportCurrentStockSetupExcel() {\n  const result = document.querySelector('#stock-setup-result');\n  if (result) { result.textContent = 'Preparing Excel…'; result.className = 'connection-result loading'; }\n  try {\n    const outlet = activeStockOutlet();\n    const response = await callOperations('stock', { action: 'getStockSetup', outlet }, state.settings, { timeoutMs: 12000 });\n    if (!response.setup) throw new Error('No Stock Setup found in D1. Import your Excel setup first.');\n    await exportStockSetupWorkbook(response.setup, \`\${outlet}_Stock_Setup.xlsx\`);\n    if (result) { result.textContent = 'Exported current D1 setup as Excel.'; result.className = 'connection-result success'; }\n    showToast('Stock setup Excel exported');\n  } catch (error) {\n    if (result) { result.textContent = error.message; result.className = 'connection-result error'; }\n    showToast(error.message, 'error');\n  }\n}\n`;
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
