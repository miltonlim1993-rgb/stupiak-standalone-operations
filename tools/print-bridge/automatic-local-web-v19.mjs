#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = 'stupiaks-automatic-local-web-connector-v19'
const HOST = '127.0.0.1'
const PORT = Number(process.env.PRINT_CONNECTOR_WEB_PORT || 8788)
const BRIDGE_PORT = Number(process.env.PRINT_BRIDGE_PORT || 8787)
const TOKEN_PATH = String(process.env.PRINT_BRIDGE_TOKEN_FILE || path.join(os.homedir(), '.stupiaks-print-bridge-token')).trim()
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE_SOURCE = path.join(ROOT, 'server.mjs')
const MAX_BODY_BYTES = 12 * 1024 * 1024
const TRUSTED_ORIGINS = new Set([
  'https://stupiaks-ops.sporkburger19.workers.dev',
  'https://localhost',
  'capacitor://localhost',
  'http://localhost:5173',
  'http://localhost:5188',
  ...String(process.env.PRINT_CONNECTOR_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
])

function clean(value = '') {
  return String(value ?? '').trim()
}

function allowedOrigin(request) {
  const origin = clean(request.headers.origin)
  return origin && TRUSTED_ORIGINS.has(origin) ? origin : ''
}

function cors(origin = '') {
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  }
}

function json(request, response, status, payload) {
  const origin = allowedOrigin(request)
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    ...cors(origin),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

function isLoopbackRequest(request) {
  const address = clean(request.socket.remoteAddress)
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
}

function authorizeBrowser(request, response) {
  if (!isLoopbackRequest(request)) {
    json(request, response, 403, { ok: false, error: 'Automatic Web printing is available only on this computer.' })
    return false
  }
  if (!allowedOrigin(request)) {
    json(request, response, 403, { ok: false, error: 'This website is not allowed to use the local print connector.' })
    return false
  }
  return true
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Print payload is too large.'), { statusCode: 413 })
    chunks.push(chunk)
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.from('{}')
}

async function waitForToken() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const token = clean(await fs.readFile(TOKEN_PATH, 'utf8'))
      if (token) return token
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Internal Print Bridge pairing token was not created.')
}

async function forward(request, pathname) {
  const token = await waitForToken()
  const body = request.method === 'GET' ? undefined : await readBody(request)
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${pathname}`, {
    method: request.method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'X-Print-Bridge-Token': token,
    },
    body,
  })
  return {
    status: response.status,
    body: await response.text(),
  }
}

const bridge = spawn(process.execPath, [BRIDGE_SOURCE], {
  env: {
    ...process.env,
    PRINT_BRIDGE_HOST: '127.0.0.1',
    PRINT_BRIDGE_PORT: String(BRIDGE_PORT),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})

bridge.on('exit', (code, signal) => {
  console.error(`Internal Print Bridge stopped (${signal || code || 0}).`)
  process.exit(code || 1)
})

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${HOST}:${PORT}`}`)
  const origin = allowedOrigin(request)

  if (request.method === 'OPTIONS') {
    if (!isLoopbackRequest(request) || !origin) {
      response.writeHead(403, cors())
      response.end()
      return
    }
    response.writeHead(204, cors(origin))
    response.end()
    return
  }

  if (!authorizeBrowser(request, response)) return

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      const forwarded = await forward(request, '/health')
      const internal = JSON.parse(forwarded.body || '{}')
      json(request, response, forwarded.status, {
        ...internal,
        ok: forwarded.status >= 200 && forwarded.status < 300 && internal.ok !== false,
        service: VERSION,
        automatic: true,
        pairing_token_required: false,
        web_origin: origin,
        local_port: PORT,
        bridge_port: BRIDGE_PORT,
      })
      return
    }

    const allowed = new Set(['/test', '/print', '/printers', '/discover'])
    if (!allowed.has(url.pathname)) {
      json(request, response, 404, { ok: false, error: 'Local Print Connector endpoint was not found.' })
      return
    }

    const forwarded = await forward(request, `${url.pathname}${url.search}`)
    response.writeHead(forwarded.status, {
      ...cors(origin),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(forwarded.body),
    })
    response.end(forwarded.body)
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${request.method} ${url.pathname}:`, error)
    json(request, response, Number(error.statusCode || 500), {
      ok: false,
      error: clean(error.message) || 'Local Print Connector request failed.',
    })
  }
})

server.listen(PORT, HOST, () => {
  console.log('============================================================')
  console.log(`Stupiak's Automatic Local Web Connector ${VERSION}`)
  console.log(`Web URL: http://${HOST}:${PORT}`)
  console.log(`Internal Bridge: http://127.0.0.1:${BRIDGE_PORT}`)
  console.log('Same-computer Stupiak’s Ops Web requires no pairing token.')
  console.log('The browser still sends the same Stable RAW TSPL used by the APK.')
  console.log('============================================================')
})

function shutdown(signal) {
  console.log(`\n${signal}: stopping Local Print Connector...`)
  bridge.kill('SIGTERM')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 3000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
