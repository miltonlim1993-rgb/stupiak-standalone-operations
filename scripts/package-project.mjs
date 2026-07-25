import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const parent = path.dirname(root)
const name = path.basename(root)
const output = path.join(parent, `${name}.zip`)
execFileSync('zip', ['-qr', output, name, '-x', `${name}/node_modules/*`, `${name}/web/dist/*`, `${name}/.generated/*`, `${name}/worker/.dev.vars`, `${name}/web/.env.local`, `${name}/.env.setup`], { cwd: parent })
console.log(output)
