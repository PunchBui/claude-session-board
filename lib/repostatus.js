import { gitInfo, fetchRemote } from './git.js'

const TTL = 60_000

export function repoState({ ahead = 0, behind = 0, dirtyCount = 0 }) {
  const local = ahead > 0 || dirtyCount > 0
  if (local && behind) return 'diverged'
  if (behind) return 'behind'
  if (local) return 'ahead'
  return 'synced'
}

export function createRepoStatusReader({ cwd, info = gitInfo, fetchOrigin = fetchRemote, now = Date.now } = {}) {
  let cache = null
  let at = 0
  let pending = null
  async function load() {
    const fetched = await fetchOrigin(cwd)
    const git = await info(cwd)
    if (!git.available) return { available: false, reason: git.reason }
    if (!git.upstream) return { available: false, reason: 'no upstream branch' }
    return {
      available: true,
      fetched,
      branch: git.branch,
      upstream: git.upstream,
      ahead: git.ahead,
      behind: git.behind,
      dirtyCount: git.dirtyCount,
      state: repoState(git),
    }
  }
  return function readRepoStatus({ force = false } = {}) {
    if (!force && cache && now() - at < TTL) return Promise.resolve(cache)
    pending ??= load().then((result) => {
      cache = result
      at = now()
      return result
    }).finally(() => { pending = null })
    return pending
  }
}
