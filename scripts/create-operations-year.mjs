import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPERATIONS_SHEET_DEFINITIONS } from '../worker/src/schema.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const varsPath = path.join(root, 'worker', '.dev.vars')

function parseEnv(text) {
  const result = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 0) continue
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return result
}

function requireValue(env, key) {
  const value = String(env[key] || '').trim()
  if (!value) throw new Error(`Missing ${key} in worker/.dev.vars`)
  return value
}

async function googleJson(url, { token, method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`Google API ${response.status}: ${JSON.stringify(data)}`)
  return data
}

async function accessToken(env) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireValue(env, 'GOOGLE_DATA_CLIENT_ID'),
      client_secret: requireValue(env, 'GOOGLE_DATA_CLIENT_SECRET'),
      refresh_token: requireValue(env, 'GOOGLE_DATA_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  })
  const data = await response.json()
  if (!response.ok || !data.access_token) throw new Error(`Unable to refresh Google access token: ${JSON.stringify(data)}`)
  return data.access_token
}

async function main() {
  const requestedYear = Number(process.argv[2])
  if (!Number.isInteger(requestedYear) || requestedYear < 2020 || requestedYear > 2100) {
    throw new Error('Usage: npm run sheets:create-year -- 2027')
  }
  const text = await fs.readFile(varsPath, 'utf8')
  const env = parseEnv(text)
  const ids = JSON.parse(requireValue(env, 'GOOGLE_OPERATIONS_SPREADSHEET_IDS'))
  if (ids[String(requestedYear)]) throw new Error(`Operations spreadsheet for ${requestedYear} already exists`)
  const folderId = requireValue(env, 'GOOGLE_OPERATIONS_FOLDER_ID')
  const token = await accessToken(env)
  const timestamp = new Date().toISOString()

  const spreadsheet = await googleJson('https://sheets.googleapis.com/v4/spreadsheets', {
    token,
    method: 'POST',
    body: {
      properties: { title: `ChefOps Operations ${requestedYear}` },
      sheets: [
        ...OPERATIONS_SHEET_DEFINITIONS.map(({ title }) => ({ properties: { title } })),
        { properties: { title: '_Config' } },
      ],
    },
  })

  const current = await googleJson(`https://www.googleapis.com/drive/v3/files/${spreadsheet.spreadsheetId}?fields=parents`, { token })
  const moveUrl = new URL(`https://www.googleapis.com/drive/v3/files/${spreadsheet.spreadsheetId}`)
  moveUrl.searchParams.set('addParents', folderId)
  if (current.parents?.length) moveUrl.searchParams.set('removeParents', current.parents.join(','))
  moveUrl.searchParams.set('fields', 'id,parents')
  await googleJson(moveUrl.toString(), { token, method: 'PATCH' })

  const data = [
    ...OPERATIONS_SHEET_DEFINITIONS.map(({ title, headers }) => ({
      range: `'${title.replaceAll("'", "''")}'!A1`, majorDimension: 'ROWS', values: [headers],
    })),
    {
      range: "'_Config'!A1", majorDimension: 'ROWS',
      values: [
        ['key', 'value', 'description', 'updated_at'],
        ['schema_version', '2', 'ChefOps sheet layout version', timestamp],
        ['storage_type', 'operations', 'Year-partitioned operational records', timestamp],
        ['year', String(requestedYear), 'Operational partition year', timestamp],
      ],
    },
  ]
  await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheet.spreadsheetId}/values:batchUpdate`, {
    token,
    method: 'POST',
    body: { valueInputOption: 'RAW', data },
  })

  ids[String(requestedYear)] = spreadsheet.spreadsheetId
  const lines = text.split(/\r?\n/).filter(Boolean).map((line) =>
    line.startsWith('GOOGLE_OPERATIONS_SPREADSHEET_IDS=')
      ? `GOOGLE_OPERATIONS_SPREADSHEET_IDS=${JSON.stringify(ids)}`
      : line,
  )
  await fs.copyFile(varsPath, `${varsPath}.before-create-year-${requestedYear}-${Date.now()}`)
  await fs.writeFile(varsPath, lines.join('\n') + '\n', { mode: 0o600 })

  console.log(`ChefOps Operations ${requestedYear} created.`)
  console.log(spreadsheet.spreadsheetUrl)
  console.log('Restart npm run dev so Wrangler reloads worker/.dev.vars.')
}

main().catch((error) => {
  console.error(`\nCreate operations year failed: ${error.message}`)
  process.exitCode = 1
})
