import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1103TemplateStockExport(dist, root) {
  await copyFile(
    resolve(root, 'src/core/stock-template-export.js'),
    resolve(dist, 'src/core/stock-local-export.js')
  );
}
