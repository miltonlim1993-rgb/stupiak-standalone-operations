import fs from 'node:fs'
import path from 'node:path'

const project = process.cwd()
const varsPath = path.join(project, 'worker', '.dev.vars')
const env = { ...process.env }
if (fs.existsSync(varsPath)) {
  for (const line of fs.readFileSync(varsPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    env[key] = value
  }
}

const gasUrl = String(env.CASH_GAS_URL || env.SALES_TEMPLATE_GAS_URL || '').trim()
const secret = String(env.CASH_GAS_SECRET || env.SALES_TEMPLATE_SYNC_SECRET || '').trim()
if (!gasUrl || !secret) {
  console.error('Missing CASH_GAS_URL or CASH_GAS_SECRET in worker/.dev.vars')
  process.exit(1)
}

const [outletCode = 'RR-KCH', spreadsheetId = '1QwwL7_r2lMK7cqbhbT2LSHV_0vlNvIusSZMnE3xr8cY', outletName = "Stupiak's Pork Burger - Royal Richmond", yearText = String(new Date().getFullYear()), feedmeOutletId = '6960e4e32553bd001c723f3b'] = process.argv.slice(2)
const year = Number(yearText)
if (!Number.isInteger(year)) throw new Error('Year must be a number')

async function parseGasJson(response) {
  const raw = await response.text()
  if (/<!doctype html|<html/i.test(raw)) {
    throw new Error(`GAS returned Google HTML instead of JSON (HTTP ${response.status})`)
  }
  let result
  try { result = JSON.parse(raw) } catch {
    throw new Error(`GAS returned invalid JSON (HTTP ${response.status}): ${raw.slice(0, 300)}`)
  }
  if (!response.ok || !result.ok) throw new Error(result.error || `GAS returned ${response.status}`)
  return result
}

async function post(payload) {
  const first = await fetch(gasUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ ...payload, secret }),
    redirect: 'manual',
  })

  let response = first
  if ([301, 302, 303, 307, 308].includes(first.status)) {
    const location = first.headers.get('location')
    if (!location) throw new Error(`GAS redirect ${first.status} did not include Location`)
    response = await fetch(location, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      redirect: 'follow',
    })
  }

  return parseGasJson(response)
}

const registered = await post({
  action: 'registerOutletReport',
  active: true,
  feedmeOutletId,
  outletCode,
  outletName,
  siteKey: outletCode,
  year,
  spreadsheetId,
  source: 'ChefOps v4.1 data pack + Close Up',
})
console.log('Registered Sales Template target:')
console.log(JSON.stringify(registered, null, 2))

const date = `${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`
const bootstrap = await post({ action: 'getStandaloneCashBootstrap', outletRef: outletCode, businessDate: date })
console.log('\nGAS bootstrap test passed:')
console.log(JSON.stringify({
  outlet: bootstrap.outlet,
  businessDate: bootstrap.businessDate,
  spreadsheetId: bootstrap.spreadsheetId,
  spreadsheetName: bootstrap.spreadsheetName,
  paymentMethods: (bootstrap.payments || []).map((item) => item.name),
}, null, 2))
