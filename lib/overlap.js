import { dirname } from 'node:path'

export const OVERLAP_WINDOW_MS = 24 * 60 * 60_000
const IGNORED = /(^|\/)(node_modules|\.git)\//

const insideCwd = (path, cwd) => Boolean(cwd) && path.startsWith(`${cwd.replace(/\/$/, '')}/`)

export function overlapsOf(entries, { nowMs = Date.now(), windowMs = OVERLAP_WINDOW_MS } = {}) {
  const byPath = new Map()
  for (const entry of entries) {
    for (const [path, info] of entry.files ?? []) {
      if (IGNORED.test(path) || !insideCwd(path, entry.cwd)) continue
      const at = Date.parse(info.lastAt)
      if (!Number.isFinite(at) || nowMs - at > windowMs) continue
      const sessions = byPath.get(path) ?? new Map()
      sessions.set(entry.id, { id: entry.id, title: entry.title, cwd: entry.cwd, lastAt: at })
      byPath.set(path, sessions)
    }
  }
  return [...byPath]
    .filter(([, sessions]) => sessions.size > 1)
    .map(([path, sessions]) => ({ path, dir: dirname(path), sessions: [...sessions.values()].sort((a, b) => b.lastAt - a.lastAt) }))
    .sort((a, b) => b.sessions[0].lastAt - a.sessions[0].lastAt)
}

export function modifiedPaths(porcelain, root) {
  const paths = new Set()
  for (const line of String(porcelain ?? '').split('\n')) {
    if (line.length < 4) continue
    const name = line.slice(3).split(' -> ').at(-1).replace(/^"|"$/g, '')
    paths.add(`${root.replace(/\/$/, '')}/${name}`)
  }
  return paths
}
