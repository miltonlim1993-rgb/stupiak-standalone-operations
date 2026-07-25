import { DENOMINATIONS } from '../config.js';
import { createId } from '../core/ids.js';
import { todayIso } from '../core/dates.js';
import { icon } from '../ui/icons.js';

const PAYMENT_METHODS = [
  { id: 'grabfood', name: 'GrabFood', aliases: ['grabfood', 'grab food', 'gf delivery'] },
  { id: 'grab-dine-out', name: 'Grab Dine-Out', aliases: ['grab dine-out', 'grab dine out', 'grab dineout', 'grabpay pos'] },
  { id: 'foodpanda', name: 'Foodpanda', aliases: ['foodpanda', 'food panda'] },
  { id: 'pay-go', name: 'Pay & Go', aliases: ['pay & go', 'pay and go', 'pay go'] },
  { id: 'shopee-food', name: 'ShopeeFood', aliases: ['shopeefood', 'shopee food'] },
  { id: 'spay', name: 'S Pay', aliases: ['spay', 's pay', 's pay global'] },
  { id: 'duitnow', name: 'DuitNow', aliases: ['duitnow', 'duit now', 'duitnow/card', 'duitnow card'] }
];

function emptyCounts() {
  return Object.fromEntries(DENOMINATIONS.map((value) => [String(value), '']));
}

function emptyPaymentValues() {
  return Object.fromEntries(PAYMENT_METHODS.map((payment) => [payment.id, { actual: '', remark: '' }]));
}

export function createCashState() {
  return {
    phase: 'opening',
    businessDate: todayIso(),
    loading: false,
    error: '',
    data: null,
    opening: emptyCounts(),
    closing: emptyCounts(),
    outgoing: emptyCounts(),
    incoming: emptyCounts(),
    openingOther: '',
    closingOther: '',
    outgoingOther: '',
    incomingOther: '',
    staff: { opening: '', closing: '' },
    handover: { fromStaff: '', toStaff: '' },
    remarks: { opening: '', handover: '', closing: '' },
    payments: emptyPaymentValues(),
    submitting: false,
    result: null
  };
}

export function initializeCashFromBootstrap(state, sourceData) {
  const backendPayments = Array.isArray(sourceData?.payments) ? sourceData.payments : [];
  const canonicalPayments = PAYMENT_METHODS.map((payment) => {
    const backend = backendPayments.find((entry) => paymentMatches(payment, entry));
    return { ...payment, actual: backend?.actual ?? '', remark: backend?.remark || '' };
  });
  const data = { ...(sourceData || {}), payments: canonicalPayments };

  state.data = data;
  state.error = '';
  state.payments = emptyPaymentValues();
  for (const payment of canonicalPayments) {
    state.payments[payment.id] = {
      actual: payment.actual === '' || payment.actual === null || payment.actual === undefined ? '' : String(payment.actual),
      remark: payment.remark || ''
    };
  }

  const events = [...(data.events || [])].sort((a, b) => String(a.savedAt || '').localeCompare(String(b.savedAt || '')));
  const opening = [...events].reverse().find((event) => event.phase === 'opening');
  const closing = [...events].reverse().find((event) => event.phase === 'closing');

  if (opening) {
    state.opening = normalizeDenominations(opening.denominations);
    state.openingOther = numberOrBlank(opening.otherCash);
    state.staff.opening = opening.countedBy || '';
    state.remarks.opening = opening.remark || '';
  } else {
    state.opening = emptyCounts();
    state.openingOther = '';
    state.staff.opening = data.summary?.morningStaff || '';
    state.remarks.opening = '';
  }

  if (closing) {
    state.closing = normalizeDenominations(closing.denominations);
    state.closingOther = numberOrBlank(closing.otherCash);
    state.staff.closing = closing.countedBy || data.summary?.preparedBy || '';
    state.remarks.closing = closing.remark || data.summary?.closeUpNote || '';
  } else {
    state.closing = emptyCounts();
    state.closingOther = '';
    state.staff.closing = data.summary?.preparedBy || '';
    state.remarks.closing = data.summary?.closeUpNote || '';
  }

  state.outgoing = emptyCounts();
  state.incoming = emptyCounts();
  state.outgoingOther = '';
  state.incomingOther = '';
  state.handover = { fromStaff: '', toStaff: '' };
  state.remarks.handover = '';
}

