import { errorResponse, json } from './http.js'
import {
  directoryCounts,
  importDirectorySnapshot,
} from './d1-directory-import.js'
import {
  listLegacyDirectoryRecordsDuringBootstrap,
  markDirectoryBootstrapComplete,
} from './d1-directory-bootstrap-state.js'

const BOOTSTRAP_PATH = '/api/internal/d1-directory/migrate-once'

function secureEqual(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  if (!a || !b || a.length !== b.length) return false
  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return mismatch === 0
}

function migrationError(message, code, status = 409) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

export async function handleD1DirectoryBootstrap(request, env, url) {
  if (url.pathname !== BOOTSTRAP_PATH) return null

  try {
    if (request.method !== 'POST') throw migrationError('Method not allowed', 'method_not_allowed', 405)

    const configured = String(env.D1_DIRECTORY_MIGRATION_SECRET || '')
    const provided = String(request.headers.get('X-ChefOps-Directory-Migration-Secret') || '')
    if (!secureEqual(configured, provided)) {
      throw migrationError('Invalid directory migration secret', 'invalid_directory_migration_secret', 403)
    }

    const before = await directoryCounts(env)
    if (before.users > 0 && before.outlets > 0 && before.active_users > 0) {
      const marker = await markDirectoryBootstrapComplete(env, {
        source: 'existing-d1-directory',
        counts: before,
      })
      return json(request, env, {
        ok: true,
        migrated: false,
        already_complete: true,
        counts: before,
        marker,
      })
    }

    const [users, outlets] = await Promise.all([
      listLegacyDirectoryRecordsDuringBootstrap(env, 'User', { limit: 5000 }),
      listLegacyDirectoryRecordsDuringBootstrap(env, 'Outlet', { limit: 5000 }),
    ])

    const activeUsers = (users || []).filter((row) => (
      !String(row?.deleted_at || '').trim()
      && String(row?.status || '').toLowerCase() === 'active'
    ))
    const liveOutlets = (outlets || []).filter((row) => !String(row?.deleted_at || '').trim())

    if (!users?.length) {
      throw migrationError('User directory source returned no rows', 'directory_users_empty', 503)
    }
    if (!activeUsers.length) {
      throw migrationError('User directory source has no active user', 'directory_active_users_empty', 503)
    }
    if (!liveOutlets.length) {
      throw migrationError('Outlet directory source returned no active rows', 'directory_outlets_empty', 503)
    }

    const userResult = await importDirectorySnapshot(env, 'User', users)
    const outletResult = await importDirectorySnapshot(env, 'Outlet', outlets)
    const after = await directoryCounts(env)

    if (after.users < users.length || after.active_users < activeUsers.length || after.outlets < liveOutlets.length) {
      throw migrationError('D1 directory verification did not match source rows', 'directory_import_verification_failed', 500)
    }

    const marker = await markDirectoryBootstrapComplete(env, {
      source: 'google-sheets-explicit-one-time-import',
      counts: after,
      imported: {
        users: userResult.imported,
        active_users: userResult.active,
        outlets: outletResult.imported,
      },
    })

    return json(request, env, {
      ok: true,
      migrated: true,
      already_complete: false,
      before,
      after,
      imported: marker.imported,
      marker,
    }, 201)
  } catch (error) {
    if (!error.status && (
      error?.code === 'sheets_rate_limited'
      || error?.code === 'google_api_error'
      || Number(error?.status || 0) >= 500
    )) {
      error.status = 503
      error.code = error.code || 'directory_source_temporarily_unavailable'
    }
    return errorResponse(request, env, error)
  }
}
