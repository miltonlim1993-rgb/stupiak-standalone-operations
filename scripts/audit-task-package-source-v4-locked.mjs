import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(os.homedir(), '.stupiaks-ops-data-packages', 'reports')
const EXPECTED_TIMEZONE = 'Asia/Kuching'
const STATE_KEYS = [
  'opening_v3',
  'toilet_full_v3',
  'morning_cleaning_v4',
  'toilet_quick_v4',
  'evening_closing_v4',
]

function clean(value = '') {
  return String(value ?? '').trim()
}

function parseArgs(argv) {
  const result = { outlet: 'RR-KCH', waitSeconds: 20 }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--outlet') result.outlet = clean(argv[++index])
    else if (value === '--wait-seconds') result.waitSeconds = Number(argv[++index] || 0)
    else if (value === '--help' || value === '-h') result.help = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!Number.isFinite(result.waitSeconds) || result.waitSeconds < 0 || result.waitSeconds > 600) {
    throw new Error('--wait-seconds must be between 0 and 600')
  }
  return result
}

function usage() {
  console.log(`
Locked RR-KCH V4 Task source audit

Usage:
  node scripts/audit-task-package-source-v4-locked.mjs \\
    --outlet RR-KCH \\
    --wait-seconds 30

Runs the read-only V4 source audit, then requires every active package template
to use Asia/Kuching. No Google Sheet rows are written.
`)
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

async function latestReport(outlet, startedAtMs) {
  await fs.mkdir(reportDir, { recursive: true })
  const names = await fs.readdir(reportDir)
  const candidates = []
  for (const name of names) {
    if (!name.startsWith(`${outlet}-task-source-v4-`) || !name.endsWith('.json')) continue
    const filePath = path.join(reportDir, name)
    const stat = await fs.stat(filePath)
    if (stat.mtimeMs >= startedAtMs) candidates.push({ filePath, mtimeMs: stat.mtimeMs })
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  if (!candidates.length) throw new Error('The underlying V4 source audit did not create a report')
  return candidates[0].filePath
}

function verifyReport(report) {
  if (report.schema !== 'stupiaks-task-package-source-v4-audit-v1') throw new Error('Unexpected V4 source audit schema')
  if (report.writes_performed !== false) throw new Error('V4 source audit unexpectedly performed writes')
  if (report.stable_source !== true) throw new Error('V4 source is not stable')

  for (const snapshotName of ['first', 'second']) {
    const snapshot = report[snapshotName]
    for (const key of STATE_KEYS) {
      const state = snapshot?.states?.[key]
      if (!state) throw new Error(`${snapshotName}.${key} is missing`)
      if (state.active !== true) throw new Error(`${snapshotName}.${key} is not active`)
      if (clean(state.timezone) !== EXPECTED_TIMEZONE) {
        throw new Error(`${snapshotName}.${key} timezone expected ${EXPECTED_TIMEZONE}, received ${state.timezone}`)
      }
    }
    const legacy = snapshot?.states?.toilet_quick_v3
    if (!legacy || legacy.active !== false) throw new Error(`${snapshotName}.toilet_quick_v3 must remain inactive`)
  }

  if (report.first.hashes.combined !== report.second.hashes.combined) throw new Error('V4 source hash changed between reads')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()

  const startedAtMs = Date.now() - 1000
  await run(process.execPath, [
    path.join(root, 'scripts', 'audit-task-package-source-v4.mjs'),
    '--outlet', args.outlet,
    '--wait-seconds', String(args.waitSeconds),
  ])

  const reportPath = await latestReport(args.outlet, startedAtMs)
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
  verifyReport(report)

  console.log('\n✅ Locked V4 Task source audit passed')
  console.log(`Timezone: ${EXPECTED_TIMEZONE}`)
  console.log(`Source SHA-256: ${report.second.hashes.combined}`)
  console.log(`Sample photos configured: ${report.second.counts.enabled_sample_photos}`)
  console.log(`Report: ${reportPath}`)
  console.log('No Google Sheet rows were changed.')
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`)
  process.exitCode = 1
})
