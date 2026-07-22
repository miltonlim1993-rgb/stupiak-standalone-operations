import { icon } from '../ui/icons.js';

export function settingsPage(context) {
  const stockManaged = Boolean(context.systemStatus?.stockGasConfigured || context.systemStatus?.stockD1Configured);
  const cashManaged = Boolean(context.systemStatus?.cashGasConfigured);
  const storageProvider = context.systemStatus?.storageProvider || 'google_drive';
  const d1Mode = context.systemStatus?.stockD1Configured;
  return `
    <section class="page settings-page">
      <div class="page-heading"><div><span class="eyebrow">SYSTEM STATUS</span><h1>Connections</h1><p>D1 stores live Stock data. Excel controls the Stock setup and Order Page layout.</p></div></div>
      <form id="settings-form" class="settings-form">
        <article class="settings-block stock-setup-block">
          <div class="settings-title"><div class="module-icon amber">${icon('stock')}</div><div><h2>Stock Setup</h2><p>Import the original outlet workbook or an exported Stock Setup file.</p></div></div>
          <div class="reserved-row"><span>Live source</span><strong>${d1Mode ? 'Cloudflare D1' : 'Not connected'}</strong></div>
          <div class="reserved-row"><span>Accepted Excel</span><strong>Original workbook or Stock Setup DB</strong></div>
          <div class="reserved-row"><span>Imported tabs</span><strong>Order Page · Inventory · Untensil PG1 · Utensil PG2 · Stationary</strong></div>
          <p class="microcopy">The original Order Page is kept. Item order, units, minimum levels and the outlet code are remembered for Stock Count.</p>
          <div class="stock-setup-actions">
            <input id="stock-setup-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
            <button class="button primary" type="button" id="import-stock-setup" disabled>Import Setup (admin)</button>
            <button class="button secondary" type="button" id="export-stock-setup" ${d1Mode ? '' : 'disabled'}>Export Setup</button>
            <button class="button secondary" type="button" id="test-stock" ${stockManaged ? '' : 'disabled'}>Test D1</button>
          </div>
          <p class="microcopy">Setup changes are locked in the outlet app. Use the administrator channel for imports and count deletion.</p>
          <div class="connection-result" id="stock-setup-result"></div>
          <div class="connection-result" id="stock-test-result"></div>
        </article>
        <article class="settings-block">
          <div class="settings-title"><div class="module-icon">${icon('cash')}</div><div><h2>Cash Count</h2><p>Cash and payment actuals save through the existing Cash GAS.</p></div></div>
          <div class="reserved-row"><span>Connection</span><strong>${cashManaged ? 'Configured' : 'Missing variables'}</strong></div>
          <div class="reserved-row"><span>Payments</span><strong>Cash · GrabFood · Grab Dine-Out · Foodpanda · Pay & Go · ShopeeFood · S Pay · DuitNow</strong></div>
        </article>
        <article class="settings-block reserved-block">
          <div class="settings-title"><div class="module-icon reserved">${icon('external')}</div><div><h2>Archive</h2><p>Exports and yearly archive do not block outlet saving.</p></div></div>
          <div class="reserved-row"><span>Storage</span><strong>${storageProvider === 'cloudflare_r2' ? 'Cloudflare R2' : 'Google Drive'}</strong></div>
          <div class="reserved-row"><span>Yearly Stock archive</span><strong>Next phase</strong></div>
        </article>
      </form>
    </section>`;
}
