import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1162OrderPageSafe(dist) {
  await patchStockPage(dist);
  await patchLegacyFormulaReadback(dist);
  await patchStyles(dist);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  if (!source.includes('liveOrderPageV1162(state)')) {
    const callPattern = /state\.activeTab\s*===\s*['"]Order Page['"]\s*\?\s*orderPage\([^)]*\)\s*:\s*sectionPage\(state,\s*weekly,\s*monthly\)/;
    if (callPattern.test(source)) {
      source = source.replace(callPattern, `state.activeTab === 'Order Page' ? liveOrderPageV1162(state) : sectionPage(state, weekly, monthly)`);
    } else {
      console.warn('v1.16.2: Order Page call anchor not found; leaving existing renderer unchanged');
    }
  }

  if (!source.includes('function liveOrderPageV1162(state)')) {
    const helper = `
function liveOrderPageV1162(state) {
  const weeks = [1, 2, 3, 4, 5].map((weekIndex) => {
    const inventory = liveOrderItemsForWeekV1162(state, ['Inventory'], weekIndex);
    const utensils = liveOrderItemsForWeekV1162(state, ['Untensil PG1', 'Utensil PG2'], weekIndex);
    const date = liveOrderDateForWeekV1162(state, weekIndex);
    return { weekIndex, date, inventory, utensils };
  });
  const stationary = liveStationaryOrderItemsV1162(state);
  return \`<div class="sheet-table-wrap order-wrap live-order-wrap"><table class="sheet-table order-table live-order-table"><tbody>
    \${weeks.map((week) => \`<tr class="order-week-row"><th colspan="5">Week \${week.weekIndex}</th><td colspan="2">\${week.date ? escapeHtml(formatDate(week.date)) : 'Not counted'}</td></tr>
      <tr><th colspan="2">Inventory Order List</th><td colspan="5">\${liveOrderListTextV1162(week.inventory)}</td></tr>
      <tr><th colspan="2">Utensil Order List</th><td colspan="5">\${liveOrderListTextV1162(week.utensils)}</td></tr>\`).join('')}
    <tr class="order-week-row stationary-order-row"><th colspan="5">Stationary Stock (MONTHLY)</th><td colspan="2">Monthly</td></tr>
    <tr><th colspan="2">Stationary Order List</th><td colspan="5">\${liveOrderListTextV1162(stationary)}</td></tr>
  </tbody></table></div>\`;
}

function liveOrderItemsForWeekV1162(state, sheetNames, weekIndex) {
  const items = [];
  for (const sheetName of sheetNames) {
    const section = (state.data?.sections || []).find((entry) => entry.sheetName === sheetName);
    if (!section) continue;
    for (const row of section.rows || []) {
      const week = (row.weeks || []).find((entry) => Number(entry.index) === Number(weekIndex));
      let status = String(week?.status || '');
      if (Number(weekIndex) === Number(state.data?.selectedWeek)) {
        const value = state.values?.[sheetName]?.[row.row] || {};
        status = section.type === 'weekly-inventory'
          ? inventoryStatus(row, value)
          : utensilStatus(sheetName, row, Number(value.quantity || 0));
      }
      if (status === 'Order') items.push(row.item);
    }
  }
  return items;
}

function liveStationaryOrderItemsV1162(state) {
  const section = (state.data?.sections || []).find((entry) => entry.sheetName === 'Stationary');
  if (!section) return [];
  return (section.rows || []).filter((row) => {
    const value = state.values?.Stationary?.[row.row];
    if (value) return Number(value.quantity || 0) <= Number(row.minimum || 0);
    return String(row.status || '') === 'Order';
  }).map((row) => row.item);
}

function liveOrderDateForWeekV1162(state, weekIndex) {
  for (const sheetName of ['Inventory', 'Untensil PG1', 'Utensil PG2']) {
    const section = (state.data?.sections || []).find((entry) => entry.sheetName === sheetName);
    const firstRow = section?.rows?.[0];
    const week = (firstRow?.weeks || []).find((entry) => Number(entry.index) === Number(weekIndex));
    if (week?.date) return week.date;
  }
  return Number(weekIndex) === Number(state.data?.selectedWeek) ? state.businessDate : '';
}

function liveOrderListTextV1162(items) {
  return items.length ? items.map(escapeHtml).join(', ') : '<span class="order-none">No order</span>';
}
`;
    const anchor = source.indexOf('\nfunction submitSuccess');
    source = anchor >= 0 ? source.slice(0, anchor) + helper + source.slice(anchor) : source + helper;
  }

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
  if (!source.includes('v1.16.2 live Order Page')) {
    source += `\n/* v1.16.2 live Order Page */\n.live-order-wrap{margin-top:10px}.live-order-table{table-layout:fixed}.live-order-table th,.live-order-table td{padding:12px 14px;text-align:left;vertical-align:top;white-space:normal;line-height:1.45}.live-order-table .order-week-row th,.live-order-table .order-week-row td{background:#3f3f3f;color:#fff;font-weight:800}.live-order-table .order-week-row td{text-align:right}.live-order-table tr:not(.order-week-row) th{width:210px;background:#e5e4e0}.live-order-table tr:not(.order-week-row) td{background:#f6f5f1}.live-order-table .order-none{color:#888;font-weight:700}.live-order-table .stationary-order-row th,.live-order-table .stationary-order-row td{background:#76651e}\n`;
  }
  await writeFile(file, source);
}
