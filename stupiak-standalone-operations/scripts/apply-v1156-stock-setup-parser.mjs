import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceIfPresent(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    console.warn(`v1.15.6 patch skipped: ${label}`);
    return source;
  }
  return source.replace(pattern, replacement);
}

export async function applyV1156StockSetupParser(dist) {
  const setupPath = resolve(dist, 'src/core/stock-setup-excel.js');
  let source = await readFile(setupPath, 'utf8');

  // v1.15.5 normally installs findStockWorksheet()/normalizeSheetName().
  // Keep this patch safe when those helpers already exist, and never declare them twice.
  if (!source.includes('function findStockWorksheet(')) {
    source = replaceIfPresent(
      source,
      /function parseInventorySheet\(sheet\) \{/,
      `function findStockWorksheet(workbook, expectedName) {
  const expected = normalizeStockSheetNameV1156(expectedName);
  return workbook.getWorksheet(expectedName)
    || (workbook.worksheets || []).find((sheet) => normalizeStockSheetNameV1156(sheet.name) === expected)
    || null;
}

function normalizeStockSheetNameV1156(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\\u200B-\\u200D\\uFEFF]/g, '')
    .replace(/\\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseInventorySheet(sheet) {`,
      'worksheet lookup fallback'
    );
  }

  source = source.replace("parseInventorySheet(workbook.getWorksheet('Inventory'))", "parseInventorySheet(findStockWorksheet(workbook, 'Inventory'))");
  source = source.replace('parseUtensilSheet(workbook.getWorksheet(name), name)', 'parseUtensilSheet(findStockWorksheet(workbook, name), name)');
  source = source.replace("parseStationarySheet(workbook.getWorksheet('Stationary'))", "parseStationarySheet(findStockWorksheet(workbook, 'Stationary'))");
  source = source.replace("parseOrderPage(workbook.getWorksheet('Order Page'))", "parseOrderPage(findStockWorksheet(workbook, 'Order Page'))");

  // v1.15.5 already rejects partial workbooks. Only add the guard when absent.
  if (!source.includes('missingSheets') && !source.includes('Stock setup is incomplete')) {
    source = replaceIfPresent(
      source,
      /\n\s*if \(!sheets\.length\) throw new Error\('No valid Stock setup rows found\. Keep the Excel tab names: Inventory, Untensil PG1, Utensil PG2, Stationary\.'\);/,
      `\n  const requiredSheetsV1156 = ['Inventory', 'Untensil PG1', 'Utensil PG2', 'Stationary'];
  const importedSheetsV1156 = new Set(sheets.map((sheet) => String(sheet.sheetName || '').trim().toLowerCase()));
  const missingSheetsV1156 = requiredSheetsV1156.filter((name) => !importedSheetsV1156.has(name.toLowerCase()));
  if (missingSheetsV1156.length) {
    const available = workbook.worksheets.map((sheet) => sheet.name).join(', ') || 'none';
    throw new Error(\`Stock setup is incomplete. Missing: \${missingSheetsV1156.join(', ')}. Excel tabs found: \${available}\`);
  }
  if (!sheets.length) throw new Error('No valid Stock setup rows found. Keep the Excel tab names: Inventory, Untensil PG1, Utensil PG2, Stationary.');`,
      'complete setup requirement'
    );
  }

  source = source.replaceAll('if (!item) continue;', 'if (!isValidItemName(item)) continue;');

  if (!source.includes('function isValidItemName(')) {
    source = replaceIfPresent(
      source,
      /function text\(sheet, row, col\) \{\n\s*return display\(sheet\.getCell\(row, col\)\.value\)\.trim\(\);\n\}/,
      `function text(sheet, row, col) {
  return display(sheet.getCell(row, col).value).trim();
}

function isValidItemName(value) {
  const textValue = String(value || '').trim();
  if (!textValue) return false;
  if (/^\\[object\\s+object\\]$/i.test(textValue)) return false;
  if (/^week\\s+\\d+/i.test(textValue)) return false;
  if (/^quantity/i.test(textValue)) return false;
  if (/^status$/i.test(textValue)) return false;
  return true;
}`,
      'item validator'
    );
  }

  if (!source.includes('value.sharedFormula')) {
    source = replaceIfPresent(
      source,
      /function display\(value\) \{\n\s*if \(value === null \|\| value === undefined\) return '';\n\s*if \(typeof value === 'object'\) \{\n\s*if \(value\.result !== undefined\) return display\(value\.result\);\n\s*if \(value\.text !== undefined\) return String\(value\.text \|\| ''\);\n\s*if \(Array\.isArray\(value\.richText\)\) return value\.richText\.map\(\(part\) => part\.text \|\| ''\)\.join\(''\);\n\s*if \(value\.formula\) return '';\n\s*\}\n\s*return String\(value\);\n\}/,
      `function display(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.result !== undefined) return display(value.result);
    if (value.text !== undefined) return String(value.text || '');
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if (value.hyperlink && value.text) return String(value.text || '');
    if (value.formula || value.sharedFormula) return '';
    return '';
  }
  return String(value);
}`,
      'safe display value'
    );
  }

  await writeFile(setupPath, source, 'utf8');

  const stockPagePath = resolve(dist, 'src/pages/stock.js');
  let pageSource = await readFile(stockPagePath, 'utf8');
  if (pageSource.includes('state.submitResult = null;') && !pageSource.includes('data?.countedBy')) {
    pageSource = pageSource.replace('state.submitResult = null;', `if (data?.countedBy) state.countedBy = data.countedBy;\n  state.submitResult = null;`);
    await writeFile(stockPagePath, pageSource, 'utf8');
  }
}