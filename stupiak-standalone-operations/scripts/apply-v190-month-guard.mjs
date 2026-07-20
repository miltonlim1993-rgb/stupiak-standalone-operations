import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.9.0 month guard failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV190MonthGuard(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');
  source = replaceRequired(
    source,
    `    initializeStockValues(state.stock, cached);\n    const cachedMonth`,
    `    initializeStockValues(state.stock, cached);\n    state.stock.monthKey = requestedMonth;\n    state.stock.businessDate = requestedMonth + '-01';\n    const cachedMonth`,
    'cached month must not replace requested month'
  );
  source = replaceRequired(
    source,
    `    initializeStockValues(state.stock, data);\n    applyStockDraft`,
    `    initializeStockValues(state.stock, data);\n    state.stock.monthKey = requestedMonth;\n    state.stock.businessDate = requestedMonth + '-01';\n    applyStockDraft`,
    'fresh month must preserve requested month'
  );
  await writeFile(file, source);
}
