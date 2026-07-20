import { DENOMINATIONS } from '../config.js';
import { createId } from '../core/ids.js';
import { todayIso } from '../core/dates.js';
import { icon } from '../ui/icons.js';

function emptyCounts() {
  return Object.fromEntries(DENOMINATIONS.map((value) => [String(value), '']));
}

function emptyPaymentValues() {
  return {};
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

export function initializeCashFromBootstrap(state, data) {
  state.data = data;
  state.error = '';
  state.payments = {};
  for (const payment of data.payments || []) {
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
    state.remarks.closing = closing.remark || data.summary?.closeUpNote || data.summary?.dailyRemark || '';
  } else {
    state.closing = emptyCounts();
    state.closingOther = '';
    state.staff.closing = data.summary?.preparedBy || '';
    state.remarks.closing = data.summary?.closeUpNote || data.summary?.dailyRemark || '';
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
        <div>
          <span class="eyebrow">CASH COUNT</span>
          <h1>${escapeHtml(outlet)}</h1>
          <p>Actual-only entry. FeedMe backfill and the Google Sheet handle all system, variance and issue formulas.</p>
        </div>
        <div class="date-field"><label>Business date<input id="cash-date" type="date" value="${state.businessDate}"></label></div>
      </div>
      <div class="segmented cash-phases">${phases.map(([key, label]) => `<button class="${state.phase === key ? 'active' : ''}" data-cash-phase="${key}">${label}</button>`).join('')}</div>
      ${state.loading ? loadingMarkup() : state.error ? errorMarkup(state.error) : state.data ? cashContent(state) : emptyMarkup()}
      ${state.result ? resultMarkup(state.result) : ''}
    </section>`;
}

function cashContent(state) {
  return `
    ${state.phase === 'handover' ? handoverMarkup(state) : standardMarkup(state)}
    ${historyMarkup(state.data?.events || [])}`;
}

function standardMarkup(state) {
  const key = state.phase;
  const counts = state[key];
  const other = state[`${key}Other`];
  const total = cashTotal(counts, other);
  const isClosing = key === 'closing';
  const staff = state.staff[key] || '';
  const remark = state.remarks[key] || '';

  return `<div class="cash-full-stack">
    <div class="cash-layout">
      <article class="cash-card">
        <div class="cash-card-head">
          <div><span>${key === 'opening' ? 'Start of shift' : 'End of shift'}</span><h2>${key === 'opening' ? 'Opening cash' : 'Physical closing cash'}</h2></div>
          <strong class="money-total">RM ${total.toFixed(2)}</strong>
        </div>
        ${savedNotice(state, key)}
        ${denominationGrid(counts, key)}
        <div class="form-grid two">
          <label>Other cash (RM)<input type="number" min="0" step="0.01" data-cash-other="${key}" value="${escapeHtml(other)}"></label>
          <label>Counted by<input type="text" id="cash-counted-by" value="${escapeHtml(staff)}" placeholder="Staff name"></label>
        </div>
        <label>Remark<textarea id="cash-remark" rows="3" placeholder="Optional note">${escapeHtml(remark)}</textarea></label>
      </article>
      <aside class="summary-panel cash-control-panel">
        <span>${isClosing ? 'Physical cash counted' : 'Calculated total'}</span>
        <strong>RM ${total.toFixed(2)}</strong>
        <p>No system or variance check is shown here. The Sheet calculates those after FeedMe backfill.</p>
      </aside>
    </div>
    ${isClosing ? paymentActualMarkup(state) : ''}
    <button class="button primary full cash-submit-main" id="submit-cash" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Saving…' : `Submit ${key}`}</button>
  </div>`;
}

function savedNotice(state, phase) {
  const saved = (state.data?.events || []).filter((event) => event.phase === phase);
  if (!saved.length) return '';
  const latest = saved[saved.length - 1];
  const total = phase === 'handover' ? latest.incomingTotal : latest.countedTotal;
  return `<div class="cash-readback-note">${icon('check', 17)}<div><strong>Existing record loaded</strong><span>${formatDateTime(latest.savedAt)} · RM ${money(total)}</span></div></div>`;
}

function paymentActualMarkup(state) {
  const payments = state.data?.payments || [];
  if (!payments.length) {
    return `<article class="cash-card payment-empty"><strong>No payment methods detected</strong><p>The Cash GAS could not find payment actual columns in _RelationDaily.</p></article>`;
  }
  return `<section class="payment-section">
    <div class="section-title-row">
      <div><span class="eyebrow">PAYMENT ACTUAL ENTRY</span><h2>Other payment received</h2><p>Enter actual payment only. System and variance remain in the Sheet.</p></div>
      <div class="payment-total-box"><span>Actual total</span><strong>RM ${sumCurrentPaymentActuals(state).toFixed(2)}</strong></div>
    </div>
    <div class="payment-method-grid actual-only-grid">${payments.map((payment) => paymentCard(state, payment)).join('')}</div>
  </section>`;
}

function paymentCard(state, payment) {
  const value = state.payments[payment.id] || { actual: '', remark: '' };
  return `<article class="payment-method-card actual-only">
    <div class="payment-method-head">
      <div><span>Payment method</span><h3>${escapeHtml(payment.name)}</h3></div>
      <span class="payment-status ${value.actual === '' ? 'pending' : 'matched'}">${value.actual === '' ? 'Pending' : 'Entered'}</span>
    </div>
    <div class="payment-values actual-only-values">
      <label><span>Actual</span><input id="payment-actual-${payment.id}" type="number" min="0" step="0.01" data-payment-actual="${payment.id}" value="${escapeHtml(value.actual)}" placeholder="0.00"></label>
    </div>
    <label class="payment-remark">Remark <input id="payment-remark-${payment.id}" data-payment-remark="${payment.id}" value="${escapeHtml(value.remark)}" placeholder="Optional"></label>
  </article>`;
}

function handoverMarkup(state) {
  const outgoing = cashTotal(state.outgoing, state.outgoingOther);
  const incoming = cashTotal(state.incoming, state.incomingOther);
  const variance = incoming - outgoing;
  const handovers = (state.data?.events || []).filter((event) => event.phase === 'handover');
  return `<div class="handover-stack">
    ${handovers.length ? `<div class="cash-readback-note">${icon('check', 17)}<div><strong>${handovers.length} handover${handovers.length === 1 ? '' : 's'} already saved</strong><span>Every handover remains in Today History below. This form creates a new event.</span></div></div>` : ''}
    <div class="handover-people form-grid two">
      <label>From staff<input id="cash-from-staff" value="${escapeHtml(state.handover.fromStaff)}"></label>
      <label>To staff<input id="cash-to-staff" value="${escapeHtml(state.handover.toStaff)}"></label>
    </div>
    <div class="cash-pair">
      <article class="cash-card compact">
        <div class="cash-card-head"><div><span>Outgoing count</span><h2>Cash handed over</h2></div><strong class="money-total">RM ${outgoing.toFixed(2)}</strong></div>
        ${denominationGrid(state.outgoing, 'outgoing')}
        <label>Other cash (RM)<input type="number" min="0" step="0.01" data-cash-other="outgoing" value="${escapeHtml(state.outgoingOther)}"></label>
      </article>
      <article class="cash-card compact">
        <div class="cash-card-head"><div><span>Incoming count</span><h2>Cash received</h2></div><strong class="money-total">RM ${incoming.toFixed(2)}</strong></div>
        ${denominationGrid(state.incoming, 'incoming')}
        <label>Other cash (RM)<input type="number" min="0" step="0.01" data-cash-other="incoming" value="${escapeHtml(state.incomingOther)}"></label>
      </article>
    </div>
    <article class="variance-card ${Math.abs(variance) > 0.009 ? 'warning' : 'ok'}"><div><span>Handover variance</span><strong>${variance >= 0 ? '+' : '−'} RM ${Math.abs(variance).toFixed(2)}</strong></div><small>Incoming − outgoing</small></article>
    <label>Remark ${Math.abs(variance) > 0.009 ? '<em>Required when variance is not zero</em>' : ''}<textarea id="cash-remark" rows="3">${escapeHtml(state.remarks.handover)}</textarea></label>
    <button class="button primary full" id="submit-cash" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Saving…' : 'Submit new handover'}</button>
  </div>`;
}

function denominationGrid(counts, scope) {
  return `<div class="denomination-grid">${DENOMINATIONS.map((value) => {
    const raw = counts[String(value)] ?? '';
    const count = Number(raw || 0);
    return `<label class="denomination"><span>RM ${value.toFixed(value < 1 ? 2 : 0)}</span><input type="number" inputmode="numeric" min="0" step="1" data-cash-scope="${scope}" data-denomination="${value}" value="${escapeHtml(raw)}" placeholder="0"><small>RM ${(count * value).toFixed(2)}</small></label>`;
  }).join('')}</div>`;
}

function historyMarkup(events) {
  const sorted = [...events].sort((a, b) => String(a.savedAt || '').localeCompare(String(b.savedAt || '')));
  return `<section class="cash-history-section">
    <div class="section-title-row"><div><span class="eyebrow">READ BACK</span><h2>Today history</h2><p>Opening, every handover and closing saved in the yearly FeedMe report.</p></div><span class="history-count">${sorted.length} record${sorted.length === 1 ? '' : 's'}</span></div>
    ${sorted.length ? `<div class="cash-history-list">${sorted.map(historyRow).join('')}</div>` : '<div class="empty-state compact-empty"><strong>No cash records for this date.</strong><span>The first submission will appear here.</span></div>'}
  </section>`;
}

function historyRow(event) {
  const phase = event.phase || '';
  const amount = phase === 'handover'
    ? `RM ${money(event.outgoingTotal)} → RM ${money(event.incomingTotal)}`
    : `RM ${money(event.countedTotal)}`;
  const staff = phase === 'handover'
    ? `${event.fromStaff || '—'} → ${event.toStaff || '—'}`
    : event.countedBy || '—';
  return `<article class="cash-history-row">
    <div class="history-phase ${phase}">${escapeHtml(phase)}</div>
    <div><strong>${amount}</strong><span>${escapeHtml(staff)}</span></div>
    <div><strong>${formatDateTime(event.savedAt)}</strong><span>${escapeHtml(event.remark || '')}</span></div>
    ${phase === 'handover' ? `<div class="${Math.abs(Number(event.variance || 0)) > 0.009 ? 'negative' : ''}"><strong>${Number(event.variance || 0) >= 0 ? '+' : '−'} RM ${Math.abs(Number(event.variance || 0)).toFixed(2)}</strong><span>Variance</span></div>` : '<div></div>'}
  </article>`;
}

function resultMarkup(result) {
  return `<article class="submit-success">
    <div class="success-icon">${icon('check')}</div>
    <div><span>Saved successfully</span><strong>${escapeHtml(result.phase || 'Cash count')} · RM ${Number(result.displayTotal || 0).toFixed(2)}</strong><small>${escapeHtml(result.spreadsheetName || '')}</small></div>
    <div class="success-actions">
      ${result.spreadsheetUrl ? `<a class="button secondary" href="${result.spreadsheetUrl}" target="_blank" rel="noopener">Open FeedMe Report ${icon('external', 16)}</a>` : ''}
      ${result.whatsappShareUrl ? `<a class="button whatsapp" href="${result.whatsappShareUrl}" target="_blank" rel="noopener">${icon('whatsapp', 18)} Send to WhatsApp</a>` : ''}
    </div>
  </article>`;
}

export function buildCashPayload(state, outlet) {
  const common = {
    action: 'saveStandaloneCashCount',
    eventId: createId('cash'),
    businessDate: state.businessDate,
    outlet,
    phase: state.phase,
    remark: state.remarks[state.phase] || ''
  };

  if (state.phase === 'handover') {
    const outgoingTotal = cashTotal(state.outgoing, state.outgoingOther);
    const incomingTotal = cashTotal(state.incoming, state.incomingOther);
    return {
      ...common,
      fromStaff: state.handover.fromStaff,
      toStaff: state.handover.toStaff,
      countedBy: state.handover.toStaff,
      outgoingTotal,
      incomingTotal,
      outgoingDenominations: numericDenominations(state.outgoing),
      incomingDenominations: numericDenominations(state.incoming),
      outgoingOtherCash: Number(state.outgoingOther || 0),
      incomingOtherCash: Number(state.incomingOther || 0),
      denominations: numericDenominations(state.incoming),
      otherCash: Number(state.incomingOther || 0)
    };
  }

  const counts = state[state.phase];
  const otherCash = state[`${state.phase}Other`];
  const payload = {
    ...common,
    countedBy: state.staff[state.phase],
    countedTotal: cashTotal(counts, otherCash),
    denominations: numericDenominations(counts),
    otherCash: Number(otherCash || 0)
  };

  if (state.phase === 'closing') {
    payload.payments = (state.data?.payments || []).map((payment) => ({
      id: payment.id,
      name: payment.name,
      actual: state.payments[payment.id]?.actual ?? '',
      remark: state.payments[payment.id]?.remark || ''
    }));
  }
  return payload;
}

export function validateCash(state) {
  if (state.phase === 'handover') {
    if (!state.handover.fromStaff.trim() || !state.handover.toStaff.trim()) return 'Enter both handover staff names.';
    const variance = cashTotal(state.incoming, state.incomingOther) - cashTotal(state.outgoing, state.outgoingOther);
    if (Math.abs(variance) > 0.009 && !state.remarks.handover.trim()) return 'A handover remark is required when the variance is not zero.';
    return '';
  }

  if (!state.staff[state.phase].trim()) return 'Enter the staff name before submitting.';

  if (state.phase === 'closing') {
    for (const payment of state.data?.payments || []) {
      const value = state.payments[payment.id] || {};
      if (value.actual === '' || value.actual === null || value.actual === undefined) return `Enter the actual amount for ${payment.name}. Use 0 when there was no payment.`;
    }
  }
  return '';
}

export function cashTotal(counts, other = 0) {
  return DENOMINATIONS.reduce((sum, value) => sum + Number(counts[String(value)] || 0) * value, Number(other || 0));
}

function numericDenominations(values) {
  return Object.fromEntries(DENOMINATIONS.map((value) => [String(value), Number(values[String(value)] || 0)]));
}

function normalizeDenominations(values) {
  const result = emptyCounts();
  for (const value of DENOMINATIONS) {
    const raw = values?.[String(value)];
    result[String(value)] = raw === null || raw === undefined || raw === 0 ? (raw === 0 ? '0' : '') : String(raw);
  }
  return result;
}

function sumCurrentPaymentActuals(state) {
  return (state.data?.payments || []).reduce((sum, payment) => {
    const value = state.payments[payment.id]?.actual;
    return sum + (value === '' || value === null || value === undefined ? 0 : Number(value || 0));
  }, 0);
}

function numberOrBlank(value) {
  return value === '' || value === null || value === undefined ? '' : String(value);
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

function loadingMarkup() {
  return `<div class="loading-state"><span class="spinner"></span><strong>Reading cash actual history…</strong><small>Loading saved opening, handovers, closing and payment method names.</small></div>`;
}

function errorMarkup(error) {
  return `<div class="error-state">${icon('alert')}<div><strong>Unable to load Cash Count</strong><span>${escapeHtml(error)}</span></div><button class="button secondary" id="retry-cash">Retry</button></div>`;
}

function emptyMarkup() {
  return `<div class="empty-state"><strong>Cash Count is ready to connect.</strong><span>Cloudflare must contain CASH_GAS_URL and CASH_GAS_SECRET.</span></div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
