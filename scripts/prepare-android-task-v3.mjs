import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const webRoot = path.join(root, 'web')
const androidRoot = path.join(webRoot, 'android')
const appRoot = path.join(androidRoot, 'app')
const buildCandidates = [
  path.join(appRoot, 'build.gradle'),
  path.join(appRoot, 'build.gradle.kts'),
]
const versionCode = Number(process.env.CHEFOPS_ANDROID_VERSION_CODE || 14)
const versionName = String(process.env.CHEFOPS_ANDROID_VERSION_NAME || '4.6.12-all-device-print-v12').trim()

function run(command, args, cwd = root) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

if (!Number.isInteger(versionCode) || versionCode < 1) throw new Error('CHEFOPS_ANDROID_VERSION_CODE must be a positive integer')
if (!versionName) throw new Error('CHEFOPS_ANDROID_VERSION_NAME is required')
if (!existsSync(path.join(webRoot, 'package.json'))) throw new Error('Run this script from the repository root')

run('npm', ['run', 'build', '-w', 'web'])
if (!existsSync(androidRoot)) run('node', ['scripts/setup-android.mjs'])
else run('npx', ['cap', 'sync', 'android'], webRoot)

const buildPath = buildCandidates.find((candidate) => existsSync(candidate))
if (!buildPath) throw new Error('Android app Gradle file was not found after Capacitor sync')

let gradle = await fs.readFile(buildPath, 'utf8')
const isKotlin = buildPath.endsWith('.kts')
const codePattern = /versionCode\s*(?:=\s*)?\d+/
const namePattern = /versionName\s*(?:=\s*)?["'][^"']*["']/
if (!codePattern.test(gradle) || !namePattern.test(gradle)) throw new Error(`Unable to find versionCode/versionName in ${buildPath}`)
gradle = gradle.replace(codePattern, isKotlin ? `versionCode = ${versionCode}` : `versionCode ${versionCode}`)
gradle = gradle.replace(namePattern, isKotlin ? `versionName = "${versionName}"` : `versionName "${versionName}"`)
await fs.writeFile(buildPath, gradle)

run('node', ['scripts/configure-android-direct-label-print.mjs'])
run('node', ['scripts/configure-android-tspl-food-label-compat.mjs'])
run('node', ['scripts/configure-android-all-device-print-v12.mjs'])

const metadata = {
  schema: 'stupiaks-ops-android-build-v1',
  prepared_at: new Date().toISOString(),
  version_code: versionCode,
  version_name: versionName,
  app_id: 'com.stupiaks.ops',
  web_source: 'bundled-capacitor-dist',
  task_workflow: 'v5-practical-bilingual',
  data_package: 'v2',
  direct_label_print: true,
  native_tspl_food_label: true,
  all_device_print_transport: 'v12',
  supported_routes: [
    'android_system_print',
    'android_raw_tcp',
    'android_lpr',
    'android_bluetooth_classic',
    'windows_driver_bridge',
    'macos_cups_bridge',
    'bridge_raw_tcp',
    'bridge_lpr',
  ],
}
await fs.writeFile(path.join(androidRoot, 'stupiaks-build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)

console.log('\n✅ Android all-device printer transport project prepared')
console.log(`Version code: ${versionCode}`)
console.log(`Version name: ${versionName}`)
console.log(`Gradle: ${buildPath}`)
console.log('Android System Print / installed driver: configured')
console.log('Raw TCP / LPR / Bluetooth Classic: configured')
console.log('Windows/macOS Print Bridge: configured')
console.log('Native TSPL food-label compatibility: configured')
console.log('Build debug APK: cd web/android && ./gradlew assembleDebug')
