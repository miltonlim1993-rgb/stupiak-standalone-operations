import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRegexRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`v1.11.2 patch failed: ${label}`);
  pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

export async function applyV1112StockSaveRetry(dist) {
  await patchMain(dist);
  await patchStockPage(dist);
  await patchStyles(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    `  document.querySelector('#export-stock-excel-result')?.addEventListener('click', () => exportCurrentStock('excel'));`,
    `  document.querySelector('#export-stock-excel-result')?.addEventListener('click', () => exportCurrentStock('excel'));
  document.querySelector('#retry-stock-save')?.addEventListener('click', retryStockSave);
  document.querySelector('#retry-stock-save-result')?.addEventListener('click', retryStockSave);`
  );

  source = source.replace(
    `  state.stock.syncError = '';
  state.stock.dirtyWeeks = {};`,
    `  state.stock.syncError = '';
  state.stock.pendingError = '';
  state.stock.pendingStartedAt = Date.now();
  state.stock.dirtyWeeks = {};`
  );

  source = replaceRegexRequired(
    source,
    /async function syncStockSubmission\(payload, options = \{\}\) \{[\s\S]*?\n\}\n\nfunction applyStockSaveResult/,
    `async function syncStockSubmission(payload, options = {}) {
  const id = payload.submissionId;
  if (!id || activeSubmissionSyncs.has(id)) return;
  activeSubmissionSyncs.add(id);
  markSubmissionAttempt(id);
  if (isCurrentStockPayload(payload)) {
    state.stock.pendingSubmission = id;
    state.stock.pendingError = '';
    state.stock.pendingStartedAt = state.stock.pendingStartedAt || Date.now();
    state.stock.submitting = true;
    render();
  }

  try {
    const existing = await checkStockSubmissionStatus(payload);
    if (existing?.saved) {
      removeQueuedSubmission(id);
      if (isCurrentStockPayload(payload)) applyStockSaveResult(payload, existing, options);
      return;
    }

    const result = await callOperations('stock', payload, state.settings, { timeoutMs: 30000 });
    if (!result?.saved) throw new Error(result?.error || 'Stock GAS did not confirm the relation save.');
    removeQueuedSubmission(id);
    if (isCurrentStockPayload(payload)) applyStockSaveResult(payload, result, options);
  } catch (error) {
    const confirmed = await recoverStockSubmission(payload, options, error);
    if (!confirmed && isCurrentStockPayload(payload)) {
      state.stock.pendingSubmission = id;
      state.stock.pendingError = String(error?.message || error || 'No confirmation was returned by Stock GAS.');
      state.stock.syncError = state.stock.pendingError;
      if (!options.quiet) showToast('Stock save was not confirmed. Use Retry Save.', 'error');
    }
  } finally {
    activeSubmissionSyncs.delete(id);
    if (isCurrentStockPayload(payload)) state.stock.submitting = false;
    render();
  }
}

async function checkStockSubmissionStatus(payload) {
  try {
    return await callOperations('stock', {
      action: 'getStockSubmissionStatus',
      submissionId: payload.submissionId,
      businessDate: payload.businessDate,
      monthKey: payload.monthKey || String(payload.businessDate || '').slice(0, 7)
    }, state.settings, { timeoutMs: 12000 });
  } catch (_) {
    return null;
  }
}

function retryStockSave() {
  const id = state.stock.pendingSubmission;
  if (!id) return;
  const item = queuedSubmissions().find((entry) => entry.service === 'stock' && entry.id === id);
  if (!item?.payload) {
    state.stock.pendingError = 'The queued save payload is missing. Re-enter the changed Week column and save again.';
    state.stock.syncError = state.stock.pendingError;
    render();
    return;
  }
  state.stock.pendingError = '';
  state.stock.syncError = '';
  state.stock.pendingStartedAt = Date.now();
  state.stock.submitting = true;
  render();
  syncStockSubmission(item.payload, { quiet: false });
}

function applyStockSaveResult`,
    'stock save request and retry flow'
  );

  source = source.replace(
    `  state.stock.pendingSubmission = '';
  state.stock.syncError = '';`,
    `  state.stock.pendingSubmission = '';
  state.stock.pendingError = '';
  state.stock.pendingStartedAt = 0;
  state.stock.syncError = '';`
  );

  source = replaceRegexRequired(
    source,
    /async function recoverStockSubmission\(payload, options = \{\}\) \{[\s\S]*?\n\}\n\nasync function prepareStockSharePackage/,
    `async function recoverStockSubmission(payload, options = {}, originalError = null) {
  const id = payload.submissionId;
  if (!id || recoveringStockSubmissions.has(id)) return false;
  recoveringStockSubmissions.add(id);
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 700 : 1500));
      const status = await checkStockSubmissionStatus(payload);
      if (status?.saved) {
        removeQueuedSubmission(id);
        if (isCurrentStockPayload(payload)) applyStockSaveResult(payload, status, options);
        return true;
      }
    }
    if (isCurrentStockPayload(payload)) {
      state.stock.pendingError = String(originalError?.message || originalError || 'No relation-save confirmation was found.');
      state.stock.syncError = state.stock.pendingError;
      render();
    }
    return false;
  } finally {
    recoveringStockSubmissions.delete(id);
  }
}

async function prepareStockSharePackage`,
    'bounded stock confirmation polling'
  );

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = replaceRegexRequired(
    source,
    /function submitSuccess\(result, state\) \{[\s\S]*?\n\}\n\nexport function buildStockPayload/,
    `function submitSuccess(result, state) {
  const savedLabel = Array.isArray(result.savedWeeks) && result.savedWeeks.length
    ? result.savedWeeks.map((entry) => 'W' + entry.weekIndex).join(', ')
    : result.weekIndex ? 'W' + result.weekIndex : '';
  const pending = Boolean(result.localPending || state.pendingSubmission);
  const failed = Boolean(pending && state.pendingError);
  const title = failed ? 'Save not completed' : pending ? 'Saving to _StockRelation' : 'Saved to _StockRelation';
  const detail = failed
    ? escapeHtml(state.pendingError)
    : pending
      ? 'Keep this page open. The app is waiting for the Submission ID to appear in _StockSubmissions.'
      : 'Relation save confirmed. PDF and Excel can be exported separately.';
  const openSheet = result.spreadsheetUrl
    ? \`<a class="button secondary" href="\${escapeHtml(result.spreadsheetUrl)}" target="_blank" rel="noopener">Open Monthly Sheet \${icon('external', 16)}</a>\`
    : '';
  const retry = failed ? '<button class="button primary" id="retry-stock-save-result">Retry Save</button>' : '';
  const savingState = pending
    ? \`<div class="stock-save-lock-state \${failed ? 'failed' : ''}"><span class="sync-dot"></span><strong>\${failed ? 'Waiting for Retry' : 'Saving — keep page open'}</strong></div>\`
    : '';
  return \`<article class="submit-success stock-success separated-stock-success \${pending ? 'stock-save-locked' : ''} \${failed ? 'stock-save-failed' : ''}"><div class="success-icon">\${failed ? '!' : pending ? '…' : icon('check')}</div><div><span>\${title}</span><strong>\${escapeHtml(result.outlet || '')}\${savedLabel ? ' · ' + escapeHtml(savedLabel) : ''}</strong><small>\${detail}</small></div><div class="success-actions">\${openSheet}<button class="button secondary" id="export-stock-pdf-result" \${state.exportingFormat ? 'disabled' : ''}>Export PDF</button><button class="button secondary" id="export-stock-excel-result" \${state.exportingFormat ? 'disabled' : ''}>Export Excel</button>\${retry}</div>\${savingState}</article>\`;
}

export function buildStockPayload`,
    'stock save result states'
  );

  source = replaceRegexRequired(
    source,
    /function stockSyncStatusMarkup\(state\) \{[\s\S]*?\n\}\n\nfunction stockFirstLoadShell/,
    `function stockSyncStatusMarkup(state) {
  const error = state.syncError || state.error;
  if (state.pendingSubmission && state.pendingError) return '<div class="sync-strip warning"><span class="sync-dot"></span><div><strong>Stock save not confirmed</strong><span>' + escapeHtml(state.pendingError) + '</span></div><button id="retry-stock-save">Retry Save</button></div>';
  if (state.pendingSubmission) return '<div class="sync-strip pending"><span class="sync-dot"></span><div><strong>Saving directly to _StockRelation</strong><span>Keep this page open until the Submission ID is confirmed.</span></div></div>';
  if (state.syncing) return '<div class="sync-strip syncing"><span class="sync-dot"></span><div><strong>Refreshing monthly Sheet in the background</strong><span>The current form stays visible and editable.</span></div></div>';
  if (error) return '<div class="sync-strip warning"><span class="sync-dot"></span><div><strong>Google Sheet sync is unavailable</strong><span>' + escapeHtml(error) + '</span></div><button id="retry-stock">Retry sync</button></div>';
  return '';
}

function stockFirstLoadShell`,
    'stock sync strip states'
  );

  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `
/* v1.11.2 explicit Stock save confirmation and retry */
.stock-save-failed{border-color:#c2473d;background:#fff4f2}.stock-save-failed .success-icon{background:#fbd8d4;color:#9f2f27}.stock-save-lock-state.failed{color:#9f2f27;border-top-color:#efc0bb}.stock-save-lock-state.failed .sync-dot{background:#c2473d;box-shadow:0 0 0 4px rgba(194,71,61,.14);animation:none}.sync-strip.warning button{white-space:nowrap}
`;
  await writeFile(file, source);
}
