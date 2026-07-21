import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1123NavFooter(dist) {
  await patchMain(dist);
  await patchStockPage(dist);
  await patchStyles(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  const guard = `function isStockSavePending() {
  const id = state.stock.pendingSubmission;
  if (state.stock.submitting) return true;
  if (!id || state.stock.pendingError) return false;
  return typeof activeSubmissionSyncs !== 'undefined' && activeSubmissionSyncs.has(id);
}`;

  const pattern = /function\s+isStockSavePending\s*\([^)]*\)\s*\{[\s\S]*?\n\}/;
  if (pattern.test(source)) {
    source = source.replace(pattern, guard);
  } else if (!source.includes('function isStockSavePending')) {
    source += `\n\n${guard}\n`;
  }

  await writeFile(file, source);
}

async function patchStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    `state.pendingSubmission ? 'Saving to Sheet…' : state.submitting ? 'Saving…' : state.submitBlocked ? 'Waiting for month data…' : saveLabel`,
    `state.pendingSubmission || state.submitting ? 'Saving…' : state.submitBlocked ? 'Waiting…' : 'Save to Sheet'`
  );
  source = source.replace(
    `state.submitting ? 'Syncing…' : state.submitBlocked ? 'Waiting for month data…' : saveLabel`,
    `state.submitting ? 'Saving…' : state.submitBlocked ? 'Waiting…' : 'Save to Sheet'`
  );

  await writeFile(file, source);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  source += `
/* v1.12.4 responsive Stock footer and navigation guard */
.stock-submit-panel.compact-submit-panel{padding:10px 12px}.stock-submit-panel .form-grid.two{gap:8px}.stock-submit-panel .submit-row{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;flex-wrap:nowrap!important;margin-top:8px!important;padding-top:8px!important}.stock-submit-panel .submit-row>div:first-child{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1}.stock-submit-panel .submit-row>div:first-child strong{font-size:13px;white-space:nowrap}.stock-submit-panel .submit-row>div:first-child small{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.stock-action-buttons{display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:6px!important;flex-wrap:nowrap!important;width:auto!important}.stock-action-buttons .button{min-width:0!important;width:auto!important;padding:7px 10px!important;font-size:12px!important;line-height:1.1!important;border-radius:8px!important;white-space:nowrap!important}.stock-action-buttons .button.primary{min-width:96px!important}@media(max-width:900px){.stock-submit-panel .submit-row{align-items:stretch!important;flex-direction:column!important}.stock-submit-panel .submit-row>div:first-child{display:block}.stock-submit-panel .submit-row>div:first-child small{display:block;margin-top:3px}.stock-action-buttons{justify-content:flex-start!important}}@media(max-width:560px){.stock-action-buttons{display:grid!important;grid-template-columns:1fr 1fr!important;width:100%!important}.stock-action-buttons .button{width:100%!important}.stock-action-buttons .button.primary{grid-column:1/-1!important}}
`;
  await writeFile(file, source);
}
