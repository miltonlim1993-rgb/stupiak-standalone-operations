import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const forbidden = ['@' + 'base44', 'base44' + '.app', 'base44' + 'Client', 'base44' + '.entities', 'base44' + '.auth']
const ignored = new Set(['node_modules', '.git', 'dist', '.generated'])
const findings = []

async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) await walk(full)
    else if (/\.(js|jsx|ts|tsx|json|jsonc|html|css|md)$/.test(entry.name) && full !== fileURLToPath(import.meta.url)) {
      const text = await fs.readFile(full, 'utf8').catch(() => '')
      forbidden.forEach((term) => {
        if (text.includes(term)) findings.push(`${path.relative(root, full)} contains ${term}`)
      })
    }
  }
}
await walk(root)
if (findings.length) {
  console.error(findings.join('\n'))
  process.exitCode = 1
} else {
  console.log('Base44 audit passed: no SDK, server URL, auth or entity client references found.')
}
