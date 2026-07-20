import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.8.0 patch failed: ${label}`);
  return source.replace(search, replacement);
}

function replaceRegexRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`v1.8.0 patch failed: ${label}`);
  pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

export async function applyV180StockShare(dist) {
  await patchMain(dist);
  await patchCashPage(dist);
  await patchStockPage(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    `      if (!result.whatsappShareUrl) result.whatsappShareUrl = buildCashWhatsapp(result, payload);\n`,
    ''
  );

  source = replaceRequired(
    source,
    `  document.querySelector('#stock-whatsapp')?.addEventListener('click', openStockWhatsApp);`,
    `  document.querySelector('#stock-whatsapp')?.addEventListener('click', openStockWhatsApp);\n  document.querySelector('#stock-prepare-share')?.addEventListener('click', retryStockSharePackage);`,
    'stock share bindings'
  );

  source = replaceRequired(
    source,
    `      state.stock.submitResult = result;\n      state.stock.pendingSubmission = '';\n      state.stock.syncError = '';\n      clearStockDraft(stockOfflineOutlet(), payload.businessDate);\n      if (!options.quiet) showToast('Stock count uploaded to Google Sheet');\n      setTimeout(() => loadStock({ preserveResult: true, forceFresh: true }), 250);`,
    `      result.sharePreparing = true;\n      result.shareError = '';\n      state.stock.lastSubmittedPayload = payload;\n      state.stock.submitResult = result;\n      state.stock.pendingSubmission = '';\n      state.stock.syncError = '';\n      clearStockDraft(stockOfflineOutlet(), payload.businessDate);\n      if (!options.quiet) showToast('Stock count saved. Preparing PDF and Excel in the background.');\n      render();\n      prepareStockSharePackage(payload, result, { quiet: options.quiet });\n      setTimeout(() => loadStock({ preserveResult: true, forceFresh: true }), 250);`,
    'prepare stock share after fast save'
  );

  source = replaceRequired(
    source,
    `function openStockWhatsApp() {`,
    `async function prepareStockSharePackage(payload, savedResult = state.stock.submitResult, options = {}) {\n  if (!payload?.submissionId || !savedResult) return;\n  const currentId = payload.submissionId;\n  savedResult.sharePreparing = true;\n  savedResult.shareError = '';\n  if (state.stock.submitResult?.submissionId === currentId) render();\n  try {\n    const share = await callOperations('stock', {\n      action: 'prepareStockShare',\n      submissionId: currentId,\n      businessDate: payload.businessDate,\n      selectedWeek: payload.selectedWeek,\n      countedBy: payload.countedBy\n    }, state.settings, { timeoutMs: 180000 });\n    Object.assign(savedResult, share, { sharePreparing: false, shareError: '' });\n    if (state.stock.submitResult?.submissionId === currentId) {\n      state.stock.submitResult = savedResult;\n      if (!options.quiet) showToast('PDF, Excel and WhatsApp message are ready');\n    }\n  } catch (error) {\n    savedResult.sharePreparing = false;\n    savedResult.shareError = error.message || 'Unable to prepare PDF and Excel.';\n    if (state.stock.submitResult?.submissionId === currentId && !options.quiet) {\n      showToast('Stock is saved. PDF and Excel can be retried separately.', 'warning');\n    }\n  } finally {\n    if (state.stock.submitResult?.submissionId === currentId) render();\n  }\n}\n\nfunction retryStockSharePackage() {\n  const result = state.stock.submitResult;\n  const payload = state.stock.lastSubmittedPayload || (result ? {\n    submissionId: result.submissionId,\n    businessDate: result.businessDate || state.stock.businessDate,\n    selectedWeek: result.weekIndex || state.stock.data?.selectedWeek,\n    countedBy: state.stock.countedBy\n  } : null);\n  if (!result || !payload) return;\n  prepareStockSharePackage(payload, result);\n}\n\nfunction openStockWhatsApp() {`,
    'stock share preparation functions'
  );

  await writeFile(file, source);
}

async function patchCashPage(dist) {
  const file = resolve(dist, 'src/pages/cash.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    /\n\s*\$\{result\.whatsappShareUrl \? `<a class="button whatsapp"[\s\S]*?Send to WhatsApp<\/a>` : ''\}/,
    ''
  );

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  const replacement = [
    'function submitSuccess(result) {',
    '  const shareStatus = result.sharePreparing',
    '    ? `<div class="share-preparing"><span class="sync-dot"></span><div><strong>Preparing PDF and Excel</strong><small>Stock is already saved. File export continues separately.</small></div></div>`',
    '    : result.shareError',
    '      ? `<div class="share-preparing warning"><div><strong>Stock saved, export not ready</strong><small>${escapeHtml(result.shareError)}</small></div><button class="button secondary" id="stock-prepare-share">Retry PDF & Excel</button></div>`',
    "      : '';",
    '  const fileActions = [',
    '    result.pdfUrl ? `<a class="button secondary" href="${escapeHtml(result.pdfUrl)}" target="_blank" rel="noopener">Open PDF ${icon(\'external\',16)}</a>` : \'\',',
    '    result.excelUrl ? `<a class="button secondary" href="${escapeHtml(result.excelUrl)}" target="_blank" rel="noopener">Open Excel ${icon(\'external\',16)}</a>` : \'\',',
    '    result.whatsappShareUrl ? `<button class="button whatsapp" id="stock-whatsapp">${icon(\'whatsapp\',18)} Send to WhatsApp</button>` : \'\'',
    "  ].filter(Boolean).join('');",
    '  return `<article class="submit-success stock-success"><div class="success-icon">${icon(\'check\')}</div><div><span>Stock count saved</span><strong>${escapeHtml(result.outlet)} · Week ${result.weekIndex}</strong><small>${result.orderCount} item(s) require attention · ${escapeHtml(result.spreadsheetName)}</small></div><div class="success-actions"><a class="button secondary" href="${result.spreadsheetUrl}" target="_blank" rel="noopener">Open Monthly Sheet ${icon(\'external\',16)}</a>${fileActions}</div>${shareStatus}</article>`;',
    '}',
    '',
    'export function buildStockPayload'
  ].join('\n');

  source = replaceRegexRequired(
    source,
    /function submitSuccess\(result\) \{[\s\S]*?\n\}\n\nexport function buildStockPayload/,
    replacement,
    'stock success package UI'
  );

  await writeFile(file, source);
}
