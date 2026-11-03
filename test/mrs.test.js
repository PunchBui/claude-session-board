import test from 'node:test'
import assert from 'node:assert/strict'
import { GITLAB_HOST, MAX_FOCUSED, isMrUrl, toggleFocus, withFocus, resolveGlabBin, normalizeMr, verdictOf, loadMergeRequests, withSessions, createMrCache } from '../lib/mrs.js'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const ago = (ms) => new Date(NOW - ms).toISOString()

const node = (over = {}) => ({
  iid: '1',
  reference: '!1',
  title: 'Add thing',
  webUrl: `https://${GITLAB_HOST}/team/repo/-/merge_requests/1`,
  draft: false,
  createdAt: ago(5 * DAY),
  updatedAt: ago(HOUR),
  sourceBranch: 'feat',
  targetBranch: 'main',
  conflicts: false,
  detailedMergeStatus: 'NOT_APPROVED',
  approved: false,
  userNotesCount: 0,
  author: { username: 'dkunweeroj', name: 'D K' },
  reviewers: { nodes: [{ username: 'sam', name: 'Sam' }] },
  approvedBy: { nodes: [] },
  headPipeline: { status: 'SUCCESS' },
  project: { fullPath: 'team/repo' },
  ...over,
})

const payload = ({ authored = [], reviewing = [] } = {}) =>
  JSON.stringify({ data: { currentUser: { username: 'dkunweeroj', authoredMergeRequests: { nodes: authored }, reviewRequestedMergeRequests: { nodes: reviewing } } } })

const verdict = (over, role = 'authored') => verdictOf(normalizeMr(node(over), 'dkunweeroj'), role, NOW).code

test('queries only the configured GitLab host', async () => {
  let args
  await loadMergeRequests({ run: async (a) => { args = a; return payload() }, now: NOW })
  assert.deepEqual(args.slice(0, 4), ['api', '--hostname', 'gitlab.example.com', 'graphql'])
  assert.ok(!args.join(' ').includes('gitlab.com'))
})

test('drops merge requests that are not on the configured host', async () => {
  const foreign = node({ webUrl: 'https://gitlab.com/someone/repo/-/merge_requests/9' })
  const data = await loadMergeRequests({ run: async () => payload({ authored: [node(), foreign], reviewing: [foreign] }), now: NOW })
  assert.equal(data.authored.length, 1)
  assert.equal(data.reviewing.length, 0)
})

test('normalizes pipeline status, reviewers and project reference', () => {
  const mr = normalizeMr(node({ headPipeline: { status: 'RUNNING' }, approvedBy: { nodes: [{ username: 'dkunweeroj' }] } }), 'dkunweeroj')
  assert.equal(mr.pipeline, 'running')
  assert.deepEqual(mr.reviewers, ['sam'])
  assert.equal(mr.ref, 'team/repo!1')
  assert.equal(mr.approvedByMe, true)
  assert.equal(normalizeMr(node({ headPipeline: null }), 'x').pipeline, null)
})

test('authored verdicts follow the most urgent blocker first', () => {
  assert.equal(verdict({ headPipeline: { status: 'FAILED' }, conflicts: true }), 'ci-failed')
  assert.equal(verdict({ conflicts: true, detailedMergeStatus: 'DISCUSSIONS_NOT_RESOLVED' }), 'conflicts')
  assert.equal(verdict({ detailedMergeStatus: 'DISCUSSIONS_NOT_RESOLVED' }), 'threads')
  assert.equal(verdict({ approved: true }), 'ready')
  assert.equal(verdict({ draft: true }), 'draft')
  assert.equal(verdict({ headPipeline: { status: 'RUNNING' } }), 'ci-running')
  assert.equal(verdict({ reviewers: { nodes: [] } }), 'no-reviewer')
  assert.equal(verdict({ updatedAt: ago(4 * DAY) }), 'stale')
  assert.equal(verdict({}), 'waiting')
})

test('an approved merge request with CI still running is not ready yet', () => {
  assert.equal(verdict({ approved: true, headPipeline: { status: 'RUNNING' } }), 'ci-running')
})

test('review verdicts distinguish approved, draft and awaiting review', () => {
  assert.equal(verdict({ approvedBy: { nodes: [{ username: 'dkunweeroj' }] } }, 'reviewing'), 'approved')
  assert.equal(verdict({ draft: true }, 'reviewing'), 'draft')
  assert.equal(verdict({}, 'reviewing'), 'needs-review')
})

