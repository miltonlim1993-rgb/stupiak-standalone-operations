import app, { OutletRealtimeHub } from './entry-local-auth.js'
import { getAppPackModule, getPublishedAppPack } from './app-pack.js'
import { driveBackupMode, mediaPrimaryStorage, retryPendingDriveBackups } from './drive.js'
import { googleAuthMode } from './google.js'
import {
  googleLoginMode,
  localAuthMode,
  localRegistrationMode,
} from './local-auth-crypto.js'
import { localAuthSchemaReady } from './local-auth-store.js'
import { refreshAppPacksWhenMasterChanges } from './master-data-watch.js'

const MASTER_WATCH_CRON = '*/2 * * * *'
const HOURLY_SAFETY_CRON = '0 * * * *'
const MASTER_WATCH_STATE_KEY = 'chefops:master-data-watch:v1'
const MASTER_WATCH_POLICY = 'sheets-task-template-fingerprint-v1'
const MASTER_WATCH_RUN_PATH = '/api/internal/master-watch/run'
const DEFAULT_STATVARA_BRIDGE_PORT = 8791
const DEFAULT_STATVARA_API_PATH = '/api/ops/v1'

function safeSecretEqual(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  if (!a || !b || a.length !== b.length) return false
  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return mismatch === 0
}

function internalJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

async function masterWatchStatus(env) {
  const configured = Boolean(env.GOOGLE_MASTER_SPREADSHEET_ID || env.GOOGLE_SPREADSHEET_ID)
  const authMode = googleAuthMode(env, 'data')
  if (!env.APP_DATA_PACKS?.get) {
    return { configured, auth_mode: authMode, state_available: false }
  }

  try {
    const state = await env.APP_DATA_PACKS.get(MASTER_WATCH_STATE_KEY, 'json')
    return {
      configured,
      auth_mode: authMode,
      state_available: Boolean(state),
      spreadsheet_id: String(state?.spreadsheet_id || ''),
      source: String(state?.source || ''),
      source_fingerprint: String(state?.source_fingerprint || ''),
      checked_at: String(state?.checked_at || ''),
      published_at: String(state?.published_at || ''),
      template_count: Number(state?.template_count || 0),
      photo_count: Number(state?.photo_count || 0),
      last_error: String(state?.last_error || ''),
      last_error_at: String(state?.last_error_at || ''),
      packs: Array.isArray(state?.packs) ? state.packs : [],
    }
  } catch (error) {
    console.error('Unable to read Master watcher health state', error)
    return {
      configured,
      auth_mode: authMode,
      state_available: false,
      status_error: String(error?.message || error).slice(0, 300),
    }
  }
}

async function runtimeDependencyStatus(env) {
  const backupMode = driveBackupMode(env)
  const schemaReady = await localAuthSchemaReady(env)
  const pepperReady = String(env.LOCAL_AUTH_PEPPER || '').length >= 32
  return {
    google_data_auth: googleAuthMode(env, 'data'),
    media_primary_storage: mediaPrimaryStorage(env),
    drive_legacy_read_auth: googleAuthMode(env, 'drive'),
    drive_backup_auth: googleAuthMode(env, 'drive'),
    drive_backup_mode: backupMode === 'enabled'
      ? 'asynchronous_non_blocking'
      : 'disabled_non_blocking',
    local_auth: {
      mode: localAuthMode(env),
      schema_ready: schemaReady,
      secret_ready: pepperReady,
      ready: localAuthMode(env) === 'enabled' && schemaReady && pepperReady,
      registration: localRegistrationMode(env),
      google_login: googleLoginMode(env),
      owner_approval_required: true,
    },
    statvara_bridge: {
      reserved: true,
      port: Number(env.STATVARA_OPS_BRIDGE_PORT || DEFAULT_STATVARA_BRIDGE_PORT),
      api_path: String(env.STATVARA_OPS_API_PATH || DEFAULT_STATVARA_API_PATH),
      blocks_store_execution: false,
    },
  }
}

