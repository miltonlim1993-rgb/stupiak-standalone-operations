import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MASTER_SHEET_DEFINITIONS,
  OPERATIONS_SHEET_DEFINITIONS,
} from '../worker/src/schema.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const varsPath = path.join(root, 'worker', '.dev.vars')
const generatedDir = path.join(root, '.generated')
const year = new Date().getFullYear()

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
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
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

async function createFolder(token, name, parentId) {
  const body = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId ? { parents: [parentId] } : {}),
  }
  return googleJson('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    token,
    method: 'POST',
    body,
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

  const headerData = [
    ...definitions.map(({ title: sheetTitle, headers }) => ({
      range: `'${sheetTitle.replaceAll("'", "''")}'!A1`,
      majorDimension: 'ROWS',
      values: [headers],
    })),
    {
      range: "'_Config'!A1",
      majorDimension: 'ROWS',
      values: [['key', 'value', 'description', 'updated_at'], ...configRows],
    },
  ]
  await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheet.spreadsheetId}/values:batchUpdate`, {
    token,
    method: 'POST',
    body: { valueInputOption: 'RAW', data: headerData },
  })

  const details = await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheet.spreadsheetId}?fields=sheets.properties`, { token })
  const requests = details.sheets.flatMap(({ properties }) => {
    const headerWidth = properties.title === '_Config'
      ? 4
      : (definitions.find((item) => item.title === properties.title)?.headers.length || 1)
    return [
      {
        updateSheetProperties: {
          properties: { sheetId: properties.sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
      {
        repeatCell: {
          range: { sheetId: properties.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: headerWidth },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.12, green: 0.12, blue: 0.12 },
              textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
              horizontalAlignment: 'CENTER',
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId: properties.sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: headerWidth },
        },
      },
    ]
  })
  await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheet.spreadsheetId}:batchUpdate`, {
    token,
    method: 'POST',
    body: { requests },
  })
  return spreadsheet
}

async function readTab(token, spreadsheetId, title) {
  const range = encodeURIComponent(`'${title.replaceAll("'", "''")}'!A:ZZ`)
  try {
    const data = await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, { token })
    return data.values || []
  } catch (error) {
    if (String(error.message).includes('Unable to parse range')) return []
    throw error
  }
}

