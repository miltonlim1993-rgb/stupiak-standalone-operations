import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const varsPath = path.join(root, 'worker', '.dev.vars')
const text = fs.existsSync(varsPath) ? fs.readFileSync(varsPath, 'utf8') : ''
const values = {}
for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim()
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const index = line.indexOf('=')
  values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
}

const spreadsheetId = process.env.SALES_TEMPLATE_SPREADSHEET_ID || values.SALES_TEMPLATE_SPREADSHEET_ID || process.argv[2] || ''
if (!spreadsheetId) {
  console.error('Missing SALES_TEMPLATE_SPREADSHEET_ID')
  process.exit(1)
}

const required = [
  'GOOGLE_DATA_CLIENT_ID',
  'GOOGLE_DATA_CLIENT_SECRET',
  'GOOGLE_DATA_REFRESH_TOKEN',
]
for (const key of required) {
  if (!values[key]) {
    console.error(`Missing ${key} in worker/.dev.vars`)
    process.exit(1)
  }
}

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: values.GOOGLE_DATA_CLIENT_ID,
    client_secret: values.GOOGLE_DATA_CLIENT_SECRET,
    refresh_token: values.GOOGLE_DATA_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }),
})
const tokenData = await tokenResponse.json()
if (!tokenResponse.ok || !tokenData.access_token) {
  console.error('Google token refresh failed:', tokenData.error_description || tokenData.error || tokenResponse.status)
  process.exit(1)
}

async function google(url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const raw = await response.text()
  let result
  try { result = JSON.parse(raw) } catch { result = null }
  if (!response.ok) {
    console.error(`Google API ${response.status}:`, result || raw.slice(0, 500))
    process.exit(1)
  }
  return result
}

const metadata = await google(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties.title`)
const sheetNames = (metadata.sheets || []).map((item) => item.properties?.title)
if (!sheetNames.includes('_RelationDaily')) {
  console.error('Target spreadsheet does not contain _RelationDaily')
  process.exit(1)
}

const range = encodeURIComponent("'_RelationDaily'!A1:BD2")
const relation = await google(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`)
const headers = relation.values?.[0] || []
for (const requiredHeader of ['Business Date', 'Outlet', 'Night Closing Actual', 'Submitted At']) {
  if (!headers.includes(requiredHeader)) {
    console.error(`_RelationDaily is missing required header: ${requiredHeader}`)
    process.exit(1)
  }
}

console.log(JSON.stringify({
  ok: true,
  mode: 'direct-google-sheets',
  spreadsheetId,
  spreadsheetName: metadata.properties?.title || '',
  relationHeaders: headers.length,
  writableAccountVerified: true,
}, null, 2))
