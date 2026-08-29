const encoder = new TextEncoder()
const safeToken = /^[^\r\n\t]+$/u
const quantityPattern = /^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,4})?$/u

function fail(message, code = 'invalid_stock_count_quantity') {
  const error = new Error(message)
  error.status = 400
  error.code = code
  throw error
}

function token(value, max) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > max || !safeToken.test(normalized)) {
    fail('Stock-count observation identity contains unsupported characters', 'invalid_stock_count_identity')
  }
  return normalized
}

export function normalizeObservedQuantity(value) {
  const source = String(value ?? '').trim()
  if (!quantityPattern.test(source)) {
    fail('actual_qty must be a non-negative decimal with at most four fractional digits')
  }
  const [integer, fraction = ''] = source.split('.')
  const normalizedFraction = fraction.replace(/0+$/u, '')
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer
}

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function canonicalObservation(value) {
  return [
    'STATVARA_STOCK_COUNT_V1',
    token(value.sourceSystem, 40),
    token(value.sourceBatchMutationId, 160),
    token(value.sourceCountId, 240),
    String(Number(value.sourceCountVersion)),
    token(value.sourceLineMutationId, 200),
    token(value.sourceOutletCode, 100),
    token(value.sourceItemCode, 160),
    normalizeObservedQuantity(value.observedQuantity),
    token(value.uom, 64),
    token(value.countedBySubject, 254),
    value.requiresBatchSerial ? '1' : '0',
  ].join('\n')
}

export async function observationDigest(value) {
  if (!Number.isInteger(Number(value.sourceCountVersion)) || Number(value.sourceCountVersion) < 1) {
    fail('Stock-count source version must be a positive integer', 'invalid_stock_count_version')
  }
  return sha256Hex(canonicalObservation(value))
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function createAcceptedObservation({ secret, batchMutationId, outletId, commit, user }) {
  if (!secret || encoder.encode(String(secret)).length < 32) return null
  const stock = commit.stockList || {}
  const itemCode = token(stock.item_id, 160)
  const uom = token(stock.count_uom || commit.record?.unit, 64)
  const observation = {
    sourceSystem: 'STANDALONE_D1',
    sourceBatchMutationId: token(batchMutationId, 160),
    sourceCountId: token(commit.id, 240),
    sourceCountVersion: Number(commit.version),
    sourceLineMutationId: token(commit.mutationId, 200),
    sourceOutletCode: token(outletId, 100),
    sourceItemCode: itemCode,
    observedQuantity: normalizeObservedQuantity(commit.canonicalQuantity),
    uom,
    countedBySubject: token(user.email, 254),
    requiresBatchSerial: Boolean(
      stock.requires_batch_serial || stock.has_batch_no || stock.has_serial_no
      || stock.batch_no || stock.serial_no || stock.batch_id || stock.serial_id,
    ),
  }
  const digest = await observationDigest(observation)
  return {
    ...observation,
    observationDigest: digest,
    signature: await hmacHex(String(secret), digest),
  }
}

export async function stockBatchFingerprint({ outletId, countDate, items }) {
  return sha256Hex(JSON.stringify({
    outletId: token(outletId, 100),
    countDate: token(countDate, 10),
    items: items.map((item) => ({
      stock_list_id: token(item.stock_list_id, 160),
      actual_qty: normalizeObservedQuantity(item.actual_qty),
    })),
  }))
}

export async function stockLineMutationId(batchMutationId, stockListId) {
  const identity = `${token(batchMutationId, 160)}\n${token(stockListId, 160)}`
  return `stock-line:${await sha256Hex(identity)}`
}
