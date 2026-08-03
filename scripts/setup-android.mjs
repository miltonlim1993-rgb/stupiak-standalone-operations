import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const web = path.join(root, 'web')
const cap = path.join(web, 'node_modules', '.bin', 'cap')

function run(command, args, cwd = root) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

if (!existsSync(path.join(web, 'package.json'))) throw new Error('Run this from the ChefOps project root.')

run('npm', [
  'install',
  '--no-save',
  '--package-lock=false',
  '--workspaces=false',
  '@capacitor/core@^8',
  '@capacitor/android@^8',
  '@capacitor/app@^8',
  '@capacitor/camera@^8',
  '@capacitor/cli@^8',
], web)

if (!existsSync(cap)) throw new Error(`Capacitor CLI was not installed at ${cap}`)
run('npm', ['run', 'build'], web)
if (!existsSync(path.join(web, 'android'))) run(cap, ['add', 'android'], web)
run(cap, ['sync', 'android'], web)

console.log('\nAndroid project is ready at web/android.')
console.log('Open it with: npm run mobile:open')
console.log('A downloadable release APK still requires your own signing key.')
