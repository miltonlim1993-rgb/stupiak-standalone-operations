import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1131FastStockRefresh(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  // Do not force a full Google Sheet scan whenever the browser regains focus.
  source = source.replace(
    /\n\s*window\.addEventListener\('focus', \(\) => \{ if \(state\.route === 'stock'[\s\S]*?\}\);/,
    ''
  );

  // Visibility changes should only protect the browser draft. They must not trigger a full refresh.
  source = source.replace(
    /document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(document\.visibilityState === 'hidden'\) \{ persistStockDraft\(\); return; \}\s*if \(state\.route === 'stock'[\s\S]*?\}\);/,
    `document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistStockDraft();
  });`
  );

  // When cached Stock data already exists, keep the UI quiet and editable while a normal
  // cache-backed server check runs. Only an explicit force refresh shows the refresh banner.
  source = source.replace(
    `  if (preservedResult) state.stock.submitResult = preservedResult;\n  render();\n\n  try {\n    const data = await callOperations('stock',`,
    `  if (preservedResult) state.stock.submitResult = preservedResult;\n  if (cached && !forceFresh) state.stock.syncing = false;\n  render();\n\n  try {\n    const data = await callOperations('stock',`
  );

  await writeFile(file, source);
}
