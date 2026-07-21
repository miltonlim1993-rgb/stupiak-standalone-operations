import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, pattern, replacement, label) {
  const matched = typeof pattern === 'string'
    ? source.includes(pattern)
    : pattern instanceof RegExp && pattern.test(source);
  if (!matched) throw new Error(`v1.14.1 patch failed: ${label}`);
  if (pattern instanceof RegExp) pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

export async function applyV1141StockReadiness(dist) {
  await patchStockPage(dist);
  await patchMain(dist);
  await patchStyles(dist);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    /export function validateStock\(state\) \{[\s\S]*?\n\}(?=\n\nfunction completionProgress)/,
    `export function stockSaveReadiness(state) {
  const sectionName = state.activeTab;
  const section = state.data?.sections?.find((entry) => entry.sheetName === sectionName);
  const entered = (value) => value !== '' && value !== null && value !== undefined && Number(value) >= 0;
  if (!section) return { ready: false, summary: 'Section is not ready', error: 'Stock section is not available.' };

  if (sectionName === 'Stationary') {
    const rows = section.rows || [];
    let completed = 0;
    let firstMissing = '';
    for (const row of rows) {
      const value = state.values?.Stationary?.[row.row]?.quantity;
      if (entered(value)) completed += 1;
      else if (!firstMissing) firstMissing = row.item;
    }
    const parts = [\`\${completed}/\${rows.length} entered\`];
    if (!state.stationaryDate) parts.push('select count date');
    if (!String(state.countedBy || '').trim()) parts.push('enter staff name');
    if (!state.stationaryDirty) parts.push('edit this tab');
    const ready = Boolean(state.stationaryDirty && state.stationaryDate && String(state.countedBy || '').trim() && completed === rows.length);
    const error = !state.stationaryDirty
      ? 'Edit the Stationary count before saving.'
      : !state.stationaryDate
        ? 'Enter the Stationary count date.'
        : completed !== rows.length
          ? \`Complete Stationary: \${firstMissing}\`
          : !String(state.countedBy || '').trim()
            ? 'Enter the staff name before saving.'
            : '';
    return { ready, summary: \`Stationary · \${parts.join(' · ')}\`, error };
  }

  const dirty = dirtyWeekIndexes(state, sectionName);
  if (!dirty.length) return { ready: false, summary: 'Edit a Week column to save', error: \`Edit at least one \${sectionName} Week column before saving.\` };

  let total = 0;
  let completed = 0;
  let firstMissing = '';
  let firstMissingWeek = dirty[0];
  let firstMissingDate = 0;
  let invalidDateWeek = 0;

  for (const weekIndex of dirty) {
    const countDate = state.sheetWeekDates?.[sectionName]?.[weekIndex] || '';
    if (!countDate && !firstMissingDate) firstMissingDate = weekIndex;
    else if (countDate && !dateBelongsToWeek(state.monthKey, weekIndex, countDate) && !invalidDateWeek) invalidDateWeek = weekIndex;

    for (const row of section.rows || []) {
      total += 1;
      const value = state.values?.[sectionName]?.[row.row]?.[weekIndex] || {};
      const main = section.type === 'weekly-inventory' ? value.primary : value.quantity;
      const complete = entered(main) && (!row.hasSecondaryQuantity || entered(value.secondary));
      if (complete) completed += 1;
      else if (!firstMissing) {
        firstMissing = row.hasSecondaryQuantity && entered(main) && !entered(value.secondary)
          ? \`\${row.item} secondary unit\`
          : row.item;
        firstMissingWeek = weekIndex;
      }
    }
  }

  const label = dirty.length === 1 ? \`Week \${dirty[0]}\` : \`\${dirty.length} Week columns\`;
  const parts = [\`\${completed}/\${total} entered\`];
  if (firstMissingDate) parts.push('select count date');
  if (invalidDateWeek) parts.push('fix count date');
  if (!String(state.countedBy || '').trim()) parts.push('enter staff name');
  const ready = Boolean(!firstMissingDate && !invalidDateWeek && completed === total && String(state.countedBy || '').trim());
  const error = firstMissingDate
    ? \`Enter the \${sectionName} count date for Week \${firstMissingDate}.\`
    : invalidDateWeek
      ? \`\${sectionName} Week \${invalidDateWeek} count date must be within \${weekPeriodForIndex(state.monthKey, invalidDateWeek)}.\`
      : completed !== total
        ? \`Complete Week \${firstMissingWeek} · \${sectionName}: \${firstMissing}\`
        : !String(state.countedBy || '').trim()
          ? 'Enter the staff name before saving.'
          : '';
  return { ready, summary: \`\${label} · \${parts.join(' · ')}\`, error };
}

export function validateStock(state) {
  const readiness = stockSaveReadiness(state);
  return readiness.ready ? '' : readiness.error;
}`,
    'Stock readiness validation'
  );

  source = replaceRequired(
    source,
    /(\s+const saveLabel = [\s\S]*?\n\s+: 'Edit a Week column to save';)/,
    `$1\n  const readiness = stockSaveReadiness(state);`,
    'readiness state in section page'
  );

  source = replaceRequired(
    source,
    /<small>Save writes to _StockRelation\. PDF and Excel follow the RR-KCH Inventory Listing workbook layout\.<\/small>/,
    `<small>Save writes to _StockRelation. PDF and Excel follow the RR-KCH Inventory Listing workbook layout. <span id="stock-readiness" class="stock-readiness \${readiness.ready ? 'ready' : 'missing'}">\${escapeHtml(readiness.summary)}</span></small>`,
    'readiness footer copy'
  );

  source = replaceRequired(
    source,
    /id="submit-stock" \$\{state\.submitting \|\| state\.submitBlocked \|\| state\.pendingSubmission \|\| \(!isMonthly && !dirtyWeeks\.length\) \? 'disabled' : ''\}/,
    `id="submit-stock" \${state.submitting || state.submitBlocked || state.pendingSubmission || !readiness.ready ? 'disabled' : ''}`,
    'save button readiness guard'
  );

  await writeFile(file, source);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `import { stockPage, createStockState, initializeStockValues, buildStockPayload, validateStock } from './pages/stock.js';`,
    `import { stockPage, createStockState, initializeStockValues, buildStockPayload, validateStock, stockSaveReadiness } from './pages/stock.js';`,
    'Stock readiness import'
  );

  source = replaceRequired(
    source,
    /function markWeekDirtyInDom\(stockSheet, weekIndex\) \{/,
    `function refreshStockSaveReadiness() {
  const readiness = stockSaveReadiness(state.stock);
  const status = document.querySelector('#stock-readiness');
  if (status) {
    status.textContent = readiness.summary;
    status.className = 'stock-readiness ' + (readiness.ready ? 'ready' : 'missing');
  }
  const button = document.querySelector('#submit-stock');
  if (button && !state.stock.submitting && !state.stock.submitBlocked && !state.stock.pendingSubmission) {
    button.disabled = !readiness.ready;
  }
}

function markWeekDirtyInDom(stockSheet, weekIndex) {`,
    'live readiness helper'
  );

  source = source.replace(
    `    updateLiveStockStatus(event.target); persistStockDraft();`,
    `    updateLiveStockStatus(event.target); persistStockDraft(); refreshStockSaveReadiness();`
  );

  source = source.replace(
    `  document.querySelector('#stock-counted-by')?.addEventListener('input', (event) => { state.stock.countedBy = event.target.value; persistStockDraft(); });`,
    `  document.querySelector('#stock-counted-by')?.addEventListener('input', (event) => { state.stock.countedBy = event.target.value; persistStockDraft(); refreshStockSaveReadiness(); });`
  );

  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `
/* v1.14.1 explicit Stock completion state */
.stock-page input[type="number"]::placeholder{color:#b6b7b3!important;opacity:1!important;font-weight:600!important}.stock-readiness{display:inline-flex;margin-left:8px;padding:3px 7px;border-radius:999px;font-size:10px;font-weight:800;white-space:nowrap}.stock-readiness.missing{background:#fff0ed;color:#a63a31}.stock-readiness.ready{background:#e8f7ef;color:#237653}.stock-action-buttons #submit-stock:disabled{cursor:not-allowed;opacity:.48}@media(max-width:900px){.stock-readiness{margin:5px 0 0;white-space:normal}}
`;
  await writeFile(file, source);
}