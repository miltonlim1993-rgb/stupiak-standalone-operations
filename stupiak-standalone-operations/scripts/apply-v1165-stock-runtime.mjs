import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const VERSION = '1.16.14';

export async function applyV1165StockRuntime(dist) {
  await patchIndex(dist);
  await patchMain(dist);
  await patchServiceWorker(dist);
  await audit(dist);
}

async function patchIndex(dist) {
  const file = resolve(dist, 'index.html');
  let source = await readFile(file, 'utf8');
  source = versionAsset(source, '/src/app.css');
  source = versionAsset(source, '/src/dashboard.css');
  source = versionAsset(source, '/src/cash-full.css');
  source = versionAsset(source, '/src/offline-workflow.css');
  source = versionAsset(source, '/vendor/exceljs.min.js');
  source = versionAsset(source, '/vendor/pdf-lib.min.js');
  source = versionAsset(source, '/src/main.js');
  await writeFile(file, source);
}

function versionAsset(source, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(new RegExp(`${escaped}(?:\\?v=[^"']+)?`, 'g'), `${path}?v=${VERSION}`);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  const imports = [
    './config.js',
    './pages/stock.js',
    './core/stock-local-export.js',
    './core/stock-count-excel.js',
    './core/stock-setup-excel.js',
    './core/stock-setup-legacy.js',
    './core/offline-workflow.js'
  ];
  for (const specifier of imports) {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    source = source.replace(new RegExp(`${escaped}(?:\\?v=[^"']+)?`, 'g'), `${specifier}?v=${VERSION}`);
  }

  if (!source.includes('function installStockActionBridgeV1165()')) {
    const bridge = `
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
`;
    const anchor = source.indexOf('\nwindow.addEventListener(\'hashchange\'');
    if (anchor >= 0) source = source.slice(0, anchor) + bridge + source.slice(anchor);
    else source += bridge;
  }

  await writeFile(file, source);
}

async function patchServiceWorker(dist) {
  const file = resolve(dist, 'sw.js');
  let source = await readFile(file, 'utf8');
  source = source.replace(/const CACHE = ['"][^'"]+['"];/, `const CACHE = 'stupiak-ops-v${VERSION}';`);
  source = source.replace(/fetch\(request\)/g, "fetch(request, { cache: 'no-store' })");
  if (!source.includes("'/src/pages/stock.js'")) {
    source = source.replace("'/src/main.js'", "'/src/main.js', '/src/pages/stock.js'");
  }
  await writeFile(file, source);
}

async function audit(dist) {
  const index = await readFile(resolve(dist, 'index.html'), 'utf8');
  const main = await readFile(resolve(dist, 'src/main.js'), 'utf8');
  const stock = await readFile(resolve(dist, 'src/pages/stock.js'), 'utf8');
  const sw = await readFile(resolve(dist, 'sw.js'), 'utf8');

  const checks = [
    [index.includes(`/src/main.js?v=${VERSION}`), 'versioned main.js'],
    [main.includes(`./pages/stock.js?v=${VERSION}`), 'versioned stock.js import'],
    [main.includes('function installStockActionBridgeV1165()'), 'Stock action bridge'],
    [main.includes("exportCurrentStock('pdf')"), 'PDF export action'],
    [main.includes("exportCurrentStock('excel')"), 'Excel export action'],
    [main.includes('async function exportCurrentStock(format)'), 'Stock export implementation'],
    [main.includes('submitStock()'), 'Save action'],
    [stock.includes(`state.activeTab === 'Order Page' ? liveOrderPageV1162(state)`), 'live Order Page'],
    [!stock.includes('It follows the monthly spreadsheet calculation and layout.'), 'old Order Page removed'],
    [sw.includes("cache: 'no-store'"), 'service-worker no-store fetch']
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
  if (failed.length) throw new Error(`v${VERSION} Stock runtime audit failed: ${failed.join(', ')}`);
  console.log(`v${VERSION} Stock runtime audit passed`);
}
