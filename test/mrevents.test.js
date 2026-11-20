import test from 'node:test'
import assert from 'node:assert/strict'
import { eventsFrom, parseMrUrl, needsEvents, refreshEvents, loadAuthoredMrs, loadMrsByUrl } from '../lib/mrevents.js'
import { createFlowSync, relevantMrs } from '../lib/flowsync.js'
import { recordDeploy } from '../lib/deploycheck.js'
import { newScanState, absorbLine } from '../lib/scan.js'

const URL_A = 'https://gitlab.example.com/web/shop/-/merge_requests/11'
const note = (created_at, body, system = true) => ({ created_at, body, system })

test('approval, ready and review label times come from system notes and label events', () => {
  const events = eventsFrom(
    [
      note('2026-11-03T10:00:00Z', 'approved this merge request'),
      note('2026-11-02T10:00:00Z', 'marked this merge request as **ready**'),
      note('2026-11-03T11:00:00Z', 'unapproved this merge request'),
      note('2026-11-04T09:00:00Z', 'approved this merge request'),
      note('2026-11-02T09:00:00Z', 'approved this merge request', false),
    ],
    [{ action: 'add', created_at: '2026-11-02T12:00:00Z', label: { name: 'Ready for review' } }, { action: 'add', created_at: '2026-11-01T12:00:00Z', label: { name: 'bug' } }],
  )
  assert.deepEqual(events, { approvedAt: Date.parse('2026-11-04T09:00:00Z'), readyAt: Date.parse('2026-11-02T10:00:00Z'), reviewLabelAt: Date.parse('2026-11-02T12:00:00Z'), everDraft: true })
})

test('MR URLs split into host, project and iid', () => {
  assert.deepEqual(parseMrUrl(URL_A), { host: 'gitlab.example.com', project: 'web/shop', iid: '11' })
  assert.equal(parseMrUrl('https://gitlab.example.com/web/shop'), null)
})

test('events are fetched again only when the MR changed, and never after merge', () => {
  assert.equal(needsEvents({ updatedAt: 5 }, null), true)
  assert.equal(needsEvents({ updatedAt: 5 }, { updatedAt: 5, fetchedAt: 6 }), false)
  assert.equal(needsEvents({ updatedAt: 9 }, { updatedAt: 5, fetchedAt: 6 }), true)
  assert.equal(needsEvents({ updatedAt: 9, mergedAt: 4 }, { updatedAt: 5, fetchedAt: 6 }), false)
})

test('refreshing events calls glab for notes and label events and keeps the cache for the rest', async () => {
  const calls = []
  const run = async (args) => {
    calls.push(args.at(-1))
    if (args.at(-1).includes('/notes')) return JSON.stringify([note('2026-11-03T10:00:00Z', 'approved this merge request')])
    return '[]'
  }
  const cache = { other: { approvedAt: 1, updatedAt: 1, fetchedAt: 2 } }
  const next = await refreshEvents({ run, host: 'gitlab.example.com', mrs: [{ url: URL_A, updatedAt: 3 }], cache, now: 10 })
  assert.equal(next[URL_A].approvedAt, Date.parse('2026-11-03T10:00:00Z'))
  assert.equal(next[URL_A].fetchedAt, 10)
  assert.equal(next.other.approvedAt, 1)
  assert.deepEqual(calls, ['projects/web%2Fshop/merge_requests/11/notes?sort=asc&order_by=created_at&per_page=100&page=1', 'projects/web%2Fshop/merge_requests/11/resource_label_events?per_page=100'])
})

const node = (iid, over = {}) => ({ iid: String(iid), title: `T${iid}`, webUrl: `https://gitlab.example.com/web/shop/-/merge_requests/${iid}`, sourceBranch: `ABC-${iid}-x`, createdAt: '2026-11-02T10:00:00Z', mergedAt: null, updatedAt: '2026-11-02T11:00:00Z', state: 'opened', draft: false, author: { username: 'me' }, project: { fullPath: 'web/shop' }, ...over })

test('authored MRs page through GraphQL and report the username', async () => {
  const pages = [
    { data: { currentUser: { username: 'me', authoredMergeRequests: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [node(1)] } } } },
    { data: { currentUser: { username: 'me', authoredMergeRequests: { pageInfo: { hasNextPage: false }, nodes: [node(2, { state: 'merged', mergedAt: '2026-11-03T10:00:00Z' })] } } } },
  ]
  const queries = []
  const result = await loadAuthoredMrs({ run: async (args) => { queries.push(args.at(-1)); return JSON.stringify(pages.shift()) }, host: 'gitlab.example.com', now: Date.parse('2026-11-20T00:00:00Z') })
  assert.equal(result.me, 'me')
  assert.deepEqual(result.mrs.map((mr) => [mr.ref, mr.state, mr.branch]), [['web/shop!1', 'opened', 'ABC-1-x'], ['web/shop!2', 'merged', 'ABC-2-x']])
  assert.match(queries[1], /after: "c1"/)
  assert.match(queries[0], /createdAfter: "2026-05-24/)
})

