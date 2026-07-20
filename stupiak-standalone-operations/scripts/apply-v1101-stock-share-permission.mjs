import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.10.1 patch failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV1101StockSharePermission(dist) {
  await patchLocalExporter(dist);
  await patchMain(dist);
  await patchStockPage(dist);
  await patchStyles(dist);
}

async function patchLocalExporter(dist) {
  const file = resolve(dist, 'src/core/stock-local-export.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `export async function prepareAndShareStockPackage(stockState, outletName) {
  const snapshot = buildStockSnapshot(stockState, outletName);
  validateSnapshot(snapshot);

  const [pdfFile, excelFile] = await Promise.all([
    createPdfFile(snapshot),
    createExcelFile(snapshot)
  ]);

  const message = buildWhatsappMessage(snapshot);
  const files = [pdfFile, excelFile];

  if (navigator.share && (!navigator.canShare || navigator.canShare({ files }))) {
    await navigator.share({
      title: \`Stock Count · \${snapshot.outlet}\`,
      text: message,
      files
    });
    return { shared: true, files, message };
  }

  files.forEach(downloadFile);
  try { await navigator.clipboard.writeText(message); } catch (_) {}
  window.open(\`https://wa.me/?text=\${encodeURIComponent(message)}\`, '_blank', 'noopener');
  return { shared: false, files, message };
}`,
    `export async function prepareStockPackage(stockState, outletName) {
  const snapshot = buildStockSnapshot(stockState, outletName);
  validateSnapshot(snapshot);

  const [pdfFile, excelFile] = await Promise.all([
    createPdfFile(snapshot),
    createExcelFile(snapshot)
  ]);

  const message = buildWhatsappMessage(snapshot);
  return {
    snapshot,
    pdfFile,
    excelFile,
    files: [pdfFile, excelFile],
    message,
    preparedAt: Date.now()
  };
}

export async function shareStockPackage(preparedPackage) {
  if (!preparedPackage?.files?.length) throw new Error('Prepare the PDF and Excel first.');
  const files = preparedPackage.files;
  const message = preparedPackage.message || '';
  const snapshot = preparedPackage.snapshot || {};
  const mobileLike = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const canShareFiles = mobileLike
    && Boolean(navigator.share)
    && (!navigator.canShare || navigator.canShare({ files }));

  if (canShareFiles) {
    await navigator.share({
      title: \`Stock Count · \${snapshot.outlet || 'Outlet'}\`,
      text: message,
      files
    });
    return { shared: true, files, message };
  }

  files.forEach(downloadFile);
  try { await navigator.clipboard.writeText(message); } catch (_) {}
  const whatsappWindow = window.open(\`https://wa.me/?text=\${encodeURIComponent(message)}\`, '_blank', 'noopener');
  return { shared: false, downloaded: true, whatsappOpened: Boolean(whatsappWindow), files, message };
}

export async function prepareAndShareStockPackage(stockState, outletName) {
  const preparedPackage = await prepareStockPackage(stockState, outletName);
  return shareStockPackage(preparedPackage);
}`,
    'split local prepare and share'
  );

  await writeFile(file, source);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `import { prepareAndShareStockPackage } from './core/stock-local-export.js';`,
    `import { prepareStockPackage, shareStockPackage } from './core/stock-local-export.js';`,
    'split exporter import'
  );

  source = replaceRequired(
    source,
    `const recoveringStockSubmissions = new Set();`,
    `const recoveringStockSubmissions = new Set();
let preparedStockWhatsappPackage = null;`,
    'prepared package state'
  );

  source = replaceRequired(
    source,
    `  document.querySelector('#prepare-stock-whatsapp')?.addEventListener('click', prepareLocalStockWhatsapp);
  document.querySelector('#prepare-stock-whatsapp-result')?.addEventListener('click', prepareLocalStockWhatsapp);`,
    `  document.querySelector('#prepare-stock-whatsapp')?.addEventListener('click', prepareLocalStockWhatsapp);
  document.querySelector('#prepare-stock-whatsapp-result')?.addEventListener('click', prepareLocalStockWhatsapp);
  document.querySelector('#share-prepared-stock-whatsapp')?.addEventListener('click', sharePreparedStockWhatsapp);
  document.querySelector('#share-prepared-stock-whatsapp-result')?.addEventListener('click', sharePreparedStockWhatsapp);`,
    'prepared share bindings'
  );

  source = replaceRequired(
    source,
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
}`,
    `async function prepareLocalStockWhatsapp() {
  try {
    state.stock.localSharePreparing = true;
    state.stock.localShareReady = null;
    render();
    showToast('Preparing PDF and Excel on this device…');
    const outlet = state.stock.data?.outlet || state.outlet || state.outletRef || 'Outlet';
    preparedStockWhatsappPackage = await prepareStockPackage(state.stock, outlet);
    state.stock.localShareReady = {
      pdfName: preparedStockWhatsappPackage.pdfFile.name,
      excelName: preparedStockWhatsappPackage.excelFile.name,
      preparedAt: preparedStockWhatsappPackage.preparedAt
    };
    showToast('PDF and Excel are ready. Tap Share to WhatsApp.');
  } catch (error) {
    preparedStockWhatsappPackage = null;
    state.stock.localShareReady = null;
    showToast(error?.message || 'Unable to prepare WhatsApp files.', 'error');
  } finally {
    state.stock.localSharePreparing = false;
    render();
  }
}

async function sharePreparedStockWhatsapp() {
  if (!preparedStockWhatsappPackage) {
    showToast('Prepare the PDF and Excel first.', 'warning');
    return;
  }
  try {
    const result = await shareStockPackage(preparedStockWhatsappPackage);
    if (result.shared) showToast('Files sent to the system share menu. Choose WhatsApp.');
    else showToast('PDF and Excel downloaded. WhatsApp opened with the message. Attach both downloaded files.');
  } catch (error) {
    if (error?.name === 'AbortError') return;
    showToast(error?.message || 'Unable to share the prepared files.', 'error');
  }
}`,
    'two-step local prepare/share handler'
  );

  source = replaceRequired(
    source,
    `  document.querySelector('.stock-page')?.addEventListener('input', () => saveStockDraft(state.stock, stockOfflineOutlet()));`,
    `  document.querySelector('.stock-page')?.addEventListener('input', () => {
    preparedStockWhatsappPackage = null;
    state.stock.localShareReady = null;
    saveStockDraft(state.stock, stockOfflineOutlet());
  });`,
    'invalidate stale prepared package'
  );

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `<div class="submit-row"><div><strong>Two separate actions</strong><small>Save writes to _StockRelation. Prepare WhatsApp creates PDF and Excel locally without GAS or Drive.</small></div><div class="stock-action-buttons"><button class="button secondary whatsapp-prepare" id="prepare-stock-whatsapp">Prepare WhatsApp PDF + Excel</button><button class="button primary" id="submit-stock" \${state.submitting || state.submitBlocked || (!isMonthly && !dirtyWeeks.length) ? 'disabled' : ''}>\${state.submitting ? 'Saving…' : state.submitBlocked ? 'Waiting for month data…' : saveLabel}</button></div></div>`,
    `<div class="submit-row"><div><strong>Two separate actions</strong><small>Save writes to _StockRelation. PDF and Excel are prepared locally, then shared with a second explicit click.</small></div><div class="stock-action-buttons"><button class="button secondary whatsapp-prepare" id="prepare-stock-whatsapp" \${state.localSharePreparing ? 'disabled' : ''}>\${state.localSharePreparing ? 'Preparing files…' : state.localShareReady ? 'Regenerate PDF + Excel' : 'Prepare PDF + Excel'}</button>\${state.localShareReady ? '<button class="button whatsapp" id="share-prepared-stock-whatsapp">Share to WhatsApp</button>' : ''}<button class="button primary" id="submit-stock" \${state.submitting || state.submitBlocked || (!isMonthly && !dirtyWeeks.length) ? 'disabled' : ''}>\${state.submitting ? 'Saving…' : state.submitBlocked ? 'Waiting for month data…' : saveLabel}</button></div></div>`,
    'two-stage footer buttons'
  );

  source = replaceRequired(
    source,
    `  return \`<article class="submit-success stock-success separated-stock-success"><div class="success-icon">\${icon('check')}</div><div><span>\${title}</span><strong>\${escapeHtml(result.outlet || '')}\${savedLabel ? ' · ' + escapeHtml(savedLabel) : ''}</strong><small>\${detail}</small></div><div class="success-actions">\${openSheet}<button class="button whatsapp" id="prepare-stock-whatsapp-result">Prepare WhatsApp PDF + Excel</button></div></article>\`;`,
    `  const localShareAction = state.localShareReady
    ? '<button class="button whatsapp" id="share-prepared-stock-whatsapp-result">Share PDF + Excel to WhatsApp</button>'
    : '<button class="button secondary" id="prepare-stock-whatsapp-result">Prepare PDF + Excel</button>';
  return \`<article class="submit-success stock-success separated-stock-success"><div class="success-icon">\${icon('check')}</div><div><span>\${title}</span><strong>\${escapeHtml(result.outlet || '')}\${savedLabel ? ' · ' + escapeHtml(savedLabel) : ''}</strong><small>\${detail}</small></div><div class="success-actions">\${openSheet}\${localShareAction}</div></article>\`;`,
    'two-stage result action'
  );

  source = source.replace(
    "${state.submitResult ? submitSuccess(state.submitResult) : ''}",
    "${state.submitResult ? submitSuccess(state.submitResult, state) : ''}"
  );
  source = source.replace(`function submitSuccess(result) {`, `function submitSuccess(result, state) {`);

  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `
/* v1.10.1 two-click local file sharing */
.stock-action-buttons .button.whatsapp{background:#1f9d55;color:#fff;border-color:#1f9d55}.stock-action-buttons .button:disabled{opacity:.55;cursor:not-allowed}.separated-stock-success .button.whatsapp{background:#1f9d55;color:#fff;border-color:#1f9d55}
`;
  await writeFile(file, source);
}
