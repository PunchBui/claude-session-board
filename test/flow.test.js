import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LINKS, buildFlow, sessionGraph, ticketKeys, reviewPattern, parseMilestoneInput, recordMilestone, recordLink, DEFAULT_REVIEW_STATUS } from '../lib/flow.js'

const H = 3_600_000
const T0 = Date.UTC(2026, 10, 2, 3)
const at = (hours) => T0 + hours * H
const MR_A = 'https://gitlab.example.com/web/shop/-/merge_requests/11'
const MR_B = 'https://gitlab.example.com/api/pay/-/merge_requests/12'
const MR_C = 'https://gitlab.example.com/web/shop/-/merge_requests/13'

const issue = (key, over = {}) => ({
  key,
  url: `https://example.atlassian.net/browse/${key}`,
  title: `Title ${key}`,
  type: 'Story',
  isEpic: false,
  status: 'In Progress',
  category: 'indeterminate',
  createdAt: at(0),
  updatedAt: at(100),
  resolvedAt: null,
  epic: { key: 'ABC-1', title: 'Epic', status: 'Created', category: 'new' },
  sprints: [],
  statusChanges: [],
  sprintChanges: [],
  hasRemoteLinks: false,
  ...over,
})
const mr = (url, over = {}) => ({ url, ref: `${url.split('gitlab.example.com/')[1].split('/-/')[0]}!${url.split('/').pop()}`, project: 'p', title: 'Change', branch: 'main', state: 'merged', draft: false, author: 'me', createdAt: at(10), mergedAt: at(30), updatedAt: at(30), ...over })
const session = (id, over = {}) => ({ id, title: `Session ${id}`, project: 'shop', status: 'idle', archived: false, createdAt: at(5), lastActivityAt: at(40), branches: [], tickets: [], mrUrls: [], ...over })

test('ticket keys are found once each and common acronyms are ignored', () => {
  assert.deepEqual(ticketKeys('ABC-12 fix, see ABC-12 and UTF-8 and XY-3'), ['ABC-12', 'XY-3'])
})

test('lowercase ticket keys in branch names are found', () => {
  const flow = buildFlow({
    jira: { issues: [issue('ABC-12')], mrLinks: {} },
    mrs: [mr(MR_A, { branch: 'claude/abc-12-mirror-log' })],
    sessions: [session('s1', { branches: [{ name: 'feature/abc-12-x', firstAt: at(1) }] })],
  })
  assert.deepEqual(flow.tickets[0].mrs, [MR_A])
  assert.deepEqual(flow.sessions[0].tickets, [{ key: 'ABC-12', why: 'On branch feature/abc-12-x' }])
})

test('a bad review pattern falls back to the default', () => {
  assert.equal(reviewPattern('('), DEFAULT_REVIEW_STATUS)
  assert.equal(reviewPattern('code review').test('Code Review'), true)
})

test('a full ticket gets every step from Jira, GitLab and the deploy check', () => {
  const ticket = issue('ABC-7', {
    status: 'Done',
    category: 'done',
    sprintChanges: [{ at: at(1), from: '', to: 'Sprint 4' }],
    sprints: [{ name: 'Sprint 4', state: 'closed', startAt: at(3) }],
    statusChanges: [
      { at: at(4), from: 'Created', to: 'In Progress', category: 'indeterminate' },
      { at: at(12), from: 'In Progress', to: 'Review / Merge', category: 'indeterminate' },
      { at: at(50), from: 'Review / Merge', to: 'Done', category: 'done' },
    ],
  })
  const flow = buildFlow({
    jira: { issues: [ticket], mrLinks: { 'ABC-7': [MR_A] } },
    mrs: [mr(MR_A)],
    events: { [MR_A]: { approvedAt: at(20), readyAt: null, reviewLabelAt: at(11), everDraft: false } },
    deploys: { [MR_A]: { state: 'live', note: 'prod', at: at(45), deployedAt: at(33) } },
  })
  const steps = flow.tickets[0].steps
  assert.equal(steps.created.at, at(0))
  assert.equal(steps.sprint.at, at(3), 'sprint start wins when the ticket was added before the sprint started')
  assert.equal(steps.progress.at, at(4))
  assert.equal(steps.mr.at, at(10))
  assert.equal(steps.review.at, at(12))
  assert.equal(steps.review.source, 'jira', 'a Jira review status wins over the GitLab label')
  assert.equal(steps.approved.at, at(20))
  assert.equal(steps.merged.at, at(30))
  assert.deepEqual([steps.deployed.at, steps.deployed.inferred], [at(33), false])
  assert.equal(steps.experiment.na, true)
  assert.equal(steps.done.at, at(50))
  assert.deepEqual(flow.mrs[0].tickets, [{ key: 'ABC-7', why: ['Jira link'] }])
  assert.deepEqual(flow.epics.map((epic) => epic.key), ['ABC-1'])
})

