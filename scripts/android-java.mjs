import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

function javaExecutable(javaHome) {
  return path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
}

function readJavaVersion(javaHome) {
  if (!javaHome) return null
  const executable = javaExecutable(javaHome)
  if (!existsSync(executable)) return null
  const result = spawnSync(executable, ['-version'], { encoding: 'utf8' })
  const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
  const match = text.match(/\bversion\s+"(?:1\.)?(\d+)/i)
  return match ? { major: Number(match[1]), text } : null
}

function macJavaHome21() {
  if (process.platform !== 'darwin' || !existsSync('/usr/libexec/java_home')) return null
  const result = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : null
}

function currentJavaDescription() {
  const result = spawnSync('java', ['-version'], { encoding: 'utf8' })
  const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
  return text.split('\n')[0] || 'Java was not found on PATH'
}

export function resolveJava21Home() {
  const candidates = [
    process.env.JAVA_HOME_21_X64,
    process.env.JAVA_HOME,
    macJavaHome21(),
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    path.join(homedir(), 'Applications', 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home'),
    '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home',
    '/usr/lib/jvm/temurin-21-jdk-amd64',
    '/usr/lib/jvm/java-21-openjdk-amd64',
    '/opt/android-studio/jbr',
  ].filter(Boolean)

  const visited = new Set()
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (visited.has(resolved)) continue
    visited.add(resolved)
    const version = readJavaVersion(resolved)
    if (version?.major === 21) return resolved
  }

  throw new Error([
    'Android builds require Java 21.',
    `Current Java: ${currentJavaDescription()}`,
    'Install or enable a Java 21 JDK, then rerun the same npm command.',
    'On macOS you can list installed JDKs with: /usr/libexec/java_home -V',
  ].join('\n'))
}

export function java21Environment(baseEnv = process.env) {
  const javaHome = resolveJava21Home()
  const currentPath = baseEnv.PATH || ''
  return {
    javaHome,
    env: {
      ...baseEnv,
      JAVA_HOME: javaHome,
      PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${currentPath}`,
    },
  }
}
