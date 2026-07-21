import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1162OrderPage(dist) {
  await patchStockPage(dist);
  await patchLegacySetupExport(dist);
  await patchStyles(dist);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    `state.activeTab === 'Order Page' ? orderPage(state.data.orderPage) : sectionPage(state, weekly, monthly)`,
    `state.activeTab === 'Order Page' ? orderPage(state) : sectionPage(state, weekly, monthly)`
  );

  const start = source.indexOf('function orderPage(orderPage) {');
  const end = source.indexOf('\nfunction submitSuccess', start);
  if (start < 0 || end < 0) throw new Error('v1.16.2 patch failed: Order Page renderer');

  const replacement = `function orderPage(state) {
  const weeks = [1, 2, 3, 4, 5].map((weekIndex) => {
    const inventory = orderItemsForWeek(state, ['Inventory'], weekIndex);
    const utensils = orderItemsForWeek(state, ['Untensil PG1', 'Utensil PG2'], weekIndex);
    const date = orderDateForWeek(state, weekIndex);
    return { weekIndex, date, inventory, utensils };
  });
  const stationary = orderItemsForStationary(state);
  return \`<div class="sheet-table-wrap order-wrap live-order-wrap"><table class="sheet-table order-table live-order-table"><tbody>
    \${weeks.map((week) => \`<tr class="order-week-row"><th colspan="5">Week \${week.weekIndex}</th><td colspan="2">\${week.date ? escapeHtml(formatDate(week.date)) : 'Not counted'}</td></tr>
      <tr><th colspan="2">Inventory Order List</th><td colspan="5">\${orderListText(week.inventory)}</td></tr>
      <tr><th colspan="2">Utensil Order List</th><td colspan="5">\${orderListText(week.utensils)}</td></tr>\`).join('')}
    <tr class="order-week-row stationary-order-row"><th colspan="5">Stationary Stock (MONTHLY)</th><td colspan="2">Monthly</td></tr>
    <tr><th colspan="2">Stationary Order List</th><td colspan="5">\${orderListText(stationary)}</td></tr>
  </tbody></table></div>\`;
}

function orderItemsForWeek(state, sheetNames, weekIndex) {
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

function orderItemsForStationary(state) {
  const section = (state.data?.sections || []).find((entry) => entry.sheetName === 'Stationary');
  if (!section) return [];
  return (section.rows || []).filter((row) => {
    const value = state.values?.Stationary?.[row.row];
    if (value) return Number(value.quantity || 0) <= Number(row.minimum || 0);
    return String(row.status || '') === 'Order';
  }).map((row) => row.item);
}

function orderDateForWeek(state, weekIndex) {
  for (const sheetName of ['Inventory', 'Untensil PG1', 'Utensil PG2']) {
    const section = (state.data?.sections || []).find((entry) => entry.sheetName === sheetName);
    const firstRow = section?.rows?.[0];
    const week = (firstRow?.weeks || []).find((entry) => Number(entry.index) === Number(weekIndex));
    if (week?.date) return week.date;
  }
  return Number(weekIndex) === Number(state.data?.selectedWeek) ? state.businessDate : '';
}

function orderListText(items) {
  return items.length ? items.map(escapeHtml).join(', ') : '<span class="order-none">No order</span>';
}
`;

  source = source.slice(0, start) + replacement + source.slice(end);
  await writeFile(file, source);
}