async function verifyPublishedTemplate(env, outletId, templateId) {
  const expectedOutlet = String(outletId || '').trim()
  const expectedTemplate = String(templateId || '').trim()
  if (!expectedOutlet || !expectedTemplate) {
    return { verified: false, reason: 'outlet_id and template_id are required' }
  }

  const manifest = await getPublishedAppPack(env, expectedOutlet)
  const tasksInfo = manifest?.modules?.tasks
  if (!manifest || !tasksInfo?.hash) {
    return { verified: false, reason: 'RR-KCH tasks pack is not published' }
  }
  const tasksModule = await getAppPackModule(env, expectedOutlet, 'tasks', tasksInfo.hash)
  const templates = Array.isArray(tasksModule?.data?.task_templates)
    ? tasksModule.data.task_templates
    : []
  return {
    verified: templates.some((row) => String(row?.id || '') === expectedTemplate),
    manifest_version: String(manifest.version || ''),
    tasks_hash: String(tasksInfo.hash || ''),
    template_count: templates.length,
  }
}

async function handleImmediateMasterWatch(request, env, url) {
  if (url.pathname !== MASTER_WATCH_RUN_PATH) return null
  if (request.method !== 'POST') return internalJson({ ok: false, error: 'Method not allowed' }, 405)

  const expected = String(env.MASTER_WATCH_RUN_SECRET || '')
  const provided = String(request.headers.get('X-ChefOps-Master-Watch-Secret') || '')
  if (!safeSecretEqual(expected, provided)) {
    return internalJson({ ok: false, error: 'Invalid Master watcher secret' }, 403)
  }

  try {
    const body = await request.json().catch(() => ({}))
    const result = await refreshAppPacksWhenMasterChanges(env, { force: true })
    const verification = await verifyPublishedTemplate(env, body.outlet_id, body.template_id)
    if (body.template_id && !verification.verified) {
      return internalJson({
        ok: false,
        error: 'Requested Task Template was not found in the published tasks module',
        result,
        verification,
      }, 502)
    }
    return internalJson({ ok: true, result, verification })
  } catch (error) {
    console.error('Immediate Master watcher run failed', error)
    return internalJson({
      ok: false,
      error: String(error?.message || error),
      code: String(error?.code || ''),
    }, Number(error?.status || 500))
  }
}

export default {
  ...app,

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const immediateResponse = await handleImmediateMasterWatch(request, env, url)
    if (immediateResponse) return immediateResponse

    const response = await app.fetch(request, env, ctx)
    if (request.method !== 'GET' || url.pathname !== '/api/health' || !response.ok) return response

    try {
      const payload = await response.clone().json()
      const [watch, dependencies] = await Promise.all([
        masterWatchStatus(env),
        runtimeDependencyStatus(env),
      ])
      const headers = new Headers(response.headers)
      headers.set('Content-Type', 'application/json; charset=utf-8')
      return new Response(JSON.stringify({
        ...payload,
        deployment: {
          ...(payload.deployment || {}),
          master_data_watch: {
            policy: MASTER_WATCH_POLICY,
            cron: MASTER_WATCH_CRON,
            enabled: true,
            ...watch,
          },
          runtime_dependencies: dependencies,
        },
      }), {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch (error) {
      console.error('Unable to augment health with Master watcher status', error)
      return response
    }
  },

  async scheduled(event, env, ctx) {
    if (String(event?.cron || '') === MASTER_WATCH_CRON) {
      const refresh = refreshAppPacksWhenMasterChanges(env)
        .then((result) => {
          if (result.changed) console.log('Task Template data changed; app packs published', result)
          return result
        })
        .catch((error) => {
          console.error('Master Task Template watcher failed', error)
          throw error
        })
      ctx.waitUntil(refresh)
      return
    }

    const jobs = []
    if (String(event?.cron || '') === HOURLY_SAFETY_CRON) {
      jobs.push(retryPendingDriveBackups(env, 25).catch((error) => {
        console.error('Pending Drive backup retry failed; R2 remains canonical', error)
        return []
      }))
    }
    if (typeof app.scheduled === 'function') jobs.push(app.scheduled(event, env, ctx))
    return Promise.all(jobs)
  },
}

export { OutletRealtimeHub }
