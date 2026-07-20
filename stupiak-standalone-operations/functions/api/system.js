export function onRequestGet(context) {
  const stockGasConfigured = Boolean(context.env.STOCK_GAS_URL && context.env.STOCK_GAS_SECRET);
  const cashGasConfigured = Boolean(context.env.CASH_GAS_URL && context.env.CASH_GAS_SECRET);
  return new Response(JSON.stringify({
    ok: true,
    stockGasConfigured,
    cashGasConfigured,
    stockConnectionMode: stockGasConfigured ? 'cloudflare_server' : 'browser_settings',
    cashConnectionMode: cashGasConfigured ? 'cloudflare_server' : 'browser_settings',
    statvara: context.env.STATVARA_WEBHOOK_URL ? 'enabled' : 'reserved',
    storageProvider: context.env.FILE_STORAGE_PROVIDER || 'google_drive',
    cloudflareStorageReady: Boolean(context.env.FILE_STORAGE_PROVIDER === 'cloudflare_r2'),
    version: '1.1.0'
  }), {
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
