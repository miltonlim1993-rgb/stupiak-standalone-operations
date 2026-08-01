import app from './index.js'
import { loginWithGoogle, sessionCookie } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import { ensureEntitySheet } from './sheets.js'
import { markAppPackDirty } from './app-pack.js'
import { handleRealtimeApi, publishMutationEvent } from './realtime.js'
import { OutletRealtimeHub } from './outlet-realtime-hub.js'
import { overlayOperationalBootstrapResponse } from './realtime-task-bootstrap.js'
import { handleRealtimeWorkflowApi } from './realtime-workflows.js'
import {
  flushPendingSheetMirrors,
  handleRealtimeDataApi,
  processSheetMirrorQueue,
} from './realtime-store.js'

const WORKER_REVISION = 'realtime-d1-foundation-v1'
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
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ChefOps-Native, X-ChefOps-Pack-Secret, X-ChefOps-Client-Id, X-ChefOps-Mutation-Id, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Access-Control-Expose-Headers': 'X-ChefOps-Worker-Revision',
    'Vary': 'Origin',
    'X-ChefOps-Worker-Revision': WORKER_REVISION,
  }
}

function withApiHeaders(request, env, response) {
  if (response.status === 101) return response
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

async function handleDataPackDirtyWebhook(request, env, pathname) {
  if (pathname !== '/api/internal/data-pack/dirty') return null
  if (request.method !== 'POST') {
    const error = new Error('Method not allowed')
    error.status = 405
    error.code = 'method_not_allowed'
    return errorResponse(request, env, error)
  }

  const configuredSecret = String(env.APP_PACK_WEBHOOK_SECRET || '')
  const providedSecret = String(request.headers.get('X-ChefOps-Pack-Secret') || '')
  if (!safeSecretEqual(configuredSecret, providedSecret)) {
    const error = new Error('Invalid data-pack webhook secret')
    error.status = 403
    error.code = 'invalid_pack_webhook_secret'
    return errorResponse(request, env, error)
  }

  try {
    const body = await readJson(request)
    const entity = String(body.entity || '').trim()
    const requestedModule = String(body.module || '').trim().toLowerCase()
    const moduleName = PACK_MODULES.has(requestedModule) ? requestedModule : ENTITY_MODULE[entity] || ''
    const outletId = String(body.outlet_id || '').trim()
    await markAppPackDirty(env, outletId, { modules: moduleName ? [moduleName] : [] })
    return json(request, env, {
      ok: true,
      queued: true,
      entity,
      module: moduleName || 'all',
      outlet_id: outletId,
      changed_at: new Date().toISOString(),
    }, 202)
  } catch (error) {
    return errorResponse(request, env, error)
  }
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

      const realtimeWorkflowResponse = await handleRealtimeWorkflowApi(request, runEnv, url)
      if (realtimeWorkflowResponse) return withApiHeaders(request, env, realtimeWorkflowResponse)

      const realtimeDataResponse = await handleRealtimeDataApi(request, runEnv, url)
      if (realtimeDataResponse) return withApiHeaders(request, env, realtimeDataResponse)

      const realtimeResponse = await handleRealtimeApi(request, runEnv, url)
      if (realtimeResponse) return withApiHeaders(request, env, realtimeResponse)

      const webhookResponse = await handleDataPackDirtyWebhook(request, runEnv, url.pathname)
      if (webhookResponse) return withApiHeaders(request, env, webhookResponse)

      const nativeLoginResponse = await handleNativeGoogleLogin(request, runEnv, url.pathname)
      if (nativeLoginResponse) return withApiHeaders(request, env, nativeLoginResponse)

      const appResponse = await app.fetch(request, runEnv, ctx)
      const response = await overlayOperationalBootstrapResponse(url, runEnv, appResponse)
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) && response.status >= 200 && response.status < 300) {
        const broadcastResponse = response.clone()
        ctx.waitUntil(publishMutationEvent(request, runEnv, url.pathname, broadcastResponse).catch((error) => {
          console.error('Realtime mutation broadcast failed', url.pathname, error)
        }))
      }
      return withApiHeaders(request, env, response)
    }

    return env.ASSETS.fetch(request)
  },

  async scheduled(event, env, ctx) {
    const runEnv = runtimeEnv(env, ctx)
    const jobs = [flushPendingSheetMirrors(runEnv, 50)]
    if (typeof app.scheduled === 'function') jobs.push(app.scheduled(event, runEnv, ctx))
    return Promise.all(jobs)
  },

  async queue(batch, env, ctx) {
    return processSheetMirrorQueue(batch, runtimeEnv(env, ctx), ctx)
  },
}

export { OutletRealtimeHub }
