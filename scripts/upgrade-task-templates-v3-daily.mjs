import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'scripts', 'upgrade-task-templates-v3.mjs')
const runtimePath = path.join(root, 'scripts', '.upgrade-task-templates-v3-daily-runtime.mjs')

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search)
  if (index < 0) throw new Error(`Unable to patch ${label}`)
  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`
}

function patchQuickConfig(source) {
  const start = source.indexOf('function quickToiletConfig()')
  const end = source.indexOf('function fullToiletConfig()', start)
  if (start < 0 || end < 0) throw new Error('Unable to locate quick toilet configuration')

  let quick = source.slice(start, end)
  quick = replaceOnce(quick, "shift_id: 'MORNING'", "shift_id: 'DAILY'", 'quick shift_id')
  quick = replaceOnce(quick, "shift_name: 'Morning Shift'", "shift_name: 'All Day'", 'quick shift_name')
  quick = replaceOnce(quick, "shift_name_cn: '早班'", "shift_name_cn: '全天'", 'quick Chinese shift name')
  quick = replaceOnce(quick, "shift_name_en: 'Morning Shift'", "shift_name_en: 'All Day'", 'quick English shift name')

  return `${source.slice(0, start)}${quick}${source.slice(end)}`
}

function patchQuickTemplatePeriod(source) {
  const anchor = source.indexOf("id: 'tmpl-rr-toilet-quick-v3'")
  if (anchor < 0) throw new Error('Unable to locate quick toilet template')
  const nextTemplate = source.indexOf("id: 'tmpl-rr-toilet-full-v3'", anchor)
  const end = nextTemplate > anchor ? nextTemplate : source.length
  let block = source.slice(anchor, end)
  block = replaceOnce(block, "period: 'MORNING'", "period: 'DAILY'", 'quick template period')
  return `${source.slice(0, anchor)}${block}${source.slice(end)}`
}

async function main() {
  let source = await fs.readFile(sourcePath, 'utf8')
  source = patchQuickConfig(source)
  source = patchQuickTemplatePeriod(source)

  await fs.writeFile(runtimePath, source, 'utf8')
  try {
    execFileSync(process.execPath, [pathToFileURL(runtimePath).pathname, ...process.argv.slice(2)], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    })
  } finally {
    await fs.rm(runtimePath, { force: true })
  }
}

main().catch((error) => {
  console.error(`\nTask Template v3 all-day upgrade failed: ${error.message}`)
  process.exitCode = 1
})
