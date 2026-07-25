import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const children = [
  spawn('npm', ['run', 'dev', '-w', 'web'], { cwd: root, stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '-w', 'worker'], { cwd: root, stdio: 'inherit' }),
]

let stopping = false
function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  children.forEach((child) => {
    if (!child.killed) child.kill(signal)
  })
}

children.forEach((child) => {
  child.on('exit', (code) => {
    if (!stopping && code !== 0) {
      stop()
      process.exitCode = code || 1
    }
  })
})

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
