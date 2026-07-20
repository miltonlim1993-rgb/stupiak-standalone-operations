import { DENOMINATIONS } from '../config.js';
import { createId } from '../core/ids.js';
import { todayIso } from '../core/dates.js';
import { icon } from '../ui/icons.js';

function emptyCounts() { return Object.fromEntries(DENOMINATIONS.map((d) => [String(d), 0])); }
export function createCashState() {
  return {
    phase: 'opening', businessDate: todayIso(), countedBy: '', fromStaff: '', toStaff: '', remark: '',
    opening: emptyCounts(), closing: emptyCounts(), outgoing: emptyCounts(), incoming: emptyCounts(),
    openingOther: 0, closingOther: 0, outgoingOther: 0, incomingOther: 0,
    submitting: false, result: null
  };
}

export function cashPage(context, state) {
  const outlet = context.outlet || 'Load Stock once to identify outlet';
  const phases = [['opening','Opening'],['handover','Handover'],['closing','Closing']];
  return `
    <section class="page cash-page">
      <div class="page-heading"><div><span class="eyebrow">CASH COUNT</span><h1>${outlet}</h1><p>Each opening, handover and closing is stored as its own event.</p></div><div class="date-field"><label>Business date<input id="cash-date" type="date" value="${state.businessDate}"></label></div></div>
      <div class="segmented cash-phases">${phases.map(([key,label]) => `<button class="${state.phase === key ? 'active' : ''}" data-cash-phase="${key}">${label}</button>`).join('')}</div>
      ${state.phase === 'handover' ? handoverMarkup(state) : standardMarkup(state)}
      ${state.result ? resultMarkup(state.result) : ''}
    </section>`;
}

function standardMarkup(state) {
  const key = state.phase;
  const counts = state[key];
  const other = state[`${key}Other`];
  const total = cashTotal(counts, other);
  return `<div class="cash-layout">
    <article class="cash-card">
      <div class="cash-card-head"><div><span>${key === 'opening' ? 'Start of shift' : 'End of shift'}</span><h2>${key === 'opening' ? 'Opening cash' : 'Closing cash'}</h2></div><strong class="money-total">RM ${total.toFixed(2)}</strong></div>
      ${denominationGrid(counts, key)}
      <div class="form-grid two"><label>Other cash (RM)<input type="number" min="0" step="0.01" data-cash-other="${key}" value="${other || ''}"></label><label>Counted by<input type="text" id="cash-counted-by" value="${escapeHtml(state.countedBy)}" placeholder="Staff name"></label></div>
      <label>Remark<textarea id="cash-remark" rows="3" placeholder="Optional note">${escapeHtml(state.remark)}</textarea></label>
      <button class="button primary full" id="submit-cash" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Saving…' : `Submit ${key}`}</button>
    </article>
    <aside class="summary-panel"><span>Calculated total</span><strong>RM ${total.toFixed(2)}</strong><p>The amount is calculated from denomination quantities. Submit first, then send the confirmation to WhatsApp.</p></aside>
  </div>`;
}

function handoverMarkup(state) {
  const out = cashTotal(state.outgoing, state.outgoingOther);
  const incoming = cashTotal(state.incoming, state.incomingOther);
  const variance = incoming - out;
  return `<div class="handover-stack">
    <div class="handover-people form-grid two"><label>From staff<input id="cash-from-staff" value="${escapeHtml(state.fromStaff)}"></label><label>To staff<input id="cash-to-staff" value="${escapeHtml(state.toStaff)}"></label></div>
    <div class="cash-pair">
      <article class="cash-card compact"><div class="cash-card-head"><div><span>Outgoing count</span><h2>Cash handed over</h2></div><strong class="money-total">RM ${out.toFixed(2)}</strong></div>${denominationGrid(state.outgoing, 'outgoing')}<label>Other cash (RM)<input type="number" min="0" step="0.01" data-cash-other="outgoing" value="${state.outgoingOther || ''}"></label></article>
      <article class="cash-card compact"><div class="cash-card-head"><div><span>Incoming count</span><h2>Cash received</h2></div><strong class="money-total">RM ${incoming.toFixed(2)}</strong></div>${denominationGrid(state.incoming, 'incoming')}<label>Other cash (RM)<input type="number" min="0" step="0.01" data-cash-other="incoming" value="${state.incomingOther || ''}"></label></article>
    </div>
    <article class="variance-card ${Math.abs(variance) > 0.009 ? 'warning' : 'ok'}"><div><span>Handover variance</span><strong>${variance >= 0 ? '+' : '−'} RM ${Math.abs(variance).toFixed(2)}</strong></div><small>Incoming − outgoing</small></article>
    <label>Remark ${Math.abs(variance) > 0.009 ? '<em>Required when variance is not zero</em>' : ''}<textarea id="cash-remark" rows="3">${escapeHtml(state.remark)}</textarea></label>
    <button class="button primary full" id="submit-cash" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Saving…' : 'Submit handover'}</button>
  </div>`;
}

function denominationGrid(counts, scope) {
  return `<div class="denomination-grid">${DENOMINATIONS.map((value) => `<label class="denomination"><span>RM ${value.toFixed(value < 1 ? 2 : 0)}</span><input type="number" inputmode="numeric" min="0" step="1" data-cash-scope="${scope}" data-denomination="${value}" value="${Number(counts[String(value)] || 0) || ''}" placeholder="0"><small>RM ${(Number(counts[String(value)] || 0) * value).toFixed(2)}</small></label>`).join('')}</div>`;
}

function resultMarkup(result) {
  return `<article class="submit-success"><div class="success-icon">${icon('check')}</div><div><span>Saved successfully</span><strong>${escapeHtml(result.phase || 'Cash count')} · RM ${Number(result.displayTotal || 0).toFixed(2)}</strong><small>${escapeHtml(result.spreadsheetName || '')}</small></div><div class="success-actions">${result.spreadsheetUrl ? `<a class="button secondary" href="${result.spreadsheetUrl}" target="_blank" rel="noopener">Open Sheet ${icon('external',16)}</a>` : ''}${result.whatsappShareUrl ? `<a class="button whatsapp" href="${result.whatsappShareUrl}" target="_blank" rel="noopener">${icon('whatsapp',18)} Send to WhatsApp</a>` : ''}</div></article>`;
}

export function cashTotal(counts, other = 0) {
  return DENOMINATIONS.reduce((sum, value) => sum + Number(counts[String(value)] || 0) * value, Number(other || 0));
}

export function buildCashPayload(state, outlet) {
  const common = { action: 'saveStandaloneCashCount', eventId: createId('cash'), businessDate: state.businessDate, outlet, phase: state.phase, remark: state.remark };
  if (state.phase === 'handover') {
    const outgoingTotal = cashTotal(state.outgoing, state.outgoingOther);
    const incomingTotal = cashTotal(state.incoming, state.incomingOther);
    return { ...common, fromStaff: state.fromStaff, toStaff: state.toStaff, countedBy: state.toStaff, outgoingTotal, incomingTotal, outgoingDenominations: state.outgoing, incomingDenominations: state.incoming, outgoingOtherCash: state.outgoingOther, incomingOtherCash: state.incomingOther, denominations: state.incoming, otherCash: state.incomingOther };
  }
  const counts = state[state.phase];
  const otherCash = state[`${state.phase}Other`];
  return { ...common, countedBy: state.countedBy, countedTotal: cashTotal(counts, otherCash), denominations: counts, otherCash };
}

function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