test('sorts newest update first and counts actionable ones', async () => {
  const data = await loadMergeRequests({
    run: async () => payload({
      authored: [
        node({ webUrl: `https://${GITLAB_HOST}/t/r/-/merge_requests/1`, updatedAt: ago(HOUR) }),
        node({ webUrl: `https://${GITLAB_HOST}/t/r/-/merge_requests/2`, headPipeline: { status: 'FAILED' }, updatedAt: ago(2 * HOUR) }),
        node({ webUrl: `https://${GITLAB_HOST}/t/r/-/merge_requests/3`, headPipeline: { status: 'FAILED' }, updatedAt: ago(DAY) }),
      ],
      reviewing: [node({ webUrl: `https://${GITLAB_HOST}/t/r/-/merge_requests/4` })],
    }),
    now: NOW,
  })
  assert.deepEqual(data.authored.map((mr) => mr.url.split('/').pop()), ['1', '2', '3'])
  assert.equal(data.actionable, 3)
})

test('attaches the sessions that mentioned each merge request', async () => {
  const data = await loadMergeRequests({ run: async () => payload({ authored: [node()] }), now: NOW })
  const url = data.authored[0].url
  const linked = new Map([[url, [{ sessionId: 's1', title: 'Fix it' }]]])
  assert.deepEqual(withSessions(data, linked).authored[0].sessions, [{ sessionId: 's1', title: 'Fix it' }])
  assert.deepEqual(withSessions(data, new Map()).authored[0].sessions, [])
})

test('reports an error when glab is not signed in', async () => {
  await assert.rejects(loadMergeRequests({ run: async () => JSON.stringify({ data: { currentUser: null } }), now: NOW }), /not signed in to gitlab.example.com/)
})

test('cache serves within the ttl, refetches when forced, and shares one in-flight load', async () => {
  let clock = 0
  let calls = 0
  const load = async () => ({ host: GITLAB_HOST, authored: [], reviewing: [], actionable: 0, n: ++calls })
  const get = createMrCache({ load, ttlMs: 60_000, now: () => clock })
  const [a, b] = await Promise.all([get(), get()])
  assert.equal(a.n, 1)
  assert.equal(b.n, 1)
  clock = 30_000
  assert.equal((await get()).n, 1)
  assert.equal((await get({ force: true })).n, 2)
  clock = 200_000
  assert.equal((await get()).n, 3)
})

test('cache keeps the last good data and flags the error when a refresh fails', async () => {
  let fail = false
  const load = async () => {
    if (fail) throw new Error('boom')
    return { host: GITLAB_HOST, authored: [{ url: 'x' }], reviewing: [], actionable: 0 }
  }
  const get = createMrCache({ load, ttlMs: 0, now: () => 0 })
  await get()
  fail = true
  const stale = await get()
  assert.equal(stale.error, 'boom')
  assert.equal(stale.authored.length, 1)
})

test('cache with no prior data returns an empty result carrying the error', async () => {
  const get = createMrCache({ load: async () => { throw new Error('not signed in') }, now: () => 0 })
  const out = await get()
  assert.equal(out.error, 'not signed in')
  assert.deepEqual(out.authored, [])
})

test('finds glab in Homebrew even when launchd gives a bare PATH', () => {
  const exists = (path) => path === '/opt/homebrew/bin/glab'
  assert.equal(resolveGlabBin({ pathEnv: '/usr/bin:/bin', home: '/Users/x', exists }), '/opt/homebrew/bin/glab')
  assert.equal(resolveGlabBin({ pathEnv: '/usr/bin', home: '/Users/x', exists: () => false }), 'glab')
})

test('accepts only configured merge request URLs for focus', () => {
  assert.equal(isMrUrl(`https://${GITLAB_HOST}/team/sub/repo/-/merge_requests/12`), true)
  assert.equal(isMrUrl('https://gitlab.com/team/repo/-/merge_requests/12'), false)
  assert.equal(isMrUrl(`https://${GITLAB_HOST}/team/repo/-/issues/12`), false)
  assert.equal(isMrUrl(`https://${GITLAB_HOST}/team/repo/-/merge_requests/12?x=1`), false)
  assert.equal(isMrUrl(`https://gitlabXexampleYio/team/repo/-/merge_requests/12`), false)
  assert.equal(isMrUrl(null), false)
})

test('toggleFocus adds once, removes, and caps the stored list', () => {
  assert.deepEqual(toggleFocus(['a'], 'b', true), ['a', 'b'])
  assert.deepEqual(toggleFocus(['a', 'b'], 'a', true), ['b', 'a'])
  assert.deepEqual(toggleFocus(['a', 'b'], 'a', false), ['b'])
  const many = Array.from({ length: MAX_FOCUSED }, (_, i) => `u${i}`)
  const next = toggleFocus(many, 'new', true)
  assert.equal(next.length, MAX_FOCUSED)
  assert.equal(next.at(-1), 'new')
  assert.equal(next[0], 'u1')
})

test('withFocus marks merge requests whose URL is focused', async () => {
  const data = await loadMergeRequests({ run: async () => payload({ authored: [node()], reviewing: [node({ webUrl: `https://${GITLAB_HOST}/t/r/-/merge_requests/2` })] }), now: NOW })
  const marked = withFocus(data, [data.reviewing[0].url])
  assert.equal(marked.authored[0].focused, false)
  assert.equal(marked.reviewing[0].focused, true)
})
