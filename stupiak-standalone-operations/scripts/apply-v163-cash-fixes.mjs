import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.6.3 cash fix failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV163CashFixes(dist) {
  await patchCashPage(dist);
  await patchMainRuntime(dist);
}

async function patchCashPage(dist) {
  const file = resolve(dist, 'src/pages/cash.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `    payments: emptyPaymentValues(),\n    submitting: false,`,
    `    payments: emptyPaymentValues(),\n    handoverPayments: emptyPaymentValues(),\n    submitting: false,`,
    'handover payment state'
  );

  source = replaceRequired(
    source,
    `  state.payments = {};\n  for (const payment of data.payments || []) {\n    state.payments[payment.id] = {\n      actual: payment.actual === '' || payment.actual === null || payment.actual === undefined ? '' : String(payment.actual),\n      remark: payment.remark || ''\n    };\n  }`,
    `  state.payments = {};\n  state.handoverPayments = {};\n  for (const payment of data.payments || []) {\n    state.payments[payment.id] = {\n      actual: payment.actual === '' || payment.actual === null || payment.actual === undefined ? '' : String(payment.actual),\n      remark: payment.remark || ''\n    };\n    state.handoverPayments[payment.id] = { actual: '', remark: '' };\n  }`,
    'initialize phase payment values'
  );

  source = replaceRequired(
    source,
    `${'${'}isClosing ? paymentActualMarkup(state) : ''}`,
    `${'${'}isClosing ? paymentActualMarkup(state, 'closing') : ''}`,
    'closing payment section phase'
  );

  const oldPaymentFunctions = `function paymentActualMarkup(state) {\n  const payments = state.data?.payments || [];\n  if (!payments.length) {\n    return \`<article class="cash-card payment-empty"><strong>No payment methods detected</strong><p>The Cash GAS could not find payment actual columns in _RelationDaily.</p></article>\`;\n  }\n  return \`<section class="payment-section">\n    <div class="section-title-row">\n      <div><span class="eyebrow">PAYMENT ACTUAL ENTRY</span><h2>Other payment received</h2><p>Enter actual payment only. System and variance remain in the Sheet.</p></div>\n      <div class="payment-total-box"><span>Actual total</span><strong>RM ${'${'}sumCurrentPaymentActuals(state).toFixed(2)}</strong></div>\n    </div>\n    <div class="payment-method-grid actual-only-grid">${'${'}payments.map((payment) => paymentCard(state, payment)).join('')}</div>\n  </section>\`;\n}\n\nfunction paymentCard(state, payment) {\n  const value = state.payments[payment.id] || { actual: '', remark: '' };\n  const actualEntered = value.actual !== '' && value.actual !== null && value.actual !== undefined;\n  return \`<article class="payment-method-card actual-only">\n    <div class="payment-method-head">\n      <div><span>Payment method</span><h3>${'${'}escapeHtml(payment.name)}</h3></div>\n      <span class="payment-status ${'${'}actualEntered ? 'matched' : 'pending'}">${'${'}actualEntered ? 'Entered' : 'Pending'}</span>\n    </div>\n    <label class="payment-actual-only"><span>Actual received</span><input id="payment-actual-${'${'}payment.id}" type="text" inputmode="decimal" autocomplete="off" data-payment-actual="${'${'}payment.id}" value="${'${'}escapeHtml(value.actual)}" placeholder="0.00"></label>\n    <label class="payment-remark">Remark <input id="payment-remark-${'${'}payment.id}" data-payment-remark="${'${'}payment.id}" value="${'${'}escapeHtml(value.remark)}" placeholder="Optional"></label>\n  </article>\`;\n}`;

  const newPaymentFunctions = `function paymentActualMarkup(state, phase) {\n  const payments = state.data?.payments || [];\n  if (!payments.length) {\n    return \`<article class="cash-card payment-empty"><strong>No payment methods detected</strong><p>The Cash GAS could not find payment actual columns in _RelationDaily.</p></article>\`;\n  }\n  const title = phase === 'handover' ? 'Handover payment received' : 'Closing payment received';\n  const copy = phase === 'handover'\n    ? 'Enter payment actuals received at this handover. Each handover is saved as its own event.'\n    : 'Enter closing payment actuals only. System and variance remain in the Sheet.';\n  return \`<section class="payment-section payment-section-${'${'}phase}">\n    <div class="section-title-row">\n      <div><span class="eyebrow">PAYMENT ACTUAL ENTRY</span><h2>${'${'}title}</h2><p>${'${'}copy}</p></div>\n      <div class="payment-total-box" data-payment-total="${'${'}phase}"><span>Actual total</span><strong>RM ${'${'}sumCurrentPaymentActuals(state, phase).toFixed(2)}</strong></div>\n    </div>\n    <div class="payment-method-grid actual-only-grid">${'${'}payments.map((payment) => paymentCard(state, payment, phase)).join('')}</div>\n  </section>\`;\n}\n\nfunction paymentCard(state, payment, phase) {\n  const collection = phase === 'handover' ? state.handoverPayments : state.payments;\n  const value = collection[payment.id] || { actual: '', remark: '' };\n  const actualEntered = value.actual !== '' && value.actual !== null && value.actual !== undefined;\n  return \`<article class="payment-method-card actual-only">\n    <div class="payment-method-head">\n      <div><span>Payment method</span><h3>${'${'}escapeHtml(payment.name)}</h3></div>\n      <span class="payment-status ${'${'}actualEntered ? 'matched' : 'pending'}">${'${'}actualEntered ? 'Entered' : 'Pending'}</span>\n    </div>\n    <label class="payment-actual-only"><span>Actual received</span><input id="payment-actual-${'${'}phase}-${'${'}payment.id}" type="text" inputmode="decimal" autocomplete="off" data-payment-actual="${'${'}payment.id}" data-payment-phase="${'${'}phase}" value="${'${'}escapeHtml(value.actual)}" placeholder="0.00"></label>\n    <label class="payment-remark"><span>Remark</span><input id="payment-remark-${'${'}phase}-${'${'}payment.id}" data-payment-remark="${'${'}payment.id}" data-payment-phase="${'${'}phase}" value="${'${'}escapeHtml(value.remark)}" placeholder="Optional"></label>\n  </article>\`;\n}`;

  source = replaceRequired(source, oldPaymentFunctions, newPaymentFunctions, 'payment cards and phase support');

  source = replaceRequired(
    source,
    `    <article class="variance-card ${'${'}Math.abs(variance) > 0.009 ? 'warning' : 'ok'}"><div><span>Handover difference</span><strong>${'${'}variance >= 0 ? '+' : '−'} RM ${'${'}Math.abs(variance).toFixed(2)}</strong></div><small>Incoming − outgoing, for staff reference only</small></article>\n    <label>Remark <textarea id="cash-remark" rows="3" placeholder="Optional note">${'${'}escapeHtml(state.remarks.handover)}</textarea></label>`,
    `    <article class="variance-card ${'${'}Math.abs(variance) > 0.009 ? 'warning' : 'ok'}"><div><span>Handover difference</span><strong>${'${'}variance >= 0 ? '+' : '−'} RM ${'${'}Math.abs(variance).toFixed(2)}</strong></div><small>Incoming − outgoing, for staff reference only</small></article>\n    ${'${'}paymentActualMarkup(state, 'handover')}\n    <label class="handover-remark">Remark <textarea id="cash-remark" rows="3" placeholder="Optional note">${'${'}escapeHtml(state.remarks.handover)}</textarea></label>`,
    'handover payment section'
  );

  source = replaceRequired(
    source,
    `      denominations: numericDenominations(state.incoming),\n      otherCash: Number(state.incomingOther || 0)\n    };`,
    `      denominations: numericDenominations(state.incoming),\n      otherCash: Number(state.incomingOther || 0),\n      payments: (state.data?.payments || []).map((payment) => ({\n        id: payment.id,\n        name: payment.name,\n        actual: state.handoverPayments[payment.id]?.actual ?? '',\n        remark: state.handoverPayments[payment.id]?.remark || ''\n      }))\n    };`,
    'handover payment payload'
  );

  source = replaceRequired(
    source,
    `  if (state.phase === 'handover') {\n    if (!state.handover.fromStaff.trim() || !state.handover.toStaff.trim()) return 'Enter both handover staff names.';\n    return '';\n  }`,
    `  if (state.phase === 'handover') {\n    if (!state.handover.fromStaff.trim() || !state.handover.toStaff.trim()) return 'Enter both handover staff names.';\n    for (const payment of state.data?.payments || []) {\n      const value = state.handoverPayments[payment.id] || {};\n      if (value.actual === '' || value.actual === null || value.actual === undefined) return \`Enter the handover amount for ${'${'}payment.name}. Use 0 when there was no payment.\`;\n    }\n    return '';\n  }`,
    'handover payment validation'
  );

  source = replaceRequired(
    source,
    `function sumCurrentPaymentActuals(state) {\n  return (state.data?.payments || []).reduce((sum, payment) => {\n    const value = state.payments[payment.id]?.actual;\n    return sum + (value === '' || value === null || value === undefined ? 0 : Number(value || 0));\n  }, 0);\n}`,
    `function sumCurrentPaymentActuals(state, phase = 'closing') {\n  const collection = phase === 'handover' ? state.handoverPayments : state.payments;\n  return (state.data?.payments || []).reduce((sum, payment) => {\n    const value = collection[payment.id]?.actual;\n    return sum + (value === '' || value === null || value === undefined ? 0 : Number(value || 0));\n  }, 0);\n}`,
    'phase payment total'
  );

  source = replaceRequired(
    source,
    `${'${'}formatDateTime(event.savedAt)}`,
    `${'${'}formatEventDateTime(event)}`,
    'history timestamp rendering'
  );

  source = replaceRequired(
    source,
    `function formatDateTime(value) {\n  if (!value) return 'Saved';\n  const date = new Date(value);\n  if (Number.isNaN(date.getTime())) return escapeHtml(value);\n  return new Intl.DateTimeFormat('en-MY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);\n}`,
    `function formatEventDateTime(event) {\n  const value = event?.savedAt || '';\n  const isLegacyMidnight = event?.source === 'relation-daily-readback' && /T00:00:00(?:\\.000)?(?:Z|[+-]\\d{2}:?\\d{2})?$/.test(String(value));\n  if (isLegacyMidnight) {\n    const date = new Date(\`${'${'}event.businessDate}T00:00:00+08:00\`);\n    return \`${'${'}new Intl.DateTimeFormat('en-MY', { day: '2-digit', month: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(date)} · time not recorded\`;\n  }\n  return formatDateTime(value);\n}\n\nfunction formatDateTime(value) {\n  if (!value) return 'Saved';\n  const date = new Date(value);\n  if (Number.isNaN(date.getTime())) return escapeHtml(value);\n  return new Intl.DateTimeFormat('en-MY', {\n    day: '2-digit',\n    month: 'short',\n    hour: '2-digit',\n    minute: '2-digit',\n    hour12: true,\n    timeZone: 'Asia/Kuala_Lumpur'\n  }).format(date);\n}`,
    'Malaysia timestamp formatting'
  );

  await writeFile(file, source);
}

