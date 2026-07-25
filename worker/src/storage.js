import { getSchema } from './schema.js'

function configError(message) {
  const error = new Error(message)
  error.status = 500
  error.code = 'storage_not_configured'
  return error
}

export function currentYear() {
  return new Date().getUTCFullYear()
}

export function parseOperationsSpreadsheetIds(env) {
  const raw = String(env.GOOGLE_OPERATIONS_SPREADSHEET_IDS || '').trim()
  if (!raw) {
    const legacy = String(env.GOOGLE_SPREADSHEET_ID || '').trim()
    return legacy ? { [currentYear()]: legacy } : {}
  }
  try {
    const parsed = JSON.parse(raw)
    return Object.fromEntries(
      Object.entries(parsed || {})
        .map(([year, id]) => [String(year), String(id || '').trim()])
        .filter(([, id]) => id),
    )
  } catch {
    throw configError('GOOGLE_OPERATIONS_SPREADSHEET_IDS must be valid JSON')
  }
}

export function configuredOperationYears(env) {
  return Object.keys(parseOperationsSpreadsheetIds(env))
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => b - a)
}

export function inferRecordYear(entity, record = {}, fallback = currentYear()) {
  const schema = getSchema(entity)
  const candidates = [
    schema.partitionField ? record[schema.partitionField] : '',
    record.created_date,
    record.updated_date,
  ]
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/^(\d{4})/)
    if (match) return Number(match[1])
  }
  return Number(fallback) || currentYear()
}

export function inferFilterYear(entity, filter = {}, fallback = currentYear()) {
  const schema = getSchema(entity)
  const expected = schema.partitionField ? filter?.[schema.partitionField] : null
  if (typeof expected === 'string') {
    const match = expected.match(/^(\d{4})/)
    if (match) return Number(match[1])
  }
  if (expected && typeof expected === 'object') {
    for (const key of ['$gte', '$gt', '$lte', '$lt']) {
      const match = String(expected[key] || '').match(/^(\d{4})/)
      if (match) return Number(match[1])
    }
  }
  return Number(fallback) || currentYear()
}

export function spreadsheetIdForEntity(env, entity, { year } = {}) {
  const schema = getSchema(entity)
  if (schema.storage === 'master') {
    const id = String(env.GOOGLE_MASTER_SPREADSHEET_ID || env.GOOGLE_SPREADSHEET_ID || '').trim()
    if (!id) throw configError('GOOGLE_MASTER_SPREADSHEET_ID is missing')
    return { spreadsheetId: id, year: null, storage: 'master' }
  }

  if (schema.storage === 'training') {
    const id = String(env.GOOGLE_TRAINING_SPREADSHEET_ID || '1oljGV1NxJyGbFQoxkrzHeVBGCK7zs3r8x3jphe0HQAs').trim()
    if (!id) throw configError('GOOGLE_TRAINING_SPREADSHEET_ID is missing')
    return { spreadsheetId: id, year: null, storage: 'training' }
  }

  const ids = parseOperationsSpreadsheetIds(env)
  const requestedYear = Number(year) || currentYear()
  const id = ids[String(requestedYear)]
  if (!id) {
    throw configError(`No operations spreadsheet is configured for ${requestedYear}`)
  }
  return { spreadsheetId: id, year: requestedYear, storage: 'operations' }
}

export function allSpreadsheetTargetsForEntity(env, entity, preferredYear) {
  const schema = getSchema(entity)
  if (schema.storage === 'master' || schema.storage === 'training') return [spreadsheetIdForEntity(env, entity)]
  const ids = parseOperationsSpreadsheetIds(env)
  const years = configuredOperationYears(env)
  const preferred = Number(preferredYear)
  if (preferred && ids[String(preferred)]) {
    years.splice(years.indexOf(preferred), 1)
    years.unshift(preferred)
  }
  return years.map((year) => ({ spreadsheetId: ids[String(year)], year, storage: 'operations' }))
}
