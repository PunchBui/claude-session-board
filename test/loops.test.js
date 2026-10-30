import test from 'node:test'
import assert from 'node:assert/strict'
import { newScanState, absorbLine } from '../lib/scan.js'
import { loopOf, loopRecords } from '../lib/loops.js'
import { diffLoops, withoutTickFinishes, untilLabel, loopTip, statusTip, byLatestEnded } from '../public/loops.js'
import { snapshot } from '../public/alerts.js'

const T0 = Date.parse('2026-10-29T03:00:00.000Z')
const iso = (offsetMin) => new Date(T0 + offsetMin * 60_000).toISOString()
const feed = (state, entry) => absorbLine(state, JSON.stringify(entry))
const toolUse = (id, name, input, at) => ({ type: 'assistant', timestamp: iso(at), message: { id: `m${id}`, content: [{ type: 'tool_use', id, name, input }] } })
const toolResult = (id, content, at) => ({ type: 'user', timestamp: iso(at), message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
const scheduled = (text, at) => ({ type: 'user', isMeta: true, turnOrigin: 'scheduled', timestamp: iso(at), message: { content: text } })
const view = (state, minutes, over = {}) => loopOf(state.loops, { nowMs: T0 + minutes * 60_000, working: false, idleMs: 600_000, ...over })

function startCron(state, every = 10) {
  feed(state, toolUse('c1', 'CronCreate', { cron: `*/${every} * * * *`, prompt: 'check deploy' }, 0))
  feed(state, toolResult('c1', `Scheduled recurring job abc123 (Every ${every} minutes). Next run: soon.`, 0))
}

test('a created cron job reads as looping with its next run', () => {
  const state = newScanState()
  startCron(state)
  const loop = view(state, 3)
  assert.equal(loop.state, 'looping')
  assert.equal(loop.every, 10)
  assert.equal(loop.nextAt, T0 + 10 * 60_000)
})

test('scheduled firings push the next run forward', () => {
  const state = newScanState()
  startCron(state)
  feed(state, scheduled('check deploy', 10))
  feed(state, scheduled('check deploy', 20))
  const loop = view(state, 22)
  assert.equal(loop.lastFiredAt, T0 + 20 * 60_000)
  assert.equal(loop.nextAt, T0 + 30 * 60_000)
})

test('an overdue job is stalled', () => {
  const state = newScanState()
  startCron(state)
  assert.equal(view(state, 45).state, 'stalled')
  assert.equal(view(state, 45, { working: true }).state, 'looping')
})

test('CronDelete ends the loop', () => {
  const state = newScanState()
  startCron(state)
  feed(state, toolUse('d1', 'CronDelete', { id: 'abc123' }, 30))
  const loop = view(state, 31)
  assert.equal(loop.state, 'ended')
  assert.equal(loop.endedAt, T0 + 30 * 60_000)
})

test('deleting one of two jobs keeps the loop going', () => {
  const state = newScanState()
  startCron(state)
  feed(state, toolUse('c2', 'CronCreate', { cron: '*/5 * * * *', prompt: 'other' }, 1))
  feed(state, toolResult('c2', 'Scheduled recurring job def456 (Every 5 minutes).', 1))
  feed(state, toolUse('d1', 'CronDelete', { id: 'abc123' }, 2))
  const loop = view(state, 3)
  assert.equal(loop.state, 'looping')
  assert.equal(loop.count, 1)
})

test('a one-shot cron ends when it fires', () => {
  const state = newScanState()
  feed(state, toolUse('c1', 'CronCreate', { cron: '30 9 * * *', prompt: 'once', recurring: false }, 0))
  feed(state, toolResult('c1', 'Scheduled one-shot job zzz999 (At 9:30).', 0))
  assert.equal(view(state, 5).state, 'looping')
  feed(state, scheduled('once', 10))
  assert.equal(view(state, 11).state, 'ended')
})

test('ScheduleWakeup loops until a tick ends without rescheduling', () => {
  const state = newScanState()
  feed(state, toolUse('w1', 'ScheduleWakeup', { delaySeconds: 600, prompt: 'poll', reason: 'poll' }, 0))
  assert.equal(view(state, 5).state, 'looping')
  feed(state, scheduled('poll', 10))
  assert.equal(view(state, 10.5, { working: true }).state, 'looping')
  assert.equal(view(state, 15).state, 'ended')
})

test('ScheduleWakeup with stop ends the loop', () => {
  const state = newScanState()
  feed(state, toolUse('w1', 'ScheduleWakeup', { delaySeconds: 600, prompt: 'poll' }, 0))
  feed(state, toolUse('w2', 'ScheduleWakeup', { stop: true }, 5))
  assert.equal(view(state, 6).state, 'ended')
})

test('ended loops are forgotten after a day and plain sessions have no loop', () => {
  const state = newScanState()
  assert.equal(view(state, 1), null)
  startCron(state)
  feed(state, toolUse('d1', 'CronDelete', { id: 'abc123' }, 5))
  assert.equal(view(state, 25 * 60), null)
})

test('diffLoops reports finished and stalled loops once, never on the first snapshot', () => {
  const session = (state) => ({ id: 's1', title: 'Watch', loop: state ? { state } : null })
  assert.equal(diffLoops(null, [session('looping')]).events.length, 0)
  const first = diffLoops(null, [session('looping')]).next
  const stalled = diffLoops(first, [session('stalled')])
  assert.deepEqual(stalled.events.map((e) => e.kind), ['stalled'])
  assert.equal(diffLoops(stalled.next, [session('stalled')]).events.length, 0)
  assert.deepEqual(diffLoops(stalled.next, [session('ended')]).events.map((e) => e.kind), ['loopdone'])
  assert.equal(diffLoops(diffLoops(first, [session('ended')]).next, [session('ended')]).events.length, 0)
})

test('a tick finishing is not announced, but the last one is replaced by the loop event', () => {
  const card = (over) => ({ id: 's1', title: 'Watch', status: 'completed', usage: { context: 0 }, ...over })
  assert.equal(snapshot(card({ loop: { state: 'looping' } })).looping, true)
  const events = [{ id: 's1', kind: 'finished' }, { id: 's2', kind: 'finished' }]
  assert.deepEqual(withoutTickFinishes(events, [{ id: 's1', kind: 'loopdone' }]).map((e) => e.id), ['s2'])
})

test('untilLabel', () => {
  assert.equal(untilLabel(1000, 5000), 'due now')
  assert.equal(untilLabel(31_000, 1000), 'in 30s')
  assert.equal(untilLabel(5 * 60_000 + 1000, 1000), 'in 5m')
})

const records = (state, minutes, over = {}) => loopRecords(state.loops, { nowMs: T0 + minutes * 60_000, working: false, idleMs: 600_000, ...over })

test('history keeps a deleted job with its runs and end reason', () => {
  const state = newScanState()
  startCron(state)
  feed(state, scheduled('check deploy', 10))
  feed(state, scheduled('check deploy', 20))
  feed(state, toolUse('d1', 'CronDelete', { id: 'abc123' }, 25))
  const [job] = records(state, 30)
  assert.equal(job.status, 'ended')
  assert.equal(job.endReason, 'deleted')
  assert.equal(job.endedAt, T0 + 25 * 60_000)
  assert.equal(job.fireCount, 2)
  assert.equal(job.every, 10)
})

test('history lists active and past jobs side by side', () => {
  const state = newScanState()
  startCron(state)
  feed(state, toolUse('d1', 'CronDelete', { id: 'abc123' }, 5))
  feed(state, toolUse('c2', 'CronCreate', { cron: '*/5 * * * *', prompt: 'second' }, 6))
  feed(state, toolResult('c2', 'Scheduled recurring job def456 (Every 5 minutes).', 6))
  assert.deepEqual(records(state, 8).map((r) => [r.id, r.status]), [['abc123', 'ended'], ['def456', 'looping']])
  assert.equal(records(state, 40)[1].status, 'stalled')
})

test('history marks a job expired after seven days', () => {
  const state = newScanState()
  startCron(state)
  const [job] = records(state, 8 * 24 * 60)
  assert.equal(job.status, 'ended')
  assert.equal(job.endReason, 'expired')
})

test('a wakeup chain is one record across reschedules and ends when it stops', () => {
  const state = newScanState()
  feed(state, toolUse('w1', 'ScheduleWakeup', { delaySeconds: 300, prompt: 'poll' }, 0))
  feed(state, scheduled('poll', 5))
  feed(state, toolUse('w2', 'ScheduleWakeup', { delaySeconds: 300, prompt: 'poll' }, 5.2))
  feed(state, scheduled('poll', 10))
  feed(state, toolUse('w3', 'ScheduleWakeup', { stop: true }, 10.2))
  const list = records(state, 11)
  assert.equal(list.length, 1)
  assert.equal(list[0].kind, 'wakeup')
  assert.equal(list[0].fireCount, 2)
  assert.equal(list[0].endReason, 'stopped')
})

test('a wakeup chain that goes quiet after a tick is finished', () => {
  const state = newScanState()
  feed(state, toolUse('w1', 'ScheduleWakeup', { delaySeconds: 300, prompt: 'poll' }, 0))
  feed(state, scheduled('poll', 5))
  const [chain] = records(state, 20)
  assert.equal(chain.status, 'ended')
  assert.equal(chain.endReason, 'finished')
  feed(state, toolUse('w2', 'ScheduleWakeup', { delaySeconds: 300, prompt: 'again' }, 120))
  assert.equal(records(state, 121).length, 2)
})

test('loopTip explains each state with the facts a reader needs', () => {
  const now = T0 + 60 * 60_000
  const looping = loopTip({ status: 'looping', kind: 'cron', every: 10, recurring: true, createdAt: T0, fireCount: 3, lastFiredAt: now - 120_000, nextAt: now + 480_000 }, now)
  assert.equal(looping.heading, 'Loop running')
  assert.deepEqual(looping.rows.map((r) => r[0]), ['Schedule', 'Started', 'Runs', 'Last run', 'Next run'])
  assert.match(looping.rows.at(-1)[1], /in 8m/)
  const stalled = loopTip({ state: 'stalled', count: 2, every: 5, lastFiredAt: null, nextAt: now - 1_800_000 }, now)
  assert.equal(stalled.heading, 'Loop stalled')
  assert.deepEqual(stalled.rows.map((r) => r[0]), ['Scheduled tasks', 'Schedule', 'Last run', 'Was due'])
  assert.match(stalled.rows.at(-1)[1], /30m overdue/)
  const ended = loopTip({ status: 'ended', kind: 'cron', every: 15, recurring: true, createdAt: T0, fireCount: 12, lastFiredAt: now - 600_000, endedAt: now - 300_000, endReason: 'deleted' }, now)
  assert.equal(ended.heading, 'Loop ended')
  assert.match(ended.text, /cancelled/)
  assert.equal(ended.rows.at(-1)[0], 'Ended')
})

test('statusTip describes the session status and its latest detail', () => {
  const tip = statusTip('review_ready', 'no prod deploy yet', T0, T0 + 3_600_000)
  assert.equal(tip.heading, 'review ready')
  assert.match(tip.text, /review/)
  assert.deepEqual(tip.rows.map((r) => r[0]), ['Latest', 'Last activity'])
  assert.match(tip.rows[1][1], /1h ago/)
  assert.equal(statusTip('weird', null, null).rows.length, 0)
})

test("a job missing from the session's own CronList is closed as removed", () => {
  const state = newScanState()
  startCron(state)
  feed(state, toolUse('c2', 'CronCreate', { cron: '*/5 * * * *', prompt: 'second' }, 1))
  feed(state, toolResult('c2', 'Scheduled recurring job def456 (Every 5 minutes).', 1))
  assert.equal(view(state, 3).count, 2)
  feed(state, toolUse('l1', 'CronList', {}, 20))
  feed(state, toolResult('l1', 'abc123 — Every 10 minutes (recurring) [session-only], next run soon: check deploy', 20))
  assert.equal(view(state, 21).count, 1)
  const list = records(state, 21)
  assert.deepEqual(list.map((r) => [r.id, r.status, r.endReason]), [['abc123', 'looping', null], ['def456', 'ended', 'removed']])
})

test('an empty CronList ends every loop', () => {
  const state = newScanState()
  startCron(state)
  feed(state, toolUse('l1', 'CronList', {}, 20))
  feed(state, toolResult('l1', 'No scheduled jobs.', 20))
  assert.equal(view(state, 21).state, 'ended')
  assert.equal(records(state, 21)[0].endReason, 'removed')
})

test('a job created after the list was requested is left alone', () => {
  const state = newScanState()
  feed(state, toolUse('l1', 'CronList', {}, -1))
  startCron(state)
  feed(state, toolResult('l1', 'No scheduled jobs.', 6))
  assert.equal(view(state, 8).state, 'looping')
})

test('loops sort with active first, then the most recently ended', () => {
  const list = [
    { id: 'old', createdAt: 1, endedAt: 100 },
    { id: 'new-ended', createdAt: 5, endedAt: 300 },
    { id: 'active-old', createdAt: 2, endedAt: null },
    { id: 'active-new', createdAt: 9, endedAt: null },
    { id: 'mid', createdAt: 3, endedAt: 200 },
  ]
  assert.deepEqual([...list].sort(byLatestEnded).map((l) => l.id), ['active-new', 'active-old', 'new-ended', 'mid', 'old'])
})
