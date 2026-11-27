import { gitInfo, fetchRemote, runGit } from './git.js'

export function createRepoPuller({ cwd, info = gitInfo, fetchOrigin = fetchRemote, run = runGit }) {
  let busy = false
  return async function pullRepo() {
    if (busy) return { ok: false, status: 409, error: 'A pull is already running.' }
    busy = true
    try {
      await fetchOrigin(cwd)
      const git = await info(cwd)
      if (!git.available) return { ok: false, status: 400, error: `Not a git repository: ${git.reason}.` }
      if (!git.upstream) return { ok: false, status: 400, error: 'This branch has no upstream to pull from.' }
      if (!git.behind) return { ok: true, pulled: 0 }
      const pulled = await run(cwd, ['pull', '--ff-only', '--quiet'])
      if (!pulled.ok) return { ok: false, status: 409, error: `git pull failed: ${pulled.err}` }
      return { ok: true, pulled: git.behind }
    } finally {
      busy = false
    }
  }
}
