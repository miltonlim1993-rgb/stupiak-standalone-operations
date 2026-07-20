import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.5 build patch failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV15Patches(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    "  outlet: '',\n  systemStatus: null,",
    "  outletRef: readOutletRef(),\n  outlet: '',\n  systemStatus: null,",
    'outlet reference state'
  );

  source = replaceRequired(
    source,
    'function shell(content) {',
    `function readOutletRef() {
  const storageKey = 'stupiak.operations.outletRef';
  const params = new URLSearchParams(location.search);
  const value = String(params.get('outlet') || params.get('outletId') || params.get('site') || '').trim();
  if (value) {
    try { localStorage.setItem(storageKey, value); } catch {}
    return value;
  }
  try { return String(localStorage.getItem(storageKey) || '').trim(); } catch { return ''; }
}

function shell(content) {`,
    'outlet reference reader'
  );

  source = replaceRequired(
    source,
    "    const outlet = state.outlet || state.systemStatus?.outletName || '';",
    "    const outlet = state.outletRef || state.outlet || state.systemStatus?.outletName || '';",
    'cash load outlet reference'
  );

  source = replaceRequired(
    source,
    "    const dashboardOutlet = state.outlet || state.systemStatus?.outletName || '';",
    "    const dashboardOutlet = state.outletRef || state.outlet || state.systemStatus?.outletName || '';",
    'dashboard outlet reference'
  );

  source = replaceRequired(
    source,
    "  const cashOutlet = state.outlet || state.cash.data?.outlet || state.systemStatus?.outletName || '';",
    "  const cashOutlet = state.cash.data?.outlet || state.outletRef || state.outlet || state.systemStatus?.outletName || '';",
    'cash submit outlet reference'
  );

  source = replaceRequired(
    source,
    "  state.outlet = status?.outletName || state.outlet;",
    "  state.outlet = state.outletRef || status?.outletName || state.outlet;",
    'system status outlet preference'
  );

  await writeFile(file, source);
}
