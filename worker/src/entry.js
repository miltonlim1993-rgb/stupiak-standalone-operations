import app from './index.js'
import { errorResponse, json, readJson } from './http.js'
import { markAppPackDirty } from './app-pack.js'
import { handleCloudflareAuth } from './cloudflare-auth.js'
import { handleD1DirectoryApi } from './d1-directory-api.js'
import { handleD1DirectoryBootstrap } from './d1-directory-bootstrap.js'
import { processDirectoryMirrorQueue } from './d1-directory-mirror.js'
import { handleRealtimeApi, publishMutationEvent } from './realtime.js'
import { handleRealtimeMutationBatch } from './realtime-mutation-batch.js'
import { OutletRealtimeHub } from './outlet-realtime-hub.js'
import { handleRealtimeCloseUpSync } from './realtime-closeup-sync.js'
import { handleD1CloseUpUpsert } from './realtime-closeup-upsert-d1.js'
import { handleCashCloseApi } from './cash-close-d1.js'
import { handlePaymentReconciliationApi } from './payment-reconciliation-d1.js'
import { handleJsonAtomicStockCountBatch } from './realtime-stock-batch-json.js'
import { guardCompletedOperationalTask } from './realtime-task-action-guard.js'
import { handleD1OperationalTaskAction } from './realtime-task-action-d1.js'
import { overlayOperationalBootstrapResponse } from './realtime-task-bootstrap.js'
import { handleRealtimeTaskPhotoMutation } from './realtime-task-photo.js'
import { handlePrimaryMediaUpload } from './realtime-media-upload.js'
import { withStableWorkflowMutationId } from './realtime-workflow-idempotency.js'
import { handleRealtimeWorkflowApi } from './realtime-workflows.js'
import { withSubmissionLock } from './submission-locks.js'
import { augmentHealthResponse } from './realtime-health.js'
import { handleBundledSopMedia } from './bundled-sop-media.js'
import { handleD1Labels } from './realtime-labels-d1.js'
import { handleRealtimeAttendanceRosterImport } from './realtime-attendance-roster.js'
import { processAttendanceRosterMirrorQueue } from './realtime-attendance-roster-mirror.js'
import { handleDutyRosterSourceUpload } from './realtime-attendance-roster-source.js'
import { applyOperationalTaskPolicyResponse } from './operational-task-policy.js'
import {
  applyOperationalTaskAudienceResponse,
  guardOperationalTaskAssignment,
  guardOperationalTaskPhotoAssignment,
} from './operational-task-audience.js'
import {
  flushPendingSheetMirrors,
  handleRealtimeDataApi,
  processSheetMirrorQueue,
} from './sheet-backup-queue.js'

const WORKER_REVISION = 'realtime-resilience-v23-device-outbox-batch-sync+statvara-slice-007-payment-reconciliation-v1'
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

function legacyCloseUpMutationBlocked(request, url) {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)
    && /^\/api\/entities\/CloseUp(?:\/|$)/.test(url.pathname)
}

