import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.9.3 patch failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV193StockFooterFilter(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');
  source = replaceRequired(
    source,
    `export function initializeStockValues(state, data) {\n  const monthKey = String(data.monthKey || state.businessDate || todayIso()).slice(0, 7);`,
    `export function initializeStockValues(state, data) {\n  data.sections = (data.sections || []).map(sanitizeStockSectionRows);\n  const monthKey = String(data.monthKey || state.businessDate || todayIso()).slice(0, 7);`,
    'sanitize stock rows before rendering'
  );
  source = replaceRequired(
    source,
    `function dirtyWeekIndexes(state) {`,
    `function sanitizeStockSectionRows(section) {\n  const sourceRows = Array.isArray(section?.rows) ? section.rows.slice().sort((a, b) => Number(a.row || 0) - Number(b.row || 0)) : [];\n  const rows = [];\n  let previousRow = null;\n  for (const row of sourceRows) {\n    const item = String(row?.item || '').trim();\n    if (!item) continue;\n    const commaCount = (item.match(/,/g) || []).length;\n    const footerLike = commaCount >= 4 || item.length > 180;\n    const gap = previousRow === null ? 0 : Number(row.row || 0) - previousRow;\n    if (footerLike || (gap >= 4 && commaCount >= 2)) break;\n    rows.push(row);\n    previousRow = Number(row.row || 0);\n  }\n  return { ...section, rows };\n}\n\nfunction dirtyWeekIndexes(state) {`,
    'footer row sanitizer helper'
  );
  await writeFile(file, source);
}
