import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const androidRoot = path.join(root, 'web', 'android')
const javaRoot = path.join(androidRoot, 'app', 'src', 'main', 'java', 'com', 'stupiaks', 'ops')
const mainActivityPath = path.join(javaRoot, 'MainActivity.java')
const sourcePath = path.join(root, 'scripts', 'android-app-update', 'AppUpdatePlugin.java')
const targetPath = path.join(javaRoot, 'AppUpdatePlugin.java')

await fs.mkdir(javaRoot, { recursive: true })
await fs.copyFile(sourcePath, targetPath)

let mainActivity = await fs.readFile(mainActivityPath, 'utf8')
if (!mainActivity.includes('registerPlugin(AppUpdatePlugin.class);')) {
  const anchors = [
    '        registerPlugin(TaskAlarmPlugin.class);\n',
    '        registerPlugin(DirectLabelPrintPlugin.class);\n',
    '        registerPlugin(NativeLabelPrintPlugin.class);\n',
  ]
  const anchor = anchors.find((candidate) => mainActivity.includes(candidate))
  if (!anchor) throw new Error('Unable to find Android plugin registration anchor')
  mainActivity = mainActivity.replace(anchor, `${anchor}        registerPlugin(AppUpdatePlugin.class);\n`)
}
await fs.writeFile(mainActivityPath, mainActivity)

console.log('Configured native installed-version detection and external APK download opening.')
