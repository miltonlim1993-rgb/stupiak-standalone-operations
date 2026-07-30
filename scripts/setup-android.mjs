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
const requiredPackages = [
  '@capacitor/core',
  '@capacitor/android',
  '@capacitor/app',
  '@capacitor/cli',
]

for (const packageName of requiredPackages) {
  const parts = packageName.split('/')
  const candidates = [
    path.join(
      root,
      'node_modules',
      ...parts,
      'package.json',
    ),
    path.join(
      web,
      'node_modules',
      ...parts,
      'package.json',
    ),
  ]

  if (!candidates.some((candidate) => existsSync(candidate))) {
    throw new Error(
      `Missing ${packageName}. Run npm install from the repository root.`,
    )
  }
}
run('npm', ['run', 'build', '-w', 'web'])
if (!existsSync(path.join(web, 'android'))) run('npx', ['cap', 'add', 'android'], web)
run('npx', ['cap', 'sync', 'android'], web)
console.log('\nAndroid project is ready at web/android.')
console.log('Open it with: npx cap open android (from web/)')
console.log('A downloadable release APK still requires your own signing key.')
