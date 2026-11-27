import { readdir, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const RUN_LOG_TTL_MS = 30 * 86_400_000
export const RUN_LOG_FILE = /\.(?:log|out\.jsonl)$/

export async function pruneOldFiles(dir, { now = Date.now(), maxAgeMs = RUN_LOG_TTL_MS, match = RUN_LOG_FILE } = {}) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const removed = []
  for (const entry of entries) {
    if (!entry.isFile() || !match.test(entry.name)) continue
    const path = join(dir, entry.name)
    const info = await stat(path).catch(() => null)
    if (info && now - info.mtimeMs > maxAgeMs) {
      await rm(path, { force: true })
      removed.push(entry.name)
    }
  }
  return removed
}
