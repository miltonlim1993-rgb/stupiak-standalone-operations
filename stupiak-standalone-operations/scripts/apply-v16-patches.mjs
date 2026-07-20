import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.6 build patch failed: ${label}`);
  return source.replace(search, replacement);
}

function replaceRegexRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`v1.6 build patch failed: ${label}`);
  return source.replace(pattern, replacement);
}

export async function applyV16Patches(dist) {
  const cashFile = resolve(dist, 'src/pages/cash.js');
  let cash = await readFile(cashFile, 'utf8');

  cash = replaceRequired(
    cash,
    'Opening, every handover, closing cash and all payment methods from the FeedMe report.',
    'Opening, handover and closing actual entries only. FeedMe backfill and Sheet formulas handle system and variance.',
    'cash page copy'
  );

  cash = replaceRequired(
    cash,
    "  const expectedClosing = nullableNumber(state.data?.summary?.expectedClosing);\n  const cashVariance = expectedClosing === null ? null : total - expectedClosing;\n\n",
    '',
    'remove closing comparison variables'
  );

  cash = replaceRequired(
    cash,
    "        <label>Remark ${isClosing && cashVariance !== null && Math.abs(cashVariance) > 0.009 ? '<em>Required when cash differs from expected closing</em>' : ''}<textarea id=\"cash-remark\" rows=\"3\" placeholder=\"Optional note\">${escapeHtml(remark)}</textarea></label>",
    "        <label>Remark <textarea id=\"cash-remark\" rows=\"3\" placeholder=\"Optional note\">${escapeHtml(remark)}</textarea></label>",
    'cash remark label'
  );

  cash = replaceRequired(
    cash,
    "        ${isClosing ? closingControlMarkup(state, total, expectedClosing) : '<p>Calculated from the denomination quantities below.</p>'}",
    "        ${isClosing ? '<p>Submit physical cash only. System, expected closing and variance are calculated in the Sheet after backfill.</p>' : '<p>Calculated from the denomination quantities below.</p>'}",
    'closing summary panel'
  );

  cash = replaceRequired(
    cash,
    '<div><span class="eyebrow">PAYMENT RECONCILIATION</span><h2>Actual payment received</h2><p>Methods are detected from the current FeedMe report template, not hard-coded in the website.</p></div>',
    '<div><span class="eyebrow">PAYMENT ENTRY</span><h2>Actual payment received</h2><p>Enter actual amounts only. System and variance remain controlled by FeedMe backfill and Sheet formulas.</p></div>',
    'payment section copy'
  );

  cash = replaceRegexRequired(
    cash,
    /function paymentCard\(state, payment\) \{[\s\S]*?\n\}\n\nfunction handoverMarkup/,
    `function paymentCard(state, payment) {
  const value = state.payments[payment.id] || { actual: '', remark: '' };
  const actualEntered = value.actual !== '' && value.actual !== null && value.actual !== undefined;
  return \`<article class="payment-method-card actual-only">
    <div class="payment-method-head">
      <div><span>Payment method</span><h3>\${escapeHtml(payment.name)}</h3></div>
      <span class="payment-status \${actualEntered ? 'matched' : 'pending'}">\${actualEntered ? 'Entered' : 'Pending'}</span>
    </div>
    <label class="payment-actual-only"><span>Actual received</span><input id="payment-actual-\${payment.id}" type="number" min="0" step="0.01" data-payment-actual="\${payment.id}" value="\${escapeHtml(value.actual)}" placeholder="0.00"></label>
    <label class="payment-remark">Remark <input id="payment-remark-\${payment.id}" data-payment-remark="\${payment.id}" value="\${escapeHtml(value.remark)}" placeholder="Optional"></label>
  </article>\`;
}

function handoverMarkup`,
    'actual-only payment cards'
  );

  cash = replaceRequired(
    cash,
    "    <article class=\"variance-card ${Math.abs(variance) > 0.009 ? 'warning' : 'ok'}\"><div><span>Handover variance</span><strong>${variance >= 0 ? '+' : '−'} RM ${Math.abs(variance).toFixed(2)}</strong></div><small>Incoming − outgoing</small></article>\n    <label>Remark ${Math.abs(variance) > 0.009 ? '<em>Required when variance is not zero</em>' : ''}<textarea id=\"cash-remark\" rows=\"3\">${escapeHtml(state.remarks.handover)}</textarea></label>",
    "    <article class=\"variance-card ${Math.abs(variance) > 0.009 ? 'warning' : 'ok'}\"><div><span>Handover difference</span><strong>${variance >= 0 ? '+' : '−'} RM ${Math.abs(variance).toFixed(2)}</strong></div><small>Incoming − outgoing, for staff reference only</small></article>\n    <label>Remark <textarea id=\"cash-remark\" rows=\"3\" placeholder=\"Optional note\">${escapeHtml(state.remarks.handover)}</textarea></label>",
    'handover no required variance remark'
  );

  cash = replaceRegexRequired(
    cash,
    /export function validateCash\(state\) \{[\s\S]*?\n\}\n\nexport function cashTotal/,
    `export function validateCash(state) {
  if (state.phase === 'handover') {
    if (!state.handover.fromStaff.trim() || !state.handover.toStaff.trim()) return 'Enter both handover staff names.';
    return '';
  }

  if (!state.staff[state.phase].trim()) return 'Enter the staff name before submitting.';

  if (state.phase === 'closing') {
    for (const payment of state.data?.payments || []) {
      const value = state.payments[payment.id] || {};
      if (value.actual === '' || value.actual === null || value.actual === undefined) return \`Enter the actual amount for \${payment.name}. Use 0 when there was no payment.\`;
    }
  }
  return '';
}

export function cashTotal`,
    'cash validation actual only'
  );

  cash = replaceRequired(
    cash,
    'Loading payment methods, existing values and handover history.',
    'Loading actual-entry fields and today history.',
    'cash loading copy'
  );

  await writeFile(cashFile, cash);

  const stockFile = resolve(dist, 'src/pages/stock.js');
  let stock = await readFile(stockFile, 'utf8');
  stock = replaceRequired(
    stock,
    'export function initializeStockValues(state, data) {\n  state.values = {};',
    'export function initializeStockValues(state, data) {\n  data.selectedWeek = weekPeriod(state.businessDate).index;\n  state.values = {};',
    'stock selected week override'
  );
  stock = replaceRequired(
    stock,
    "<p>Original spreadsheet order, units, minimum levels and Week 1–5 structure.</p>",
    "<p>Original spreadsheet order with calendar-style Monday–Sunday stock weeks.</p>",
    'stock page copy'
  );
  stock = replaceRequired(
    stock,
    "function weekPeriodForIndex(dateValue,index){const d=new Date(`${String(dateValue).slice(0,7)}-01T00:00:00`); const last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate(); const start=(index-1)*7+1; const end=Math.min(index*7,last); return `${start}–${end}`;}",
    "function weekPeriodForIndex(dateValue,index){const monthStart=new Date(`${String(dateValue).slice(0,7)}-01T00:00:00`); const offset=(monthStart.getDay()+6)%7; const start=new Date(monthStart.getFullYear(),monthStart.getMonth(),1-offset+(index-1)*7); const end=new Date(start.getFullYear(),start.getMonth(),start.getDate()+6); return `${formatDate(start,{year:false})}–${formatDate(end,{year:false})}`;}",
    'stock calendar week headers'
  );
  stock = replaceRequired(
    stock,
    "return { action:'submitStockCount', submissionId:createId('stock'), businessDate:state.businessDate, countedBy:state.countedBy, sessionNote:state.sessionNote, sections };",
    "return { action:'submitStockCount', submissionId:createId('stock'), businessDate:state.businessDate, weekIndex:weekPeriod(state.businessDate).index, countedBy:state.countedBy, sessionNote:state.sessionNote, sections };",
    'stock submit week index'
  );
  await writeFile(stockFile, stock);
}