test('missing Jira statuses are filled from the first session and the review label, marked inferred', () => {
  const ticket = issue('ABC-8', { statusChanges: [{ at: at(30), from: 'Created', to: 'Done', category: 'done' }], status: 'Done', category: 'done' })
  const flow = buildFlow({
    jira: { issues: [ticket], mrLinks: {} },
    mrs: [mr(MR_A, { branch: 'ABC-8-thing' })],
    events: { [MR_A]: { approvedAt: at(20), readyAt: null, reviewLabelAt: at(15), everDraft: true } },
    sessions: [session('s1', { branches: [{ name: 'ABC-8-thing', firstAt: at(6) }] })],
  })
  const steps = flow.tickets[0].steps
  assert.deepEqual([steps.progress.at, steps.progress.inferred, steps.progress.source], [at(6), true, 'board'])
  assert.deepEqual([steps.review.at, steps.review.inferred], [at(15), true])
  assert.match(steps.review.note, /Ready for review/)
  assert.deepEqual(flow.sessions[0].tickets, [{ key: 'ABC-8', why: 'On branch ABC-8-thing' }])
})

test('an MR opened ready for review counts its creation as the review step', () => {
  const flow = buildFlow({ jira: { issues: [issue('ABC-8')], mrLinks: { 'ABC-8': [MR_A] } }, mrs: [mr(MR_A, { mergedAt: null, state: 'opened' })], events: { [MR_A]: { approvedAt: null, readyAt: null, reviewLabelAt: null, everDraft: false } } })
  assert.equal(flow.tickets[0].steps.review.at, at(10))
})

test('with several MRs, created is the first and approved, merged and deployed wait for the last', () => {
  const flow = buildFlow({
    jira: { issues: [issue('ABC-9')], mrLinks: { 'ABC-9': [MR_A, MR_B] } },
    mrs: [mr(MR_A, { createdAt: at(10), mergedAt: at(30) }), mr(MR_B, { createdAt: at(14), mergedAt: null, state: 'opened' })],
    events: { [MR_A]: { approvedAt: at(20) }, [MR_B]: { approvedAt: at(25) } },
    deploys: { [MR_A]: { state: 'live', at: at(40) } },
  })
  const steps = flow.tickets[0].steps
  assert.equal(steps.mr.at, at(10))
  assert.equal(steps.approved.at, at(25))
  assert.equal(steps.merged, null)
  assert.equal(steps.deployed, null)
})

test('a deploy without deployedAt uses the check time and says so; a waiting deploy is reported', () => {
  const live = buildFlow({ jira: { issues: [issue('ABC-9')], mrLinks: { 'ABC-9': [MR_A] } }, mrs: [mr(MR_A)], deploys: { [MR_A]: { state: 'live', at: at(40) } } })
  assert.deepEqual([live.tickets[0].steps.deployed.at, live.tickets[0].steps.deployed.inferred], [at(40), true])
  const waiting = buildFlow({ jira: { issues: [issue('ABC-9')], mrLinks: { 'ABC-9': [MR_A] } }, mrs: [mr(MR_A)], deploys: { [MR_A]: { state: 'waiting', note: 'manual job', at: at(40) } } })
  assert.equal(waiting.tickets[0].steps.deployed, null)
  assert.deepEqual(waiting.tickets[0].deployState, { state: 'waiting', note: 'manual job' })
})

test('a closed MR is ignored for the steps, and a done ticket with no MR marks the MR steps n/a', () => {
  const flow = buildFlow({ jira: { issues: [issue('ABC-9', { status: 'Done', category: 'done', statusChanges: [{ at: at(9), to: 'Done', category: 'done' }] })], mrLinks: { 'ABC-9': [MR_A] } }, mrs: [mr(MR_A, { state: 'closed', mergedAt: null })] })
  const steps = flow.tickets[0].steps
  assert.equal(steps.mr.na, true)
  assert.equal(steps.merged.na, true)
})

