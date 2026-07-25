import fs from 'node:fs'
import path from 'node:path'

const project = process.cwd()
const varsPath = path.join(project, 'worker', '.dev.vars')
if (!fs.existsSync(varsPath)) throw new Error(`Missing ${varsPath}`)

const vars = {}
for (const line of fs.readFileSync(varsPath, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const index = trimmed.indexOf('=')
  if (index < 0) continue
  let value = trimmed.slice(index + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
  vars[trimmed.slice(0, index).trim()] = value
}

for (const key of ['GOOGLE_DATA_CLIENT_ID', 'GOOGLE_DATA_CLIENT_SECRET', 'GOOGLE_DATA_REFRESH_TOKEN']) {
  if (!vars[key]) throw new Error(`Missing ${key} in worker/.dev.vars`)
}

const registryId = process.argv[2] || '1QwwL7_r2lMK7cqbhbT2LSHV_0vlNvIusSZMnE3xr8cY'
const outletRef = process.argv[3] || 'RR-KCH'
const year = Number(process.argv[4] || 2026)

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: vars.GOOGLE_DATA_CLIENT_ID,
    client_secret: vars.GOOGLE_DATA_CLIENT_SECRET,
    refresh_token: vars.GOOGLE_DATA_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }),
})
const tokenData = await tokenResponse.json()
if (!tokenResponse.ok || !tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || 'Unable to refresh Google token')
const headers = { Authorization: `Bearer ${tokenData.access_token}` }

function normalize(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '') }
function active(value) { return !['', 'false', 'no', 'n', '0', 'inactive', 'disabled'].includes(String(value ?? '').trim().toLowerCase()) }
function id(value) {
  const raw = String(value || '').trim()
  return (raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || raw.match(/^([a-zA-Z0-9_-]{20,})$/) || [])[1] || ''
}

const range = encodeURIComponent("'Outlet Reports'!A1:K5000")
const registryResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${registryId}/values/${range}`, { headers })
const registryData = await registryResponse.json()
if (!registryResponse.ok) throw new Error(`Cannot read registry: ${JSON.stringify(registryData).slice(0, 500)}`)
const values = registryData.values || []
const columns = values[0] || []
const rows = values.slice(1).map((row, index) => Object.fromEntries(columns.map((column, i) => [column, row[i] ?? ''])))
const needle = normalize(outletRef)
const match = rows.find((row) => active(row.Active) && Number(row.Year) === year && ['FeedMe Outlet ID', 'Outlet Code', 'Outlet Name', 'Site Key'].some((column) => normalize(row[column]) === needle))
if (!match) {
  console.log(JSON.stringify({
    ok: true,
    registrySpreadsheetId: registryId,
    outletRef,
    year,
    exactTargetFound: false,
    note: 'No exact yearly report exists yet. ChefOps will copy the configured template once and register the new yearly file.',
  }, null, 2))
  process.exit(0)
}

const targetId = id(match['Report Spreadsheet ID'] || match['Report URL'])
if (!targetId) throw new Error('Registry match has no Report Spreadsheet ID')
const relationRange = encodeURIComponent("'_RelationDaily'!A1:BD5")
const targetResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values/${relationRange}`, { headers })
const targetData = await targetResponse.json()
if (!targetResponse.ok) throw new Error(`Cannot read registered yearly report ${targetId}: ${JSON.stringify(targetData).slice(0, 500)}`)
console.log(JSON.stringify({
  ok: true,
  mode: 'registry-yearly-report',
  registrySpreadsheetId: registryId,
  outletRef,
  year,
  exactTargetFound: true,
  targetSpreadsheetId: targetId,
  targetReportUrl: match['Report URL'] || `https://docs.google.com/spreadsheets/d/${targetId}/edit`,
  outletName: match['Outlet Name'] || match['Outlet Code'],
  relationHeadersVerified: (targetData.values?.[0] || []).includes('Business Date'),
}, null, 2))
