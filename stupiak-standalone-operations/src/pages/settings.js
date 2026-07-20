import { icon } from '../ui/icons.js';

export function settingsPage(context) {
  const s = context.settings;
  const stockManaged = Boolean(context.systemStatus?.stockGasConfigured);
  const cashManaged = Boolean(context.systemStatus?.cashGasConfigured);
  return `
    <section class="page settings-page">
      <div class="page-heading"><div><span class="eyebrow">DEV SETTINGS</span><h1>Connections</h1><p>Cash and Stock remain separate because they write to different Google Sheets.</p></div></div>
      <form id="settings-form" class="settings-form">
        <article class="settings-block">
          <div class="settings-title"><div class="module-icon amber">${icon('stock')}</div><div><h2>Stock Count</h2><p>Original-layout monthly Google Sheet GAS.</p></div></div>
          ${stockManaged ? `
            <div class="reserved-row"><span>Connection</span><strong>Managed securely by Cloudflare</strong></div>
            <p class="microcopy">The Stock GAS URL and secret are stored as Cloudflare server variables and are not exposed to outlet devices.</p>
          ` : `
            <label>Stock Count GAS URL<input name="stockCountGasUrl" type="url" value="${escapeHtml(s.stockCountGasUrl)}" placeholder="https://script.google.com/macros/s/.../exec" required></label>
            <label>Stock Count Secret<input name="stockCountGasSecret" type="password" value="${escapeHtml(s.stockCountGasSecret)}" autocomplete="off" placeholder="Same as STOCKCOUNT_SECRET"></label>
          `}
          <button class="button secondary" type="button" id="test-stock">Test Stock Connection</button>
          <div class="connection-result" id="stock-test-result"></div>
        </article>
        <article class="settings-block">
          <div class="settings-title"><div class="module-icon">${icon('cash')}</div><div><h2>Cash Count</h2><p>Existing Cash workbook GAS with standalone patch.</p></div></div>
          ${cashManaged ? `
            <div class="reserved-row"><span>Connection</span><strong>Managed securely by Cloudflare</strong></div>
            <p class="microcopy">The Cash GAS URL and secret are stored as Cloudflare server variables.</p>
          ` : `
            <label>Cash Count GAS URL<input name="cashCountGasUrl" type="url" value="${escapeHtml(s.cashCountGasUrl)}" placeholder="https://script.google.com/macros/s/.../exec"></label>
            <label>Cash Count Secret<input name="cashCountGasSecret" type="password" value="${escapeHtml(s.cashCountGasSecret)}" autocomplete="off" placeholder="Cash GAS secret"></label>
          `}
        </article>
        <article class="settings-block reserved-block">
          <div class="settings-title"><div class="module-icon reserved">${icon('external')}</div><div><h2>Future integrations</h2><p>Reserved at Cloudflare server level, hidden from outlet staff.</p></div></div>
          <div class="reserved-row"><span>Statvara event connector</span><strong>${context.systemStatus?.statvara === 'enabled' ? 'Enabled' : 'Reserved'}</strong></div>
          <div class="reserved-row"><span>Cloudflare file storage adapter</span><strong>${context.systemStatus?.storageProvider === 'cloudflare_r2' ? 'Enabled' : 'Reserved'}</strong></div>
          <p class="microcopy">Later, an outlet submission can continue writing to Google Drive and also emit a signed event to Statvara. File storage can then switch from Google Drive to Cloudflare R2 without changing this UI.</p>
        </article>
        ${(!stockManaged || !cashManaged) ? '<div class="sticky-actions"><button class="button primary" type="submit">Save settings</button></div>' : ''}
      </form>
    </section>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
}
