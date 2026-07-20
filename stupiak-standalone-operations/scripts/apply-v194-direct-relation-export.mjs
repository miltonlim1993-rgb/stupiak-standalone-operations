import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.9.4 patch failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV194DirectRelationExport(dist) {
  await patchMain(dist);
  await patchStockPage(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `  prepareStockSharePackage(payload, result, { quiet: options.quiet });\n  setTimeout(() => loadStock({ preserveResult: true, forceFresh: true }), 250);`,
    `  prepareStockSharePackage(payload, result, { quiet: options.quiet });\n  // Keep the current local table. A forced bootstrap refresh would reopen the full\n  // monthly workbook and compete with PDF/XLSX preparation.`,
    'remove heavy post-save bootstrap refresh'
  );

  source = replaceRequired(
    source,
    `      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 2000 : 3000));`,
    `      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 600 : 1200));`,
    'faster relation confirmation polling'
  );

  source = source.replace(
    `    }, state.settings, { timeoutMs: 180000 });`,
    `    }, state.settings, { timeoutMs: 60000 });`
  );

  source = source.replace(
    `  showToast('Saved on this device. Google Sheet upload continues in the background.');`,
    `  showToast('Saved on this device. Writing directly to the relation sheet.');`
  );

  source = source.replace(
    `      state.stock.syncError = 'Saved on this device. Checking Google Sheet confirmation in the background.';`,
    `      state.stock.syncError = 'Relation write is being confirmed in the background.';`
  );

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');
  source = source.replace(
    `Google Sheet upload continues in the background. PDF and Excel start automatically after confirmation.`,
    `Writing directly to _StockRelation. The compact PDF and XLSX start immediately after confirmation.`
  );
  source = source.replace(`<strong>Uploading</strong>`, `<strong>Saving relation</strong>`);
  source = source.replace(
    `Preparing PDF and Excel</strong><small>Stock is already saved. File export continues separately.`,
    `Preparing PDF and Excel</strong><small>Stock is already saved. Files are generated from this submission only, not from the full workbook.`
  );
  await writeFile(file, source);
}
