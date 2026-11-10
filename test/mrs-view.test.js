import test from 'node:test'
import assert from 'node:assert/strict'
import { FILTERS, mergeMrs, orderMrs, visibleMrs, tempCounts, mrTemperature, mrWarmthTip, fixOffered, startOutcome, folderName, babysitView, babysitOffered, babysitFocusId, babysitStoppable, deployOffered, deployView, deployFocusId, refreshStatus, MRS_POLL_MS, DEPLOY_STALL_MS, BABYSIT_STALL_MS } from '../public/mrs.js'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

const mr = (id, over = {}) => ({
  url: `https://gitlab.example.com/t/r/-/merge_requests/${id}`,
  role: 'authored',
  focused: false,
  actionable: false,
  updatedAt: NOW - HOUR / 2,
  verdict: { rank: 5 },
  ...over,
})

const ids = (list) => list.map((item) => item.url.split('/').pop())

test('temperature follows the time since the last MR activity', () => {
  const tier = (ms) => mrTemperature(mr(1, { updatedAt: NOW - ms }), NOW).tier
  assert.equal(tier(10 * 60_000), 'hot')
  assert.equal(tier(3 * HOUR), 'warm')
  assert.equal(tier(3 * DAY), 'cooling')
  assert.equal(tier(10 * DAY), 'cold')
})

test('merges authored and reviewing lists without duplicating an MR in both', () => {
  const shared = mr(1)
  const merged = mergeMrs({ authored: [shared], reviewing: [shared, mr(2)] })
  assert.deepEqual(merged.map((item) => [item.url.split('/').pop(), item.role]), [['1', 'authored'], ['2', 'reviewing']])
})

test('focused merge requests sort first, then the most recently updated', () => {
  const list = [
    mr(1, { verdict: { rank: 0 }, updatedAt: NOW - 2 * DAY }),
    mr(2, { focused: true, updatedAt: NOW - 5 * DAY }),
    mr(3, { updatedAt: NOW - DAY }),
    mr(4, { updatedAt: NOW - HOUR }),
    mr(5, { focused: true, updatedAt: NOW - 3 * DAY }),
  ]
  assert.deepEqual(ids(orderMrs(list)), ['5', '2', '4', '3', '1'])
})

test('the focus filter keeps only focused merge requests', () => {
  const list = [mr(1), mr(2, { focused: true })]
  assert.deepEqual(ids(visibleMrs(list, { filter: 'focus', now: NOW })), ['2'])
  assert.equal(FILTERS.focus(list[0]), false)
})

test('the temperature filter composes with the role filter', () => {
  const list = [
    mr(1, { updatedAt: NOW - HOUR / 2 }),
    mr(2, { updatedAt: NOW - 3 * DAY }),
    mr(3, { updatedAt: NOW - 3 * DAY, role: 'reviewing' }),
  ]
  assert.deepEqual(ids(visibleMrs(list, { temp: 'cool', now: NOW })).sort(), ['2', '3'])
  assert.deepEqual(ids(visibleMrs(list, { filter: 'reviewing', temp: 'cool', now: NOW })), ['3'])
  assert.deepEqual(ids(visibleMrs(list, { temp: 'warm', now: NOW })), ['1'])
})

test('an unknown filter falls back to all', () => {
  assert.equal(visibleMrs([mr(1), mr(2)], { filter: 'nope', now: NOW }).length, 2)
})

test('counts warm and cool merge requests', () => {
  const list = [mr(1), mr(2, { updatedAt: NOW - 2 * HOUR }), mr(3, { updatedAt: NOW - 9 * DAY })]
  assert.deepEqual(tempCounts(list, NOW), { warm: 2, cool: 1 })
})

test('tooltip speaks about MR activity, not prompts', () => {
  const item = mr(1, { updatedAt: NOW - 2 * DAY })
  const tip = mrWarmthTip(item, mrTemperature(item, NOW), NOW)
  assert.equal(tip.heading, 'Cooling')
  assert.match(tip.text, /activity/)
  assert.equal(tip.rows[0][0], 'Last activity')
})

test('merged merge requests show in every filter their role matches', () => {
  const open = mr(1, { role: 'authored' })
  const merged = mr(2, { mergedAt: NOW - HOUR, role: 'authored', updatedAt: NOW - 2 * HOUR })
  const reviewed = mr(3, { mergedAt: NOW - HOUR, role: 'reviewing', updatedAt: NOW - 3 * HOUR })
  const list = [open, merged, reviewed]
  assert.deepEqual(ids(visibleMrs(list, { filter: 'all', now: NOW })), ['1', '2', '3'])
  assert.deepEqual(ids(visibleMrs(list, { filter: 'authored', now: NOW })), ['1', '2'])
  assert.deepEqual(ids(visibleMrs(list, { filter: 'reviewing', now: NOW })), ['3'])
  assert.deepEqual(ids(visibleMrs(list, { filter: 'merged', now: NOW })), ['2', '3'])
})

