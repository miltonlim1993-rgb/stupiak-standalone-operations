import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { exec } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  MASTER_SHEET_DEFINITIONS,
  OPERATIONS_SHEET_DEFINITIONS,
  getSchema,
} from '../worker/src/schema.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const setupPath = path.join(root, '.env.setup')
const redirectUri = 'http://localhost:53682/callback'
const year = new Date().getFullYear()

function parseEnv(text) {
  const result = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    result[key] = value
  }
  return result
}

function requireValue(env, key) {
  const value = String(env[key] || '').trim()
  if (!value || value.startsWith('YOUR_')) throw new Error(`Missing ${key} in .env.setup`)
  return value
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? `open ${JSON.stringify(url)}`
    : process.platform === 'win32'
      ? `start "" ${JSON.stringify(url)}`
      : `xdg-open ${JSON.stringify(url)}`
  exec(command, (error) => {
    if (error) console.log(`Open this URL manually:\n${url}`)
  })
}

async function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, redirectUri)
      if (url.pathname !== '/callback') {
        response.writeHead(404).end('Not found')
        return
      }
      if (url.searchParams.get('state') !== expectedState) {
        response.writeHead(400).end('Invalid OAuth state')
        server.close()
        reject(new Error('OAuth state mismatch'))
        return
      }
      const oauthError = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (oauthError || !code) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`OAuth failed: ${oauthError || 'missing code'}`)
        server.close()
        reject(new Error(oauthError || 'OAuth code missing'))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h2>ChefOps Google connection completed.</h2><p>You may close this tab and return to Terminal.</p>')
      server.close()
      resolve(code)
    })
    server.listen(53682, '127.0.0.1', () => console.log(`OAuth callback listening at ${redirectUri}`))
    server.on('error', reject)
  })
}

async function googleJson(url, { token, method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`Google API ${response.status}: ${JSON.stringify(data)}`)
  return data
}

function blankRecord(entity, values) {
  const schema = getSchema(entity)
  const row = Object.fromEntries(schema.headers.map((field) => [field, '']))
  return { ...row, ...values }
}

async function createFolder(token, name, parentId) {
  return googleJson('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    token,
    method: 'POST',
    body: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
  })
}

