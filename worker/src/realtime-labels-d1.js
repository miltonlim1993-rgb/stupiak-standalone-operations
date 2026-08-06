import { errorResponse } from './http.js'
import { d1LabelCatalog } from './label-d1-store.js'
import {
  handleD1PrinterProfileApi,
  handleD1PrinterProfileEntity,
} from './label-d1-printer.js'
import {
  handleD1CreateLabel,
  handleD1FinishSource,
  handleD1LabelCatalog,
  handleD1ReprintLabel,
} from './label-d1-operations-v26.js'
import { recoveredCreateBody } from './label-rule-recovery.js'

async function normalizeCreateRequest(request, env, url) {
  if (url.pathname !== '/api/labels/create' || request.method !== 'POST') return request

  const body = await request.clone().json().catch(() => null)
  if (!body?.rule_key) return request

  const catalog = await d1LabelCatalog(env)
  const recoveredBody = recoveredCreateBody(catalog.rules || [], body)
  if (!recoveredBody) return request

  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.delete('Content-Length')
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(recoveredBody),
  })
}

export async function handleD1Labels(request, env, url) {
  const handlers = [
    handleD1PrinterProfileEntity,
    handleD1LabelCatalog,
    handleD1PrinterProfileApi,
    handleD1CreateLabel,
    handleD1ReprintLabel,
    handleD1FinishSource,
  ]
  try {
    const routedRequest = await normalizeCreateRequest(request, env, url)
    for (const handler of handlers) {
      const response = await handler(routedRequest, env, url)
      if (response) return response
    }
    return null
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
