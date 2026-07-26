import app from './index.js'
import { getCurrentUser, loginWithGoogle, sessionCookie } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import { ensureEntitySheet } from './sheets.js'
import { assignedOutletIds, assertOutletAccess } from './permissions.js'
import { getDataPackageModuleBody, markDataPackageDirty } from './data-package-v2-store.js'
import {
  listDataPackageDeviceStates,
  saveDataPackageDeviceState,
} from './data-package-device-store.js'
import {
  handleDataPackageV2Api,
  previewDataPackageV2,
  publishDataPackageV2,
} from './data-package-v2-api.js'

const WORKER_REVISION = 'data-package-v2-device-state-v1'
const PACK_MODULES = new Set(['core', 'inventory', 'tasks', 'training', 'labels'])
const ENTITY_MODULE = {
  Outlet: 'core',
  PaymentMethod: 'core',
  PositionMaster: 'core',
  AppSetting: 'core',
  MediaRule: 'core',
  InventoryCatalog: 'inventory',
  OutletStockList: 'inventory',
  TaskTemplate: 'tasks',
  TaskTemplatePhoto: 'tasks',
  SOP: 'training',
  SOPStep: 'training',
  SOPAsset: 'training',
  TrainingCourse: 'training',
  TrainingLesson: 'training',
  TrainingQuiz: 'training',
  TrainingQuestion: 'training',
  LabelProduct: 'labels',
  LabelRule: 'labels',
  PrinterProfile: 'labels',
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function isNativeAppRequest(request) {
  const origin = String(request.headers.get('Origin') || '').toLowerCase()
  const marker = String(request.headers.get('X-ChefOps-Native') || '').toLowerCase()
  return marker === 'android' || origin === 'https://localhost' || origin === 'capacitor://localhost'
}

function runtimeEnv(env, ctx) {
  const value = Object.create(env)
  Object.defineProperty(value, '__CHEFOPS_CTX', { value: ctx, enumerable: false })
  return value
}

function safeSecretEqual(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  if (!a || !b || a.length !== b.length) return false
  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return mismatch === 0
}

function hasPackSecret(request, env) {
  return safeSecretEqual(
    String(env.APP_PACK_WEBHOOK_SECRET || ''),
    String(request.headers.get('X-ChefOps-Pack-Secret') || ''),
  )
}

function allowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  return new Set([
    ...configured,
    'https://stupiaks-ops.sporkburger19.workers.dev',
    'https://localhost',
    'capacitor://localhost',
    'http://localhost:5188',
  ])
}

function apiCorsHeaders(request, env) {
  const origin = String(request.headers.get('Origin') || '')
  const allowed = allowedOrigins(env)
  const allowOrigin = allowed.has(origin)
    ? origin
    : (allowed.has('https://stupiaks-ops.sporkburger19.workers.dev')
        ? 'https://stupiaks-ops.sporkburger19.workers.dev'
        : 'null')

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ChefOps-Native, X-ChefOps-Pack-Secret, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Access-Control-Expose-Headers': 'X-ChefOps-Worker-Revision',
    'Vary': 'Origin',
    'X-ChefOps-Worker-Revision': WORKER_REVISION,
  }
}

