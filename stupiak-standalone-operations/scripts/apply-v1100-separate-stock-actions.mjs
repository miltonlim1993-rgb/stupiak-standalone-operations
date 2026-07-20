import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.10.0 patch failed: ${label}`);
  return source.replace(search, replacement);
}

function replaceRegexRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`v1.10.0 patch failed: ${label}`);
  pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

export async function applyV1100SeparateStockActions(dist) {
  await patchMain(dist);
  await patchStockPage(dist);
  await patchStyles(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `import { showToast } from './ui/toast.js';`,
    `import { showToast } from './ui/toast.js';\nimport { prepareAndShareStockPackage } from './core/stock-local-export.js';`,
    'local Stock export import'
  );

  source = replaceRequired(
    source,
    `  document.querySelector('#submit-stock')?.addEventListener('click', submitStock);`,
    `  document.querySelector('#submit-stock')?.addEventListener('click', submitStock);\n  document.querySelector('#prepare-stock-whatsapp')?.addEventListener('click', prepareLocalStockWhatsapp);\n  document.querySelector('#prepare-stock-whatsapp-result')?.addEventListener('click', prepareLocalStockWhatsapp);`,
    'separate Stock action bindings'
  );

  source = source.replace(`  result.sharePreparing = true;\n  result.shareError = '';`, `  result.sharePreparing = false;\n  result.shareError = '';`);
  source = source.replace(
    `  if (!options.quiet) showToast('Stock count saved. Preparing PDF and Excel in the background.');`,
    `  if (!options.quiet) showToast('Stock count saved to _StockRelation.');`
  );
  source = source.replace(`  prepareStockSharePackage(payload, result, { quiet: options.quiet });\n`, '');

  source = replaceRequired(
    source,
    `async function prepareStockSharePackage(payload, savedResult = state.stock.submitResult, options = {}) {`,
    `async function prepareLocalStockWhatsapp() {
  try {
    showToast('Preparing PDF and Excel on this device…');
    const outlet = state.stock.data?.outlet || state.outlet || state.outletRef || 'Outlet';
    const result = await prepareAndShareStockPackage(state.stock, outlet);
    if (result.shared) showToast('PDF and Excel sent to the share menu. Choose WhatsApp.');
    else showToast('PDF and Excel downloaded. The WhatsApp message was opened separately.');
  } catch (error) {
    if (error?.name === 'AbortError') return;
    showToast(error?.message || 'Unable to prepare WhatsApp files.', 'error');
  }
}

async function prepareStockSharePackage(payload, savedResult = state.stock.submitResult, options = {}) {`,
    'local Stock WhatsApp handler'
  );

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `<div class="submit-row"><div><strong>\${isMonthly ? 'Monthly stationary' : 'Independent Week columns'}</strong><small>\${isMonthly ? 'Saves Stationary only.' : 'Only changed Week columns are written. Each column uses its own count date.'}</small></div><button class="button primary" id="submit-stock" \${state.submitting || state.submitBlocked || (!isMonthly && !dirtyWeeks.length) ? 'disabled' : ''}>\${state.submitting ? 'Syncing…' : state.submitBlocked ? 'Waiting for month data…' : saveLabel}</button></div>`,
    `<div class="submit-row"><div><strong>Two separate actions</strong><small>Save writes to _StockRelation. Prepare WhatsApp creates PDF and Excel locally without GAS or Drive.</small></div><div class="stock-action-buttons"><button class="button secondary whatsapp-prepare" id="prepare-stock-whatsapp">Prepare WhatsApp PDF + Excel</button><button class="button primary" id="submit-stock" \${state.submitting || state.submitBlocked || (!isMonthly && !dirtyWeeks.length) ? 'disabled' : ''}>\${state.submitting ? 'Saving…' : state.submitBlocked ? 'Waiting for month data…' : saveLabel}</button></div></div>`,
    'separate footer buttons'
  );

  source = source.replace(`? 'Save stationary count'`, `? 'Save stationary to Sheet'`);
  source = source.replace("? `Save ${dirtyWeeks.length} changed week${dirtyWeeks.length === 1 ? '' : 's'}`", "? `Save ${dirtyWeeks.length} Week column${dirtyWeeks.length === 1 ? '' : 's'} to Sheet`");

  source = replaceRegexRequired(
    source,
    /function submitSuccess\(result\) \{[\s\S]*?\n\}\n\nexport function buildStockPayload/,
    `function submitSuccess(result) {
  const savedLabel = Array.isArray(result.savedWeeks) && result.savedWeeks.length
    ? result.savedWeeks.map((entry) => 'W' + entry.weekIndex).join(', ')
    : result.weekIndex ? 'W' + result.weekIndex : '';
  const pending = Boolean(result.localPending);
  const title = pending ? 'Saved on this device' : 'Saved to _StockRelation';
  const detail = pending
    ? 'Relation upload continues separately. WhatsApp files can be prepared now without waiting.'
    : 'The Sheet save is complete. WhatsApp files are generated locally and are not stored in Drive.';
  const openSheet = result.spreadsheetUrl
    ? \`<a class="button secondary" href="\${escapeHtml(result.spreadsheetUrl)}" target="_blank" rel="noopener">Open Monthly Sheet \${icon('external', 16)}</a>\`
    : '';
  return \`<article class="submit-success stock-success separated-stock-success"><div class="success-icon">\${icon('check')}</div><div><span>\${title}</span><strong>\${escapeHtml(result.outlet || '')}\${savedLabel ? ' · ' + escapeHtml(savedLabel) : ''}</strong><small>\${detail}</small></div><div class="success-actions">\${openSheet}<button class="button whatsapp" id="prepare-stock-whatsapp-result">Prepare WhatsApp PDF + Excel</button></div></article>\`;
}

export function buildStockPayload`,
    'simple Stock save result card'
  );

  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `\n/* v1.10.0 separate Stock save and WhatsApp preparation */
.stock-action-buttons{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.stock-action-buttons .button{min-width:210px}.whatsapp-prepare{background:#edf8f1;border-color:#bddfca;color:#176a3a}.whatsapp-prepare:hover{background:#e2f3e8}.separated-stock-success .success-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}.separated-stock-success .button.whatsapp{background:#1f9d55;color:#fff;border-color:#1f9d55}@media(max-width:760px){.stock-action-buttons{width:100%;display:grid;grid-template-columns:1fr}.stock-action-buttons .button{width:100%;min-width:0}.separated-stock-success .success-actions{grid-column:1/-1;display:grid;grid-template-columns:1fr}.separated-stock-success .success-actions .button{width:100%}}
`;
  await writeFile(file, source);
}
