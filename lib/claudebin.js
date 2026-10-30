import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

const isExecutable = (path) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function claudeSearchDirs({ pathEnv = '', home = '' } = {}) {
  const extra = [join(home, '.local/bin'), join(home, '.claude/local'), join(home, '.npm-global/bin'), join(home, '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  return [...new Set([...pathEnv.split(delimiter).filter(Boolean), ...extra])]
}

export function resolveClaudeBin({ configured, pathEnv = process.env.PATH ?? '', home = '', exists = isExecutable } = {}) {
  if (configured) return configured
  for (const dir of claudeSearchDirs({ pathEnv, home })) {
    const candidate = join(dir, 'claude')
    if (exists(candidate)) return candidate
  }
  return 'claude'
}