function withApiHeaders(request, env, response) {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(apiCorsHeaders(request, env))) {
    headers.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function requestedOutletForUser(user, requested = '') {
  const value = String(requested || user?.outlet_id || assignedOutletIds(user)[0] || '').trim()
  if (value && !['manager', 'owner'].includes(String(user?.role || ''))) assertOutletAccess(user, value)
  return value
}

async function handleNativeGoogleLogin(request, env, pathname) {
  if (
    pathname !== '/api/auth/google'
    || request.method !== 'POST'
    || !isNativeAppRequest(request)
  ) return null

  try {
    await ensureEntitySheet(env, 'User')
    const { credential } = await readJson(request)
    const { user, token } = await loginWithGoogle(credential, env)
    return json(request, env, {
      user,
      session_token: token,
    }, 200, {
      'Set-Cookie': sessionCookie(token, request),
    })
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

function forbiddenPackSecret(request, env) {
  if (hasPackSecret(request, env)) return null
  const error = new Error('Invalid data-package publisher secret')
  error.status = 403
  error.code = 'invalid_pack_webhook_secret'
  return errorResponse(request, env, error)
}

async function handleDataPackDirtyWebhook(request, env, pathname) {
  if (pathname !== '/api/internal/data-pack/dirty') return null
  if (request.method !== 'POST') {
    const error = new Error('Method not allowed')
    error.status = 405
    error.code = 'method_not_allowed'
    return errorResponse(request, env, error)
  }

  const forbidden = forbiddenPackSecret(request, env)
  if (forbidden) return forbidden

  try {
    const body = await readJson(request)
    const entity = String(body.entity || '').trim()
    const requestedModule = String(body.module || '').trim().toLowerCase()
    const moduleName = PACK_MODULES.has(requestedModule) ? requestedModule : ENTITY_MODULE[entity] || ''
    const outletId = String(body.outlet_id || '').trim()
    const state = await markDataPackageDirty(env, outletId, {
      modules: moduleName ? [moduleName] : [],
      reason: String(body.reason || (entity ? `${entity} source changed` : 'Package source changed')),
      actor: String(body.actor || 'internal-webhook'),
    })
    return json(request, env, {
      ok: true,
      queued: false,
      publish_required: true,
      entity,
      module: moduleName || 'all',
      outlet_id: outletId,
      changed_at: state.dirty_at,
    }, 202)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

async function handleInternalDataPackagePublisher(request, env, pathname) {
  if (!pathname.startsWith('/api/internal/data-package-v2/')) return null
  if (request.method !== 'POST') {
    const error = new Error('Method not allowed')
    error.status = 405
    error.code = 'method_not_allowed'
    return errorResponse(request, env, error)
  }

  const forbidden = forbiddenPackSecret(request, env)
  if (forbidden) return forbidden

  try {
    const body = await readJson(request)
    const outletId = String(body.outlet_id || '').trim()
    if (!outletId) {
      const error = new Error('outlet_id is required')
      error.status = 400
      error.code = 'missing_outlet'
      throw error
    }
    const actor = String(body.actor || 'drive-package-publisher')
    const mediaFiles = Array.isArray(body.media_files) ? body.media_files : []

    if (pathname === '/api/internal/data-package-v2/preview') {
      return json(request, env, await previewDataPackageV2(env, outletId, { actor, mediaFiles }))
    }
    if (pathname === '/api/internal/data-package-v2/publish') {
      const result = await publishDataPackageV2(env, {
        outletId,
        actor,
        expectedVersion: body.expected_version,
        expectedSourceVersion: body.expected_source_version,
        mediaFiles,
      })
      return json(request, env, { ok: true, ...result }, 201)
    }

    const error = new Error('Internal data-package endpoint not found')
    error.status = 404
    error.code = 'not_found'
    throw error
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

async function handleDataPackageDeviceState(request, env, url) {
  if (!url.pathname.startsWith('/api/app/v4/data-package/device')) return null
  const user = await getCurrentUser(request, env)

  if (url.pathname === '/api/app/v4/data-package/device' && request.method === 'POST') {
    const body = await readJson(request)
    const outletId = requestedOutletForUser(user, body.outlet_id)
    const device = await saveDataPackageDeviceState(env, {
      outletId,
      deviceId: body.device_id,
      user,
      platform: body.platform,
      appVersion: body.app_version,
      packageVersion: body.data_package_version,
      installedAt: body.data_package_installed_at,
      status: body.status || 'active',
    })
    return json(request, env, { ok: true, device })
  }

  if (url.pathname === '/api/app/v4/data-package/devices' && request.method === 'GET') {
    if (!['manager', 'owner'].includes(String(user?.role || ''))) {
      const error = new Error('Manager access required')
      error.status = 403
      error.code = 'forbidden'
      throw error
    }
    const outletId = requestedOutletForUser(user, url.searchParams.get('outlet_id'))
    const devices = await listDataPackageDeviceStates(env, outletId)
    return json(request, env, { ok: true, outlet_id: outletId, devices })
  }

  return null
}

async function handleExactDataPackageModule(request, env, url) {
  const match = url.pathname.match(/^\/api\/app\/v4\/data-package\/module\/([^/]+)$/)
  if (!match || request.method !== 'GET') return null

  const user = await getCurrentUser(request, env)
  const outletId = requestedOutletForUser(user, url.searchParams.get('outlet_id'))
  const name = decodeURIComponent(match[1])
  const hash = String(url.searchParams.get('hash') || '').trim()
  const body = await getDataPackageModuleBody(env, outletId, name, hash)
  if (!body) {
    const error = new Error('Data Package v2 module was not found')
    error.status = 404
    error.code = 'data_package_v2_module_not_found'
    throw error
  }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'ETag': `"${hash}"`,
      'Content-Length': String(new TextEncoder().encode(body).length),
    },
  })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const runEnv = runtimeEnv(env, ctx)

    if (isApiPath(url.pathname)) {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: apiCorsHeaders(request, env),
        })
      }

      const webhookResponse = await handleDataPackDirtyWebhook(request, runEnv, url.pathname)
      if (webhookResponse) return withApiHeaders(request, env, webhookResponse)

      const publisherResponse = await handleInternalDataPackagePublisher(request, runEnv, url.pathname)
      if (publisherResponse) return withApiHeaders(request, env, publisherResponse)

      const nativeLoginResponse = await handleNativeGoogleLogin(request, runEnv, url.pathname)
      if (nativeLoginResponse) return withApiHeaders(request, env, nativeLoginResponse)

      try {
        const deviceResponse = await handleDataPackageDeviceState(request, runEnv, url)
        if (deviceResponse) return withApiHeaders(request, env, deviceResponse)

        const exactModuleResponse = await handleExactDataPackageModule(request, runEnv, url)
        if (exactModuleResponse) return withApiHeaders(request, env, exactModuleResponse)

        const packageResponse = await handleDataPackageV2Api(request, runEnv, url)
        if (packageResponse) return withApiHeaders(request, env, packageResponse)
      } catch (error) {
        return withApiHeaders(request, env, errorResponse(request, runEnv, error))
      }

      const response = await app.fetch(request, runEnv, ctx)
      return withApiHeaders(request, env, response)
    }

    return env.ASSETS.fetch(request)
  },

  async scheduled(event, env, ctx) {
    if (typeof app.scheduled === 'function') {
      return app.scheduled(event, runtimeEnv(env, ctx), ctx)
    }
  },
}
