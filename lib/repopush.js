import { basename } from 'node:path'
import { gitInfo, fetchRemote, runGit } from './git.js'

const NAMED_FILES = 3

export function commitMessage(files) {
  const names = [...new Set(files.map((file) => basename(file.path.split(' -> ').pop().replace(/^"|"$/g, ''))))]
  if (!names.length) return 'Update'
  if (names.length <= NAMED_FILES) return `Update ${names.join(', ')}`
  return `Update ${names.slice(0, 2).join(', ')} and ${names.length - 2} more files`
}

export function createRepoPusher({ cwd, info = gitInfo, fetchOrigin = fetchRemote, run = runGit }) {
  let busy = false
  // pull: true also brings origin's new commits in first (fast-forward when nothing
  // local is ahead, otherwise a rebase that is aborted on conflict), then pushes.
  return async function commitAndPush({ pull = false } = {}) {
    if (busy) return { ok: false, status: 409, error: 'A commit and push is already running.' }
    busy = true
    try {
      await fetchOrigin(cwd)
      const git = await info(cwd)
      if (!git.available) return { ok: false, status: 400, error: `Not a git repository: ${git.reason}.` }
      if (!git.upstream) return { ok: false, status: 400, error: 'This branch has no upstream to push to.' }
      if (git.behind && !pull) return { ok: false, status: 409, error: `Origin has ${git.behind} new commit${git.behind === 1 ? '' : 's'}. Pull first.` }
      let committed = null
      if (git.dirtyCount) {
        const added = await run(cwd, ['add', '-A'])
        if (!added.ok) return { ok: false, status: 500, error: `git add failed: ${added.err}` }
        committed = commitMessage(git.files)
        const made = await run(cwd, ['commit', '-m', committed])
        if (!made.ok) return { ok: false, status: 500, error: `git commit failed: ${made.err}` }
      }
      let pulled = 0
      if (git.behind) {
        const rebase = git.ahead > 0 || committed !== null
        const got = await run(cwd, rebase ? ['pull', '--rebase', '--quiet'] : ['pull', '--ff-only', '--quiet'])
        if (!got.ok) {
          if (rebase) await run(cwd, ['rebase', '--abort'])
          return { ok: false, status: 409, committed, error: `git pull failed${rebase ? ' (rebase aborted, nothing was lost)' : ''}: ${got.err}` }
        }
        pulled = git.behind
      }
      if (git.ahead > 0 || committed !== null) {
        const pushed = await run(cwd, ['push'])
        if (!pushed.ok) return { ok: false, status: 500, committed, pulled, error: `git push failed: ${pushed.err}` }
        return { ok: true, committed, pulled, pushed: true }
      }
      return { ok: true, committed, pulled, pushed: false }
    } finally {
      busy = false
    }
  }
}
