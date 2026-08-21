const REALTIME_ENTITIES = new Set([
  'Task',
  'TaskPhoto',
  'UrgentIssue',
  'StockCount',
  'CloseUp',
  'FoodLabel',
  'LabelPrintLog',
  'Attendance',
  'Receipt',
  'Notification',
  'TrainingAssignment',
  'TrainingProgress',
  'TrainingAcknowledgement',
  'TrainingAttempt',
])

const CANONICAL_ONLY_EXACT = new Map([
  ['POST /api/close-up/upsert', 'close_up_d1'],
  ['POST /api/tasks/operational/bootstrap', 'task_bootstrap_d1'],
  ['POST /api/tasks/operational/action', 'task_action_d1'],
  ['POST /api/attendance/import', 'attendance_roster_d1'],
  ['POST /api/stock-counts/batch', 'stock_count_d1'],
  ['POST /api/auth/google', 'auth_d1'],
  ['POST /api/auth/logout', 'auth_d1'],
  ['GET /api/auth/me', 'auth_d1'],
  ['PATCH /api/auth/me', 'auth_d1'],
  ['GET /api/notifications', 'notifications_d1'],
  ['POST /api/notifications/push', 'notifications_d1'],
  ['GET /api/labels/catalog', 'labels_d1'],
  ['POST /api/labels/create', 'labels_d1'],
  ['GET /api/labels/printer-profile', 'labels_d1'],
  ['POST /api/labels/printer-profile', 'labels_d1'],
  ['PUT /api/labels/printer-profile', 'labels_d1'],
])

function canonicalDirectoryRoute(method, pathname) {
  if (method === 'POST' && /^\/api\/users\/[^/]+\/access$/.test(pathname)) return 'directory_d1'
  const match = pathname.match(/^\/api\/entities\/(User|Outlet)(?:\/[^/]+)?$/)
  if (!match) return ''
  if (['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return 'directory_d1'
  return ''
}

function canonicalRealtimeEntityWrite(method, pathname) {
  if (!['POST', 'PATCH', 'DELETE'].includes(method)) return ''
  const match = pathname.match(/^\/api\/entities\/([^/]+)(?:\/([^/]+))?$/)
  if (!match || !REALTIME_ENTITIES.has(decodeURIComponent(match[1]))) return ''
  return 'realtime_d1'
}

function canonicalNotificationRoute(method, pathname) {
  if (method === 'PATCH' && /^\/api\/notifications\/[^/]+\/read$/.test(pathname)) return 'notifications_d1'
  return ''
}

function canonicalLabelRoute(method, pathname) {
  if (method === 'POST' && /^\/api\/labels\/[^/]+\/reprint$/.test(pathname)) return 'labels_d1'
  if (method === 'POST' && /^\/api\/labels\/source\/[^/]+\/finish$/.test(pathname)) return 'labels_d1'

  const printerEntity = pathname.match(/^\/api\/entities\/PrinterProfile(?:\/([^/]+))?$/)
  if (!printerEntity) return ''
  if (!printerEntity[1] && ['GET', 'POST'].includes(method)) return 'labels_d1'
  if (printerEntity[1] === 'update-many' && method === 'POST') return 'labels_d1'
  if (printerEntity[1] && printerEntity[1] !== 'update-many' && ['PATCH', 'DELETE'].includes(method)) return 'labels_d1'
  return ''
}

function canonicalCloseUpSyncRoute(method, pathname) {
  if (method === 'POST' && /^\/api\/close-up\/[^/]+\/sync$/.test(pathname)) return 'close_up_d1'
  if (method === 'GET' && /^\/api\/close-up\/[^/]+\/sync-status$/.test(pathname)) return 'close_up_d1'
  return ''
}

export function canonicalOnlyOwner(request, url) {
  const method = String(request.method || 'GET').toUpperCase()
  const pathname = String(url?.pathname || '')
  return CANONICAL_ONLY_EXACT.get(`${method} ${pathname}`)
    || canonicalDirectoryRoute(method, pathname)
    || canonicalNotificationRoute(method, pathname)
    || canonicalLabelRoute(method, pathname)
    || canonicalCloseUpSyncRoute(method, pathname)
    || canonicalRealtimeEntityWrite(method, pathname)
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
