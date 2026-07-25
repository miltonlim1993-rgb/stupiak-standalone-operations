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

const url = process.env.CASH_GAS_URL || values.CASH_GAS_URL || values.SALES_TEMPLATE_GAS_URL || ''
const secret = process.env.CASH_GAS_SECRET || values.CASH_GAS_SECRET || values.SALES_TEMPLATE_SYNC_SECRET || ''
const outletRef = process.argv[2] || 'RR-KCH'
const businessDate = process.argv[3] || new Date().toISOString().slice(0, 10)

if (!url || !secret) {
  console.error('Missing CASH_GAS_URL or CASH_GAS_SECRET in worker/.dev.vars')
  process.exit(1)
}

const first = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'text/plain;charset=utf-8',
    'Accept': 'application/json',
  },
  body: JSON.stringify({
    secret,
    action: 'getStandaloneCashBootstrap',
    outletRef,
    businessDate,
  }),
  redirect: 'manual',
})

let response = first
if ([301, 302, 303, 307, 308].includes(first.status)) {
  const location = first.headers.get('location')
  if (!location) {
    console.error(`Sales Template GAS redirect ${first.status} did not include Location`)
    process.exit(1)
  }
  response = await fetch(location, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    redirect: 'follow',
  })
}

const raw = await response.text()
if (/<!doctype html|<html/i.test(raw)) {
  console.error('Sales Template GAS returned Google HTML instead of JSON')
  process.exit(1)
}
let result
try { result = JSON.parse(raw) } catch {
  console.error('Sales Template GAS returned invalid JSON:', raw.slice(0, 300))
  process.exit(1)
}
if (!response.ok || !result.ok) {
  console.error('Sales Template GAS test failed:', result.error || response.status)
  process.exit(1)
}
console.log(JSON.stringify({
  ok: true,
  outlet: result.outlet,
  businessDate: result.businessDate,
  spreadsheetName: result.spreadsheetName,
  spreadsheetUrl: result.spreadsheetUrl,
  paymentMethods: (result.payments || []).map((row) => row.name),
}, null, 2))

