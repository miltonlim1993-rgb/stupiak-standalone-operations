import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.4 build patch failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV14Patches(dist) {
  await patchCashPage(dist);
  await patchMainRuntime(dist);
}

async function patchCashPage(dist) {
  const file = resolve(dist, 'src/pages/cash.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    "${isClosing ? paymentReconciliationMarkup(state) : ''}",
    "${isClosing ? paymentReconciliationMarkup(state, 'closing') : ''}",
    'closing payment render'
  );

  source = replaceRequired(
    source,
    "function paymentReconciliationMarkup(state) {\n  const payments = state.data?.payments || [];",
    "function paymentReconciliationMarkup(state, mode = 'closing') {\n  const payments = state.data?.payments || [];\n  const isHandover = mode === 'handover';",
    'payment renderer signature'
  );

  source = replaceRequired(
    source,
    '<div><span class="eyebrow">PAYMENT RECONCILIATION</span><h2>Actual payment received</h2><p>Methods are detected from the current FeedMe report template, not hard-coded in the website.</p></div>',
    '<div><span class="eyebrow">${isHandover ? \'PAYMENT HANDOVER\' : \'PAYMENT RECONCILIATION\'}</span><h2>${isHandover ? \'Payment snapshot at handover\' : \'Actual payment received\'}</h2><p>${isHandover ? \'Record the current actual total for every payment method before the next staff takes over. These values are saved in handover history and read back at closing.\' : \'Methods are detected from the current FeedMe report template, not hard-coded in the website.\'}</p></div>',
    'payment renderer heading'
  );

  source = replaceRequired(
    source,
    "    <article class=\"variance-card ${Math.abs(variance) > 0.009 ? 'warning' : 'ok'}\"><div><span>Handover variance</span><strong>${variance >= 0 ? '+' : '−'} RM ${Math.abs(variance).toFixed(2)}</strong></div><small>Incoming − outgoing</small></article>\n    <label>Remark",
    "    <article class=\"variance-card ${Math.abs(variance) > 0.009 ? 'warning' : 'ok'}\"><div><span>Handover variance</span><strong>${variance >= 0 ? '+' : '−'} RM ${Math.abs(variance).toFixed(2)}</strong></div><small>Incoming − outgoing</small></article>\n    ${paymentReconciliationMarkup(state, 'handover')}\n    <label>Remark",
    'handover payment section'
  );

  source = replaceRequired(
    source,
    "      denominations: numericDenominations(state.incoming),\n      otherCash: Number(state.incomingOther || 0)\n    };",
    "      denominations: numericDenominations(state.incoming),\n      otherCash: Number(state.incomingOther || 0),\n      payments: paymentPayload(state)\n    };",
    'handover payment payload'
  );

  source = replaceRequired(
    source,
    `  if (state.phase === 'closing') {
    payload.payments = (state.data?.payments || []).map((payment) => ({
      id: payment.id,
      name: payment.name,
      actual: state.payments[payment.id]?.actual ?? '',
      remark: state.payments[payment.id]?.remark || ''
    }));
  }`,
    "  if (state.phase === 'closing') payload.payments = paymentPayload(state);",
    'closing payment payload'
  );

  source = replaceRequired(
    source,
    'export function validateCash(state) {',
    `function paymentPayload(state) {
  return (state.data?.payments || []).map((payment) => ({
    id: payment.id,
    name: payment.name,
    actual: state.payments[payment.id]?.actual ?? '',
    remark: state.payments[payment.id]?.remark || ''
  }));
}

function validatePaymentInputs(state) {
  for (const payment of state.data?.payments || []) {
    const value = state.payments[payment.id] || {};
    if (value.actual === '' || value.actual === null || value.actual === undefined) {
      return \`Enter the actual amount for \${payment.name}. Use 0 when there was no payment.\`;
    }
    const system = nullableNumber(payment.system);
    const actual = Number(value.actual);
    if (system !== null && Math.abs(actual - system) > 0.009 && !String(value.remark || '').trim()) {
      return \`Add a remark for \${payment.name} because Actual differs from System.\`;
    }
  }
  return '';
}

export function validateCash(state) {`,
    'payment validation helpers'
  );

  source = replaceRequired(
    source,
    "    if (Math.abs(variance) > 0.009 && !state.remarks.handover.trim()) return 'A handover remark is required when the variance is not zero.';\n    return '';\n  }",
    "    if (Math.abs(variance) > 0.009 && !state.remarks.handover.trim()) return 'A handover remark is required when the variance is not zero.';\n    return validatePaymentInputs(state);\n  }",
    'handover payment validation'
  );

  source = replaceRequired(
    source,
    `    for (const payment of state.data?.payments || []) {
      const value = state.payments[payment.id] || {};
      if (value.actual === '' || value.actual === null || value.actual === undefined) return \`Enter the actual amount for \${payment.name}. Use 0 when there was no payment.\`;
      const system = nullableNumber(payment.system);
      const actual = Number(value.actual);
      if (system !== null && Math.abs(actual - system) > 0.009 && !String(value.remark || '').trim()) return \`Add a remark for \${payment.name} because Actual differs from System.\`;
    }
`,
    `    const paymentError = validatePaymentInputs(state);
    if (paymentError) return paymentError;
`,
    'closing payment validation'
  );

  source = replaceRequired(
    source,
    "    result[String(value)] = raw === null || raw === undefined || raw === 0 ? (raw === 0 ? '0' : '') : String(raw);",
    "    result[String(value)] = raw === null || raw === undefined || Number(raw) === 0 ? '' : String(raw);",
    'blank zero denomination values'
  );

  source = replaceRequired(
    source,
    '<input type="number" inputmode="numeric" min="0" step="1" data-cash-scope="${scope}" data-denomination="${value}" value="${escapeHtml(raw)}" placeholder="0">',
    '<input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" data-cash-scope="${scope}" data-denomination="${value}" value="${escapeHtml(raw)}" placeholder="0">',
    'cash quantity input mode'
  );

  source = replaceRequired(
    source,
    '<input id="payment-actual-${payment.id}" type="number" min="0" step="0.01" data-payment-actual="${payment.id}" value="${escapeHtml(value.actual)}" placeholder="0.00">',
    '<input id="payment-actual-${payment.id}" type="text" inputmode="decimal" autocomplete="off" data-payment-actual="${payment.id}" value="${escapeHtml(value.actual)}" placeholder="0.00">',
    'payment amount input mode'
  );

  await writeFile(file, source);
}

