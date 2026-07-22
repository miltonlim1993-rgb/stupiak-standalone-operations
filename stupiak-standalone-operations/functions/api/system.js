export function onRequestGet(context) {
  const stockGasConfigured = Boolean(context.env.STOCK_GAS_URL && context.env.STOCK_GAS_SECRET);
  const cashGasConfigured = Boolean(context.env.CASH_GAS_URL && context.env.CASH_GAS_SECRET);
  const stockD1Configured = Boolean(context.env.STOCK_DB);
  return new Response(JSON.stringify({
    ok: true,
    stockGasConfigured,
    cashGasConfigured,
    stockD1Configured,
    stockConnectionMode: stockD1Configured ? 'cloudflare_d1_primary' : stockGasConfigured ? 'cloudflare_server' : 'missing',
    cashConnectionMode: cashGasConfigured ? 'cloudflare_server' : 'missing',
    outletName: context.env.OUTLET_NAME || '',
    outletRouting: 'url_or_device_registry',
    statvara: context.env.STATVARA_WEBHOOK_URL ? 'enabled' : 'reserved',
    storageProvider: context.env.FILE_STORAGE_PROVIDER || 'google_drive',
    cloudflareStorageReady: Boolean(context.env.FILE_STORAGE_PROVIDER === 'cloudflare_r2'),
    adminOperationsEnabled: Boolean(context.env.OPERATIONS_ADMIN_TOKEN),
    outletRegistryConfigured: Boolean(context.env.OUTLET_REGISTRY_JSON),
    signedOutletSessionsRequired: Boolean(context.env.OUTLET_LINK_SECRET),
    version: '1.16.13'
  }), {
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
