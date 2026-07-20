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

  await writeFile(file, source);
}

async function patchMainRuntime(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

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

  await writeFile(file, source);
}
