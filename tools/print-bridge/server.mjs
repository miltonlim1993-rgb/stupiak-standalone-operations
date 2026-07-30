#!/usr/bin/env node
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const VERSION = 'stupiaks-print-bridge-v12'
const HOST = String(process.env.PRINT_BRIDGE_HOST || '0.0.0.0').trim()
const PORT = clamp(Number(process.env.PRINT_BRIDGE_PORT || 8787), 1, 65535)
const MAX_BODY_BYTES = clamp(Number(process.env.PRINT_BRIDGE_MAX_BYTES || 12 * 1024 * 1024), 1024, 64 * 1024 * 1024)
const TOKEN_PATH = String(process.env.PRINT_BRIDGE_TOKEN_FILE || path.join(os.homedir(), '.stupiaks-print-bridge-token')).trim()
const ALLOW_UNAUTHENTICATED = String(process.env.PRINT_BRIDGE_ALLOW_UNAUTHENTICATED || '').toLowerCase() === 'true'
const WINDOWS_RAW_SCRIPT = path.join(os.tmpdir(), 'stupiaks-print-bridge-raw-v12.ps1')

function clamp(value, minimum, maximum) {
  const number = Number.isFinite(value) ? value : minimum
  return Math.max(minimum, Math.min(maximum, Math.round(number)))
}

function clean(value = '') {
  return String(value ?? '').trim()
}

function json(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...corsHeaders(),
    ...extraHeaders,
  })
  response.end(body)
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Print-Bridge-Token, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  }
}

async function ensureToken() {
  const envToken = clean(process.env.PRINT_BRIDGE_TOKEN)
  if (envToken) return envToken
  try {
    const existing = clean(await fs.readFile(TOKEN_PATH, 'utf8'))
    if (existing) return existing
  } catch {}
  const token = crypto.randomBytes(18).toString('base64url')
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true })
  await fs.writeFile(TOKEN_PATH, `${token}\n`, { mode: 0o600 })
  return token
}

const TOKEN = await ensureToken()

function requestToken(request, url) {
  const authorization = clean(request.headers.authorization)
  if (/^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, '').trim()
  return clean(request.headers['x-print-bridge-token'] || url.searchParams.get('token'))
}

function requireAuth(request, response, url) {
  if (ALLOW_UNAUTHENTICATED) return true
  const supplied = requestToken(request, url)
  const suppliedBytes = Buffer.from(supplied)
  const tokenBytes = Buffer.from(TOKEN)
  const valid = suppliedBytes.length === tokenBytes.length && crypto.timingSafeEqual(suppliedBytes, tokenBytes)
  if (!valid) json(response, 401, { ok: false, error: 'Print Bridge pairing token is missing or incorrect.' })
  return valid
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Print payload is too large.'), { statusCode: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 })
  }
}

function payloadBytes(body = {}) {
  if (Array.isArray(body.bytes)) {
    if (body.bytes.length > MAX_BODY_BYTES) throw Object.assign(new Error('Print payload is too large.'), { statusCode: 413 })
    return Buffer.from(body.bytes.map((value) => clamp(Number(value), 0, 255)))
  }
  if (clean(body.payloadBase64)) return Buffer.from(clean(body.payloadBase64), 'base64')
  if (typeof body.payload === 'string') return Buffer.from(body.payload, body.payloadEncoding === 'base64' ? 'base64' : 'binary')
  throw Object.assign(new Error('Print request is missing bytes, payloadBase64, or payload.'), { statusCode: 400 })
}

function privateIpv4Interfaces() {
  const rows = []
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue
      const ip = clean(address.address)
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) rows.push({ name, address: ip })
    }
  }
  return rows
}

function tcpConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(true)
    }
    socket.setTimeout(timeoutMs, () => finish(new Error(`Connection to ${host}:${port} timed out.`)))
    socket.once('error', finish)
    socket.connect(port, host, () => finish())
  })
}

function sendRawTcp(bytes, host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve({ printer: `${host}:${port}`, bytes: bytes.length })
    }
    socket.setTimeout(timeoutMs, () => finish(new Error(`Raw TCP print to ${host}:${port} timed out.`)))
    socket.once('error', finish)
    socket.connect(port, host, () => {
      socket.write(bytes, (error) => {
        if (error) return finish(error)
        socket.end(() => finish())
      })
    })
  })
}

function readLprAck(socket, label) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      cleanup()
      if (chunk[0] === 0) resolve()
      else reject(new Error(`LPR printer rejected ${label}.`))
    }
    const onError = (error) => { cleanup(); reject(error) }
    const onTimeout = () => { cleanup(); reject(new Error(`LPR acknowledgement timed out during ${label}.`)) }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
    }
    socket.once('data', onData)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
  })
}

