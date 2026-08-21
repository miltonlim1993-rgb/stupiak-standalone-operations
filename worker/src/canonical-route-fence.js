const CANONICAL_ONLY_EXACT = new Map([
  ['POST /api/close-up/upsert', 'close_up_d1'],
  ['POST /api/tasks/operational/action', 'task_action_d1'],
  ['POST /api/attendance/import', 'attendance_roster_d1'],
  ['POST /api/auth/google', 'auth_d1'],
  ['POST /api/auth/logout', 'auth_d1'],
  ['GET /api/auth/me', 'auth_d1'],
  ['PATCH /api/auth/me', 'auth_d1'],
])

function canonicalDirectoryRoute(method, pathname) {
  if (method === 'POST' && /^\/api\/users\/[^/]+\/access$/.test(pathname)) return 'directory_d1'
  const match = pathname.match(/^\/api\/entities\/(User|Outlet)(?:\/[^/]+)?$/)
  if (!match) return ''
  if (['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return 'directory_d1'
  return ''
}

export function canonicalOnlyOwner(request, url) {
  const method = String(request.method || 'GET').toUpperCase()
  const pathname = String(url?.pathname || '')
  return CANONICAL_ONLY_EXACT.get(`${method} ${pathname}`)
    || canonicalDirectoryRoute(method, pathname)
    || ''
}

export function canonicalFallbackBlockedResponse(request, url) {
  const owner = canonicalOnlyOwner(request, url)
  if (!owner) return null
  return new Response(JSON.stringify({
    error: 'Canonical route was not handled. Legacy runtime fallback is disabled.',
    code: 'canonical_route_unhandled',
    canonical_owner: owner,
  }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
