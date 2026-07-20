import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.4 build patch failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV14Patches(dist) {
  // src/pages/cash.js is now maintained as the actual-only Cash Count page.
  // The old v1.4 cash-page string patches targeted the pre-actual-only UI and
  // will fail after v1.6. Keep only the main runtime fixes that are still needed
  // at build time: outlet-safe submit, non-blocking reload, WhatsApp text, and
  // smooth numeric input handling.
  await patchMainRuntime(dist);
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
      const cleaned = String(event.target.value || '').replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
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
    state.cash[`${event.target.dataset.cashOther}Other`] = event.target.value;
    renderCashPreservingActive();
  }));`,
    `  document.querySelectorAll('[data-cash-other]').forEach((element) => {
    element.addEventListener('focus', (event) => event.target.select?.());
    element.addEventListener('input', (event) => {
      const key = `${event.target.dataset.cashOther}Other`;
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
  if (firstDot < 0) return raw.replace(/^0+(?=\d)/, '');
  const whole = raw.slice(0, firstDot).replace(/^0+(?=\d)/, '') || '0';
  const decimals = raw.slice(firstDot + 1).replace(/\./g, '').slice(0, 2);
  return `${whole}.${decimals}`;
}

function scopeTotal(scope) {
  return cashTotal(state.cash[scope] || {}, state.cash[`${scope}Other`] || 0);
}

function updateCashInputPreview(input) {
  const scope = input.dataset.cashScope || input.dataset.cashOther;
  if (!scope) return;
  if (input.dataset.denomination) {
    const subtotal = Number(input.value || 0) * Number(input.dataset.denomination || 0);
    const small = input.closest('.denomination')?.querySelector('small');
    if (small) small.textContent = `RM ${subtotal.toFixed(2)}`;
  }
  const total = scopeTotal(scope);
  const card = input.closest('.cash-card');
  const cardTotal = card?.querySelector('.money-total');
  if (cardTotal) cardTotal.textContent = `RM ${total.toFixed(2)}`;

  if (state.cash.phase === 'handover') {
    const outgoing = scopeTotal('outgoing');
    const incoming = scopeTotal('incoming');
    const variance = incoming - outgoing;
    const varianceCard = document.querySelector('.variance-card');
    if (varianceCard) {
      varianceCard.classList.toggle('warning', Math.abs(variance) > 0.009);
      varianceCard.classList.toggle('ok', Math.abs(variance) <= 0.009);
      const strong = varianceCard.querySelector('strong');
      if (strong) strong.textContent = `${variance >= 0 ? '+' : '−'} RM ${Math.abs(variance).toFixed(2)}`;
    }
  } else {
    const controlTotal = document.querySelector('.cash-control-panel > strong');
    if (controlTotal) controlTotal.textContent = `RM ${total.toFixed(2)}`;
  }
}

function updatePaymentInputPreview(input, id) {
  const actualText = state.cash.payments[id]?.actual;
  const actual = actualText === '' || actualText === null || actualText === undefined ? null : Number(actualText);
  const card = input.closest('.payment-method-card');
  const status = card?.querySelector('.payment-status');
  if (status) {
    status.textContent = actual === null ? 'Pending' : 'Entered';
    status.className = `payment-status ${actual === null ? 'pending' : 'matched'}`;
  }
  const total = (state.cash.data?.payments || []).reduce((sum, item) => {
    const value = state.cash.payments[item.id]?.actual;
    return sum + (value === '' || value === null || value === undefined ? 0 : Number(value || 0));
  }, 0);
  const totalNode = document.querySelector('.payment-total-box strong');
  if (totalNode) totalNode.textContent = `RM ${total.toFixed(2)}`;
}

function renderCashPreservingActive() {`,
    'cash live preview helpers'
  );

  await writeFile(file, source);
}