async function sendLpr(bytes, host, port, queue, timeoutMs = 7000) {
  const socket = new net.Socket()
  socket.setTimeout(timeoutMs)
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.connect(port, host, resolve)
  })
  try {
    const safeQueue = clean(queue) || 'lp'
    const hostname = 'stupiaks-ops'
    const controlName = `cfA001${hostname}`
    const dataName = `dfA001${hostname}`
    const control = Buffer.from(`H${hostname}\nPstupiaks\nJStupiak Label\nl${dataName}\nU${dataName}\nNlabel\n`, 'ascii')
    socket.write(Buffer.concat([Buffer.from([0x02]), Buffer.from(`${safeQueue}\n`, 'ascii')]))
    await readLprAck(socket, 'queue selection')
    socket.write(Buffer.concat([Buffer.from([0x02]), Buffer.from(`${control.length} ${controlName}\n`, 'ascii')]))
    await readLprAck(socket, 'control header')
    socket.write(Buffer.concat([control, Buffer.from([0])]))
    await readLprAck(socket, 'control file')
    socket.write(Buffer.concat([Buffer.from([0x03]), Buffer.from(`${bytes.length} ${dataName}\n`, 'ascii')]))
    await readLprAck(socket, 'data header')
    socket.write(Buffer.concat([bytes, Buffer.from([0])]))
    await readLprAck(socket, 'print data')
    return { printer: `${host}:${port}/${safeQueue}`, bytes: bytes.length }
  } finally {
    socket.destroy()
  }
}

async function windowsQueues() {
  const command = [
    '$ErrorActionPreference="Stop";',
    'Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,WorkOffline,Shared | ConvertTo-Json -Compress',
  ].join(' ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  if (!clean(stdout)) return []
  const parsed = JSON.parse(stdout)
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    name: clean(item.Name),
    driver: clean(item.DriverName),
    port: clean(item.PortName),
    status: clean(item.PrinterStatus),
    offline: Boolean(item.WorkOffline),
    shared: Boolean(item.Shared),
    platform: 'windows',
  })).filter((item) => item.name)
}

async function unixQueues() {
  const { stdout } = await execFileAsync('lpstat', ['-p'], { maxBuffer: 2 * 1024 * 1024 })
  return String(stdout || '').split(/\r?\n/).map((line) => {
    const match = line.match(/^printer\s+(\S+)\s+(.*)$/i)
    if (!match) return null
    return {
      name: match[1],
      driver: '',
      port: '',
      status: match[2],
      offline: /disabled|offline|not available/i.test(match[2]),
      shared: false,
      platform: process.platform === 'darwin' ? 'macos' : 'linux',
    }
  }).filter(Boolean)
}

async function listQueues() {
  try {
    return process.platform === 'win32' ? await windowsQueues() : await unixQueues()
  } catch (error) {
    throw new Error(`Unable to read installed printer queues: ${error.message}`)
  }
}

const WINDOWS_SCRIPT_SOURCE = String.raw`param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$PayloadPath
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class StupiaksRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr hPrinter, byte[] bytes, int count, out int written);
  public static void Send(string printer, byte[] bytes) {
    IntPtr handle;
    if (!OpenPrinter(printer, out handle, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed");
    try {
      var doc = new DOCINFOA { pDocName = "Stupiak Label", pDataType = "RAW", pOutputFile = null };
      if (StartDocPrinter(handle, 1, doc) == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
      try {
        if (!StartPagePrinter(handle)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter failed");
        try {
          int written;
          if (!WritePrinter(handle, bytes, bytes.Length, out written) || written != bytes.Length) throw new IOException("Windows spooler did not accept the complete RAW job");
        } finally { EndPagePrinter(handle); }
      } finally { EndDocPrinter(handle); }
    } finally { ClosePrinter(handle); }
  }
}
'@
$payload = [System.IO.File]::ReadAllBytes($PayloadPath)
[StupiaksRawPrinter]::Send($PrinterName, $payload)
Write-Output ('{"ok":true,"bytes":' + $payload.Length + '}')
`

async function ensureWindowsRawScript() {
  if (process.platform !== 'win32') return
  await fs.writeFile(WINDOWS_RAW_SCRIPT, WINDOWS_SCRIPT_SOURCE, 'utf8')
}

async function printQueue(bytes, queue) {
  const safeQueue = clean(queue)
  if (!safeQueue) throw new Error('Installed printer queue name is required.')
  const queues = await listQueues()
  const selected = queues.find((item) => item.name.toLowerCase() === safeQueue.toLowerCase())
  if (!selected) throw new Error(`Printer queue “${safeQueue}” was not found on this computer.`)
  if (selected.offline) throw new Error(`Printer queue “${selected.name}” is offline.`)

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stupiaks-print-'))
  const payloadPath = path.join(directory, 'label.bin')
  try {
    await fs.writeFile(payloadPath, bytes)
    if (process.platform === 'win32') {
      await ensureWindowsRawScript()
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_RAW_SCRIPT, '-PrinterName', selected.name, '-PayloadPath', payloadPath], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
    } else {
      await execFileAsync('lpr', ['-P', selected.name, '-o', 'raw', payloadPath], { maxBuffer: 2 * 1024 * 1024 })
    }
    return { printer: selected.name, bytes: bytes.length, queue: selected }
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function scanSubnet(port, timeoutMs = 450) {
  const candidates = []
  const scanned = new Set()
  for (const iface of privateIpv4Interfaces()) {
    const parts = iface.address.split('.')
    if (parts.length !== 4) continue
    const prefix = parts.slice(0, 3).join('.')
    for (let suffix = 1; suffix <= 254; suffix++) {
      const host = `${prefix}.${suffix}`
      if (host === iface.address || scanned.has(host)) continue
      scanned.add(host)
      candidates.push(host)
    }
  }

  const found = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(40, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++
      const host = candidates[index]
      try {
        await tcpConnect(host, port, timeoutMs)
        found.push({ host, port, name: `Network printer ${host}`, source: 'bridge-scan' })
      } catch {}
    }
  })
  await Promise.all(workers)
  return { printers: found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true })), scanned: candidates.length }
}