export function cashPage(context, state) {
  const outlet = state.data?.outlet || context.outlet || 'Connecting…';
  const phases = [['opening', 'Opening'], ['handover', 'Handover'], ['closing', 'Closing']];
  return `
    <section class="page cash-page cash-full-page">
      <div class="page-heading">
        <div><span class="eyebrow">CASH COUNT</span><h1>${escapeHtml(outlet)}</h1><p>Enter actual cash and payments.</p></div>
        <div class="date-field"><label>Business date<input id="cash-date" type="date" value="${state.businessDate}"></label></div>
      </div>
      <div class="segmented cash-phases">${phases.map(([key, label]) => `<button class="${state.phase === key ? 'active' : ''}" data-cash-phase="${key}">${label}</button>`).join('')}</div>
      ${cashSyncStatusMarkup(state)}
      ${cashContent(state)}
      ${state.result ? resultMarkup(state.result) : ''}
    </section>`;
}

function cashContent(state) {
  return `${state.phase === 'handover' ? handoverMarkup(state) : standardMarkup(state)}${historyMarkup(state.data?.events || [])}`;
}

function standardMarkup(state) {
  const key = state.phase;
  const counts = state[key];
  const other = state[`${key}Other`];
  const total = cashTotal(counts, other);
  const isClosing = key === 'closing';
  return `<div class="cash-full-stack">
    <div class="cash-layout">
      <article class="cash-card">
        <div class="cash-card-head"><div><span>${key === 'opening' ? 'Start of shift' : 'End of shift'}</span><h2>${key === 'opening' ? 'Opening cash' : 'Closing cash'}</h2></div><strong class="money-total">RM ${total.toFixed(2)}</strong></div>
        ${savedNotice(state, key)}
        ${denominationGrid(counts, key)}
        <div class="form-grid two">
          <label>Other cash (RM)<input type="text" inputmode="decimal" autocomplete="off" data-cash-other="${key}" value="${escapeHtml(other)}"></label>
          <label>Counted by<input type="text" id="cash-counted-by" value="${escapeHtml(state.staff[key] || '')}" placeholder="Staff name"></label>
        </div>
        <label>Remark<textarea id="cash-remark" rows="3" placeholder="Optional">${escapeHtml(state.remarks[key] || '')}</textarea></label>
      </article>
      <aside class="summary-panel cash-control-panel"><span>Cash counted</span><strong>RM ${total.toFixed(2)}</strong><p>Cash is calculated automatically from the denomination count.</p></aside>
    </div>
    ${isClosing ? paymentActualMarkup(state, total) : ''}
    <button class="button primary full cash-submit-main" id="submit-cash" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Saving…' : `Save ${key}`}</button>
  </div>`;
}

