const REQUIRED_TABLES = [
  'ops_records',
  'ops_mutations',
  'sheet_sync_outbox',
  'submission_locks',
]

export async function realtimeHealth(env) {
  const databaseBound = Boolean(env.OPS_DB?.prepare)
  const queueBound = Boolean(env.SHEET_SYNC_QUEUE?.send)
  const websocketBound = Boolean(env.OUTLET_REALTIME?.getByName)
  let tables = []
  let databaseError = ''

  if (databaseBound) {
    try {
      const placeholders = REQUIRED_TABLES.map(() => '?').join(', ')
      const result = await env.OPS_DB.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
      ).bind(...REQUIRED_TABLES).all()
      tables = (result.results || []).map((row) => String(row.name || '')).filter(Boolean)
    } catch (error) {
      databaseError = String(error?.message || error || '').slice(0, 500)
    }
  }

  const missingTables = REQUIRED_TABLES.filter((name) => !tables.includes(name))
  return {
    ready: databaseBound && queueBound && websocketBound && !databaseError && missingTables.length === 0,
    database_bound: databaseBound,
    queue_bound: queueBound,
    websocket_bound: websocketBound,
    required_tables: REQUIRED_TABLES,
    present_tables: tables,
    missing_tables: missingTables,
    database_error: databaseError,
  }
}

export async function augmentHealthResponse(response, env) {
  const contentType = String(response?.headers?.get('content-type') || '')
  if (!response || response.status !== 200 || !contentType.includes('application/json')) return response
  try {
    const payload = await response.clone().json()
    const realtime = await realtimeHealth(env)
    const headers = new Headers(response.headers)
    headers.set('Content-Type', 'application/json; charset=utf-8')
    return new Response(JSON.stringify({ ...payload, realtime }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  } catch {
    return response
  }
}