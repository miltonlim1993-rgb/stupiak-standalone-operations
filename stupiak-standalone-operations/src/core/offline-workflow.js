const PREFIX = 'stupiak.operations.offline.v7';
const QUEUE_KEY = `${PREFIX}:submissionQueue`;

function readJson(key, fallback = null) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(key) {
  try { localStorage.removeItem(key); } catch {}
}

function safeOutlet(outlet) {
  return String(outlet || 'default').trim() || 'default';
}

function monthKey(date) {
  return String(date || '').slice(0, 7) || 'unknown-month';
}

export function stockBootstrapKey(outlet, businessDate) {
  return `${PREFIX}:stockBootstrap:${safeOutlet(outlet)}:${monthKey(businessDate)}`;
}

export function readStockBootstrap(outlet, businessDate) {
  return readJson(stockBootstrapKey(outlet, businessDate));
}

export function writeStockBootstrap(outlet, businessDate, data) {
  writeJson(stockBootstrapKey(outlet, businessDate), data);
}

function stockDraftKey(outlet, businessDate) {
  return `${PREFIX}:stockDraft:${safeOutlet(outlet)}:${String(businessDate || '')}`;
}

export function readStockDraft(outlet, businessDate) {
  return readJson(stockDraftKey(outlet, businessDate));
}

export function saveStockDraft(state, outlet) {
  writeJson(stockDraftKey(outlet, state.businessDate), {
    businessDate: state.businessDate,
    values: state.values,
    countedBy: state.countedBy,
    sessionNote: state.sessionNote,
    activeTab: state.activeTab,
    savedAt: Date.now()
  });
}

export function applyStockDraft(state, draft) {
  if (!draft || draft.businessDate !== state.businessDate) return false;
  for (const [sheetName, rows] of Object.entries(draft.values || {})) {
    if (!state.values[sheetName]) continue;
    for (const [rowNo, fields] of Object.entries(rows || {})) {
      if (!state.values[sheetName][rowNo]) continue;
      Object.assign(state.values[sheetName][rowNo], fields || {});
    }
  }
  state.countedBy = draft.countedBy || '';
  state.sessionNote = draft.sessionNote || '';
  if (draft.activeTab) state.activeTab = draft.activeTab;
  return true;
}

export function clearStockDraft(outlet, businessDate) {
  removeKey(stockDraftKey(outlet, businessDate));
}

function cashDraftKey(outlet, businessDate) {
  return `${PREFIX}:cashDraft:${safeOutlet(outlet)}:${String(businessDate || '')}`;
}

export function readCashDraft(outlet, businessDate) {
  return readJson(cashDraftKey(outlet, businessDate));
}

export function saveCashDraft(state, outlet) {
  writeJson(cashDraftKey(outlet, state.businessDate), {
    businessDate: state.businessDate,
    phase: state.phase,
    opening: state.opening,
    closing: state.closing,
    outgoing: state.outgoing,
    incoming: state.incoming,
    openingOther: state.openingOther,
    closingOther: state.closingOther,
    outgoingOther: state.outgoingOther,
    incomingOther: state.incomingOther,
    staff: state.staff,
    handover: state.handover,
    remarks: state.remarks,
    payments: state.payments,
    handoverPayments: state.handoverPayments || {},
    savedAt: Date.now()
  });
}

export function applyCashDraft(state, draft) {
  if (!draft || draft.businessDate !== state.businessDate) return false;
  const countKeys = ['opening', 'closing', 'outgoing', 'incoming'];
  for (const key of countKeys) {
    if (draft[key]) state[key] = { ...state[key], ...draft[key] };
  }
  const scalarKeys = ['openingOther', 'closingOther', 'outgoingOther', 'incomingOther'];
  for (const key of scalarKeys) {
    if (draft[key] !== undefined) state[key] = draft[key];
  }
  state.staff = { ...state.staff, ...(draft.staff || {}) };
  state.handover = { ...state.handover, ...(draft.handover || {}) };
  state.remarks = { ...state.remarks, ...(draft.remarks || {}) };
  state.payments = { ...state.payments, ...(draft.payments || {}) };
  state.handoverPayments = { ...(state.handoverPayments || {}), ...(draft.handoverPayments || {}) };
  if (draft.phase) state.phase = draft.phase;
  return true;
}

export function clearCashDraft(outlet, businessDate) {
  removeKey(cashDraftKey(outlet, businessDate));
}

export function queueSubmission(service, payload) {
  const queue = queuedSubmissions().filter((item) => item.id !== payload.submissionId && item.id !== payload.eventId);
  queue.push({
    id: payload.submissionId || payload.eventId,
    service,
    payload,
    createdAt: Date.now(),
    attempts: 0
  });
  writeJson(QUEUE_KEY, queue);
}

export function queuedSubmissions() {
  const queue = readJson(QUEUE_KEY, []);
  return Array.isArray(queue) ? queue : [];
}

export function markSubmissionAttempt(id) {
  const queue = queuedSubmissions().map((item) => item.id === id ? { ...item, attempts: Number(item.attempts || 0) + 1, lastAttemptAt: Date.now() } : item);
  writeJson(QUEUE_KEY, queue);
}

export function removeQueuedSubmission(id) {
  writeJson(QUEUE_KEY, queuedSubmissions().filter((item) => item.id !== id));
}
