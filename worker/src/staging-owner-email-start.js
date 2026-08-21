import { findDirectoryUser } from './d1-directory-store.js'
import { findCredentialByUserId } from './local-auth-store.js'
import { json, readJson } from './http.js'

const STAGING_OWNER_EMAIL = 'staging-owner@stupiak.invalid'

export async function handleStagingOwnerEmailStart(request, env, url) {
  if (url.pathname !== '/api/auth/local/email/start' || request.method !== 'POST') return null

  const body = await readJson(request)
  const email = String(body?.email || '').trim().toLowerCase()
  if (email !== STAGING_OWNER_EMAIL) return null

  const user = await findDirectoryUser(env, { email })
  if (!user || String(user.role || '').toLowerCase() !== 'owner' || String(user.status || '').toLowerCase() !== 'active') {
    return json(request, env, {
      ok: false,
      error: 'Synthetic staging Owner is unavailable.',
      code: 'staging_owner_unavailable',
    }, 503)
  }

  const credential = await findCredentialByUserId(env, user.id)
  if (!credential || credential.disabled_at) {
    return json(request, env, {
      ok: false,
      error: 'Synthetic staging Owner credential is unavailable. Reset the staging login.',
      code: 'staging_owner_credential_missing',
    }, 503)
  }

  return json(request, env, {
    ok: true,
    status: 'credential_required',
    email,
    credential_kind: credential.credential_kind || 'password',
    message: 'Enter the staging Owner password.',
    staging: true,
  })
}
