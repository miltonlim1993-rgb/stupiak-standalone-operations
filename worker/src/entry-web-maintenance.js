import app, { OutletRealtimeHub } from './entry-master-watch.js'

const MAINTENANCE_REVISION = 'web-maintenance-2026-08-21-v1'

function isNativeAppRequest(request) {
  const marker = String(request.headers.get('X-ChefOps-Native') || '').trim().toLowerCase()
  const origin = String(request.headers.get('Origin') || '').trim().toLowerCase()
  return marker === 'android'
    || origin === 'https://localhost'
    || origin === 'capacitor://localhost'
}

function commonHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Retry-After': '3600',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-ChefOps-Maintenance': MAINTENANCE_REVISION,
  }
}

function maintenanceApiResponse() {
  return new Response(JSON.stringify({
    ok: false,
    error: 'Stupiak OPS web access is temporarily paused for maintenance.',
    code: 'web_maintenance',
    maintenance: true,
    revision: MAINTENANCE_REVISION,
  }), {
    status: 503,
    headers: commonHeaders('application/json; charset=utf-8'),
  })
}

function maintenancePage() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <title>Stupiak OPS — Maintenance</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f8; color: #151515; padding: 24px; }
    main { width: min(560px, 100%); background: white; border: 1px solid #e5e7eb; border-radius: 18px; padding: 36px; box-shadow: 0 18px 50px rgba(0,0,0,.06); }
    .mark { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 12px; background: #f2aa00; color: #111; font-weight: 800; margin-bottom: 22px; }
    h1 { margin: 0 0 12px; font-size: clamp(28px, 5vw, 40px); letter-spacing: -.035em; }
    p { margin: 0; color: #5f6368; line-height: 1.65; font-size: 16px; }
    .small { margin-top: 22px; padding-top: 18px; border-top: 1px solid #eceff1; font-size: 13px; color: #8a8f98; }
  </style>
</head>
<body>
  <main>
    <div class="mark">OPS</div>
    <h1>Temporarily unavailable</h1>
    <p>Stupiak OPS web access is paused while system maintenance is in progress. Please try again later.</p>
    <p class="small">Maintenance mode · ${MAINTENANCE_REVISION}</p>
  </main>
</body>
</html>`
  return new Response(html, {
    status: 503,
    headers: commonHeaders('text/html; charset=utf-8'),
  })
}

export default {
  ...app,

  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // Keep health available for deployment verification and monitoring.
    if (request.method === 'GET' && url.pathname === '/api/health') {
      const response = await app.fetch(request, env, ctx)
      const headers = new Headers(response.headers)
      headers.set('X-ChefOps-Maintenance', MAINTENANCE_REVISION)
      headers.set('Cache-Control', 'no-store')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }

    // Native Android/Capacitor clients keep their API path. The requested pause
    // is scoped to web/PWA browser access and does not mutate runtime data.
    if (isNativeAppRequest(request)) return app.fetch(request, env, ctx)

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return maintenanceApiResponse()
    }

    return maintenancePage()
  },
}

export { OutletRealtimeHub }
