import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`v1.15.6 patch failed: ${label}`);
  return source.replace(pattern, replacement);
}

export async function applyV1156StockSetupParser(dist) {
  const setupPath = resolve(dist, 'src/core/stock-setup-excel.js');
  let source = await readFile(setupPath, 'utf8');

  source = source.replaceAll("workbook.getWorksheet('Inventory')", "findWorksheet(workbook, 'Inventory')");
  source = source.replaceAll("workbook.getWorksheet('Stationary')", "findWorksheet(workbook, 'Stationary')");
  source = source.replaceAll("workbook.getWorksheet('Order Page')", "findWorksheet(workbook, 'Order Page')");
  source = source.replaceAll('workbook.getWorksheet(name)', 'findWorksheet(workbook, name)');

  source = replaceRequired(
    source,
    /\n\s*if \(!sheets\.length\) throw new Error\('No valid Stock setup rows found\. Keep the Excel tab names: Inventory, Untensil PG1, Utensil PG2, Stationary\.'\);/,
    `\n  const required = ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary'];\n  const imported = new Set(sheets.map((sheet) => normalizeSheetName(sheet.sheetName)));\n  const missing = required.filter((name) => !imported.has(normalizeSheetName(name)));\n  if (missing.length) {\n    const available = workbook.worksheets.map((sheet) => sheet.name).join(', ') || 'none';\n    throw new Error(\`Stock setup is incomplete. Missing: \${missing.join(', ')}. Excel tabs found: \${available}\`);\n  }\n  if (!sheets.length) throw new Error('No valid Stock setup rows found. Keep the Excel tab names: Inventory, Untensil PG1, Utensil PG2, Stationary.');`,
    'complete setup requirement'
  );

  source = source.replaceAll('if (!item) continue;', 'if (!isValidItemName(item)) continue;');

  source = replaceRequired(
    source,
    /function text\(sheet, row, col\) \{\n\s*return display\(sheet\.getCell\(row, col\)\.value\)\.trim\(\);\n\}/,
    `function text(sheet, row, col) {\n  return display(sheet.getCell(row, col).value).trim();\n}\n\nfunction findWorksheet(workbook, wantedName) {\n  const wanted = normalizeSheetName(wantedName);\n  return workbook.getWorksheet(wantedName) || workbook.worksheets.find((sheet) => normalizeSheetName(sheet.name) === wanted) || null;\n}\n\nfunction normalizeSheetName(value) {\n  return String(value || '')\n    .replace(/[\\u200B-\\u200D\\uFEFF]/g, '')\n    .replace(/\\s+/g, ' ')\n    .trim()\n    .toLowerCase();\n}\n\nfunction isValidItemName(value) {\n  const textValue = String(value || '').trim();\n  if (!textValue) return false;\n  if (/^\\[object\\s+object\\]$/i.test(textValue)) return false;\n  if (/^week\\s+\\d+/i.test(textValue)) return false;\n  if (/^quantity/i.test(textValue)) return false;\n  if (/^status$/i.test(textValue)) return false;\n  return true;\n}`,
    'worksheet lookup helpers'
  );

  source = replaceRequired(
    source,
    /function display\(value\) \{\n\s*if \(value === null \|\| value === undefined\) return '';\n\s*if \(typeof value === 'object'\) \{\n\s*if \(value\.result !== undefined\) return display\(value\.result\);\n\s*if \(value\.text !== undefined\) return String\(value\.text \|\| ''\);\n\s*if \(Array\.isArray\(value\.richText\)\) return value\.richText\.map\(\(part\) => part\.text \|\| ''\)\.join\(''\);\n\s*if \(value\.formula\) return '';\n\s*\}\n\s*return String\(value\);\n\}/,
    `function display(value) {\n  if (value === null || value === undefined) return '';\n  if (typeof value === 'object') {\n    if (value.result !== undefined) return display(value.result);\n    if (value.text !== undefined) return String(value.text || '');\n    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');\n    if (value.hyperlink && value.text) return String(value.text || '');\n    if (value.formula || value.sharedFormula) return '';\n    return '';\n  }\n  return String(value);\n}`,
    'safe display value'
  );

  await writeFile(setupPath, source, 'utf8');

  const stockPagePath = resolve(dist, 'src/pages/stock.js');
  let pageSource = await readFile(stockPagePath, 'utf8');
  if (pageSource.includes('state.submitResult = null;') && !pageSource.includes('data?.countedBy')) {
    pageSource = pageSource.replace('state.submitResult = null;', `if (data?.countedBy) state.countedBy = data.countedBy;\n  state.submitResult = null;`);
    await writeFile(stockPagePath, pageSource, 'utf8');
  }
}