test('merging includes the merged list after the open ones', () => {
  const merged = mr(3, { mergedAt: NOW - HOUR })
  const list = mergeMrs({ authored: [mr(1)], reviewing: [], merged: [merged] })
  assert.deepEqual(ids(list), ['1', '3'])
  assert.equal(mergeMrs({ authored: [mr(1)], reviewing: [] }).length, 1)
})

test('a started session shows Started, locks the button and is remembered', () => {
  assert.deepEqual(startOutcome({ ok: true, data: { id: 'new' } }), { label: 'Started', title: 'Started in a new session, now in your Focus list', disabled: true, record: true })
})

test('a failed start offers Retry with the server error and is not remembered', () => {
  assert.deepEqual(startOutcome({ ok: false, data: { error: 'That folder does not exist' } }), { label: 'Retry', title: 'That folder does not exist', disabled: false, record: false })
  assert.equal(startOutcome({ ok: false, data: {} }).title, 'Could not start a session')
  assert.equal(startOutcome({ ok: false }).title, 'Could not start a session')
})

test('fixes are offered only on open merge requests that have a matching folder', () => {
  const folder = '/Users/me/repos/app'
  assert.equal(fixOffered(mr(1, { folder })), true)
  assert.equal(fixOffered(mr(2)), false)
  assert.equal(fixOffered(mr(3, { folder, mergedAt: NOW - HOUR })), false)
  assert.equal(fixOffered(mr(4, { folder, sessions: [] })), true)
  assert.equal(folderName(mr(1, { folder })), 'app')
  assert.equal(folderName(mr(2)), '')
})

const entry = (over = {}) => ({ state: 'watching', note: 'Pipeline 9 running', attempts: 0, sessionId: 's', startedAt: NOW - HOUR, at: NOW - 60_000, ...over })
const withSession = { folder: '/Users/me/repos/app' }

test('babysit view names each state and keeps the note', () => {
  assert.deepEqual(
    [babysitView(entry(), NOW).label, babysitView(entry({ state: 'in-review' }), NOW).label, babysitView(entry({ state: 'ready-to-merge' }), NOW).tone, babysitView(entry({ state: 'needs-you', note: 'Runner down' }), NOW).tone],
    ['Watching CI', 'Waiting for approval', 'good', 'bad']
  )
  assert.equal(babysitView(entry({ state: 'needs-you', note: 'Runner down' }), NOW).note, 'Runner down')
  assert.equal(babysitView(null, NOW), null)
})

test('fixing shows the attempt number', () => {
  assert.equal(babysitView(entry({ state: 'fixing', attempts: 2 }), NOW).label, 'Fixing CI (2/3)')
})

test('an active babysit that stopped reporting shows as stalled and no longer blocks a restart', () => {
  const quiet = entry({ at: NOW - BABYSIT_STALL_MS - 1 })
  const view = babysitView(quiet, NOW)
  assert.equal(view.label, 'Babysit stalled')
  assert.equal(view.active, false)
  assert.equal(babysitOffered(mr(1, { ...withSession, babysit: quiet }), NOW), true)
})

test('a final state is never reported as stalled', () => {
  const view = babysitView(entry({ state: 'needs-you', at: NOW - 3 * DAY }), NOW)
  assert.equal(view.stalled, false)
  assert.equal(view.label, 'Needs you')
})

test('the Babysit button needs an authored, unmerged MR with a matching folder and no live babysit', () => {
  assert.equal(babysitOffered(mr(1, withSession), NOW), true)
  assert.equal(babysitOffered(mr(1), NOW), false)
  assert.equal(babysitOffered(mr(1, { ...withSession, role: 'reviewing' }), NOW), false)
  assert.equal(babysitOffered(mr(1, { ...withSession, mergedAt: NOW }), NOW), false)
  assert.equal(babysitOffered(mr(1, { ...withSession, babysit: entry() }), NOW), false)
  assert.equal(babysitOffered(mr(1, { ...withSession, babysit: entry({ state: 'needs-you' }) }), NOW), true)
  assert.equal(babysitOffered(mr(1, { ...withSession, babysit: entry({ state: 'merged' }) }), NOW), false)
})

test('the babysit view is active only while a live babysit is reporting', () => {
  assert.equal(babysitView(entry(), NOW).active, true)
  assert.equal(babysitView(entry({ state: 'fixing' }), NOW).active, true)
  assert.equal(babysitView(entry({ state: 'needs-you' }), NOW).active, false)
  assert.equal(babysitView(entry({ state: 'ready-to-merge' }), NOW).active, false)
  assert.equal(babysitView(entry({ at: NOW - BABYSIT_STALL_MS - 1 }), NOW).active, false)
})

test('the session button needs a babysit session on an open MR, whatever the state', () => {
  assert.equal(babysitFocusId(mr(1, { babysit: entry() })), 's')
  assert.equal(babysitFocusId(mr(1, { babysit: entry({ state: 'needs-you' }) })), 's')
  assert.equal(babysitFocusId(mr(1, { babysit: entry({ sessionId: null }) })), null)
  assert.equal(babysitFocusId(mr(1)), null)
  assert.equal(babysitFocusId(mr(1, { mergedAt: NOW, babysit: entry() })), null)
})

