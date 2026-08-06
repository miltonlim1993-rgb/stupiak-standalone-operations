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

function normalizedText(value) {
  return String(value || '').trim().toLowerCase()
}

function stableRuleMatch(rules, body) {
  const requestedKey = String(body?.rule_key || '').trim()
  if (!requestedKey) return null

  const exact = rules.find((rule) => String(rule.ruleKey || '') === requestedKey)
  if (exact) return exact

  // Older catalog responses included the current D1 row index at the end of
  // ruleKey. D1 rows are ordered by updated_at, so that suffix can change after
  // an unrelated rule is edited. Recover the intended rule using the stable
  // rule ID, product, action and storage components instead of rejecting a
  // still-valid process as deleted.
  const [keyRuleId = '', keyAction = '', keyStorage = ''] = requestedKey.split('::')
  const ruleId = String(body?.rule_id || keyRuleId || '').trim()
  const productId = String(body?.product_id || '').trim()

  let candidates = rules.filter((rule) => (
    (!ruleId || String(rule.ruleId || '') === ruleId)
    && (!productId || String(rule.productId || '') === productId)
  ))

  if (keyAction) {
    const actionMatches = candidates.filter((rule) => normalizedText(rule.action) === normalizedText(keyAction))
    if (actionMatches.length) candidates = actionMatches
  }
  if (keyStorage) {
    const storageMatches = candidates.filter((rule) => normalizedText(rule.storageCondition) === normalizedText(keyStorage))
    if (storageMatches.length) candidates = storageMatches
  }

  return candidates.length === 1 ? candidates[0] : null
}

async function normalizeCreateRequest(request, env, url) {
  if (url.pathname !== '/api/labels/create' || request.method !== 'POST') return request

  const body = await request.clone().json().catch(() => null)
  if (!body?.rule_key) return request

  const catalog = await d1LabelCatalog(env)
  const matched = stableRuleMatch(catalog.rules || [], body)
  if (!matched || String(matched.ruleKey || '') === String(body.rule_key || '')) return request

  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.delete('Content-Length')
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify({
      ...body,
      rule_id: matched.ruleId,
      rule_key: matched.ruleKey,
      product_id: matched.productId || body.product_id,
    }),
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