async function moveFile(token, fileId, folderId) {
  const current = await googleJson(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, { token })
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`)
  url.searchParams.set('addParents', folderId)
  if (current.parents?.length) url.searchParams.set('removeParents', current.parents.join(','))
  url.searchParams.set('fields', 'id,parents')
  await googleJson(url.toString(), { token, method: 'PATCH' })
}

async function createSpreadsheet(token, title, definitions, folderId, configRows) {
  const spreadsheet = await googleJson('https://sheets.googleapis.com/v4/spreadsheets', {
    token,
    method: 'POST',
    body: {
      properties: { title },
      sheets: [
        ...definitions.map(({ title: sheetTitle }) => ({ properties: { title: sheetTitle } })),
        { properties: { title: '_Config' } },
      ],
    },
  })
  await moveFile(token, spreadsheet.spreadsheetId, folderId)
  const data = [
    ...definitions.map(({ title: sheetTitle, headers }) => ({
      range: `'${sheetTitle.replaceAll("'", "''")}'!A1`, majorDimension: 'ROWS', values: [headers],
    })),
    {
      range: "'_Config'!A1", majorDimension: 'ROWS',
      values: [['key', 'value', 'description', 'updated_at'], ...configRows],
    },
  ]
  await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheet.spreadsheetId}/values:batchUpdate`, {
    token,
    method: 'POST',
    body: { valueInputOption: 'RAW', data },
  })
  return spreadsheet
}

async function main() {
  let config
  try {
    config = parseEnv(await fs.readFile(setupPath, 'utf8'))
  } catch {
    throw new Error(`Create ${setupPath} first by copying .env.setup.example`)
  }

  const dataClientId = requireValue(config, 'GOOGLE_DATA_CLIENT_ID')
  const dataClientSecret = requireValue(config, 'GOOGLE_DATA_CLIENT_SECRET')
  const loginClientId = requireValue(config, 'GOOGLE_LOGIN_CLIENT_ID')
  const ownerEmail = requireValue(config, 'OWNER_EMAIL').toLowerCase()
  const ownerName = config.OWNER_NAME || 'Owner'
  const allowedOrigins = config.ALLOWED_ORIGINS || 'http://localhost:5188'
  const outletName = config.DEFAULT_OUTLET_NAME || 'Main Outlet'
  const outletCode = config.DEFAULT_OUTLET_CODE || 'MAIN'
  const sessionSecret = config.SESSION_SECRET || crypto.randomBytes(48).toString('base64url')

  const state = crypto.randomBytes(24).toString('base64url')
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authorizationUrl.search = new URLSearchParams({
    client_id: dataClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()

  console.log('\nOpening Google authorization for the ChefOps data owner...')
  const codePromise = waitForCode(state)
  openBrowser(authorizationUrl.toString())
  console.log(`If the browser does not open, visit:\n${authorizationUrl}\n`)
  const code = await codePromise

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: dataClientId,
      client_secret: dataClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })
  const tokens = await tokenResponse.json()
  if (!tokenResponse.ok || !tokens.access_token || !tokens.refresh_token) {
    throw new Error(`OAuth token exchange failed: ${JSON.stringify(tokens)}`)
  }
  const token = tokens.access_token
  const timestamp = new Date().toISOString()

  console.log('Creating ChefOps Drive folders...')
  const rootFolder = await createFolder(token, 'ChefOps')
  const masterFolder = await createFolder(token, '01 Master Data', rootFolder.id)
  const operationsFolder = await createFolder(token, '02 Operational Data', rootFolder.id)
  await createFolder(token, '03 Files', rootFolder.id)

  console.log('Creating ChefOps Master spreadsheet...')
  const master = await createSpreadsheet(token, 'ChefOps Master', MASTER_SHEET_DEFINITIONS, masterFolder.id, [
    ['schema_version', '3', 'ChefOps master layout with label printer profiles', timestamp],
    ['storage_type', 'master', 'Long-lived reference data', timestamp],
  ])

  console.log(`Creating ChefOps Operations ${year} spreadsheet...`)
  const operations = await createSpreadsheet(token, `ChefOps Operations ${year}`, OPERATIONS_SHEET_DEFINITIONS, operationsFolder.id, [
    ['schema_version', '2', 'ChefOps sheet layout version', timestamp],
    ['storage_type', 'operations', 'Year-partitioned operational records', timestamp],
    ['year', String(year), 'Operational partition year', timestamp],
  ])

  const outletId = crypto.randomUUID()
  const ownerId = crypto.randomUUID()
  const outlet = blankRecord('Outlet', {
    id: outletId, outlet_id: outletId, created_date: timestamp, created_by: ownerEmail,
    updated_date: timestamp, updated_by: ownerEmail, deleted_at: '', version: 1,
    name: outletName, code: outletCode, address: '', status: 'active', timezone: 'Asia/Kuala_Lumpur',
  })
  const owner = blankRecord('User', {
    id: ownerId, outlet_id: outletId, created_date: timestamp, created_by: ownerEmail,
    updated_date: timestamp, updated_by: ownerEmail, deleted_at: '', version: 1,
    google_sub: '', email: ownerEmail, full_name: ownerName, avatar_url: '', role: 'owner',
    phone: '', department: 'Operations', status: 'active', last_login_at: '',
  })
  const initialData = [
    { entity: 'Outlet', record: outlet },
    { entity: 'User', record: owner },
  ].map(({ entity, record }) => {
    const schema = getSchema(entity)
    return { range: `'${schema.sheet}'!A2`, majorDimension: 'ROWS', values: [schema.headers.map((field) => record[field] ?? '')] }
  })
  await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${master.spreadsheetId}/values:batchUpdate`, {
    token,
    method: 'POST',
    body: { valueInputOption: 'RAW', data: initialData },
  })

  const workerVars = [
    ['GOOGLE_LOGIN_CLIENT_ID', loginClientId],
    ['GOOGLE_DATA_CLIENT_ID', dataClientId],
    ['GOOGLE_DATA_CLIENT_SECRET', dataClientSecret],
    ['GOOGLE_DATA_REFRESH_TOKEN', tokens.refresh_token],
    ['GOOGLE_MASTER_SPREADSHEET_ID', master.spreadsheetId],
    ['GOOGLE_OPERATIONS_SPREADSHEET_IDS', JSON.stringify({ [year]: operations.spreadsheetId })],
    ['GOOGLE_MASTER_FOLDER_ID', masterFolder.id],
    ['GOOGLE_OPERATIONS_FOLDER_ID', operationsFolder.id],
    ['GOOGLE_DRIVE_FOLDER_ID', rootFolder.id],
    ['SESSION_SECRET', sessionSecret],
    ['ALLOWED_ORIGINS', allowedOrigins],
    ['BOOTSTRAP_OWNER_EMAIL', ownerEmail],
  ]
  const devVarsPath = path.join(root, 'worker', '.dev.vars')
  await fs.writeFile(devVarsPath, workerVars.map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
  await fs.writeFile(path.join(root, 'web', '.env.local'), `VITE_GOOGLE_LOGIN_CLIENT_ID=${loginClientId}\n`)
  await fs.writeFile(path.join(root, 'web', '.env.development.local'), 'VITE_API_BASE_URL=http://localhost:8787\n')
  await fs.mkdir(path.join(root, '.generated'), { recursive: true })
  await fs.writeFile(path.join(root, '.generated', 'setup-summary.json'), JSON.stringify({
    schemaVersion: 2,
    masterSpreadsheetId: master.spreadsheetId,
    masterSpreadsheetUrl: master.spreadsheetUrl,
    operations: { [year]: { spreadsheetId: operations.spreadsheetId, url: operations.spreadsheetUrl } },
    driveFolderId: rootFolder.id,
    masterFolderId: masterFolder.id,
    operationsFolderId: operationsFolder.id,
    ownerEmail,
    outletId,
    generatedAt: timestamp,
  }, null, 2))

  console.log('\nChefOps Google setup completed.')
  console.log(`Master: ${master.spreadsheetUrl}`)
  console.log(`Operations ${year}: ${operations.spreadsheetUrl}`)
  console.log(`Drive folder: https://drive.google.com/drive/folders/${rootFolder.id}`)
  console.log('Next command: npm run dev')
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error.message}`)
  process.exitCode = 1
})
