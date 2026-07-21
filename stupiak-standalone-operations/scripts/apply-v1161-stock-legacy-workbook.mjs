import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1161StockLegacyWorkbook(dist) {
  const file = resolve(dist, 'src/core/stock-setup-excel.js');
  let source = await readFile(file, 'utf8');

  if (!source.includes("./stock-setup-legacy.js")) {
    source = `import { parseLegacyStockSetupWorkbook, parseLegacyOrderPage, writeLegacySetupSheets } from './stock-setup-legacy.js';\n\n${source}`;
  }

  source = source.replace(
    `  if (!sheet) {\n    const tabs = (workbook.worksheets || []).map((entry) => entry.name).join(', ') || 'none';\n    throw new Error(\`Use the Stock Setup DB format. Sheet "Stock Setup DB" was not found. Found: \${tabs}\`);\n  }`,
    `  if (!sheet) return parseLegacyStockSetupWorkbook(workbook, fallbackOutlet, file.name || 'Stock Setup.xlsx');`
  );

  source = source.replace(
    `  return {\n    version: 3,\n    outlet,\n    workbookName: file.name || 'Stock Setup DB.xlsx',\n    importedAt: new Date().toISOString(),\n    sheets,\n    orderPage: { values: [] }\n  };`,
    `  return {\n    version: 4,\n    outletId: String(fallbackOutlet || '').trim(),\n    outletCode: outlet,\n    outlet,\n    workbookName: file.name || 'Stock Setup DB.xlsx',\n    importedAt: new Date().toISOString(),\n    sheets,\n    orderPage: parseLegacyOrderPage(workbook)\n  };`
  );

  source = source.replace(
    `  const workbook = new ExcelJS.Workbook();\n  workbook.creator = 'Stupiak Operations';\n  const sheet = workbook.addWorksheet('Stock Setup DB');`,
    `  const workbook = new ExcelJS.Workbook();\n  workbook.creator = 'Stupiak Operations';\n  writeLegacySetupSheets(workbook, setup);\n  const sheet = workbook.addWorksheet('Stock Setup DB');`
  );

  await writeFile(file, source);
}
