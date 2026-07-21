import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1110ExportLock(dist, root) {
  await copyFile(resolve(root, 'src/core/stock-workbook-export.js'), resolve(dist, 'src/core/stock-local-export.js'));
  await patchMain(dist);
  await patchStockPage(dist);
  await patchStyles(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    `import { prepareStockPackage, shareStockPackage } from './core/stock-local-export.js';`,
    `import { exportStockPdf, exportStockExcel } from './core/stock-local-export.js';`
  );
  source = source.replace(`let preparedStockWhatsappPackage = null;`, `let stockExportInProgress = false;`);

  source = source.replace(
    `  document.querySelector('#prepare-stock-whatsapp')?.addEventListener('click', prepareLocalStockWhatsapp);
  document.querySelector('#prepare-stock-whatsapp-result')?.addEventListener('click', prepareLocalStockWhatsapp);
  document.querySelector('#share-prepared-stock-whatsapp')?.addEventListener('click', sharePreparedStockWhatsapp);
  document.querySelector('#share-prepared-stock-whatsapp-result')?.addEventListener('click', sharePreparedStockWhatsapp);`,
    `  document.querySelector('#export-stock-pdf')?.addEventListener('click', () => exportCurrentStock('pdf'));
  document.querySelector('#export-stock-excel')?.addEventListener('click', () => exportCurrentStock('excel'));
  document.querySelector('#export-stock-pdf-result')?.addEventListener('click', () => exportCurrentStock('pdf'));
  document.querySelector('#export-stock-excel-result')?.addEventListener('click', () => exportCurrentStock('excel'));`
  );

  source = source.replace(
    `  document.querySelector('.stock-page')?.addEventListener('input', () => {
    preparedStockWhatsappPackage = null;
    state.stock.localShareReady = null;
    saveStockDraft(state.stock, stockOfflineOutlet());
  });`,
    `  document.querySelector('.stock-page')?.addEventListener('input', () => saveStockDraft(state.stock, stockOfflineOutlet()));`
  );

  source = source.replace(
    /async function prepareLocalStockWhatsapp\(\) \{[\s\S]*?\n\}\n\nasync function sharePreparedStockWhatsapp\(\) \{[\s\S]*?\n\}\n\nasync function prepareStockSharePackage/,
    `async function exportCurrentStock(format) {
  if (stockExportInProgress) return;
  try {
    stockExportInProgress = true;
    state.stock.exportingFormat = format;
    render();
    const outlet = state.stock.data?.outlet || state.outlet || state.outletRef || 'Outlet';
    showToast(format === 'pdf' ? 'Preparing PDF…' : 'Preparing Excel…');
    if (format === 'pdf') await exportStockPdf(state.stock, outlet);
    else await exportStockExcel(state.stock, outlet);
    showToast(format === 'pdf' ? 'PDF exported.' : 'Excel exported.');
  } catch (error) {
    showToast(error?.message || 'Unable to export the Stock Count file.', 'error');
  } finally {
    stockExportInProgress = false;
    state.stock.exportingFormat = '';
    render();
  }
}

function isStockSavePending() {
  return Boolean(state.stock.pendingSubmission || state.stock.submitting);
}

async function prepareStockSharePackage`
  );

  source = source.replace(
    `function navigate(route) {
  state.route = route;`,
    `function navigate(route) {
  if (state.route === 'stock' && route !== 'stock' && isStockSavePending()) {
    showToast('Stock Count is still saving to the Sheet. Keep this page open until saving is complete.', 'warning');
    return;
  }
  state.route = route;`
  );

  source = source.replace(
    `window.addEventListener('hashchange', () => {
  state.route = location.hash.replace('#/', '') || 'home';`,
    `window.addEventListener('hashchange', () => {
  const nextRoute = location.hash.replace('#/', '') || 'home';
  if (state.route === 'stock' && nextRoute !== 'stock' && isStockSavePending()) {
    history.replaceState(null, '', location.pathname + location.search + '#/stock');
    showToast('Stock Count is still saving. You cannot leave this page yet.', 'warning');
    return;
  }
  state.route = nextRoute;`
  );

  source = source.replace(
    `window.addEventListener('beforeinstallprompt', (event) => {`,
    `window.addEventListener('beforeunload', (event) => {
  if (!isStockSavePending()) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener('beforeinstallprompt', (event) => {`
  );

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    `<div class="submit-row"><div><strong>Two separate actions</strong><small>Save writes to _StockRelation. PDF and Excel are prepared locally, then shared with a second explicit click.</small></div><div class="stock-action-buttons"><button class="button secondary whatsapp-prepare" id="prepare-stock-whatsapp" \${state.localSharePreparing ? 'disabled' : ''}>\${state.localSharePreparing ? 'Preparing files…' : state.localShareReady ? 'Regenerate PDF + Excel' : 'Prepare PDF + Excel'}</button>\${state.localShareReady ? '<button class="button whatsapp" id="share-prepared-stock-whatsapp">Share to WhatsApp</button>' : ''}<button class="button primary" id="submit-stock" \${state.submitting || state.submitBlocked || (!isMonthly && !dirtyWeeks.length) ? 'disabled' : ''}>\${state.submitting ? 'Saving…' : state.submitBlocked ? 'Waiting for month data…' : saveLabel}</button></div></div>`,
    `<div class="submit-row"><div><strong>Save and export</strong><small>Save writes to _StockRelation. PDF and Excel follow the RR-KCH Inventory Listing workbook layout.</small></div><div class="stock-action-buttons"><button class="button secondary" id="export-stock-pdf" \${state.exportingFormat ? 'disabled' : ''}>\${state.exportingFormat === 'pdf' ? 'Preparing PDF…' : 'Export PDF'}</button><button class="button secondary" id="export-stock-excel" \${state.exportingFormat ? 'disabled' : ''}>\${state.exportingFormat === 'excel' ? 'Preparing Excel…' : 'Export Excel'}</button><button class="button primary" id="submit-stock" \${state.submitting || state.submitBlocked || state.pendingSubmission || (!isMonthly && !dirtyWeeks.length) ? 'disabled' : ''}>\${state.pendingSubmission ? 'Saving to Sheet…' : state.submitting ? 'Saving…' : state.submitBlocked ? 'Waiting for month data…' : saveLabel}</button></div></div>`
  );

  source = source.replace(
    /function submitSuccess\(result, state\) \{[\s\S]*?\n\}\n\nexport function buildStockPayload/,
    `function submitSuccess(result, state) {
  const savedLabel = Array.isArray(result.savedWeeks) && result.savedWeeks.length
    ? result.savedWeeks.map((entry) => 'W' + entry.weekIndex).join(', ')
    : result.weekIndex ? 'W' + result.weekIndex : '';
  const pending = Boolean(result.localPending || state.pendingSubmission);
  const title = pending ? 'Saving to _StockRelation' : 'Saved to _StockRelation';
  const detail = pending
    ? 'Do not close, refresh, or leave this page until the Sheet confirms the save.'
    : 'Save complete. PDF and Excel can be exported separately using the original workbook layout.';
  const openSheet = result.spreadsheetUrl
    ? \`<a class="button secondary" href="\${escapeHtml(result.spreadsheetUrl)}" target="_blank" rel="noopener">Open Monthly Sheet \${icon('external', 16)}</a>\`
    : '';
  const savingState = pending ? '<div class="stock-save-lock-state"><span class="sync-dot"></span><strong>Saving — keep page open</strong></div>' : '';
  return \`<article class="submit-success stock-success separated-stock-success \${pending ? 'stock-save-locked' : ''}"><div class="success-icon">\${pending ? '…' : icon('check')}</div><div><span>\${title}</span><strong>\${escapeHtml(result.outlet || '')}\${savedLabel ? ' · ' + escapeHtml(savedLabel) : ''}</strong><small>\${detail}</small></div><div class="success-actions">\${openSheet}<button class="button secondary" id="export-stock-pdf-result" \${state.exportingFormat ? 'disabled' : ''}>Export PDF</button><button class="button secondary" id="export-stock-excel-result" \${state.exportingFormat ? 'disabled' : ''}>Export Excel</button></div>\${savingState}</article>\`;
}

export function buildStockPayload`
  );

  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `
/* v1.11.0 Stock export-only workflow and save-close guard */
.stock-action-buttons{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.stock-action-buttons .button{min-width:150px}.stock-save-locked{border-color:#d59a21;background:#fff8e8;grid-template-columns:auto minmax(260px,1fr) auto}.stock-save-locked .success-icon{background:#ffe7a7;color:#795300}.stock-save-lock-state{grid-column:1/-1;display:flex;align-items:center;gap:9px;padding-top:10px;border-top:1px solid #ead29b;color:#795300}.stock-save-lock-state .sync-dot{width:9px;height:9px;border-radius:50%;background:#f2aa00;box-shadow:0 0 0 4px rgba(242,170,0,.15);animation:syncPulse 1.2s ease-in-out infinite}.separated-stock-success .success-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}@media(max-width:760px){.stock-action-buttons{display:grid;grid-template-columns:1fr 1fr;width:100%}.stock-action-buttons .button.primary{grid-column:1/-1}.stock-action-buttons .button{width:100%;min-width:0}.stock-save-locked{grid-template-columns:auto 1fr}.stock-save-locked .success-actions{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr}.stock-save-lock-state{grid-column:1/-1}}
`;
  await writeFile(file, source);
}