async function copyEntityTabs(token, sourceId, targetId, definitions) {
  const data = []
  const copied = []
  for (const definition of definitions) {
    const values = await readTab(token, sourceId, definition.title)
    if (values.length <= 1) {
      copied.push({ tab: definition.title, rows: 0 })
      continue
    }
    const sourceHeaders = values[0]
    const index = new Map(sourceHeaders.map((field, column) => [field, column]))
    const rows = values.slice(1).map((sourceRow) => definition.headers.map((field) => sourceRow[index.get(field)] ?? ''))
    data.push({
      range: `'${definition.title.replaceAll("'", "''")}'!A2`,
      majorDimension: 'ROWS',
      values: rows,
    })
    copied.push({ tab: definition.title, rows: rows.length })
  }
  if (data.length) {
    await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values:batchUpdate`, {
      token,
      method: 'POST',
      body: { valueInputOption: 'RAW', data },
    })
  }
  return copied
}

async function writeEnvFile(file, updates) {
  const existing = parseEnv(await fs.readFile(file, 'utf8'))
  Object.assign(existing, updates)
  const preferredOrder = [
    'GOOGLE_LOGIN_CLIENT_ID',
    'GOOGLE_DATA_CLIENT_ID',
    'GOOGLE_DATA_CLIENT_SECRET',
    'GOOGLE_DATA_REFRESH_TOKEN',
    'GOOGLE_MASTER_SPREADSHEET_ID',
    'GOOGLE_OPERATIONS_SPREADSHEET_IDS',
    'GOOGLE_MASTER_FOLDER_ID',
    'GOOGLE_OPERATIONS_FOLDER_ID',
    'GOOGLE_DRIVE_FOLDER_ID',
    'GOOGLE_LEGACY_SPREADSHEET_ID',
    'GOOGLE_SPREADSHEET_ID',
    'SESSION_SECRET',
    'ALLOWED_ORIGINS',
    'BOOTSTRAP_OWNER_EMAIL',
  ]
  const keys = [...preferredOrder.filter((key) => key in existing), ...Object.keys(existing).filter((key) => !preferredOrder.includes(key)).sort()]
  await fs.writeFile(file, keys.map((key) => `${key}=${existing[key]}`).join('\n') + '\n', { mode: 0o600 })
}

async function main() {
  const envText = await fs.readFile(varsPath, 'utf8')
  const env = parseEnv(envText)
  if (env.GOOGLE_MASTER_SPREADSHEET_ID && env.GOOGLE_OPERATIONS_SPREADSHEET_IDS) {
    throw new Error('The Master/Operations layout is already configured. No files were created.')
  }

  const legacyId = requireValue(env, 'GOOGLE_SPREADSHEET_ID')
  const rootFolderId = requireValue(env, 'GOOGLE_DRIVE_FOLDER_ID')
  const token = await accessToken(env)
  const timestamp = new Date().toISOString()

  console.log('Creating organized ChefOps folders...')
  const masterFolder = await createFolder(token, '01 Master Data', rootFolderId)
  const operationsFolder = await createFolder(token, '02 Operational Data', rootFolderId)

  console.log('Creating ChefOps Master spreadsheet...')
  const master = await createSpreadsheet(
    token,
    'ChefOps Master',
    MASTER_SHEET_DEFINITIONS,
    masterFolder.id,
    [
      ['schema_version', '3', 'ChefOps master layout with label printer profiles', timestamp],
      ['storage_type', 'master', 'Long-lived reference data', timestamp],
      ['legacy_spreadsheet_id', legacyId, 'Original combined spreadsheet kept as backup', timestamp],
    ],
  )

  console.log(`Creating ChefOps Operations ${year} spreadsheet...`)
  const operations = await createSpreadsheet(
    token,
    `ChefOps Operations ${year}`,
    OPERATIONS_SHEET_DEFINITIONS,
    operationsFolder.id,
    [
      ['schema_version', '2', 'ChefOps sheet layout version', timestamp],
      ['storage_type', 'operations', 'Year-partitioned operational records', timestamp],
      ['year', String(year), 'Operational partition year', timestamp],
      ['legacy_spreadsheet_id', legacyId, 'Original combined spreadsheet kept as backup', timestamp],
    ],
  )

  console.log('Copying current data without deleting the original spreadsheet...')
  const masterCopy = await copyEntityTabs(token, legacyId, master.spreadsheetId, MASTER_SHEET_DEFINITIONS)
  const operationsCopy = await copyEntityTabs(token, legacyId, operations.spreadsheetId, OPERATIONS_SHEET_DEFINITIONS)

  const backupPath = `${varsPath}.before-sheet-layout-v2-${Date.now()}`
  await fs.copyFile(varsPath, backupPath)
  await writeEnvFile(varsPath, {
    GOOGLE_MASTER_SPREADSHEET_ID: master.spreadsheetId,
    GOOGLE_OPERATIONS_SPREADSHEET_IDS: JSON.stringify({ [year]: operations.spreadsheetId }),
    GOOGLE_MASTER_FOLDER_ID: masterFolder.id,
    GOOGLE_OPERATIONS_FOLDER_ID: operationsFolder.id,
    GOOGLE_LEGACY_SPREADSHEET_ID: legacyId,
  })

  await fs.mkdir(generatedDir, { recursive: true })
  const summary = {
    version: 2,
    createdAt: timestamp,
    legacySpreadsheetId: legacyId,
    master: {
      spreadsheetId: master.spreadsheetId,
      url: master.spreadsheetUrl,
      folderId: masterFolder.id,
      copied: masterCopy,
    },
    operations: {
      year,
      spreadsheetId: operations.spreadsheetId,
      url: operations.spreadsheetUrl,
      folderId: operationsFolder.id,
      copied: operationsCopy,
    },
    devVarsBackup: backupPath,
  }
  await fs.writeFile(path.join(generatedDir, 'sheet-layout-v2.json'), JSON.stringify(summary, null, 2))

  console.log('\nChefOps Sheet database layout upgraded successfully.')
  console.log(`Master: ${master.spreadsheetUrl}`)
  console.log(`Operations ${year}: ${operations.spreadsheetUrl}`)
  console.log(`Original combined spreadsheet was not changed or deleted: ${legacyId}`)
  console.log(`worker/.dev.vars backup: ${backupPath}`)
  console.log('Next: restart npm run dev and test login plus data pages.')
}

main().catch((error) => {
  console.error(`\nSheet layout upgrade failed: ${error.message}`)
  process.exitCode = 1
})
