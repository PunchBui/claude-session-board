import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const MARK = '__BOARD_PATH__'
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

export function mergePaths(...lists) {
  const seen = new Set()
  for (const list of lists) {
    for (const dir of String(list ?? '').split(delimiter)) if (dir) seen.add(dir)
  }
  return [...seen].join(delimiter)
}

export function pathFromShellOutput(stdout) {
  const match = new RegExp(`${MARK}([\\s\\S]*?)${MARK}`).exec(String(stdout))
  return match ? match[1].trim() : ''
}

export function loginShellPath({ shell = process.env.SHELL || '/bin/zsh', timeoutMs = 5000, run = execFile } = {}) {
  return new Promise((resolve) => {
    run(shell, ['-ilc', `printf '%s' "${MARK}\${PATH}${MARK}"`], { timeout: timeoutMs, maxBuffer: 1_000_000 }, (error, stdout) => {
      resolve(error ? '' : pathFromShellOutput(stdout))
    })
  })
}

export async function resolveSpawnEnv({ base = process.env, shellPath = loginShellPath, home = homedir() } = {}) {
  const login = await shellPath()
  return { ...base, PATH: mergePaths(login, base.PATH, join(home, '.local/bin'), FALLBACK_DIRS.join(delimiter)) }
}
