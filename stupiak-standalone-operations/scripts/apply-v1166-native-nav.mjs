import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1166NativeNav(dist) {
  await patchMain(dist);
  await patchStyles(dist);
  await audit(dist);
}

async function patchMain(dist) {
  const file = resolve(dist, 'src/main.js');
  let source = await readFile(file, 'utf8');

  source = source.replace(
    /<button class="\$\{state\.route === route \? 'active' : ''\}" data-route="\$\{route\}">\$\{icon\(ico\)\}<span>\$\{label\}<\/span><\/button>/g,
    `<a class="\${state.route === route ? 'active' : ''}" data-route="\${route}" href="#/\${route}">\${icon(ico)}<span>\${label}</span></a>`
  );
  source = source.replace(
    /<button class="\$\{state\.route === route \? 'active' : ''\}" data-route="\$\{route\}">\$\{icon\(ico\)\}<span>\$\{label\.replace\(' Count', ''\)\}<\/span><\/button>/g,
    `<a class="\${state.route === route ? 'active' : ''}" data-route="\${route}" href="#/\${route}">\${icon(ico)}<span>\${label.replace(' Count', '')}</span></a>`
  );

  source = replaceFunction(source, 'navigate', `function navigate(route) {
  if (!route) return;
  if (state.route === 'stock' && route !== 'stock') {
    try { persistStockDraft(); } catch (_) {}
  }
  state.route = route;
  const targetHash = \`#/\${route}\`;
  if (location.hash !== targetHash) location.hash = targetHash;
  try {
    render();
  } catch (error) {
    console.error('Route render failed:', route, error);
    showToast(error?.message || 'Unable to open this page.', 'error');
  }
  if (route === 'stock' && !state.stock.data && !state.stock.loading) loadStock();
  if (route === 'cash' && !state.cash.data && !state.cash.loading) loadCash();
  if (route === 'dashboard' && !state.dashboard.data && !state.dashboard.loading) loadDashboard();
}`);

  source = replaceHashchange(source, `window.addEventListener('hashchange', () => {
  const nextRoute = location.hash.replace('#/', '') || 'home';
  if (state.route === 'stock' && nextRoute !== 'stock') {
    try { persistStockDraft(); } catch (_) {}
  }
  state.route = nextRoute;
  try {
    render();
  } catch (error) {
    console.error('Hash route render failed:', nextRoute, error);
    showToast(error?.message || 'Unable to open this page.', 'error');
  }
  if (nextRoute === 'stock' && !state.stock.data && !state.stock.loading) loadStock();
  if (nextRoute === 'cash' && !state.cash.data && !state.cash.loading) loadCash();
  if (nextRoute === 'dashboard' && !state.dashboard.data && !state.dashboard.loading) loadDashboard();
});`);

  const marker = 'v1.16.6 native route bridge';
  if (!source.includes(marker)) {
    const bridge = `

// ${marker}
document.addEventListener('click', (event) => {
  const link = event.target?.closest?.('[data-route]');
  if (!link) return;
  const route = String(link.dataset.route || '').trim();
  if (!route) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  navigate(route);
}, true);
`;
    const anchor = source.indexOf("\nwindow.addEventListener('hashchange'");
    source = anchor >= 0 ? source.slice(0, anchor) + bridge + source.slice(anchor) : source + bridge;
  }

  await writeFile(file, source);
}

function replaceFunction(source, name, replacement) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`v1.16.6 navigation audit failed: ${name} start`);
  let depth = 0;
  let opened = false;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') { depth += 1; opened = true; }
    else if (source[i] === '}') {
      depth -= 1;
      if (opened && depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) throw new Error(`v1.16.6 navigation audit failed: ${name} end`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function replaceHashchange(source, replacement) {
  const start = source.indexOf("window.addEventListener('hashchange'");
  if (start < 0) throw new Error('v1.16.6 navigation audit failed: hashchange start');
  const end = source.indexOf("\n\nwindow.addEventListener('", start + 1);
  if (end < 0) throw new Error('v1.16.6 navigation audit failed: hashchange end');
  return source.slice(0, start) + replacement + source.slice(end);
}

async function patchStyles(dist) {
  const file = resolve(dist, 'src/app.css');
  let source = await readFile(file, 'utf8');
  if (!source.includes('v1.16.6 native navigation')) {
    source += `\n/* v1.16.6 native navigation */\n.sidebar nav a{border:0;background:transparent;color:#9d9fa0;padding:12px 13px;border-radius:11px;display:flex;align-items:center;gap:12px;text-align:left;text-decoration:none}.sidebar nav a:hover,.sidebar nav a.active{background:#242628;color:#fff}.sidebar nav a.active:after{content:"";margin-left:auto;width:5px;height:5px;border-radius:50%;background:var(--amber)}.bottom-nav a{color:inherit;text-decoration:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-width:0}.bottom-nav a.active{color:var(--amber)}\n`;
  }
  await writeFile(file, source);
}

async function audit(dist) {
  const main = await readFile(resolve(dist, 'src/main.js'), 'utf8');
  const css = await readFile(resolve(dist, 'src/app.css'), 'utf8');
  const checks = [
    [main.includes('href="#/${route}"'), 'native route href'],
    [main.includes('v1.16.6 native route bridge'), 'native route bridge'],
    [main.includes("nextRoute === 'stock'"), 'stock hash loader'],
    [main.includes("route === 'stock'"), 'stock direct loader'],
    [!main.includes("if (nextRoute === state.route) return;"), 'hash route early return removed'],
    [css.includes('v1.16.6 native navigation'), 'native route styles']
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
  if (failed.length) throw new Error(`v1.16.6 navigation audit failed: ${failed.join(', ')}`);
  console.log('v1.16.6 navigation audit passed: native sidebar links + Stock route loader');
}