test('an MR title links only when the branch and Jira say nothing, and only to the first key', () => {
  const flow = buildFlow({
    jira: { issues: [issue('ABC-7'), issue('ABC-497')], mrLinks: {} },
    mrs: [mr(MR_A, { title: 'ABC-7 Remove ABC-497 import', branch: 'cleanup' }), mr(MR_C, { title: 'ABC-497 later', branch: 'ABC-7-other' })],
  })
  const byUrl = Object.fromEntries(flow.mrs.map((row) => [row.url, row.tickets.map((item) => item.key)]))
  assert.deepEqual(byUrl[MR_A], ['ABC-7'])
  assert.deepEqual(byUrl[MR_C], ['ABC-7'])
})

test('sessions link by branch, then by the MRs they touched, then by their top mentions', () => {
  const flow = buildFlow({
    jira: { issues: [issue('ABC-7'), issue('ABC-8'), issue('ABC-9')], mrLinks: { 'ABC-8': [MR_A] } },
    mrs: [mr(MR_A)],
    sessions: [
      session('s1', { mrUrls: [MR_A] }),
      session('s2', { tickets: [{ key: 'ABC-9', count: 5, firstAt: at(2) }, { key: 'ABC-7', count: 1, firstAt: at(2) }] }),
      session('s3', { tickets: [{ key: 'ZZZ-1', count: 9, firstAt: at(2) }], lastActivityAt: Date.now() }),
    ],
  })
  const rows = Object.fromEntries(flow.sessions.map((row) => [row.id, row]))
  assert.deepEqual(rows.s1.tickets, [{ key: 'ABC-8', why: 'Worked on !11' }])
  assert.deepEqual(rows.s1.mrs, [MR_A])
  assert.deepEqual(rows.s2.tickets, [{ key: 'ABC-9', why: 'Mentions ABC-9 5 times' }])
  assert.equal(rows.s3, undefined)
  assert.deepEqual(flow.loose.sessions.map((item) => item.id), ['s3'])
})

test('manual links and milestones override what was found', () => {
  const flow = buildFlow({
    jira: { issues: [issue('ABC-7')], mrLinks: {} },
    mrs: [mr(MR_C, { title: 'no key' })],
    sessions: [session('s9')],
    links: { mr: { [MR_C]: 'ABC-7' }, session: { s9: 'ABC-7' } },
    milestones: { 'ABC-7': { experiment: { at: at(60), source: 'skill', note: 'run 5' }, sprint: { na: true } } },
  })
  const steps = flow.tickets[0].steps
  assert.deepEqual([steps.experiment.at, steps.experiment.source], [at(60), 'skill'])
  assert.equal(steps.sprint.na, true)
  assert.deepEqual(flow.tickets[0].mrs, [MR_C])
  assert.deepEqual(flow.tickets[0].sessions, ['s9'])
  assert.equal(flow.loose.mrs.length, 0)
})

test('a ticket is mine when its assignee is me, falling back to whether the search found it', () => {
  const flow = buildFlow({ jira: { me: { id: 'me' }, issues: [issue('ABC-1', { assignee: { id: 'me', name: 'Me' } }), issue('ABC-2', { assignee: { id: 'ann', name: 'Ann' } }), issue('ABC-3', { assignee: null })], mrLinks: {} } })
  assert.deepEqual(flow.tickets.map((row) => [row.key, row.mine, row.assignee]), [['ABC-1', true, 'Me'], ['ABC-2', false, 'Ann'], ['ABC-3', false, null]])
  const old = buildFlow({ jira: { issues: [issue('ABC-4', { fromSearch: true }), issue('ABC-5', { fromSearch: false })], mrLinks: {} } })
  assert.deepEqual(old.tickets.map((row) => row.mine), [true, false])
})

test('epics in the search results become epics, not tickets', () => {
  const flow = buildFlow({ jira: { issues: [issue('ABC-1', { isEpic: true, epic: null, type: 'Epic' }), issue('ABC-7')], mrLinks: {} } })
  assert.deepEqual(flow.tickets.map((row) => row.key), ['ABC-7'])
  assert.equal(flow.epics[0].key, 'ABC-1')
})

test('a ticket added to two sprints counts as carried over once', () => {
  const flow = buildFlow({ jira: { issues: [issue('ABC-7', { sprintChanges: [{ at: at(1), from: '', to: 'S4' }, { at: at(90), from: 'S4', to: 'S4, S5' }] })], mrLinks: {} } })
  assert.equal(flow.tickets[0].carried, 1)
})

