import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1131FastStockRefresh(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  const focusRefresh = `  window.addEventListener('focus', () => { if (state.route === 'stock' && !state.stock.syncing && Date.now() - Number(state.stock.sheetLoadedAt || 0) > 15000) loadStock({ forceFresh: true, preserveResult: true }); });`;
  source = source.replace(focusRefresh, '');

  const visibilityRefresh = `  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { persistStockDraft(); return; }
    if (state.route === 'stock' && !state.stock.syncing && Date.now() - Number(state.stock.sheetLoadedAt || 0) > 15000) loadStock({ forceFresh: true, preserveResult: true });
  });`;
  source = source.replace(
    visibilityRefresh,
    `  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistStockDraft();
  });`
  );

  // Cached data should display instantly without a persistent refresh banner.
  source = source.replace(
    `  if (preservedResult) state.stock.submitResult = preservedResult;\n  render();\n\n  try {\n    const data = await callOperations('stock',`,
    `  if (preservedResult) state.stock.submitResult = preservedResult;\n  if (cached && !forceFresh) state.stock.syncing = false;\n  render();\n\n  try {\n    const data = await callOperations('stock',`
  );

  await writeFile(file, source);
}
