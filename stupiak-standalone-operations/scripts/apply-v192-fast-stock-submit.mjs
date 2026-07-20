import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRegexRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`v1.9.2 patch failed: ${label}`);
  pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.9.2 patch failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV192FastStockSubmit(dist) {
  await patchMain(dist);
  await patchStockPage(dist);
  await patchStyles(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `const activeSubmissionSyncs = new Set();`,
    `const activeSubmissionSyncs = new Set();\nconst recoveringStockSubmissions = new Set();`,
    'stock recovery set'
  );

  source = replaceRegexRequired(
    source,
    /async function submitStock\(\) \{[\s\S]*?\n\}\n\nasync function syncStockSubmission/,
    `async function submitStock() {
  if (state.stock.submitBlocked) return showToast('This month is still syncing. The form stays open, but submission waits for the correct monthly file.', 'warning');
  const error = validateStock(state.stock);
  if (error) return showToast(error, 'error');

  const payload = buildStockPayload(state.stock);
  queueSubmission('stock', payload);
  saveStockDraft(state.stock, stockOfflineOutlet());
  state.stock.lastSubmittedPayload = payload;
  state.stock.pendingSubmission = payload.submissionId;
  state.stock.submitting = false;
  state.stock.syncError = '';
  state.stock.dirtyWeeks = {};
  state.stock.submitResult = {
    localPending: true,
    submissionId: payload.submissionId,
    outlet: state.stock.data?.outlet || state.outlet || state.outletRef || 'Outlet',
    monthKey: payload.monthKey,
    weekIndex: payload.selectedWeek,
    savedWeeks: (payload.weekColumns || []).map((entry) => ({ weekIndex: entry.weekIndex, businessDate: entry.businessDate })),
    spreadsheetName: 'Waiting for Google Sheet confirmation'
  };
  render();
  showToast('Saved on this device. Google Sheet upload continues in the background.');
  syncStockSubmission(payload);
}

async function syncStockSubmission`,
    'instant local stock submit'
  );

  source = replaceRegexRequired(
    source,
    /async function syncStockSubmission\(payload, options = \{\}\) \{[\s\S]*?\n\}\n\nasync function prepareStockSharePackage/,
    `async function syncStockSubmission(payload, options = {}) {
  const id = payload.submissionId;
  if (!id || activeSubmissionSyncs.has(id)) return;
  activeSubmissionSyncs.add(id);
  markSubmissionAttempt(id);
  try {
    const result = await callOperations('stock', payload, state.settings, { timeoutMs: 120000 });
    removeQueuedSubmission(id);
    if (isCurrentStockPayload(payload)) applyStockSaveResult(payload, result, options);
  } catch (error) {
    if (isCurrentStockPayload(payload)) {
      state.stock.pendingSubmission = id;
      state.stock.syncError = 'Saved on this device. Checking Google Sheet confirmation in the background.';
      if (!options.quiet) showToast('Saved locally. Google Sheet is still confirming the upload.', 'warning');
      recoverStockSubmission(payload, options);
    }
  } finally {
    activeSubmissionSyncs.delete(id);
    if (isCurrentStockPayload(payload)) state.stock.submitting = false;
    render();
  }
}

function applyStockSaveResult(payload, result, options = {}) {
  result.monthKey = result.monthKey || payload.monthKey || String(payload.businessDate || '').slice(0, 7);
  result.sharePreparing = true;
  result.shareError = '';
  state.stock.lastSubmittedPayload = payload;
  state.stock.submitResult = result;
  state.stock.pendingSubmission = '';
  state.stock.syncError = '';

  const hasNewEdits = Object.keys(state.stock.dirtyWeeks || {}).some((key) => state.stock.dirtyWeeks[key]);
  if (hasNewEdits) saveStockDraft(state.stock, stockOfflineOutlet());
  else clearStockDraft(stockOfflineOutlet(), (payload.monthKey || String(payload.businessDate || '').slice(0, 7)) + '-01');

  if (!options.quiet) showToast('Stock count saved. Preparing PDF and Excel in the background.');
  render();
  prepareStockSharePackage(payload, result, { quiet: options.quiet });
  setTimeout(() => loadStock({ preserveResult: true, forceFresh: true }), 250);
}

async function recoverStockSubmission(payload, options = {}) {
  const id = payload.submissionId;
  if (!id || recoveringStockSubmissions.has(id)) return;
  recoveringStockSubmissions.add(id);
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 2000 : 3000));
      try {
        const status = await callOperations('stock', {
          action: 'getStockSubmissionStatus',
          submissionId: id,
          businessDate: payload.businessDate,
          monthKey: payload.monthKey || String(payload.businessDate || '').slice(0, 7)
        }, state.settings, { timeoutMs: 30000 });
        if (status?.saved) {
          removeQueuedSubmission(id);
          if (isCurrentStockPayload(payload)) applyStockSaveResult(payload, status, options);
          return;
        }
      } catch (_) {}
    }
    if (isCurrentStockPayload(payload)) {
      state.stock.syncError = 'The entry remains safely queued on this device and will retry automatically.';
      render();
    }
  } finally {
    recoveringStockSubmissions.delete(id);
  }
}

async function prepareStockSharePackage`,
    'stock save recovery and export handoff'
  );

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');
  source = replaceRequired(
    source,
    `function submitSuccess(result) {\n  const shareStatus`,
    `function submitSuccess(result) {\n  if (result.localPending) {\n    const weeks = Array.isArray(result.savedWeeks) && result.savedWeeks.length\n      ? result.savedWeeks.map((entry) => 'W' + entry.weekIndex).join(', ')\n      : 'Week ' + (result.weekIndex || '');\n    return \`<article class="submit-success stock-success local-stock-pending"><div class="success-icon">\${icon('check')}</div><div><span>Saved on this device</span><strong>\${escapeHtml(result.outlet)} · \${escapeHtml(weeks)}</strong><small>Google Sheet upload continues in the background. PDF and Excel start automatically after confirmation.</small></div><div class="local-upload-state"><span class="sync-dot"></span><strong>Uploading</strong></div></article>\`;\n  }\n  const shareStatus`,
    'local stock pending card'
  );
  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `\n/* v1.9.2 fast stock save feedback */\n.local-stock-pending{border-color:#d9c886;background:#fffdf4}.local-stock-pending .success-icon{background:#fff0bd;color:#7d5b00}.local-upload-state{display:flex;align-items:center;gap:8px;color:#7d5b00;font-size:12px}.local-upload-state .sync-dot{width:9px;height:9px;border-radius:50%;background:var(--amber);box-shadow:0 0 0 4px rgba(242,170,0,.13);animation:syncPulse 1.2s ease-in-out infinite}@media(max-width:760px){.local-upload-state{grid-column:1/-1}}\n`;
  await writeFile(file, source);
}
