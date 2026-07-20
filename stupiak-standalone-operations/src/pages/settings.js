import { icon } from '../ui/icons.js';

export function settingsPage(context) {
  const stockManaged = Boolean(context.systemStatus?.stockGasConfigured);
  const cashManaged = Boolean(context.systemStatus?.cashGasConfigured);
  const storageProvider = context.systemStatus?.storageProvider || 'google_drive';
  return `
    <section class="page settings-page">
      <div class="page-heading"><div><span class="eyebrow">SYSTEM STATUS</span><h1>Connections</h1><p>Production connection values are controlled only in Cloudflare Variables and Secrets.</p></div></div>
      <form id="settings-form" class="settings-form">
        <article class="settings-block">
          <div class="settings-title"><div class="module-icon amber">${icon('stock')}</div><div><h2>Stock Count</h2><p>Original-layout monthly Google Sheet GAS.</p></div></div>
          <div class="reserved-row"><span>Configuration source</span><strong>Cloudflare Production</strong></div>
          <div class="reserved-row"><span>Connection</span><strong>${stockManaged ? 'Configured' : 'Missing variables'}</strong></div>
          <p class="microcopy">Uses STOCK_GAS_URL and STOCK_GAS_SECRET from Cloudflare. These values are never entered or exposed on outlet devices.</p>
          <button class="button secondary" type="button" id="test-stock" ${stockManaged ? '' : 'disabled'}>Test Stock Connection</button>
          <div class="connection-result" id="stock-test-result"></div>
        </article>
        <article class="settings-block">
          <div class="settings-title"><div class="module-icon">${icon('cash')}</div><div><h2>Cash Count</h2><p>Existing Cash workbook GAS with standalone patch.</p></div></div>
          <div class="reserved-row"><span>Configuration source</span><strong>Cloudflare Production</strong></div>
          <div class="reserved-row"><span>Connection</span><strong>${cashManaged ? 'Configured' : 'Missing variables'}</strong></div>
          <p class="microcopy">Uses CASH_GAS_URL and CASH_GAS_SECRET from Cloudflare. Website users do not configure them here.</p>
        </article>
        <article class="settings-block reserved-block">
          <div class="settings-title"><div class="module-icon reserved">${icon('external')}</div><div><h2>Integrations</h2><p>Server-managed and hidden from outlet staff.</p></div></div>
          <div class="reserved-row"><span>Current file storage</span><strong>${storageProvider === 'cloudflare_r2' ? 'Cloudflare R2' : 'Google Drive'}</strong></div>
          <div class="reserved-row"><span>Statvara event connector</span><strong>${context.systemStatus?.statvara === 'enabled' ? 'Enabled' : 'Reserved'}</strong></div>
          <p class="microcopy">Google Drive remains the active storage. Statvara and Cloudflare R2 can be enabled later without changing the outlet counting pages.</p>
        </article>
      </form>
    </section>`;
}
