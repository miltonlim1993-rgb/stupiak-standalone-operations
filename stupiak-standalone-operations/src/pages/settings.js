import { icon } from '../ui/icons.js';

export function settingsPage(context) {
  const stockManaged = Boolean(context.systemStatus?.stockGasConfigured || context.systemStatus?.stockD1Configured);
  const cashManaged = Boolean(context.systemStatus?.cashGasConfigured);
  const storageProvider = context.systemStatus?.storageProvider || 'google_drive';
  const d1Mode = context.systemStatus?.stockD1Configured;
  return `
    <section class="page settings-page">
      <div class="page-heading"><div><span class="eyebrow">SYSTEM STATUS</span><h1>Connections</h1><p>D1 is the live Stock database. Excel is the setup import/export format.</p></div></div>
      <form id="settings-form" class="settings-form">
        <article class="settings-block stock-setup-block">
          <div class="settings-title"><div class="module-icon amber">${icon('stock')}</div><div><h2>Stock Setup</h2><p>Import the Excel layout you edit in office. The front end follows the same tabs, item order, units and minimum levels.</p></div></div>
          <div class="reserved-row"><span>Live source</span><strong>${d1Mode ? 'Cloudflare D1' : 'Google Sheet / GAS fallback'}</strong></div>
          <div class="reserved-row"><span>Excel format</span><strong>Order Page · Inventory · Untensil PG1 · Utensil PG2 · Stationary</strong></div>
          <p class="microcopy">Use your RR-KCH Inventory Listing workbook as the setup file. After import, daily Stock Count saves to D1 only; Google Sheet is no longer required for live input.</p>
          <div class="stock-setup-actions">
            <input id="stock-setup-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
            <button class="button primary" type="button" id="import-stock-setup" ${d1Mode ? '' : 'disabled'}>Import Stock Setup Excel</button>
            <button class="button secondary" type="button" id="export-stock-setup" ${d1Mode ? '' : 'disabled'}>Export Stock Setup Excel</button>
            <button class="button secondary" type="button" id="test-stock" ${stockManaged ? '' : 'disabled'}>Test Stock Data</button>
          </div>
          <div class="connection-result" id="stock-setup-result"></div>
          <div class="connection-result" id="stock-test-result"></div>
        </article>
        <article class="settings-block">
          <div class="settings-title"><div class="module-icon">${icon('cash')}</div><div><h2>Cash Count</h2><p>Existing Cash workbook GAS with standalone patch.</p></div></div>
          <div class="reserved-row"><span>Configuration source</span><strong>Cloudflare Production</strong></div>
          <div class="reserved-row"><span>Connection</span><strong>${cashManaged ? 'Configured' : 'Missing variables'}</strong></div>
          <p class="microcopy">Uses CASH_GAS_URL and CASH_GAS_SECRET from Cloudflare. Website users do not configure them here.</p>
        </article>
        <article class="settings-block reserved-block">
          <div class="settings-title"><div class="module-icon reserved">${icon('external')}</div><div><h2>Archive & Integrations</h2><p>Exports and Drive archive are separated from outlet save speed.</p></div></div>
          <div class="reserved-row"><span>Current file storage</span><strong>${storageProvider === 'cloudflare_r2' ? 'Cloudflare R2' : 'Google Drive'}</strong></div>
          <div class="reserved-row"><span>Stock yearly archive</span><strong>Next phase</strong></div>
          <div class="reserved-row"><span>Statvara event connector</span><strong>${context.systemStatus?.statvara === 'enabled' ? 'Enabled' : 'Reserved'}</strong></div>
          <p class="microcopy">Daily Stock input now stays fast in D1. Excel/PDF/Drive archive can run separately without blocking outlet staff.</p>
        </article>
      </form>
    </section>`;
}