function legacyPaymentReconciliationMutationBlocked(request, url) {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)
    && /^\/api\/entities\/(?:PaymentReconciliation|FIN-PAYMENT-RECONCILIATION)(?:\/|$)/.test(url.pathname)
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
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ChefOps-Native, X-ChefOps-Pack-Secret, X-ChefOps-Directory-Migration-Secret, X-ChefOps-Client-Id, X-ChefOps-Mutation-Id, X-Statvara-Cash-Timestamp, X-Statvara-Cash-Signature, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Access-Control-Expose-Headers': 'X-ChefOps-Worker-Revision, X-ChefOps-Media-Upload-Path',
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

      if (legacyCloseUpMutationBlocked(request, url)) {
        const error = new Error('Close Up mutations must use the command-specific cash custody APIs')
        error.status = 409
        error.code = 'cash_close_command_api_required'
        return withApiHeaders(request, env, errorResponse(request, env, error))
      }

      if (legacyPaymentReconciliationMutationBlocked(request, url)) {
        const error = new Error('Payment Reconciliation mutations must use the command-specific D1 lifecycle APIs')
        error.status = 409
        error.code = 'payment_reconciliation_command_api_required'
        return withApiHeaders(request, env, errorResponse(request, env, error))
      }

      const directoryBootstrapResponse = await handleD1DirectoryBootstrap(request, runEnv, url)
      if (directoryBootstrapResponse) return withApiHeaders(request, env, directoryBootstrapResponse)

      const authResponse = await handleCloudflareAuth(request, runEnv, url)
      if (authResponse) return withApiHeaders(request, env, authResponse)

      const directoryResponse = await handleD1DirectoryApi(request, runEnv, url)
      if (directoryResponse) return withApiHeaders(request, env, directoryResponse)

      const primaryMediaUploadResponse = await handlePrimaryMediaUpload(request, runEnv, url)
      if (primaryMediaUploadResponse) return withApiHeaders(request, env, primaryMediaUploadResponse)

      const rosterSourceResponse = await handleDutyRosterSourceUpload(request, runEnv, url)
      if (rosterSourceResponse) return withApiHeaders(request, env, rosterSourceResponse)

      const bundledSopMediaResponse = await handleBundledSopMedia(request, runEnv, url)
      if (bundledSopMediaResponse) return withApiHeaders(request, env, bundledSopMediaResponse)

      const d1LabelsResponse = await handleD1Labels(request, runEnv, url)
      if (d1LabelsResponse) return withApiHeaders(request, env, d1LabelsResponse)

      const attendanceRosterResponse = await handleRealtimeAttendanceRosterImport(request, runEnv, url)
      if (attendanceRosterResponse) return withApiHeaders(request, env, attendanceRosterResponse)

      const cashCloseResponse = ['/api/cash-close/submit', '/api/cash-close/review', '/api/cash-close/correct'].includes(url.pathname)
        ? await withSubmissionLock(
            request,
            runEnv,
            url,
            () => handleCashCloseApi(request, runEnv, url),
          )
        : await handleCashCloseApi(request, runEnv, url)
      if (cashCloseResponse) return withApiHeaders(request, env, cashCloseResponse)

      const paymentReconciliationResponse = url.pathname === '/api/payment-reconciliation/context'
        ? await handlePaymentReconciliationApi(request, runEnv, url)
        : url.pathname.startsWith('/api/payment-reconciliation/')
          ? await withSubmissionLock(
              request,
              runEnv,
              url,
              () => handlePaymentReconciliationApi(request, runEnv, url),
            )
          : await handlePaymentReconciliationApi(request, runEnv, url)
      if (paymentReconciliationResponse) return withApiHeaders(request, env, paymentReconciliationResponse)

      const atomicStockResponse = url.pathname === '/api/stock-counts/batch'
        ? await withSubmissionLock(
            request,
            runEnv,
            url,
            () => handleJsonAtomicStockCountBatch(request, runEnv, url),
          )
        : await handleJsonAtomicStockCountBatch(request, runEnv, url)
      if (atomicStockResponse) return withApiHeaders(request, env, atomicStockResponse)

      const closeUpSyncResponse = await handleRealtimeCloseUpSync(request, runEnv, url)
      if (closeUpSyncResponse) return withApiHeaders(request, env, closeUpSyncResponse)

      const workflowRequest = await withStableWorkflowMutationId(request, url)
      const completedTaskResponse = await guardCompletedOperationalTask(workflowRequest, runEnv, url)
      if (completedTaskResponse) return withApiHeaders(request, env, completedTaskResponse)

      const taskAssignmentResponse = await guardOperationalTaskAssignment(workflowRequest, runEnv, url)
      if (taskAssignmentResponse) return withApiHeaders(request, env, taskAssignmentResponse)

      const d1TaskResponse = url.pathname === '/api/tasks/operational/action'
        ? await withSubmissionLock(
            workflowRequest,
            runEnv,
            url,
            () => handleD1OperationalTaskAction(workflowRequest, runEnv, url),
          )
        : await handleD1OperationalTaskAction(workflowRequest, runEnv, url)
      if (d1TaskResponse) return withApiHeaders(request, env, d1TaskResponse)

      const d1CloseUpResponse = url.pathname === '/api/close-up/upsert'
        ? await withSubmissionLock(
            workflowRequest,
            runEnv,
            url,
            () => handleD1CloseUpUpsert(workflowRequest, runEnv, url),
          )
        : await handleD1CloseUpUpsert(workflowRequest, runEnv, url)
      if (d1CloseUpResponse) return withApiHeaders(request, env, d1CloseUpResponse)

      const realtimeWorkflowResponse = await handleRealtimeWorkflowApi(workflowRequest, runEnv, url)
      if (realtimeWorkflowResponse) return withApiHeaders(request, env, realtimeWorkflowResponse)

      const taskPhotoAssignmentResponse = await guardOperationalTaskPhotoAssignment(request, runEnv, url)
      if (taskPhotoAssignmentResponse) return withApiHeaders(request, env, taskPhotoAssignmentResponse)

      const taskPhotoResponse = await handleRealtimeTaskPhotoMutation(request, runEnv, url)
      if (taskPhotoResponse) return withApiHeaders(request, env, taskPhotoResponse)

      const realtimeBatchResponse = await handleRealtimeMutationBatch(request, runEnv, url)
      if (realtimeBatchResponse) return withApiHeaders(request, env, realtimeBatchResponse)

      const runtimeUrl = new URL(url)
      runtimeUrl.searchParams.set('legacy_seed', '0')
      const realtimeDataResponse = await handleRealtimeDataApi(request, runEnv, runtimeUrl)
      if (realtimeDataResponse) return withApiHeaders(request, env, realtimeDataResponse)

      const realtimeResponse = await handleRealtimeApi(request, runEnv, url)
      if (realtimeResponse) return withApiHeaders(request, env, realtimeResponse)

      const webhookResponse = await handleDataPackDirtyWebhook(request, runEnv, url.pathname)
      if (webhookResponse) return withApiHeaders(request, env, webhookResponse)

      const bootstrapRequest = url.pathname === '/api/tasks/operational/bootstrap' && request.method === 'POST'
        ? request.clone()
        : null
      const appResponse = await app.fetch(request, runEnv, ctx)
      let response = bootstrapRequest
        ? await overlayOperationalBootstrapResponse(bootstrapRequest, url, runEnv, appResponse)
        : appResponse
      if (bootstrapRequest) {
        response = await applyOperationalTaskPolicyResponse(bootstrapRequest, url, response)
        response = await applyOperationalTaskAudienceResponse(bootstrapRequest, url, runEnv, response)
      }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        response = await augmentHealthResponse(response, runEnv)
      }
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
    const runEnv = runtimeEnv(env, ctx)
    const afterDirectory = await processDirectoryMirrorQueue(batch, runEnv)
    if (!afterDirectory.length) return
    const remaining = await processAttendanceRosterMirrorQueue({ messages: afterDirectory }, runEnv)
    if (!remaining.length) return
    return processSheetMirrorQueue({ messages: remaining }, runEnv, ctx)
  },
}

export { OutletRealtimeHub }