function handoverMarkup(state) {
  const outgoing = cashTotal(state.outgoing, state.outgoingOther);
  const incoming = cashTotal(state.incoming, state.incomingOther);
  const handovers = (state.data?.events || []).filter((event) => event.phase === 'handover');
  return `<div class="handover-stack">
    ${handovers.length ? `<div class="cash-readback-note">${icon('check', 17)}<div><strong>${handovers.length} handover saved</strong><span>This creates a new handover.</span></div></div>` : ''}
    <div class="handover-people form-grid two">
      <label>From staff<input id="cash-from-staff" value="${escapeHtml(state.handover.fromStaff)}"></label>
      <label>To staff<input id="cash-to-staff" value="${escapeHtml(state.handover.toStaff)}"></label>
    </div>
    <div class="cash-pair">
      <article class="cash-card compact"><div class="cash-card-head"><div><span>Outgoing</span><h2>Cash handed over</h2></div><strong class="money-total">RM ${outgoing.toFixed(2)}</strong></div>${denominationGrid(state.outgoing, 'outgoing')}<label>Other cash (RM)<input type="text" inputmode="decimal" autocomplete="off" data-cash-other="outgoing" value="${escapeHtml(state.outgoingOther)}"></label></article>
      <article class="cash-card compact"><div class="cash-card-head"><div><span>Incoming</span><h2>Cash received</h2></div><strong class="money-total">RM ${incoming.toFixed(2)}</strong></div>${denominationGrid(state.incoming, 'incoming')}<label>Other cash (RM)<input type="text" inputmode="decimal" autocomplete="off" data-cash-other="incoming" value="${escapeHtml(state.incomingOther)}"></label></article>
    </div>
    ${paymentActualMarkup(state, incoming)}
    <label class="handover-remark">Remark<textarea id="cash-remark" rows="3" placeholder="Optional">${escapeHtml(state.remarks.handover)}</textarea></label>
    <button class="button primary full" id="submit-cash" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Saving…' : 'Save handover'}</button>
  </div>`;
}

function paymentActualMarkup(state, cashAmount) {
  const payments = state.data?.payments || PAYMENT_METHODS;
  return `<section class="payment-section ${state.phase === 'handover' ? 'payment-section-handover' : ''}">
    <div class="section-title-row"><div><span class="eyebrow">PAYMENTS</span><h2>Payment received</h2><p>Cash is automatic. Enter 0 when none.</p></div><div class="payment-total-box"><span>Total received</span><strong>RM ${sumCurrentPaymentActuals(state, cashAmount).toFixed(2)}</strong></div></div>
    <div class="payment-method-grid actual-only-grid">
      ${cashAutoCard(cashAmount)}
      ${payments.map((payment) => paymentCard(state, payment)).join('')}
    </div>
  </section>`;
}

function cashAutoCard(cashAmount) {
  return `<article class="payment-method-card actual-only cash-auto-payment"><div class="payment-method-head"><div><span>Payment method</span><h3>Cash</h3></div><span class="payment-status matched">Auto</span></div><div class="payment-auto-value"><span>From cash count</span><strong>RM ${Number(cashAmount || 0).toFixed(2)}</strong></div></article>`;
}

function paymentCard(state, payment) {
  const value = state.payments[payment.id] || { actual: '', remark: '' };
  const entered = value.actual !== '' && value.actual !== null && value.actual !== undefined;
  return `<article class="payment-method-card actual-only"><div class="payment-method-head"><div><span>Payment method</span><h3>${escapeHtml(payment.name)}</h3></div><span class="payment-status ${entered ? 'matched' : 'pending'}">${entered ? 'Entered' : 'Pending'}</span></div><label class="payment-actual-only"><span>Actual received</span><input id="payment-actual-${escapeHtml(payment.id)}" type="text" inputmode="decimal" autocomplete="off" data-payment-actual="${escapeHtml(payment.id)}" value="${escapeHtml(value.actual)}" placeholder="0.00"></label><label class="payment-remark">Remark <input id="payment-remark-${escapeHtml(payment.id)}" data-payment-remark="${escapeHtml(payment.id)}" value="${escapeHtml(value.remark)}" placeholder="Optional"></label></article>`;
}

function savedNotice(state, phase) {
  const saved = (state.data?.events || []).filter((event) => event.phase === phase);
  if (!saved.length) return '';
  const latest = saved[saved.length - 1];
  const total = phase === 'handover' ? latest.incomingTotal : latest.countedTotal;
  return `<div class="cash-readback-note">${icon('check', 17)}<div><strong>Saved record loaded</strong><span>${formatDateTime(latest.savedAt)} · RM ${money(total)}</span></div></div>`;
}

