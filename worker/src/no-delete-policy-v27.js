export const NO_DELETE_POLICY_VERSION = 'no-hard-delete-v27'

export function hardDeleteDisabledResponse() {
  return new Response(JSON.stringify({
    ok: false,
    error: 'Delete is disabled. Use status, archive, void or corrective workflows.',
    code: 'hard_delete_disabled',
    policy: NO_DELETE_POLICY_VERSION,
  }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Allow': 'GET, POST, PATCH, OPTIONS',
    },
  })
}

export function handleNoDeletePolicyV27(request) {
  if (String(request?.method || '').toUpperCase() !== 'DELETE') return null
  return hardDeleteDisabledResponse()
}
