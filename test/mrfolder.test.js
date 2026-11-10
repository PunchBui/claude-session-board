import test from 'node:test'
import assert from 'node:assert/strict'
import { repoPath, createRemoteCache, createCanonicalCache, resolveFolders, withFolders, siblingFolders, settleWithin } from '../lib/mrfolder.js'

const PROJECT = 'group/team/app-api'
const mr = (id, over = {}) => ({ url: `https://gitlab.example.com/${PROJECT}/-/merge_requests/${id}`, project: PROJECT, mergedAt: null, ...over })

test('reads the project path out of ssh and https remotes', () => {
  assert.equal(repoPath('git@gitlab.example.com:group/team/app-api.git'), PROJECT)
  assert.equal(repoPath('https://gitlab.example.com/Group/team/app-api.git\n'), PROJECT)
  assert.equal(repoPath('https://user:token@gitlab.example.com/group/team/app-api'), PROJECT)
  assert.equal(repoPath('ssh://git@gitlab.example.com:2222/group/team/app-api.git'), PROJECT)
  assert.equal(repoPath(null), null)
  assert.equal(repoPath('not a remote'), null)
})

test('the remote cache reads each folder once until it expires', async () => {
  let reads = 0
  let clock = 0
  const remoteOf = createRemoteCache({ read: async () => { reads += 1; return `git@h:${PROJECT}.git` }, ttlMs: 1000, now: () => clock })
  assert.equal(await remoteOf('/a'), PROJECT)
  assert.equal(await remoteOf('/a'), PROJECT)
  assert.equal(reads, 1)
  clock = 1001
  await remoteOf('/a')
  assert.equal(reads, 2)
})

const remoteOf = async (cwd) => ({ '/repos/app-api': PROJECT, '/repos/app-api-wt': PROJECT, '/repos/other-repo': 'other/repo' })[cwd] ?? null

test('a session that only mentioned the MR in another repo does not supply the folder', async () => {
  const linked = new Map([[mr(501).url, [{ cwd: '/repos/other-repo', lastActivityAt: 9 }]]])
  const folders = await resolveFolders([mr(501)], { linked, known: ['/repos/other-repo', '/repos/app-api'], remoteOf })
  assert.equal(folders.get(mr(501).url), '/repos/app-api')
})

test('a linked session in the right repo wins over other known folders, most recent first', async () => {
  const linked = new Map([[mr(1).url, [{ cwd: '/repos/app-api', lastActivityAt: 1 }, { cwd: '/repos/app-api-wt', lastActivityAt: 5 }]]])
  const folders = await resolveFolders([mr(1)], { linked, known: ['/repos/app-api'], remoteOf })
  assert.equal(folders.get(mr(1).url), '/repos/app-api-wt')
})

test('no folder is returned when no known folder has the MR project as its remote', async () => {
  const folders = await resolveFolders([mr(2), mr(3, { mergedAt: 1 })], { linked: new Map(), known: ['/repos/other-repo', '/gone'], remoteOf })
  assert.equal(folders.size, 0)
})

test('merged merge requests get a folder too, so their deployment can be checked', async () => {
  const merged = mr(3, { mergedAt: 1 })
  const folders = await resolveFolders([merged], { linked: new Map(), known: ['/repos/app-api'], remoteOf })
  assert.equal(folders.get(merged.url), '/repos/app-api')
})

test('project matching ignores case', async () => {
  const folders = await resolveFolders([mr(4, { project: PROJECT.toUpperCase() })], { linked: new Map(), known: ['/repos/app-api'], remoteOf })
  assert.equal(folders.get(mr(4).url), '/repos/app-api')
})

test('folders are attached to authored and merged merge requests only', () => {
  const data = withFolders({ authored: [mr(1), mr(2)], reviewing: [mr(1)], merged: [mr(8, { mergedAt: 1 })] }, new Map([[mr(1).url, '/repos/app-api'], [mr(8).url, '/repos/app-api']]))
  assert.equal(data.merged[0].folder, '/repos/app-api')
  assert.equal(data.authored[0].folder, '/repos/app-api')
  assert.equal(data.authored[1].folder, undefined)
  assert.equal(data.reviewing[0].folder, undefined)
})

test('sibling folders are listed from the parents of known folders, skipping the home folder', async () => {
  const listed = []
  const list = async (dir) => { listed.push(dir); return dir === '/repos' ? ['app', 'lib'] : ['x'] }
  const found = await siblingFolders(['/repos/app', '/repos/other', '/home/me/notes'], { list, home: '/home/me' })
  assert.deepEqual(found, ['/repos/app', '/repos/lib'])
  assert.deepEqual(listed, ['/repos'])
})

test('a checkout with no session is found next to folders that have one', async () => {
  const siblings = await siblingFolders(['/repos/other-repo'], { list: async () => ['other-repo', 'app-api'], home: '/home/me' })
  const folders = await resolveFolders([mr(9)], { linked: new Map(), known: ['/repos/other-repo', ...siblings], remoteOf })
  assert.equal(folders.get(mr(9).url), '/repos/app-api')
})

const MOVED = 'group/team/sub/reports'
const OLD = 'group/team/reports'
const movedRemote = async (cwd) => ({ '/repos/reports': OLD, '/repos/other': 'a/b/reports' })[cwd] ?? null

test('a checkout whose remote path is the old name of a moved project is matched through GitLab', async () => {
  const asked = []
  const canonical = async (path) => { asked.push(path); return path === OLD ? MOVED : 'somewhere/else' }
  const moved = mr(5, { project: MOVED })
  const folders = await resolveFolders([moved], { linked: new Map(), known: ['/repos/other', '/repos/reports'], remoteOf: movedRemote, canonical })
  assert.equal(folders.get(moved.url), '/repos/reports')
  assert.deepEqual(asked, ['a/b/reports', OLD])
})

test('a same-named repository that GitLab places elsewhere is not matched, and a failing lookup matches nothing', async () => {
  const moved = mr(6, { project: MOVED })
  const elsewhere = await resolveFolders([moved], { linked: new Map(), known: ['/repos/other'], remoteOf: movedRemote, canonical: async () => 'somewhere/else' })
  assert.equal(elsewhere.size, 0)
  const unnamed = await resolveFolders([moved], { linked: new Map(), known: ['/repos/reports'], remoteOf: movedRemote })
  assert.equal(unnamed.size, 0)
})

test('an exact remote match never asks GitLab', async () => {
  const folders = await resolveFolders([mr(7)], { linked: new Map(), known: ['/repos/app-api'], remoteOf, canonical: async () => { throw new Error('should not be called') } })
  assert.equal(folders.get(mr(7).url), '/repos/app-api')
})

test('the canonical cache asks once per path and turns failures into no match', async () => {
  let calls = 0
  const canonical = createCanonicalCache({ read: async (path) => { calls += 1; if (path === 'bad') throw new Error('404'); return 'A/B' } })
  assert.equal(await canonical('x'), 'a/b')
  assert.equal(await canonical('x'), 'a/b')
  assert.equal(await canonical('bad'), null)
  assert.equal(calls, 2)
})

test('settleWithin returns the result when the task finishes in time', async () => {
  assert.equal(await settleWithin(Promise.resolve('done'), 50), 'done')
})

test('settleWithin gives up with null when the task is slower than the limit', async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 200, 'late'))
  assert.equal(await settleWithin(slow, 10), null)
})

test('settleWithin passes a rejection through when the task fails first', async () => {
  await assert.rejects(settleWithin(Promise.reject(new Error('boom')), 50), /boom/)
})