async function patchMainRuntime(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `  document.querySelectorAll('[data-payment-actual]').forEach((element) => {\n    element.addEventListener('focus', (event) => event.target.select?.());\n    element.addEventListener('input', (event) => {\n      const id = event.target.dataset.paymentActual;\n      const cleaned = normalizeMoneyInput(event.target.value);\n      if (event.target.value !== cleaned) event.target.value = cleaned;\n      state.cash.payments[id].actual = cleaned;\n      updatePaymentInputPreview(event.target, id);\n    });\n  });\n  document.querySelectorAll('[data-payment-remark]').forEach((element) => element.addEventListener('input', (event) => {\n    const id = event.target.dataset.paymentRemark;\n    state.cash.payments[id].remark = event.target.value;\n  }));`,
    `  document.querySelectorAll('[data-payment-actual]').forEach((element) => {\n    element.addEventListener('focus', (event) => event.target.select?.());\n    element.addEventListener('input', (event) => {\n      const id = event.target.dataset.paymentActual;\n      const phase = event.target.dataset.paymentPhase || state.cash.phase;\n      const collection = phase === 'handover' ? state.cash.handoverPayments : state.cash.payments;\n      if (!collection[id]) collection[id] = { actual: '', remark: '' };\n      const cleaned = normalizeMoneyInput(event.target.value);\n      if (event.target.value !== cleaned) event.target.value = cleaned;\n      collection[id].actual = cleaned;\n      updatePaymentInputPreview(event.target, id, phase);\n    });\n  });\n  document.querySelectorAll('[data-payment-remark]').forEach((element) => element.addEventListener('input', (event) => {\n    const id = event.target.dataset.paymentRemark;\n    const phase = event.target.dataset.paymentPhase || state.cash.phase;\n    const collection = phase === 'handover' ? state.cash.handoverPayments : state.cash.payments;\n    if (!collection[id]) collection[id] = { actual: '', remark: '' };\n    collection[id].remark = event.target.value;\n  }));`,
    'phase-aware payment binding'
  );

  source = replaceRequired(
    source,
    `function updatePaymentInputPreview(input, id) {\n  const actualText = state.cash.payments[id]?.actual;\n  const actual = actualText === '' || actualText === null || actualText === undefined ? null : Number(actualText);\n  const card = input.closest('.payment-method-card');\n  const status = card?.querySelector('.payment-status');\n  if (status) {\n    status.textContent = actual === null ? 'Pending' : 'Entered';\n    status.className = \`payment-status ${'${'}actual === null ? 'pending' : 'matched'}\`;\n  }\n  const total = (state.cash.data?.payments || []).reduce((sum, item) => {\n    const value = state.cash.payments[item.id]?.actual;\n    return sum + (value === '' || value === null || value === undefined ? 0 : Number(value || 0));\n  }, 0);\n  const totalNode = document.querySelector('.payment-total-box strong');\n  if (totalNode) totalNode.textContent = \`RM ${'${'}total.toFixed(2)}\`;\n}`,
    `function updatePaymentInputPreview(input, id, phase = state.cash.phase) {\n  const collection = phase === 'handover' ? state.cash.handoverPayments : state.cash.payments;\n  const actualText = collection[id]?.actual;\n  const actual = actualText === '' || actualText === null || actualText === undefined ? null : Number(actualText);\n  const card = input.closest('.payment-method-card');\n  const status = card?.querySelector('.payment-status');\n  if (status) {\n    status.textContent = actual === null ? 'Pending' : 'Entered';\n    status.className = \`payment-status ${'${'}actual === null ? 'pending' : 'matched'}\`;\n  }\n  const total = (state.cash.data?.payments || []).reduce((sum, item) => {\n    const value = collection[item.id]?.actual;\n    return sum + (value === '' || value === null || value === undefined ? 0 : Number(value || 0));\n  }, 0);\n  const totalNode = document.querySelector(\`[data-payment-total="${'${'}phase}"] strong\`);\n  if (totalNode) totalNode.textContent = \`RM ${'${'}total.toFixed(2)}\`;\n}`,
    'phase payment live total'
  );

  await writeFile(file, source);
}