test('MRs found only through Jira are looked up by URL in one aliased query, other hosts skipped', async () => {
  let query = ''
  const mrs = await loadMrsByUrl({
    run: async (args) => { query = args.at(-1); return JSON.stringify({ data: { m0: { mergeRequest: node(7) } } }) },
    host: 'gitlab.example.com',
    urls: ['https://gitlab.example.com/web/shop/-/merge_requests/7', 'https://elsewhere.example.com/a/-/merge_requests/1'],
  })
  assert.deepEqual(mrs.map((mr) => mr.ref), ['web/shop!7'])
  assert.match(query, /m0: project\(fullPath: "web\/shop"\) \{ mergeRequest\(iid: "7"\)/)
  assert.doesNotMatch(query, /m1:/)
})

test('only MRs tied to a synced ticket get their events fetched', () => {
  const jira = { issues: [{ key: 'ABC-1' }], mrLinks: { 'ABC-1': ['https://x/-/merge_requests/9'] } }
  const mrs = [{ url: 'u1', branch: 'ABC-1-a', title: '' }, { url: 'u2', branch: 'misc', title: 'Bump' }, { url: 'https://x/-/merge_requests/9', branch: '', title: '' }]
  assert.deepEqual(relevantMrs(mrs, jira).map((mr) => mr.url), ['u1', 'https://x/-/merge_requests/9'])
})

test('the flow sync returns a placeholder at first, then the synced data, and refreshes when stale', async () => {
  let clock = 1000
  let writes = 0
  const sync = createFlowSync({
    readConfig: async () => ({ ready: false }),
    readCache: async () => null,
    writeCache: async () => { writes += 1 },
    readEvents: async () => ({}),
    writeEvents: async () => {},
    extraKeys: async () => [],
    run: async () => JSON.stringify({ data: { currentUser: { username: 'me', authoredMergeRequests: { pageInfo: { hasNextPage: false }, nodes: [node(1)] } } } }),
    host: 'gitlab.example.com',
    now: () => clock,
    staleMs: 100,
  })
  const first = await sync.get()
  assert.equal(first.refreshing, true)
  assert.equal(first.mrs.length, 0)
  const synced = await sync.refresh()
  assert.deepEqual([synced.me, synced.mrs.length, synced.jira], ['me', 1, null])
  assert.equal((await sync.get()).refreshing, undefined)
  clock += 500
  assert.equal((await sync.get()).refreshing, true)
  await sync.refresh()
  assert.ok(writes >= 2)
})

test('a live deploy keeps the reported deploy time, and a later live report without one keeps the old', () => {
  const url = 'https://gitlab.example.com/t/r/-/merge_requests/1'
  let store = recordDeploy({}, url, { state: 'live', deployedAt: '2026-11-03T10:00:00Z' }, Date.parse('2026-11-04T00:00:00Z'))
  assert.equal(store[url].deployedAt, Date.parse('2026-11-03T10:00:00Z'))
  store = recordDeploy(store, url, { state: 'live' }, Date.parse('2026-11-05T00:00:00Z'))
  assert.equal(store[url].deployedAt, Date.parse('2026-11-03T10:00:00Z'))
  store = recordDeploy(store, url, { state: 'waiting', deployedAt: '2026-11-03T10:00:00Z' }, Date.parse('2026-11-06T00:00:00Z'))
  assert.equal(store[url].deployedAt, undefined)
  const future = recordDeploy({}, url, { state: 'live', deployedAt: '2099-01-01T00:00:00Z' }, Date.parse('2026-11-04T00:00:00Z'))
  assert.equal(future[url].deployedAt, undefined)
})

test('the scanner records git branches and the first time a ticket key was mentioned', () => {
  const state = newScanState({ ownId: 's1' })
  const line = (timestamp, gitBranch, text) => JSON.stringify({ sessionId: 's1', type: 'user', timestamp, gitBranch, message: { role: 'user', content: text } })
  absorbLine(state, line('2026-11-02T10:00:00Z', 'ABC-7-fix', 'Work on ABC-7 please'))
  absorbLine(state, line('2026-11-02T09:00:00Z', 'ABC-7-fix', 'Earlier ABC-7 note'))
  absorbLine(state, line('2026-11-03T10:00:00Z', 'HEAD', 'ABC-7 again'))
  assert.deepEqual([...state.branches], [['ABC-7-fix', { firstAt: Date.parse('2026-11-02T09:00:00Z'), lastAt: Date.parse('2026-11-02T10:00:00Z') }]])
  assert.equal(state.tickets.get('ABC-7'), 3)
  assert.equal(state.ticketFirstAt.get('ABC-7'), Date.parse('2026-11-02T09:00:00Z'))
})
