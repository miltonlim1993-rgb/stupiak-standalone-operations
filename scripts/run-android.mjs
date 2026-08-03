import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { java21Environment } from './android-java.mjs'

const root = process.cwd()
const web = path.join(root, 'web')
const android = path.join(web, 'android')
const mode = String(process.argv[2] || 'debug').trim().toLowerCase()
const { javaHome, env } = java21Environment()

function run(command, args, cwd = root, { allowFailure = false } = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  try {
    execFileSync(command, args, { cwd, env, stdio: 'inherit' })
  } catch (error) {
    if (!allowFailure) throw error
  }
}

if (!existsSync(path.join(web, 'package.json'))) throw new Error('Run this from the ChefOps project root.')
console.log(`Using Java 21: ${javaHome}`)

run('npm', ['run', 'mobile:sync'])
run('npm', ['run', 'mobile:configure'])

if (mode === 'open') {
  const cap = path.join(web, 'node_modules', '.bin', process.platform === 'win32' ? 'cap.cmd' : 'cap')
  if (!existsSync(cap)) throw new Error(`Capacitor CLI was not found at ${cap}`)
  run(cap, ['open', 'android'], web)
} else if (mode === 'debug') {
  if (!existsSync(android)) throw new Error('Android project was not generated at web/android.')
  const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  run(gradle, ['--stop'], android, { allowFailure: true })
  run(gradle, ['assembleDebug'], android)
  console.log(`\nDebug APK: ${path.join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')}`)
} else {
  throw new Error(`Unsupported Android mode: ${mode}. Use "debug" or "open".`)
}
