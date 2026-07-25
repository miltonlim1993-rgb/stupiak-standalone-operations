import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const sourceIcon = path.join(root, 'web', 'public', 'stupiaks-ops-512.png')
const androidMain = path.join(root, 'web', 'android', 'app', 'src', 'main')
const drawableDir = path.join(androidMain, 'res', 'drawable-nodpi')
const targetIcon = path.join(drawableDir, 'ic_stupiaks_ops.png')
const manifestPath = path.join(androidMain, 'AndroidManifest.xml')

await fs.access(sourceIcon)
await fs.mkdir(drawableDir, { recursive: true })
await fs.copyFile(sourceIcon, targetIcon)

let manifest = await fs.readFile(manifestPath, 'utf8')
manifest = manifest
  .replace(/android:icon="[^"]+"/, 'android:icon="@drawable/ic_stupiaks_ops"')
  .replace(/android:roundIcon="[^"]+"/, 'android:roundIcon="@drawable/ic_stupiaks_ops"')

await fs.writeFile(manifestPath, manifest)
console.log('Configured Stupiak\'s Ops Android launcher icon.')