async function testTarget(body) {
  const mode = clean(body.mode || body.transport || 'queue').toLowerCase()
  if (mode === 'queue') {
    const queues = await listQueues()
    const queue = queues.find((item) => item.name.toLowerCase() === clean(body.queue).toLowerCase())
    if (!queue) throw new Error(`Printer queue “${clean(body.queue)}” was not found.`)
    if (queue.offline) throw new Error(`Printer queue “${queue.name}” is offline.`)
    return { connected: true, printer: queue.name, mode, queue }
  }
  const host = clean(body.host || body.ipAddress)
  const protocol = mode === 'lpr' ? 'lpr' : 'raw_tcp'
  const port = clamp(Number(body.port || (protocol === 'lpr' ? 515 : 9100)), 1, 65535)
  if (!host) throw new Error('Printer IP address is required.')
  await tcpConnect(host, port, clamp(Number(body.timeoutMs || 3000), 500, 30000))
  return { connected: true, printer: `${host}:${port}`, mode: protocol }
}

async function printTarget(body) {
  const bytes = payloadBytes(body)
  if (!bytes.length) throw new Error('Print payload is empty.')
  const mode = clean(body.mode || body.transport || 'raw_tcp').toLowerCase()
  if (mode === 'queue') return printQueue(bytes, body.queue)
  const host = clean(body.host || body.ipAddress)
  const port = clamp(Number(body.port || (mode === 'lpr' ? 515 : 9100)), 1, 65535)
  const timeoutMs = clamp(Number(body.timeoutMs || 7000), 500, 30000)
  if (!host) throw new Error('Printer IP address is required.')
  if (mode === 'lpr') return sendLpr(bytes, host, port, body.queue || body.lprQueue || 'lp', timeoutMs)
  return sendRawTcp(bytes, host, port, timeoutMs)
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders())
    response.end()
    return
  }

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, {
        ok: true,
        service: VERSION,
        platform: process.platform,
        hostname: os.hostname(),
        port: PORT,
        token_required: !ALLOW_UNAUTHENTICATED,
        interfaces: privateIpv4Interfaces(),
        capabilities: ['queue', 'raw_tcp', 'lpr', 'discover'],
      })
      return
    }

    if (!requireAuth(request, response, url)) return

    if (request.method === 'GET' && url.pathname === '/printers') {
      const printers = await listQueues()
      json(response, 200, { ok: true, printers, platform: process.platform })
      return
    }

    if (request.method === 'GET' && url.pathname === '/discover') {
      const port = clamp(Number(url.searchParams.get('port') || 9100), 1, 65535)
      const result = await scanSubnet(port)
      json(response, 200, { ok: true, ...result, interfaces: privateIpv4Interfaces() })
      return
    }

    if (request.method === 'POST' && url.pathname === '/test') {
      const result = await testTarget(await readJsonBody(request))
      json(response, 200, { ok: true, ...result })
      return
    }

    if (request.method === 'POST' && ['/print', '/print-queue', '/print-usb'].includes(url.pathname)) {
      const body = await readJsonBody(request)
      if (url.pathname !== '/print' && !body.mode) body.mode = 'queue'
      const result = await printTarget(body)
      json(response, 200, { ok: true, printed: true, ...result })
      return
    }

    json(response, 404, { ok: false, error: 'Print Bridge endpoint was not found.' })
  } catch (error) {
    const status = clamp(Number(error.statusCode || 500), 400, 599)
    console.error(`[${new Date().toISOString()}] ${request.method} ${url.pathname}:`, error)
    json(response, status, { ok: false, error: clean(error.message) || 'Print Bridge request failed.' })
  }
})

server.listen(PORT, HOST, () => {
  const interfaces = privateIpv4Interfaces()
  console.log('============================================================')
  console.log(`Stupiak's Print Bridge ${VERSION}`)
  console.log(`Platform: ${process.platform} · Computer: ${os.hostname()}`)
  console.log(`Listening: http://${HOST}:${PORT}`)
  for (const iface of interfaces) console.log(`Phone/tablet URL: http://${iface.address}:${PORT}`)
  console.log(`Pairing token: ${TOKEN}`)
  console.log(`Token file: ${TOKEN_PATH}`)
  console.log('Routes: installed queue / Raw TCP / LPR / LAN discovery')
  console.log('Keep this terminal or installed service running while phones print through the computer.')
  console.log('============================================================')
})

function shutdown(signal) {
  console.log(`\n${signal}: stopping Print Bridge...`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 3000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
