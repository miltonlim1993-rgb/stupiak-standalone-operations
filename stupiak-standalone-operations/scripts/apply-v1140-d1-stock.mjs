import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1140D1Stock(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    `const data = await callOperations('stock', { action: 'getBootstrap', businessDate: state.stock.businessDate, refresh: forceFresh }, state.settings, { timeoutMs: 60000 });`,
    `const data = await callOperations('stock', { action: 'getBootstrap', outlet, businessDate: state.stock.businessDate, refresh: forceFresh }, state.settings, { timeoutMs: forceFresh ? 60000 : 15000 });`
  );

  source = source.replace(
    `  const payload = buildStockPayload(state.stock);\n  queueSubmission('stock', payload);`,
    `  const payload = buildStockPayload(state.stock);\n  payload.outlet = stockOfflineOutlet();\n  queueSubmission('stock', payload);`
  );

  source = source.replace(
    `      action: 'getStockSubmissionStatus',\n      submissionId: payload.submissionId,`,
    `      action: 'getStockSubmissionStatus',\n      outlet: payload.outlet || stockOfflineOutlet(),\n      submissionId: payload.submissionId,`
  );

  await writeFile(file, source);
}
