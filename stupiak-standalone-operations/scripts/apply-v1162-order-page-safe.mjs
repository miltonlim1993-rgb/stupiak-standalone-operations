import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1162OrderPageSafe(dist) {
  await patchStockPage(dist);
  await patchLegacyFormulaReadback(dist);
  await patchStyles(dist);
  await auditFinalStockBuild(dist);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  const callPattern = /state\.activeTab\s*===\s*['"]Order Page['"]\s*\?\s*(?:orderPage|liveOrderPageV1162)\([^)]*\)\s*:\s*sectionPage\(state,\s*weekly,\s*monthly\)/;
  if (callPattern.test(source)) {
    source = source.replace(callPattern, `state.activeTab === 'Order Page' ? liveOrderPageV1162(state) : sectionPage(state, weekly, monthly)`);
  } else {
    throw new Error('v1.16.4 final audit failed: Order Page call anchor');
  }

  const oldRenderer = /function orderPage\([^)]*\)\s*\{[\s\S]*?\n\}(?=\n\nfunction (?:liveOrderPageV1162|submitSuccess))/;
  if (oldRenderer.test(source)) {
    source = source.replace(oldRenderer, `function orderPage(state) {\n  return liveOrderPageV1162(state);\n}`);
  }

  if (!source.includes('function liveOrderPageV1162(state)')) {
    const helper = `
function liveOrderPageV1162(state) {
  const weeks = [1, 2, 3, 4, 5].map((weekIndex) => ({
    weekIndex,
    inventory: liveOrderGroupForWeekV1162(state, ['Inventory'], weekIndex),
    utensils: liveOrderGroupForWeekV1162(state, ['Untensil PG1', 'Utensil PG2'], weekIndex)
  }));
  const stationary = liveStationaryOrderGroupV1162(state);
  return \`<div class="sheet-table-wrap order-wrap live-order-wrap"><table class="sheet-table order-table live-order-table"><tbody>
    \${weeks.map((week) => \`<tr class="order-week-row"><th colspan="3">Week \${week.weekIndex}</th></tr>
      <tr><th>Inventory Order List</th><td class="order-date-cell">\${liveOrderDateTextV1162(week.inventory)}</td><td>\${liveOrderItemsTextV1162(week.inventory)}</td></tr>
      <tr><th>Utensil Order List</th><td class="order-date-cell">\${liveOrderDateTextV1162(week.utensils)}</td><td>\${liveOrderItemsTextV1162(week.utensils)}</td></tr>\`).join('')}
    <tr class="order-week-row stationary-order-row"><th colspan="3">Stationary Stock (MONTHLY)</th></tr>
    <tr><th>Stationary Order List</th><td class="order-date-cell">\${stationary.dateText}</td><td>\${liveOrderItemsTextV1162(stationary)}</td></tr>
  </tbody></table></div>\`;
}

function liveOrderGroupForWeekV1162(state, sheetNames, weekIndex) {
  const items = [];
  const dates = [];
  let counted = false;
  for (const sheetName of sheetNames) {
    const section = (state.data?.sections || []).find((entry) => entry.sheetName === sheetName);
    if (!section) continue;
    const date = state.sheetWeekDates?.[sheetName]?.[weekIndex] || section.rows?.[0]?.weeks?.find((entry) => Number(entry.index) === Number(weekIndex))?.date || '';
    const dirty = Boolean(state.dirtyColumns?.[sheetName]?.[weekIndex]);
    if (!date && !dirty) continue;
    counted = true;
    if (date) dates.push({ sheetName, date });
    for (const row of section.rows || []) {
      const week = (row.weeks || []).find((entry) => Number(entry.index) === Number(weekIndex));
      const rowValues = state.values?.[sheetName]?.[row.row] || {};
      const live = rowValues?.[weekIndex] && typeof rowValues[weekIndex] === 'object'
        ? rowValues[weekIndex]
        : Number(weekIndex) === Number(state.data?.selectedWeek) ? rowValues : null;
      const status = live
        ? section.type === 'weekly-inventory'
          ? inventoryStatus(row, live)
          : utensilStatus(sheetName, row, Number(live.quantity || 0))
        : String(week?.status || '');
      if (status === 'Order') items.push(row.item);
    }
  }
  return { items: [...new Set(items)], dates, counted };
}

function liveStationaryOrderGroupV1162(state) {
  const section = (state.data?.sections || []).find((entry) => entry.sheetName === 'Stationary');
  if (!section) return { items: [], counted: false, dateText: 'Not counted' };
  const date = String(state.stationaryDate || section.countDate || section.date || '').trim();
  const counted = Boolean(date || (section.rows || []).some((row) => row.quantityValue !== '' && row.quantityValue !== null && row.quantityValue !== undefined));
  const items = counted ? (section.rows || []).filter((row) => {
    const live = state.values?.Stationary?.[row.row]?.quantity;
    const quantity = live !== '' && live !== null && live !== undefined ? Number(live) : Number(row.quantityValue || 0);
    return quantity <= Number(row.minimum || 0);
  }).map((row) => row.item) : [];
  return { items, counted, dateText: date ? \`Counted \${escapeHtml(formatDate(date))}\` : counted ? 'Counted' : 'Not counted' };
}

function liveOrderDateTextV1162(group) {
  if (!group.counted) return '<span class="order-none">Not counted</span>';
  if (!group.dates.length) return 'Counted';
  const unique = [...new Set(group.dates.map((entry) => entry.date))];
  if (unique.length === 1) return \`Counted \${escapeHtml(formatDate(unique[0]))}\`;
  return group.dates.map((entry) => \`\${escapeHtml(entry.sheetName === 'Untensil PG1' ? 'PG1' : entry.sheetName === 'Utensil PG2' ? 'PG2' : entry.sheetName)} \${escapeHtml(formatDate(entry.date))}\`).join('<br>');
}

function liveOrderItemsTextV1162(group) {
  if (!group.counted) return '<span class="order-none">Not counted</span>';
  return group.items.length ? group.items.map(escapeHtml).join(', ') : '<span class="order-none">No order</span>';
}
`;
    const anchor = source.indexOf('\nfunction submitSuccess');
    if (anchor < 0) throw new Error('v1.16.4 final audit failed: submitSuccess anchor');
    source = source.slice(0, anchor) + helper + source.slice(anchor);
  }

  source = source.replace(/<div class="order-note">[\s\S]*?<\/div><\/div>/g, '');
  await writeFile(file, source);
}