function denominationGrid(counts, scope) {
  return `<div class="denomination-grid">${DENOMINATIONS.map((value) => {
    const raw = counts[String(value)] ?? '';
    const count = Number(raw || 0);
    return `<label class="denomination"><span>RM ${value.toFixed(value < 1 ? 2 : 0)}</span><input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" data-cash-scope="${scope}" data-denomination="${value}" value="${escapeHtml(raw)}" placeholder="0"><small>RM ${(count * value).toFixed(2)}</small></label>`;
  }).join('')}</div>`;
}

function historyMarkup(events) {
  const sorted = [...events].sort((a, b) => String(a.savedAt || '').localeCompare(String(b.savedAt || '')));
  return `<section class="cash-history-section"><div class="section-title-row"><div><span class="eyebrow">HISTORY</span><h2>Today</h2></div><span class="history-count">${sorted.length}</span></div>${sorted.length ? `<div class="cash-history-list">${sorted.map(historyRow).join('')}</div>` : '<div class="empty-state compact-empty"><strong>No records yet.</strong></div>'}</section>`;
}

function historyRow(event) {
  const phase = event.phase || '';
  const amount = phase === 'handover' ? `RM ${money(event.outgoingTotal)} → RM ${money(event.incomingTotal)}` : `RM ${money(event.countedTotal)}`;
  const staff = phase === 'handover' ? `${event.fromStaff || '—'} → ${event.toStaff || '—'}` : event.countedBy || '—';
  return `<article class="cash-history-row"><div class="history-phase ${phase}">${escapeHtml(phase)}</div><div><strong>${amount}</strong><span>${escapeHtml(staff)}</span></div><div><strong>${formatDateTime(event.savedAt)}</strong><span>${escapeHtml(event.remark || '')}</span></div><div></div></article>`;
}

function resultMarkup(result) {
  return `<article class="submit-success"><div class="success-icon">${icon('check')}</div><div><span>Saved</span><strong>${escapeHtml(result.phase || 'Cash count')} · RM ${Number(result.displayTotal || 0).toFixed(2)}</strong><small>${escapeHtml(result.spreadsheetName || '')}</small></div><div class="success-actions">${result.spreadsheetUrl ? `<a class="button secondary" href="${result.spreadsheetUrl}" target="_blank" rel="noopener">Open report ${icon('external', 16)}</a>` : ''}</div></article>`;
}

export function buildCashPayload(state, outlet) {
  const common = { action: 'saveStandaloneCashCount', eventId: createId('cash'), businessDate: state.businessDate, outlet, phase: state.phase, remark: state.remarks[state.phase] || '' };
  if (state.phase === 'handover') {
    const outgoingTotal = cashTotal(state.outgoing, state.outgoingOther);
    const incomingTotal = cashTotal(state.incoming, state.incomingOther);
    return { ...common, fromStaff: state.handover.fromStaff, toStaff: state.handover.toStaff, countedBy: state.handover.toStaff, outgoingTotal, incomingTotal, outgoingDenominations: numericDenominations(state.outgoing), incomingDenominations: numericDenominations(state.incoming), outgoingOtherCash: Number(state.outgoingOther || 0), incomingOtherCash: Number(state.incomingOther || 0), denominations: numericDenominations(state.incoming), otherCash: Number(state.incomingOther || 0), payments: buildPaymentPayload(state, incomingTotal) };
  }

  const counts = state[state.phase];
  const otherCash = state[`${state.phase}Other`];
  const countedTotal = cashTotal(counts, otherCash);
  const payload = { ...common, countedBy: state.staff[state.phase], countedTotal, denominations: numericDenominations(counts), otherCash: Number(otherCash || 0) };
  if (state.phase === 'closing') payload.payments = buildPaymentPayload(state, countedTotal);
  return payload;
}

export function validateCash(state) {
  if (state.phase === 'handover') {
    if (!state.handover.fromStaff.trim() || !state.handover.toStaff.trim()) return 'Enter both staff names.';
  } else if (!state.staff[state.phase].trim()) {
    return 'Enter staff name.';
  }
  if (state.phase === 'handover' || state.phase === 'closing') {
    for (const payment of PAYMENT_METHODS) {
      const actual = state.payments[payment.id]?.actual;
      if (actual === '' || actual === null || actual === undefined) return `Enter ${payment.name}. Use 0 when none.`;
    }
  }
  return '';
}

export function cashTotal(counts, other = 0) {
  return DENOMINATIONS.reduce((sum, value) => sum + Number(counts[String(value)] || 0) * value, Number(other || 0));
}

function buildPaymentPayload(state, cashAmount) {
  return [{ id: 'cash', name: 'Cash', actual: Number(cashAmount || 0), remark: 'Auto from cash count', auto: true }, ...PAYMENT_METHODS.map((payment) => ({ id: payment.id, name: payment.name, actual: state.payments[payment.id]?.actual ?? '', remark: state.payments[payment.id]?.remark || '' }))];
}

function paymentMatches(canonical, backend) {
  const values = [backend?.id, backend?.name].map(normalizePaymentName).filter(Boolean);
  return values.includes(normalizePaymentName(canonical.id)) || values.includes(normalizePaymentName(canonical.name)) || canonical.aliases.some((alias) => values.includes(normalizePaymentName(alias)));
}

function normalizePaymentName(value) {
  return String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
}

function sumCurrentPaymentActuals(state, cashAmount = 0) {
  return Number(cashAmount || 0) + PAYMENT_METHODS.reduce((sum, payment) => {
    const value = state.payments[payment.id]?.actual;
    return sum + (value === '' || value === null || value === undefined ? 0 : Number(value || 0));
  }, 0);
}

function numericDenominations(values) {
  return Object.fromEntries(DENOMINATIONS.map((value) => [String(value), Number(values[String(value)] || 0)]));
}

function normalizeDenominations(values) {
  const result = emptyCounts();
  for (const value of DENOMINATIONS) {
    const raw = values?.[String(value)];
    result[String(value)] = raw === null || raw === undefined || Number(raw) === 0 ? '' : String(raw);
  }
  return result;
}

function numberOrBlank(value) {
  return value === '' || value === null || value === undefined || Number(value) === 0 ? '' : String(value);
}

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : '0.00';
}

function formatDateTime(value) {
  if (!value) return 'Saved';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat('en-MY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function cashSyncStatusMarkup(state) {
  const error = state.syncError || state.error;
  if (state.pendingSubmission) return '<div class="sync-strip pending"><span class="sync-dot"></span><div><strong>Saved on this device</strong><span>Upload continues in the background. Staff can keep using the form.</span></div></div>';
  if (state.syncing) return '<div class="sync-strip syncing"><span class="sync-dot"></span><div><strong>Syncing in the background</strong><span>The form is ready now. Existing Sheet records will appear when the read finishes.</span></div></div>';
  if (error) return '<div class="sync-strip warning"><span class="sync-dot"></span><div><strong>Google Sheet is temporarily unavailable</strong><span>Your form and drafts remain on this device.</span></div><button id="retry-cash">Retry sync</button></div>';
  return '';
}

function loadingMarkup() {
  return `<div class="loading-state"><span class="spinner"></span><strong>Loading saved cash count…</strong></div>`;
}

function errorMarkup(error) {
  return `<div class="error-state">${icon('alert')}<div><strong>Unable to load Cash Count</strong><span>${escapeHtml(error)}</span></div><button class="button secondary" id="retry-cash">Retry</button></div>`;
}

function emptyMarkup() {
  return `<div class="empty-state"><strong>Cash Count is ready to connect.</strong></div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
