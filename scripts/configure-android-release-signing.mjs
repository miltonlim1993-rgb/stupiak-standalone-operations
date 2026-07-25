import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const androidRoot = path.join(root, 'web', 'android')
const appGradlePath = path.join(androidRoot, 'app', 'build.gradle')
const propertiesPath = path.join(androidRoot, 'keystore.properties')

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

const storePassword = required('ANDROID_KEYSTORE_PASSWORD')
const keyAlias = required('ANDROID_KEY_ALIAS')
const keyPassword = required('ANDROID_KEY_PASSWORD')

await fs.writeFile(propertiesPath, [
  'storeFile=app/stupiaks-ops-release.jks',
  `storePassword=${storePassword}`,
  `keyAlias=${keyAlias}`,
  `keyPassword=${keyPassword}`,
  '',
].join('\n'), { mode: 0o600 })

let gradle = await fs.readFile(appGradlePath, 'utf8')

if (!gradle.includes('stupiaksReleaseSigning')) {
  const prelude = `\n// stupiaksReleaseSigning\ndef stupiaksKeystoreProperties = new Properties()\ndef stupiaksKeystorePropertiesFile = rootProject.file('keystore.properties')\nif (!stupiaksKeystorePropertiesFile.exists()) {\n    throw new GradleException('Missing keystore.properties for release signing')\n}\nstupiaksKeystoreProperties.load(new FileInputStream(stupiaksKeystorePropertiesFile))\n`

  const applyLine = "apply plugin: 'com.android.application'"
  if (!gradle.includes(applyLine)) throw new Error(`Unable to find ${applyLine} in app/build.gradle`)
  gradle = gradle.replace(applyLine, `${applyLine}${prelude}`)

  const androidOpen = 'android {'
  const signingBlock = `android {\n    signingConfigs {\n        release {\n            storeFile rootProject.file(stupiaksKeystoreProperties['storeFile'])\n            storePassword stupiaksKeystoreProperties['storePassword']\n            keyAlias stupiaksKeystoreProperties['keyAlias']\n            keyPassword stupiaksKeystoreProperties['keyPassword']\n            enableV1Signing true\n            enableV2Signing true\n            enableV3Signing true\n        }\n    }`
  if (!gradle.includes(androidOpen)) throw new Error('Unable to find android block in app/build.gradle')
  gradle = gradle.replace(androidOpen, signingBlock)

  const buildTypePattern = /buildTypes\s*\{\s*release\s*\{/m
  if (!buildTypePattern.test(gradle)) throw new Error('Unable to find release build type in app/build.gradle')
  gradle = gradle.replace(buildTypePattern, `buildTypes {\n        release {\n            signingConfig signingConfigs.release`)
}

await fs.writeFile(appGradlePath, gradle)
console.log('Configured signed Android release build.')
