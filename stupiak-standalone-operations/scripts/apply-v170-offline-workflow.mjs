import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.7.0 workflow patch failed: ${label}`);
  return source.replace(search, replacement);
}

function replaceRegexRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`v1.7.0 workflow patch failed: ${label}`);
  pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

export async function applyV170OfflineWorkflow(dist) {
  await patchMain(dist);
  await patchCashPage(dist);
  await patchStockPage(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `import { showToast } from './ui/toast.js';`,
    `import { showToast } from './ui/toast.js';\nimport { readStockBootstrap, readLatestStockBootstrap, writeStockBootstrap, readStockDraft, saveStockDraft, applyStockDraft, clearStockDraft, readCashDraft, saveCashDraft, applyCashDraft, clearCashDraft, queueSubmission, queuedSubmissions, markSubmissionAttempt, removeQueuedSubmission } from './core/offline-workflow.js';`,
    'offline workflow import'
  );

  source = replaceRequired(
    source,
    `  deferredPrompt: null\n};`,
    `  deferredPrompt: null\n};\n\nconst activeSubmissionSyncs = new Set();`,
    'active submission set'
  );

  source = replaceRequired(
    source,
    `  const context = { settings: state.settings, outlet: state.outlet, systemStatus: state.systemStatus };`,
    `  const context = { settings: state.settings, outlet: state.outlet || state.outletRef, systemStatus: state.systemStatus };`,
    'outlet context should be instant'
  );

  source = replaceRequired(
    source,
    `function missingOutletMessage() {\n  return 'Missing FeedMe Outlet ID. Open the outlet-specific Cash Count link from FeedMe Insights.';\n}`,
    `function missingOutletMessage() {\n  return 'Missing FeedMe Outlet ID. Open the outlet-specific Cash Count link from FeedMe Insights.';\n}\n\nfunction stockOfflineOutlet() {\n  return state.outletRef || state.outlet || 'stock-default';\n}\n\nfunction cashOfflineOutlet() {\n  return state.outletRef || state.outlet || 'cash-default';\n}\n\nfunction cashShellForDate(outlet) {\n  const previous = state.cash.data || {};\n  return {\n    ...previous,\n    outlet: previous.outlet || state.outlet || outlet,\n    events: [],\n    summary: {},\n    payments: (previous.payments || []).map((payment) => ({ ...payment, actual: '', remark: '' }))\n  };\n}\n\nfunction blankStockValues() {\n  for (const rows of Object.values(state.stock.values || {})) {\n    for (const fields of Object.values(rows || {})) {\n      for (const key of Object.keys(fields || {})) fields[key] = '';\n    }\n  }\n}\n\nfunction isCurrentStockPayload(payload) {\n  return payload.businessDate === state.stock.businessDate;\n}\n\nfunction isCurrentCashPayload(payload) {\n  return payload.businessDate === state.cash.businessDate && String(payload.outlet || '') === String(state.outletRef || '');\n}`,
    'offline helper functions'
  );

  source = replaceRegexRequired(
    source,
    /async function loadStock\(\) \{[\s\S]*?\n\}\n\nasync function loadCash/,
    `async function loadStock(options = {}) {\n  const forceFresh = Boolean(options.forceFresh || options.refresh);\n  const preserveResult = Boolean(options.preserveResult);\n  const preservedResult = preserveResult ? state.stock.submitResult : null;\n  const outlet = stockOfflineOutlet();\n  const requestedMonth = String(state.stock.businessDate || '').slice(0, 7);\n  state.stock.loading = false;\n  state.stock.error = '';\n  state.stock.syncError = '';\n  state.stock.syncing = true;\n  if (!preserveResult) state.stock.submitResult = null;\n\n  const exactCache = forceFresh ? null : readStockBootstrap(outlet, state.stock.businessDate);\n  const cached = exactCache || state.stock.data || readLatestStockBootstrap(outlet);\n  if (cached) {\n    state.stock.data = cached;\n    state.outlet = cached.outlet || state.outlet;\n    initializeStockValues(state.stock, cached);\n    const cachedMonth = String(cached.monthKey || '').slice(0, 7);\n    state.stock.submitBlocked = Boolean(cachedMonth && cachedMonth !== requestedMonth && !exactCache);\n    if (state.stock.submitBlocked) blankStockValues();\n    applyStockDraft(state.stock, readStockDraft(outlet, state.stock.businessDate));\n  } else {\n    state.stock.submitBlocked = true;\n  }\n  if (preservedResult) state.stock.submitResult = preservedResult;\n  render();\n\n  try {\n    const data = await callOperations('stock', { action: 'getBootstrap', businessDate: state.stock.businessDate, refresh: forceFresh }, state.settings, { timeoutMs: 60000 });\n    state.stock.data = data;\n    state.outlet = data.outlet || state.outlet;\n    writeStockBootstrap(outlet, state.stock.businessDate, data);\n    initializeStockValues(state.stock, data);\n    applyStockDraft(state.stock, readStockDraft(outlet, state.stock.businessDate));\n    state.stock.submitBlocked = false;\n    if (preservedResult) state.stock.submitResult = preservedResult;\n  } catch (error) {\n    state.stock.syncError = error.message;\n    if (!state.stock.data) state.stock.error = 'The item list has not been cached on this device yet.';\n  } finally {\n    state.stock.syncing = false;\n    state.stock.loading = false;\n    render();\n  }\n}\n\nasync function loadCash`,
    'non-blocking stock loader'
  );

  source = replaceRegexRequired(
    source,
    /async function loadCash\(options = \{\}\) \{[\s\S]*?\n\}\n\nasync function loadDashboard/,
    `async function loadCash(options = {}) {\n  const preservedResult = options.preserveResult ? state.cash.result : null;\n  const outlet = state.outletRef || '';\n  const forceFresh = Boolean(options.forceFresh || options.refresh);\n  state.cash.loading = false;\n  state.cash.error = '';\n  state.cash.syncError = '';\n  state.cash.syncing = true;\n  if (!options.preserveResult) state.cash.result = null;\n\n  if (!outlet) {\n    state.cash.syncing = false;\n    state.cash.error = missingOutletMessage();\n    state.cash.data = state.cash.data || cashShellForDate('');\n    render();\n    return;\n  }\n\n  const cached = forceFresh ? null : readCashCache(outlet, state.cash.businessDate);\n  initializeCashFromBootstrap(state.cash, cached || cashShellForDate(outlet));\n  applyCashDraft(state.cash, readCashDraft(outlet, state.cash.businessDate));\n  state.outlet = state.cash.data?.outlet || outlet;\n  if (preservedResult) state.cash.result = preservedResult;\n  render();\n\n  try {\n    if (forceFresh) clearCashCache(outlet, state.cash.businessDate);\n    const data = await callOperations('cash', { action: 'getStandaloneCashBootstrap', businessDate: state.cash.businessDate, outlet, refresh: forceFresh }, state.settings, { timeoutMs: 60000 });\n    state.outlet = data.outlet || outlet;\n    initializeCashFromBootstrap(state.cash, data);\n    writeCashCache(outlet, state.cash.businessDate, data);\n    applyCashDraft(state.cash, readCashDraft(outlet, state.cash.businessDate));\n    if (preservedResult) state.cash.result = preservedResult;\n  } catch (error) {\n    state.cash.syncError = error.message;\n  } finally {\n    state.cash.syncing = false;\n    state.cash.loading = false;\n    render();\n  }\n}\n\nasync function loadDashboard`,
    'non-blocking cash loader'
  );

  source = replaceRequired(
    source,
    `  document.querySelector('#stock-date')?.addEventListener('change', (event) => {\n    state.stock.businessDate = event.target.value || todayIso();\n    state.stock.data = null;\n    loadStock();\n  });\n  document.querySelector('#retry-stock')?.addEventListener('click', loadStock);`,
    `  document.querySelector('#stock-date')?.addEventListener('change', (event) => {\n    state.stock.businessDate = event.target.value || todayIso();\n    state.stock.submitResult = null;\n    loadStock();\n  });\n  document.querySelector('#retry-stock')?.addEventListener('click', () => loadStock({ forceFresh: true }));`,
    'stock date should not clear UI'
  );

  source = replaceRequired(
    source,
    `  document.querySelector('#stock-whatsapp')?.addEventListener('click', openStockWhatsApp);`,
    `  document.querySelector('#stock-whatsapp')?.addEventListener('click', openStockWhatsApp);\n  document.querySelector('.stock-page')?.addEventListener('input', () => saveStockDraft(state.stock, stockOfflineOutlet()));`,
    'stock delegated draft saving'
  );

  source = replaceRegexRequired(
    source,
    /async function submitStock\(\) \{[\s\S]*?\n\}\n\nfunction openStockWhatsApp/,
    `async function submitStock() {\n  if (state.stock.submitBlocked) return showToast('This month is still syncing. The form stays open, but submission waits for the correct monthly file.', 'warning');\n  const error = validateStock(state.stock);\n  if (error) return showToast(error, 'error');\n  const payload = buildStockPayload(state.stock);\n  queueSubmission('stock', payload);\n  saveStockDraft(state.stock, stockOfflineOutlet());\n  state.stock.pendingSubmission = payload.submissionId;\n  state.stock.submitting = true;\n  state.stock.syncError = '';\n  render();\n  showToast('Saved on this device. Uploading in the background.');\n  syncStockSubmission(payload);\n}\n\nasync function syncStockSubmission(payload, options = {}) {\n  const id = payload.submissionId;\n  if (!id || activeSubmissionSyncs.has(id)) return;\n  activeSubmissionSyncs.add(id);\n  markSubmissionAttempt(id);\n  try {\n    const result = await callOperations('stock', payload, state.settings, { timeoutMs: 120000 });\n    removeQueuedSubmission(id);\n    if (isCurrentStockPayload(payload)) {\n      state.stock.submitResult = result;\n      state.stock.pendingSubmission = '';\n      state.stock.syncError = '';\n      clearStockDraft(stockOfflineOutlet(), payload.businessDate);\n      if (!options.quiet) showToast('Stock count uploaded to Google Sheet');\n      setTimeout(() => loadStock({ preserveResult: true, forceFresh: true }), 250);\n    }\n  } catch (error) {\n    if (isCurrentStockPayload(payload)) {\n      state.stock.pendingSubmission = id;\n      state.stock.syncError = 'Saved on this device. Automatic upload will retry when the connection is available.';\n      if (!options.quiet) showToast('Saved on this device. Upload is still pending.', 'warning');\n    }\n  } finally {\n    activeSubmissionSyncs.delete(id);\n    if (isCurrentStockPayload(payload)) state.stock.submitting = false;\n    render();\n  }\n}\n\nfunction openStockWhatsApp`,
    'queued stock submission'
  );

  source = replaceRequired(
    source,
    `  document.querySelector('#cash-date')?.addEventListener('change', (event) => {\n    state.cash.businessDate = event.target.value || todayIso();\n    state.cash.data = null;\n    state.cash.result = null;\n    loadCash();\n  });`,
    `  document.querySelector('#cash-date')?.addEventListener('change', (event) => {\n    state.cash.businessDate = event.target.value || todayIso();\n    state.cash.result = null;\n    loadCash();\n  });`,
    'cash date should not clear UI'
  );

  source = replaceRequired(
    source,
    `  document.querySelector('#submit-cash')?.addEventListener('click', submitCash);`,
    `  document.querySelector('#submit-cash')?.addEventListener('click', submitCash);\n  document.querySelector('.cash-page')?.addEventListener('input', () => saveCashDraft(state.cash, cashOfflineOutlet()));`,
    'cash delegated draft saving'
  );

  source = replaceRegexRequired(
    source,
    /async function submitCash\(\) \{[\s\S]*?\n\}\n\nfunction buildCashWhatsapp/,
    `async function submitCash() {\n  const cashOutlet = state.outletRef || '';\n  if (!cashOutlet) return showToast(missingOutletMessage(), 'error');\n  const validationError = validateCash(state.cash);\n  if (validationError) return showToast(validationError, 'error');\n\n  const payload = buildCashPayload(state.cash, cashOutlet);\n  queueSubmission('cash', payload);\n  saveCashDraft(state.cash, cashOutlet);\n  state.cash.pendingSubmission = payload.eventId;\n  state.cash.submitting = true;\n  state.cash.syncError = '';\n  state.cash.result = null;\n  render();\n  showToast('Saved on this device. Uploading in the background.');\n  syncCashSubmission(payload);\n}\n\nasync function syncCashSubmission(payload, options = {}) {\n  const id = payload.eventId;\n  if (!id || activeSubmissionSyncs.has(id)) return;\n  activeSubmissionSyncs.add(id);\n  markSubmissionAttempt(id);\n  try {\n    const result = await callOperations('cash', payload, state.settings, { timeoutMs: 120000 });\n    removeQueuedSubmission(id);\n    if (isCurrentCashPayload(payload)) {\n      result.phase = payload.phase;\n      result.displayTotal = payload.phase === 'handover' ? payload.incomingTotal : payload.countedTotal;\n      if (!result.whatsappShareUrl) result.whatsappShareUrl = buildCashWhatsapp(result, payload);\n      state.cash.result = result;\n      state.cash.pendingSubmission = '';\n      state.cash.syncError = '';\n      clearCashCache(payload.outlet, payload.businessDate);\n      clearCashDraft(payload.outlet, payload.businessDate);\n      if (!options.quiet) showToast('Cash count uploaded to Google Sheet');\n      setTimeout(() => loadCash({ preserveResult: true, forceFresh: true }), 250);\n    }\n  } catch (error) {\n    if (isCurrentCashPayload(payload)) {\n      state.cash.pendingSubmission = id;\n      state.cash.syncError = 'Saved on this device. Automatic upload will retry when the connection is available.';\n      if (!options.quiet) showToast('Saved on this device. Upload is still pending.', 'warning');\n    }\n  } finally {\n    activeSubmissionSyncs.delete(id);\n    if (isCurrentCashPayload(payload)) state.cash.submitting = false;\n    render();\n  }\n}\n\nfunction buildCashWhatsapp`,
    'queued cash submission'
  );

  source = replaceRequired(
    source,
    `function bindSettings() {`,
    `function retryPendingSubmissions() {\n  const queue = queuedSubmissions();\n  for (const item of queue) {\n    if (item.service === 'stock') {\n      if (isCurrentStockPayload(item.payload)) state.stock.pendingSubmission = item.id;\n      syncStockSubmission(item.payload, { quiet: true });\n    } else if (item.service === 'cash') {\n      if (isCurrentCashPayload(item.payload)) state.cash.pendingSubmission = item.id;\n      syncCashSubmission(item.payload, { quiet: true });\n    }\n  }\n  if (queue.length) render();\n}\n\nfunction bindSettings() {`,
    'pending submission retry function'
  );

  source = replaceRequired(
    source,
    `render();\ngetSystemStatus().then((status) => {\n  state.systemStatus = status;\n  state.outlet = state.outletRef || state.outlet;\n  render();\n});`,
    `render();\nif (state.route === 'stock') loadStock();\nif (state.route === 'cash') loadCash();\nif (state.route === 'dashboard') loadDashboard();\nretryPendingSubmissions();\nwindow.addEventListener('online', retryPendingSubmissions);\ndocument.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retryPendingSubmissions(); });\ngetSystemStatus().then((status) => {\n  state.systemStatus = status;\n  state.outlet = state.outletRef || state.outlet;\n  render();\n});`,
    'initial instant render and background work'
  );

  await writeFile(file, source);
}

async function patchCashPage(dist) {
  const file = resolve(dist, 'src/pages/cash.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `      ${'${'}state.loading ? loadingMarkup() : state.error ? errorMarkup(state.error) : state.data ? cashContent(state) : emptyMarkup()}`,
    `      ${'${'}cashSyncStatusMarkup(state)}\n      ${'${'}cashContent(state)}`,
    'cash UI must not be gated by GAS'
  );

  source = replaceRequired(
    source,
    `function loadingMarkup() {`,
    `function cashSyncStatusMarkup(state) {\n  const error = state.syncError || state.error;\n  if (state.pendingSubmission) return '<div class="sync-strip pending"><span class="sync-dot"></span><div><strong>Saved on this device</strong><span>Upload continues in the background. Staff can keep using the form.</span></div></div>';\n  if (state.syncing) return '<div class="sync-strip syncing"><span class="sync-dot"></span><div><strong>Syncing in the background</strong><span>The form is ready now. Existing Sheet records will appear when the read finishes.</span></div></div>';\n  if (error) return '<div class="sync-strip warning"><span class="sync-dot"></span><div><strong>Google Sheet is temporarily unavailable</strong><span>Your form and drafts remain on this device.</span></div><button id="retry-cash">Retry sync</button></div>';\n  return '';\n}\n\nfunction loadingMarkup() {`,
    'cash sync status markup'
  );

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `    ${'${'}state.loading ? loadingMarkup() : state.error ? errorMarkup(state.error) : state.data ? stockContent(state, weekly, monthly) : emptyMarkup()}`,
    `    ${'${'}stockSyncStatusMarkup(state)}\n    ${'${'}state.data ? stockContent(state, weekly, monthly) : stockFirstLoadShell(state)}`,
    'stock UI must not be gated by GAS'
  );

  source = replaceRequired(
    source,
    `${'${'}state.submitting ? 'disabled' : ''}>${'${'}state.submitting ? 'Submitting…' : 'Submit Stock Count'}`,
    `${'${'}state.submitting || state.submitBlocked ? 'disabled' : ''}>${'${'}state.submitting ? 'Syncing…' : state.submitBlocked ? 'Waiting for month data…' : 'Submit Stock Count'}`,
    'stock submit state'
  );

  source = replaceRequired(
    source,
    `function loadingMarkup(){`,
    `function stockSyncStatusMarkup(state){\n  const error=state.syncError||state.error;\n  if(state.pendingSubmission)return '<div class="sync-strip pending"><span class="sync-dot"></span><div><strong>Stock count saved on this device</strong><span>Upload continues in the background. The entered quantities are not lost.</span></div></div>';\n  if(state.syncing)return '<div class="sync-strip syncing"><span class="sync-dot"></span><div><strong>Refreshing monthly Sheet in the background</strong><span>The current form stays visible and editable.</span></div></div>';\n  if(error)return '<div class="sync-strip warning"><span class="sync-dot"></span><div><strong>Google Sheet sync is unavailable</strong><span>The form and draft remain on this device.</span></div><button id="retry-stock">Retry sync</button></div>';\n  return '';\n}\nfunction stockFirstLoadShell(state){return '<div class="stock-first-shell"><div class="sheet-tabs">'+STOCK_TABS.map((tab)=>'<button class="'+(state.activeTab===tab?'active':'')+'" data-stock-tab="'+tab+'">'+tab+'</button>').join('')+'</div><div class="first-connect-card"><div><strong>Preparing the item list in the background</strong><span>This first device load needs one successful read. After that, the Stock Count UI opens instantly from the device cache, including when dates change.</span></div></div></div>';}\nfunction loadingMarkup(){`,
    'stock sync status markup'
  );

  await writeFile(file, source);
}
