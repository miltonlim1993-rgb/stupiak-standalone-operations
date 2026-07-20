import { icon } from '../ui/icons.js';
import { formatDate, todayIso, weekPeriod } from '../core/dates.js';

export function homePage(context) {
  const period = weekPeriod(todayIso());
  const outlet = context.outlet || 'Outlet will load from Stock GAS';
  return `
    <section class="page page-home">
      <div class="hero-card">
        <div>
          <span class="eyebrow">STANDALONE OPERATIONS</span>
          <h1>${outlet}</h1>
          <p>Cash and stock records without FeedMe. Google Drive is active; Statvara and Cloudflare storage are already reserved behind the connector layer.</p>
        </div>
        <div class="hero-period">
          <span>Current stock period</span>
          <strong>${period.label}</strong>
          <small>${period.rangeLabel}</small>
        </div>
      </div>
      <div class="module-grid">
        <button class="module-card" data-route="cash">
          <div class="module-icon">${icon('cash', 25)}</div>
          <div class="module-copy"><span>Cash Count</span><strong>Opening · Handover · Closing</strong><small>Multiple handovers are kept as separate records.</small></div>
          ${icon('arrow')}
        </button>
        <button class="module-card" data-route="stock">
          <div class="module-icon amber">${icon('stock', 25)}</div>
          <div class="module-copy"><span>Stock Count</span><strong>${period.label} · ${period.rangeLabel}</strong><small>Uses the original Excel row and week layout.</small></div>
          ${icon('arrow')}
        </button>
      </div>
      <div class="status-grid">
        <article class="status-card">
          <span class="status-dot ${context.settings.stockCountGasUrl ? 'online' : ''}"></span>
          <div><strong>Stock GAS</strong><small>${context.settings.stockCountGasUrl ? 'Configured' : 'Not configured'}</small></div>
        </article>
        <article class="status-card">
          <span class="status-dot ${context.settings.cashCountGasUrl ? 'online' : ''}"></span>
          <div><strong>Cash GAS</strong><small>${context.settings.cashCountGasUrl ? 'Configured' : 'Waiting for setup'}</small></div>
        </article>
        <article class="status-card">
          <span class="status-dot reserved"></span>
          <div><strong>Statvara connector</strong><small>${context.systemStatus?.statvara === 'enabled' ? 'Enabled' : 'Reserved · disabled'}</small></div>
        </article>
        <article class="status-card">
          <span class="status-dot reserved"></span>
          <div><strong>File storage</strong><small>${context.systemStatus?.storageProvider || 'Google Drive now · Cloudflare ready'}</small></div>
        </article>
      </div>
      <div class="quiet-panel">
        ${icon('calendar')}
        <div><strong>${formatDate(todayIso())}</strong><span>Next period: ${formatDate(period.nextStart)} – ${formatDate(period.nextEnd)}</span></div>
      </div>
    </section>`;
}
