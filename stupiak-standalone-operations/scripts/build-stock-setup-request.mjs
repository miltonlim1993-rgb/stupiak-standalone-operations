import ExcelJS from 'exceljs';
import { parseLegacyStockSetupWorkbook } from '../src/core/stock-setup-legacy.js';

const [workbookPath, outletRef = 'RR-KCH'] = process.argv.slice(2);
if (!workbookPath) throw new Error('Usage: node scripts/build-stock-setup-request.mjs <workbook.xlsx> [outlet]');

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(workbookPath);
const filename = workbookPath.split('/').pop() || 'Stock Setup.xlsx';
const setup = parseLegacyStockSetupWorkbook(workbook, outletRef, filename);

process.stdout.write(JSON.stringify({
  service: 'stock',
  payload: { action: 'importStockSetup', outlet: outletRef, setup }
}));