test('a babysit can be stopped while it is live, even when it has stalled', () => {
  assert.equal(babysitStoppable(mr(1, { babysit: entry() })), true)
  assert.equal(babysitStoppable(mr(1, { babysit: entry({ at: NOW - BABYSIT_STALL_MS - 1 }) })), true)
  assert.equal(babysitStoppable(mr(1, { babysit: entry({ state: 'needs-you' }) })), false)
  assert.equal(babysitStoppable(mr(1, { babysit: entry({ state: 'stopped' }) })), false)
  assert.equal(babysitStoppable(mr(1)), false)
  assert.equal(babysitStoppable(mr(1, { mergedAt: NOW, babysit: entry() })), false)
})

test('the deploy check is offered on your own merged MRs that have a folder', () => {
  const merged = { mergedAt: NOW, folder: '/Users/me/repos/app' }
  assert.equal(deployOffered(mr(1, merged)), true)
  assert.equal(deployOffered(mr(1, { ...merged, role: 'reviewing' })), false)
  assert.equal(deployOffered(mr(1, { folder: merged.folder })), false)
  assert.equal(deployOffered(mr(1, { mergedAt: NOW })), false)
})

const check = (over = {}) => ({ state: 'live', note: 'prod deployed', sessionId: 'd', at: NOW - HOUR, ...over })
const mergedMr = (over = {}) => mr(1, { mergedAt: NOW, folder: '/Users/me/repos/app', ...over })

test('deploy view names each result with a tone and keeps the note', () => {
  assert.deepEqual(['checking', 'live', 'deploying', 'waiting', 'failed', 'unknown'].map((state) => deployView(check({ state, at: NOW - 60_000 }), NOW).label),
    ['Checking deploy', 'Deployed', 'Deploying', 'Deploy waiting', 'Deploy failed', 'Deploy unknown'])
  assert.deepEqual(['live', 'waiting', 'failed', 'unknown'].map((state) => deployView(check({ state }), NOW).tone), ['good', 'warn', 'bad', 'dim'])
  assert.equal(deployView(check(), NOW).note, 'prod deployed')
  assert.equal(deployView(undefined, NOW), null)
})

test('only a fresh check is active, and a check that never reported shows as stalled', () => {
  assert.equal(deployView(check({ state: 'checking', at: NOW - 60_000 }), NOW).active, true)
  const stalled = deployView(check({ state: 'checking', at: NOW - DEPLOY_STALL_MS - 1 }), NOW)
  assert.deepEqual([stalled.label, stalled.tone, stalled.active, stalled.stalled], ['Check stalled', 'warn', false, true])
  assert.equal(deployView(check({ state: 'live', at: NOW - 3 * DAY }), NOW).stalled, false)
  assert.equal(deployView(check({ state: 'live' }), NOW).active, false)
})

test('Check deploy can be pressed again after a result, a stall or a failure, but not while a check runs', () => {
  assert.equal(deployOffered(mergedMr(), NOW), true)
  assert.equal(deployOffered(mergedMr({ deploy: check() }), NOW), true)
  assert.equal(deployOffered(mergedMr({ deploy: check({ state: 'failed' }) }), NOW), true)
  assert.equal(deployOffered(mergedMr({ deploy: check({ state: 'checking', at: NOW - DEPLOY_STALL_MS - 1 }) }), NOW), true)
  assert.equal(deployOffered(mergedMr({ deploy: check({ state: 'checking', at: NOW - 60_000 }) }), NOW), false)
})

test('the deploy session is the one that ran the check', () => {
  assert.equal(deployFocusId(mergedMr({ deploy: check() })), 'd')
  assert.equal(deployFocusId(mergedMr()), null)
})

const fmt = (ms) => `t${ms}`

test('the refresh line shows when the list was fetched and when the next refresh is due', () => {
  const line = refreshStatus({ fetchedAt: NOW - 12_000, at: NOW - 12_000, loading: false, autoOff: false }, NOW, fmt)
  assert.equal(line, `updated t${NOW - 12_000} (12s ago) · next refresh in 48s`)
})

test('the refresh line says refreshing while a load is running and due once the time has passed', () => {
  assert.match(refreshStatus({ fetchedAt: NOW - 70_000, at: NOW - 70_000, loading: true, autoOff: false }, NOW, fmt), /\(1m ago\) · refreshing now$/)
  assert.match(refreshStatus({ fetchedAt: NOW - 70_000, at: NOW - 70_000, loading: false, autoOff: false }, NOW, fmt), /next refresh due$/)
  assert.match(refreshStatus({ fetchedAt: NOW - MRS_POLL_MS, at: NOW - MRS_POLL_MS, loading: false, autoOff: false }, NOW, fmt), /next refresh due$/)
})

test('the refresh line says automatic refresh is off when the page interval is off', () => {
  assert.match(refreshStatus({ fetchedAt: NOW - 5_000, at: NOW - 5_000, loading: false, autoOff: true }, NOW, fmt), /\(5s ago\) · auto refresh off$/)
  assert.match(refreshStatus({ fetchedAt: NOW - 5_000, at: NOW - 5_000, loading: true, autoOff: true }, NOW, fmt), /refreshing now$/)
})
