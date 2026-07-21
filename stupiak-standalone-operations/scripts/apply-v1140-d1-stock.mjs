import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1140D1Stock(dist) {
  await patchMain(dist);
  await patchStockPage(dist);
  await patchStyles(dist);
}

async function patchMain(dist) {
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

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    `  const failed = Boolean(pending && state.pendingError);\n  const title = failed ? 'Save not completed' : pending ? 'Saving to _StockRelation' : 'Saved to _StockRelation';\n  const detail = failed\n    ? escapeHtml(state.pendingError)\n    : pending\n      ? 'Keep this page open. The app is waiting for the Submission ID to appear in _StockSubmissions.'\n      : 'Relation save confirmed. PDF and Excel can be exported separately.';`,
    `  const failed = Boolean(pending && state.pendingError);\n  const d1MirrorPending = Boolean(!pending && result.dataSource === 'cloudflare-d1' && result.gasSyncStatus !== 'synced');\n  const title = failed ? 'Save not completed' : pending ? 'Saving to Cloudflare' : d1MirrorPending ? 'Saved fast · Google Sheet syncing' : 'Saved to _StockRelation';\n  const detail = failed\n    ? escapeHtml(state.pendingError)\n    : pending\n      ? 'Keep this page open until Cloudflare confirms the save.'\n      : d1MirrorPending\n        ? 'Cloudflare D1 has confirmed the save. You may continue working while Google Sheet updates in the background.'\n        : 'Relation save confirmed. PDF and Excel can be exported separately.';`
  );

  source = source.replace(
    `    \${state.draftNotice ? \`<div class="sync-strip warning draft-isolated"><span class="sync-dot"></span><div><strong>Older browser draft isolated</strong><span>\${escapeHtml(state.draftNotice)}</span></div></div>\` : ''}\${stockSyncStatusMarkup(state)}`,
    `    \${state.data?.dataSource === 'cloudflare-d1' ? '<div class="d1-fast-badge"><span></span>Fast data · Cloudflare D1</div>' : ''}\${state.draftNotice ? \`<div class="sync-strip warning draft-isolated"><span class="sync-dot"></span><div><strong>Older browser draft isolated</strong><span>\${escapeHtml(state.draftNotice)}</span></div></div>\` : ''}\${stockSyncStatusMarkup(state)}`
  );

  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `\n/* v1.14.0 D1-first Stock flow */\n.d1-fast-badge{display:inline-flex;align-items:center;gap:7px;width:max-content;margin:-4px 0 10px;padding:6px 9px;border:1px solid #b8dfcc;border-radius:999px;background:#f1fbf6;color:#237653;font-size:11px;font-weight:800}.d1-fast-badge span{width:7px;height:7px;border-radius:50%;background:#2d9b6d;box-shadow:0 0 0 3px rgba(45,155,109,.13)}\n`;
  await writeFile(file, source);
}
