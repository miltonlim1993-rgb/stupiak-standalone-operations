import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const web = path.join(root, 'web')

function run(command, args, cwd = root) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

if (!existsSync(path.join(web, 'package.json'))) throw new Error('Run this from the ChefOps project root.')

run('npm', [
  'install',
  '--no-save',
  '--package-lock=false',
  '-w',
  'web',
  '@capacitor/core@^8',
  '@capacitor/android@^8',
  '@capacitor/app@^8',
  '@capacitor/camera@^8',
])
run('npm', [
  'install',
  '--no-save',
  '--package-lock=false',
  '-D',
  '-w',
  'web',
  '@capacitor/cli@^8',
])
run('npm', ['run', 'build', '-w', 'web'])
if (!existsSync(path.join(web, 'android'))) run('npx', ['cap', 'add', 'android'], web)
run('npx', ['cap', 'sync', 'android'], web)

console.log('\nAndroid project is ready at web/android.')
console.log('Open it with: npm run mobile:open')
console.log('A downloadable release APK still requires your own signing key.')
