import { credentialKindForRole } from './local-auth-crypto.js'
import { localAuthSchemaReady } from './local-auth-store.js'

function database(env) {
  if (!env.OPS_DB?.prepare) return null
  return env.OPS_DB
}

export async function revokeLocalCredential(env, userId, {
  reason = 'access_changed',
  disable = true,
} = {}) {
  const db = database(env)
  if (!db || !(await localAuthSchemaReady(env))) {
    return { revoked: false, schema_ready: false }
  }
  const id = String(userId || '').trim()
  if (!id) return { revoked: false, schema_ready: true }
  const now = new Date().toISOString()
  const result = await db.prepare(`
    UPDATE local_credentials
    SET disabled_at = ?,
        session_version = session_version + 1,
        failed_attempts = 0,
        locked_until = '',
        updated_at = ?
    WHERE user_id = ?
  `).bind(disable ? now : '', now, id).run()
  await db.prepare(`
    UPDATE local_auth_activations
    SET used_at = CASE WHEN used_at = '' THEN ? ELSE used_at END,
        locked_until = '',
        attempts = 0
    WHERE user_id = ?
  `).bind(now, id).run()
  return {
    revoked: Number(result?.meta?.changes || 0) > 0,
    schema_ready: true,
    reason,
    disabled: Boolean(disable),
  }
}

export function localCredentialMustReset(existingUser, nextAccess) {
  const previousStatus = String(existingUser?.status || 'pending').toLowerCase()
  const nextStatus = String(nextAccess?.status || previousStatus).toLowerCase()
  if (nextStatus !== 'active') return true
  if (previousStatus !== 'active') return false
  return credentialKindForRole(existingUser?.role) !== credentialKindForRole(nextAccess?.role)
}
