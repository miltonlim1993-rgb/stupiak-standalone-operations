import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV191StaticStockFooter(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `\n/* v1.9.1 stock submit panel stays in normal document flow */\n.compact-submit-panel{position:static!important;bottom:auto!important;z-index:auto!important;box-shadow:none!important}\n`;
  await writeFile(file, source);
}
