import test from 'node:test'
import assert from 'node:assert/strict'
import { repoState, createRepoStatusReader } from '../lib/repostatus.js'

const git = (over = {}) => ({ available: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirtyCount: 0, ...over })

test('the state says which side has something the other lacks', () => {
  assert.equal(repoState({ ahead: 0, behind: 0 }), 'synced')
  assert.equal(repoState({ ahead: 0, behind: 2 }), 'behind')
  assert.equal(repoState({ ahead: 3, behind: 0 }), 'ahead')
  assert.equal(repoState({ ahead: 1, behind: 1 }), 'diverged')
})

test('uncommitted files count as a local update', () => {
  assert.equal(repoState({ ahead: 0, behind: 0, dirtyCount: 3 }), 'ahead')
  assert.equal(repoState({ ahead: 0, behind: 2, dirtyCount: 1 }), 'diverged')
  assert.equal(repoState({ ahead: 0, behind: 2, dirtyCount: 0 }), 'behind')
})

test('it fetches origin before reading the branch, so a new remote commit shows up as behind', async () => {
  const calls = []
  const read = createRepoStatusReader({
    cwd: '/repo',
    fetchOrigin: async () => { calls.push('fetch'); return true },
    info: async () => { calls.push('info'); return git({ behind: 1 }) },
  })
  const status = await read()
  assert.deepEqual(calls, ['fetch', 'info'])
  assert.equal(status.state, 'behind')
  assert.equal(status.behind, 1)
  assert.equal(status.fetched, true)
})

test('a failed fetch still reports the local view and says it was not fetched', async () => {
  const read = createRepoStatusReader({ cwd: '/repo', fetchOrigin: async () => false, info: async () => git({ ahead: 2 }) })
  const status = await read()
  assert.equal(status.state, 'ahead')
  assert.equal(status.fetched, false)
})

test('the answer is cached for a minute, can be forced, and concurrent reads share one fetch', async () => {
  let fetches = 0
  let clock = 1000
  const read = createRepoStatusReader({
    cwd: '/repo',
    now: () => clock,
    fetchOrigin: async () => { fetches++; return true },
    info: async () => git(),
  })
  await Promise.all([read(), read()])
  assert.equal(fetches, 1)
  clock += 30_000
  await read()
  assert.equal(fetches, 1)
  await read({ force: true })
  assert.equal(fetches, 2)
  clock += 61_000
  await read()
  assert.equal(fetches, 3)
})

test('a folder that is not a repository, or has no upstream, is reported as unavailable', async () => {
  const none = createRepoStatusReader({ cwd: '/x', fetchOrigin: async () => false, info: async () => ({ available: false, reason: 'not a git repository' }) })
  assert.deepEqual(await none(), { available: false, reason: 'not a git repository' })
  const local = createRepoStatusReader({ cwd: '/x', fetchOrigin: async () => false, info: async () => git({ upstream: null }) })
  assert.equal((await local()).available, false)
})
