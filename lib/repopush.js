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
  return async function commitAndPush() {
    if (busy) return { ok: false, status: 409, error: 'A commit and push is already running.' }
    busy = true
    try {
      await fetchOrigin(cwd)
      const git = await info(cwd)
      if (!git.available) return { ok: false, status: 400, error: `Not a git repository: ${git.reason}.` }
      if (!git.upstream) return { ok: false, status: 400, error: 'This branch has no upstream to push to.' }
      if (git.behind) return { ok: false, status: 409, error: `Origin has ${git.behind} new commit${git.behind === 1 ? '' : 's'}. Pull first.` }
      let committed = null
      if (git.dirtyCount) {
        const added = await run(cwd, ['add', '-A'])
        if (!added.ok) return { ok: false, status: 500, error: `git add failed: ${added.err}` }
        committed = commitMessage(git.files)
        const made = await run(cwd, ['commit', '-m', committed])
        if (!made.ok) return { ok: false, status: 500, error: `git commit failed: ${made.err}` }
      }
      const pushed = await run(cwd, ['push'])
      if (!pushed.ok) return { ok: false, status: 500, committed, error: `git push failed: ${pushed.err}` }
      return { ok: true, committed }
    } finally {
      busy = false
    }
  }
}