async function patchLegacyFormulaReadback(dist) {
  const file = resolve(dist, 'src/core/stock-setup-legacy.js');
  let source = await readFile(file, 'utf8');
  source = source.replace(
    "if (value.formula) return value.result !== undefined ? display(value.result) : `=${value.formula}`;",
    "if (value.formula) return value.result !== undefined ? display(value.result) : '';"
  );
  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  if (!source.includes('v1.16.4 live Order Page')) {
    source += `\n/* v1.16.4 live Order Page */\n.live-order-wrap{margin-top:10px}.live-order-table{table-layout:fixed}.live-order-table th,.live-order-table td{padding:12px 14px;text-align:left;vertical-align:top;white-space:normal;line-height:1.45}.live-order-table .order-week-row th,.live-order-table .order-week-row td{background:#3f3f3f;color:#fff;font-weight:800}.live-order-table tr:not(.order-week-row) th{width:210px;background:#e5e4e0}.live-order-table tr:not(.order-week-row) td{background:#f6f5f1}.live-order-table .order-date-cell{width:180px;font-weight:700}.live-order-table .order-none{color:#888;font-weight:700}.live-order-table .stationary-order-row th,.live-order-table .stationary-order-row td{background:#76651e;color:#fff}\n`;
  }
  await writeFile(file, source);
}

async function auditFinalStockBuild(dist) {
  const stock = await readFile(resolve(dist, 'src/pages/stock.js'), 'utf8');
  const main = await readFile(resolve(dist, 'src/main.js'), 'utf8');
  const checks = [
    [stock.includes(`state.activeTab === 'Order Page' ? liveOrderPageV1162(state)`), 'live Order Page call'],
    [stock.includes('function liveOrderPageV1162(state)'), 'live Order Page renderer'],
    [!stock.includes('It follows the monthly spreadsheet calculation and layout.'), 'old Order Page renderer removed'],
    [stock.includes('id="export-stock-pdf"'), 'Export PDF button'],
    [stock.includes('id="export-stock-excel"'), 'Export Excel button'],
    [stock.includes('id="submit-stock"'), 'Save button'],
    [main.includes("querySelector('#export-stock-pdf')"), 'Export PDF binding'],
    [main.includes("querySelector('#export-stock-excel')"), 'Export Excel binding'],
    [main.includes("querySelector('#submit-stock')"), 'Save binding']
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
  if (failed.length) throw new Error(`Final Stock build audit failed: ${failed.join(', ')}`);
  console.log('Final Stock build audit passed: Order Page, Save, Export PDF, Export Excel');
}