async function patchMainRuntime(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    "import { cashPage, createCashState, initializeCashFromBootstrap, buildCashPayload, validateCash } from './pages/cash.js';",
    "import { cashPage, createCashState, initializeCashFromBootstrap, buildCashPayload, validateCash, cashTotal } from './pages/cash.js';",
    'cash total import'
  );

  source = replaceRequired(
    source,
    '    const outlet = await ensureOutlet();',
    "    const outlet = state.outlet || state.systemStatus?.outletName || '';",
    'cash independent outlet resolution'
  );

  source = replaceRequired(
    source,
    "    if (state.dashboard.service === 'cash' && !state.outlet) await ensureOutlet();\n    const data = await callOperations(state.dashboard.service, dashboardPayload(state.dashboard, state.outlet), state.settings);",
    "    const dashboardOutlet = state.outlet || state.systemStatus?.outletName || '';\n    const data = await callOperations(state.dashboard.service, dashboardPayload(state.dashboard, dashboardOutlet), state.settings);",
    'cash dashboard independent outlet resolution'
  );

  source = replaceRequired(
    source,
    "  if (!state.outlet) {\n    try {\n      await ensureOutlet();\n    } catch (error) {\n      showToast(error.message, 'error');\n      return;\n    }\n  }",
    "  const cashOutlet = state.outlet || state.cash.data?.outlet || state.systemStatus?.outletName || '';",
    'cash submit outlet resolution'
  );

  source = replaceRequired(
    source,
    '    const payload = buildCashPayload(state.cash, state.outlet);',
    '    const payload = buildCashPayload(state.cash, cashOutlet);',
    'cash submit payload outlet'
  );

  source = replaceRequired(
    source,
    '    await loadCash({ preserveResult: true });',
    "    setTimeout(() => loadCash({ preserveResult: true }), 250);",
    'non-blocking post-submit refresh'
  );

  source = replaceRequired(
    source,
    "  const paymentLines = payload.phase === 'closing'\n    ? (payload.payments || []).map((payment) => `*${payment.name}:* RM ${Number(payment.actual || 0).toFixed(2)}`)\n    : [];",
    "  const paymentLines = ['handover', 'closing'].includes(payload.phase)\n    ? (payload.payments || []).map((payment) => `*${payment.name}:* RM ${Number(payment.actual || 0).toFixed(2)}`)\n    : [];",
    'handover WhatsApp payments'
  );

  source = replaceRequired(
    source,
    `  document.querySelectorAll('[data-cash-scope]').forEach((element) => element.addEventListener('input', (event) => {
    state.cash[event.target.dataset.cashScope][event.target.dataset.denomination] = event.target.value;
    renderCashPreservingActive();
  }));`,
    `  document.querySelectorAll('[data-cash-scope]').forEach((element) => {
    element.addEventListener('focus', (event) => {
      if (event.target.value === '0') event.target.value = '';
      event.target.select?.();
    });
    element.addEventListener('input', (event) => {
      const scope = event.target.dataset.cashScope;
      const denomination = event.target.dataset.denomination;
      const cleaned = String(event.target.value || '').replace(/[^0-9]/g, '').replace(/^0+(?=\\d)/, '');
      if (event.target.value !== cleaned) event.target.value = cleaned;
      state.cash[scope][denomination] = cleaned;
      updateCashInputPreview(event.target);
    });
  });`,
    'smooth denomination input'
  );

  source = replaceRequired(
    source,
    `  document.querySelectorAll('[data-cash-other]').forEach((element) => element.addEventListener('input', (event) => {
    state.cash[\`${'${'}event.target.dataset.cashOther}Other\`] = event.target.value;
    renderCashPreservingActive();
  }));`,
    `  document.querySelectorAll('[data-cash-other]').forEach((element) => {
    element.addEventListener('focus', (event) => event.target.select?.());
    element.addEventListener('input', (event) => {
      const key = \`${'${'}event.target.dataset.cashOther}Other\`;
      const cleaned = normalizeMoneyInput(event.target.value);
      if (event.target.value !== cleaned) event.target.value = cleaned;
      state.cash[key] = cleaned;
      updateCashInputPreview(event.target);
    });
  });`,
    'smooth other cash input'
  );

  source = replaceRequired(
    source,
    `  document.querySelectorAll('[data-payment-actual]').forEach((element) => element.addEventListener('input', (event) => {
    const id = event.target.dataset.paymentActual;
    state.cash.payments[id].actual = event.target.value;
    renderCashPreservingActive();
  }));`,
    `  document.querySelectorAll('[data-payment-actual]').forEach((element) => {
    element.addEventListener('focus', (event) => event.target.select?.());
    element.addEventListener('input', (event) => {
      const id = event.target.dataset.paymentActual;
      const cleaned = normalizeMoneyInput(event.target.value);
      if (event.target.value !== cleaned) event.target.value = cleaned;
      state.cash.payments[id].actual = cleaned;
      updatePaymentInputPreview(event.target, id);
    });
  });`,
    'smooth payment input'
  );

  source = replaceRequired(
    source,
    'function renderCashPreservingActive() {',
    `function normalizeMoneyInput(value) {
  const raw = String(value || '').replace(/[^0-9.]/g, '');
  const firstDot = raw.indexOf('.');
  if (firstDot < 0) return raw.replace(/^0+(?=\\d)/, '');
  const whole = raw.slice(0, firstDot).replace(/^0+(?=\\d)/, '') || '0';
  const decimals = raw.slice(firstDot + 1).replace(/\\./g, '').slice(0, 2);
  return \`${'${'}whole}.${'${'}decimals}\`;
}

function scopeTotal(scope) {
  return cashTotal(state.cash[scope] || {}, state.cash[\`${'${'}scope}Other\`] || 0);
}

function updateCashInputPreview(input) {
  const scope = input.dataset.cashScope || input.dataset.cashOther;
  if (!scope) return;
  if (input.dataset.denomination) {
    const subtotal = Number(input.value || 0) * Number(input.dataset.denomination || 0);
    const small = input.closest('.denomination')?.querySelector('small');
    if (small) small.textContent = \`RM ${'${'}subtotal.toFixed(2)}\`;
  }
  const total = scopeTotal(scope);
  const card = input.closest('.cash-card');
  const cardTotal = card?.querySelector('.money-total');
  if (cardTotal) cardTotal.textContent = \`RM ${'${'}total.toFixed(2)}\`;

  if (state.cash.phase === 'handover') {
    const outgoing = scopeTotal('outgoing');
    const incoming = scopeTotal('incoming');
    const variance = incoming - outgoing;
    const varianceCard = document.querySelector('.variance-card');
    if (varianceCard) {
      varianceCard.classList.toggle('warning', Math.abs(variance) > 0.009);
      varianceCard.classList.toggle('ok', Math.abs(variance) <= 0.009);
      const strong = varianceCard.querySelector('strong');
      if (strong) strong.textContent = \`${'${'}variance >= 0 ? '+' : '−'} RM ${'${'}Math.abs(variance).toFixed(2)}\`;
    }
  } else {
    const controlTotal = document.querySelector('.cash-control-panel > strong');
    if (controlTotal) controlTotal.textContent = \`RM ${'${'}total.toFixed(2)}\`;
  }
}

function updatePaymentInputPreview(input, id) {
  const payment = state.cash.data?.payments?.find((entry) => entry.id === id);
  if (!payment) return;
  const actualText = state.cash.payments[id]?.actual;
  const actual = actualText === '' ? null : Number(actualText);
  const system = payment.system === '' || payment.system === null || payment.system === undefined ? null : Number(payment.system);
  const variance = actual === null ? null : actual - Number(system || 0);
  const card = input.closest('.payment-method-card');
  const varianceStrong = card?.querySelector('.payment-values > :last-child strong');
  if (varianceStrong) {
    varianceStrong.textContent = variance === null ? '—' : \`${'${'}variance >= 0 ? '+' : '−'} RM ${'${'}Math.abs(variance).toFixed(2)}\`;
    varianceStrong.classList.toggle('negative', variance !== null && Math.abs(variance) > 0.009);
  }
  const needsReview = variance !== null && system !== null && Math.abs(variance) > 0.009;
  card?.classList.toggle('has-variance', needsReview);
  const status = card?.querySelector('.payment-status');
  if (status) {
    status.textContent = actual === null ? 'Pending' : needsReview ? 'Review' : 'Matched';
    status.className = \`payment-status ${'${'}actual === null ? 'pending' : needsReview ? 'review' : 'matched'}\`;
  }
  const total = (state.cash.data?.payments || []).reduce((sum, item) => {
    const value = state.cash.payments[item.id]?.actual;
    return sum + (value === '' || value === null || value === undefined ? 0 : Number(value || 0));
  }, 0);
  const totalNode = document.querySelector('.payment-total-box strong');
  if (totalNode) totalNode.textContent = \`RM ${'${'}total.toFixed(2)}\`;
}

function renderCashPreservingActive() {`,
    'cash live preview helpers'
  );

  await writeFile(file, source);
}
