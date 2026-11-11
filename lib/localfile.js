import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MAX_PATH_LENGTH = 1024

export const MAX_IMAGE_BYTES = 25_000_000

export const imageType = (path) => IMAGE_TYPES[extname(path).toLowerCase()] ?? null

export function expandHome(path, home = homedir()) {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

export async function resolveLocal(value, { home = homedir() } = {}) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH || value.includes('\0')) return null
  const expanded = expandHome(value, home)
  if (!isAbsolute(expanded)) return null
  const real = await realpath(expanded).catch(() => null)
  if (!real) return null
  const info = await stat(real).catch(() => null)
  if (!info) return null
  return { path: real, directory: info.isDirectory(), size: info.size }
}