async function patchLegacySetupExport(dist) {
  const file = resolve(dist, 'src/core/stock-setup-legacy.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    "if (value.formula) return value.result !== undefined ? display(value.result) : `=${value.formula}`;",
    "if (value.formula) return value.result !== undefined ? display(value.result) : '';"
  );

  const start = source.indexOf('export function writeLegacySetupSheets(workbook, setup) {');
  const end = source.indexOf('\nfunction parseInventory', start);
  if (start < 0 || end < 0) throw new Error('v1.16.2 patch failed: legacy setup writer');
  let block = source.slice(start, end);
  if (!block.includes('applyOrderFormulas(workbook)')) {
    const closing = block.lastIndexOf('\n}');
    block = block.slice(0, closing) + '\n  applyOrderFormulas(workbook);' + block.slice(closing);
  }
  source = source.slice(0, start) + block + source.slice(end);

  if (!source.includes('function applyOrderFormulas(workbook)')) {
    source += `\n\nfunction applyOrderFormulas(workbook) {
  const inventory = workbook.getWorksheet('Inventory');
  const pg1 = workbook.getWorksheet('Untensil PG1');
  const pg2 = workbook.getWorksheet('Utensil PG2');
  const stationary = workbook.getWorksheet('Stationary');
  const order = workbook.getWorksheet('Order Page');
  if (!inventory || !pg1 || !pg2 || !stationary || !order) return;

  const inventoryLast = Math.max(4, inventory.rowCount || 4);
  const conversionByRow = { 11: 6, 13: 24, 14: 24, 15: 24, 25: 48, 26: 4 };
  const inventoryWeeks = [
    ['B', 'D', 'F', 'AD'], ['G', 'I', 'K', 'AE'], ['L', 'N', 'P', 'AF'],
    ['Q', 'S', 'U', 'AG'], ['V', 'X', 'Z', 'AH']
  ];
  inventoryWeeks.forEach(([primary, secondary, status, helper], weekOffset) => {
    for (let row = 4; row <= inventoryLast; row += 1) {
      const conversion = conversionByRow[row];
      const formula = conversion
        ? \`IF((N(\${primary}\${row})*\${conversion}+N(\${secondary}\${row}))<=\\$AA\${row},"Order","")\`
        : \`IF(N(\${primary}\${row})<=\\$AA\${row},"Order","")\`;
      setFormula(inventory, \`\${status}\${row}\`, formula);
      setFormula(inventory, \`\${helper}\${row}\`, \`IF(\\$\${status}\${row}="Order",\\$A\${row},"")\`);
    }
    setFormula(inventory, \`A\${50 + weekOffset}\`, \`TEXTJOIN(", ",TRUE,\${helper}4:\${helper}\${inventoryLast})\`);
  });

  applyUtensilFormulas(pg1, 41, false);
  applyUtensilFormulas(pg2, 46, true);
  const stationaryLast = Math.max(3, stationary.rowCount || 3);
  for (let row = 3; row <= stationaryLast; row += 1) {
    setFormula(stationary, \`D\${row}\`, \`IF(N(B\${row})<=\\$E\${row},"Order","")\`);
    setFormula(stationary, \`G\${row}\`, \`IF(\\$D\${row}="Order",\\$A\${row},"")\`);
  }
  setFormula(stationary, 'A44', \`TEXTJOIN(", ",TRUE,G3:G\${stationaryLast})\`);

  ensureOrderLayout(order);
  const formulas = {
    E2: 'IF(Inventory!B2="","",Inventory!B2)', A3: 'Inventory!A50',
    E5: 'IF(\\'Untensil PG1\\'!B2="","",\\'Untensil PG1\\'!B2)', A6: '\\'Untensil PG1\\'!A41', A7: '\\'Utensil PG2\\'!A46',
    E10: 'IF(Inventory!G2="","",Inventory!G2)', A11: 'Inventory!A51',
    E13: 'IF(\\'Untensil PG1\\'!E2="","",\\'Untensil PG1\\'!E2)', A14: '\\'Untensil PG1\\'!A42', A15: '\\'Utensil PG2\\'!A47',
    E18: 'IF(Inventory!L2="","",Inventory!L2)', A19: 'Inventory!A52',
    E21: 'IF(\\'Untensil PG1\\'!H2="","",\\'Untensil PG1\\'!H2)', A22: '\\'Untensil PG1\\'!A43', A23: '\\'Utensil PG2\\'!A48',
    E26: 'IF(Inventory!Q2="","",Inventory!Q2)', A27: 'Inventory!A53',
    E29: 'IF(\\'Untensil PG1\\'!K2="","",\\'Untensil PG1\\'!K2)', A30: '\\'Untensil PG1\\'!A44', A31: '\\'Utensil PG2\\'!A49',
    E34: 'IF(Inventory!V2="","",Inventory!V2)', A35: 'Inventory!A54',
    E37: 'IF(\\'Untensil PG1\\'!N2="","",\\'Untensil PG1\\'!N2)', A38: '\\'Untensil PG1\\'!A45', A39: '\\'Utensil PG2\\'!A50',
    A44: 'Stationary!A44'
  };
  Object.entries(formulas).forEach(([address, formula]) => setFormula(order, address, formula));
  order.getCell('F43').value = 'Monthly';
}

function applyUtensilFormulas(sheet, summaryStart, special) {
  const last = Math.max(4, sheet.rowCount || 4);
  const weeks = [['B', 'D', 'S'], ['E', 'G', 'T'], ['H', 'J', 'U'], ['K', 'M', 'V'], ['N', 'P', 'W']];
  weeks.forEach(([quantity, status, helper], weekOffset) => {
    for (let row = 4; row <= last; row += 1) {
      let formula = \`IF(N(\${quantity}\${row})<=\\$Q\${row},"Order","")\`;
      if (special && row === 9) formula = \`IF(N(\${quantity}\${row})<=0,"No More Use","")\`;
      if (special && row === 36) formula = \`IF(N(\${quantity}\${row})<=4,"Spare Item","")\`;
      setFormula(sheet, \`\${status}\${row}\`, formula);
      setFormula(sheet, \`\${helper}\${row}\`, \`IF(\\$\${status}\${row}="Order",\\$A\${row},"")\`);
    }
    setFormula(sheet, \`A\${summaryStart + weekOffset}\`, \`TEXTJOIN(", ",TRUE,\${helper}4:\${helper}\${last})\`);
  });
}

function ensureOrderLayout(sheet) {
  const labels = {
    A1: 'Week 1', A2: 'Inventory Order List', A5: 'Utensil Order List',
    A9: 'Week 2', A10: 'Inventory Order List', A13: 'Utensil Order List',
    A17: 'Week 3', A18: 'Inventory Order List', A21: 'Utensil Order List',
    A25: 'Week 4', A26: 'Inventory Order List', A29: 'Utensil Order List',
    A33: 'Week 5', A34: 'Inventory Order List', A37: 'Utensil Order List',
    A43: 'Stationary Stock (MONTHLY)'
  };
  Object.entries(labels).forEach(([address, value]) => { sheet.getCell(address).value = value; });
  const merges = ['A2:D2','E2:F2','A3:G3','A5:D5','E5:F5','A6:G6','A7:G7','A10:D10','E10:F10','A11:G11','A13:D13','E13:F13','A14:G14','A15:G15','A18:D18','E18:F18','A19:G19','A21:D21','E21:F21','A22:G22','A23:G23','A26:D26','E26:F26','A27:G27','A29:D29','E29:F29','A30:G30','A31:G31','A34:D34','E34:F34','A35:G35','A37:D37','E37:F37','A38:G38','A39:G39','A43:E43','F43:G43','A44:G44'];
  for (const range of merges) {
    try { sheet.mergeCells(range); } catch {}
  }
  sheet.getColumn(1).width = 34;
  for (let col = 2; col <= 7; col += 1) sheet.getColumn(col).width = col >= 5 ? 16 : 12;
  for (const row of [1, 9, 17, 25, 33]) sheet.getCell(row, 1).font = { bold: true, size: 15 };
  for (const row of [2, 5, 10, 13, 18, 21, 26, 29, 34, 37, 43]) sheet.getCell(row, 1).font = { bold: true, italic: row !== 43 };
  sheet.eachRow((row) => row.eachCell((cell) => { cell.alignment = { vertical: 'middle', wrapText: true }; }));
}

function setFormula(sheet, address, formula) {
  sheet.getCell(address).value = { formula };
}
`;
  }

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