test('milestone input is checked and recorded per ticket and step', () => {
  assert.match(parseMilestoneInput({ ticket: 'nope', step: 'experiment', at: 1 }).error, /Jira key/)
  assert.match(parseMilestoneInput({ ticket: 'ABC-1', step: 'created', at: 1 }).error, /step/)
  assert.match(parseMilestoneInput({ ticket: 'ABC-1', step: 'experiment', at: 'soon' }).error, /time/)
  const parsed = parseMilestoneInput({ ticket: 'abc-1', step: 'experiment', at: '2026-11-04T03:00:00Z', note: 'run 1', source: 'skill' })
  assert.deepEqual(parsed, { key: 'ABC-1', step: 'experiment', value: { at: Date.parse('2026-11-04T03:00:00Z'), note: 'run 1', source: 'skill' } })
  let store = recordMilestone({}, parsed, 7)
  assert.equal(store['ABC-1'].experiment.recordedAt, 7)
  store = recordMilestone(store, parseMilestoneInput({ ticket: 'ABC-1', step: 'experiment', clear: true }), 8)
  assert.deepEqual(store, {})
})

test('links are set and cleared', () => {
  let store = recordLink({}, { kind: 'mr', id: MR_A, ticket: 'ABC-7' })
  assert.deepEqual(store, { mr: { [MR_A]: 'ABC-7' }, session: {} })
  store = recordLink(store, { kind: 'mr', id: MR_A, ticket: null })
  assert.deepEqual(store.mr, {})
})

test('sessions link to sessions they were spawned or forked from, picked up a handoff from, or messaged', () => {
  const edges = sessionGraph([
    session('a', { createdAt: at(1), handoffWrites: ['/tmp/handoff-a.md'] }),
    session('b', { parent: { id: 'a', kind: 'fork' }, handoffReads: ['/tmp/handoff-a.md'] }),
    session('c', { handoffReads: ['/tmp/handoff-a.md'], peers: ['a', 'gone'] }),
    session('d', { parent: { id: 'missing', kind: 'task' } }),
  ])
  assert.deepEqual(edges, [{ from: 'a', to: 'b', kind: 'fork' }, { from: 'a', to: 'c', kind: 'handoff' }])
})

test('a session with no ticket joins the flow through the session it came from, with the MRs it worked on', () => {
  const flow = buildFlow({
    jira: { issues: [issue('ABC-12')], mrLinks: {} },
    mrs: [mr(MR_A, { branch: 'abc-12-fix' }), mr(MR_B, { state: 'opened', mergedAt: null }), mr(MR_C, { state: 'closed', mergedAt: null })],
    sessions: [
      session('s1', { branches: [{ name: 'abc-12-fix', firstAt: at(2) }] }),
      session('s2', { parent: { id: 's1', kind: 'task' }, mrUrls: [MR_B, MR_C] }),
      session('s3', { parent: { id: 's2', kind: 'fork' } }),
      session('lone', { lastActivityAt: Date.now() }),
    ],
  })
  assert.deepEqual(flow.sessions.map((row) => row.id), ['s1', 's2', 's3'])
  assert.deepEqual(flow.sessions[1].tickets, [])
  assert.deepEqual(flow.sessions[1].mrs, [MR_B])
  assert.ok(flow.mrs.some((row) => row.url === MR_B))
  assert.ok(!flow.loose.mrs.some((row) => row.url === MR_B))
  assert.deepEqual(flow.sessionLinks, [{ from: 's1', to: 's2', kind: 'task' }, { from: 's2', to: 's3', kind: 'fork' }])
  assert.deepEqual(flow.loose.sessions.map((row) => row.id), ['lone'])
})

test('the link store keeps the newest entries per kind', () => {
  let store = {}
  for (let n = 0; n < MAX_LINKS + 5; n++) store = recordLink(store, { kind: 'session', id: `local_${n}`, ticket: 'AB-1' })
  store = recordLink(store, { kind: 'mr', id: 'https://gitlab.example.com/t/r/-/merge_requests/9', ticket: 'AB-2' })
  assert.equal(Object.keys(store.session).length, MAX_LINKS)
  assert.equal(store.session.local_0, undefined)
  assert.equal(store.session[`local_${MAX_LINKS + 4}`], 'AB-1')
  assert.equal(store.mr['https://gitlab.example.com/t/r/-/merge_requests/9'], 'AB-2')
  store = recordLink(store, { kind: 'session', id: 'local_10', ticket: 'AB-3' })
  assert.equal(Object.keys(store.session).at(-1), 'local_10')
})
