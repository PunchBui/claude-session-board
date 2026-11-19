import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, cronTimes, timelineLanes, nextEvent, splitWindow, countdown } from '../public/timeline.js'

const at = (h, m = 0, d = 19) => new Date(2026, 10, d, h, m).getTime()
const NOW = at(14, 6)
const hm = (ms) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` }

test('parseCron accepts steps, ranges and lists and rejects junk', () => {
  assert.deepEqual([...parseCron('*/15 * * * *').minute], [0, 15, 30, 45])
  assert.deepEqual([...parseCron('7,37 9-11 * * 1-5').hour], [9, 10, 11])
  assert.ok(parseCron('0 9 * * 7').dow.has(0))
  assert.equal(parseCron('61 * * * *'), null)
  assert.equal(parseCron('* * *'), null)
  assert.equal(parseCron('every minute'), null)
})

test('cronTimes lists matching minutes inside the range', () => {
  assert.deepEqual(cronTimes('7,37 * * * *', at(14, 6), at(16)).map(hm), ['14:07', '14:37', '15:07', '15:37'])
  assert.deepEqual(cronTimes('*/30 9-10 * * *', at(0), at(23)).map(hm), ['9:00', '9:30', '10:00', '10:30'])
  assert.deepEqual(cronTimes('0 9 * * 6', at(0), at(23)), [])
  assert.deepEqual(cronTimes('bad', at(0), at(23)), [])
})

test('cronTimes respects day-of-month and day-of-week either-or matching', () => {
  assert.equal(cronTimes('0 12 19 * 1', at(0), at(23)).length, 1)
  assert.equal(cronTimes('0 12 20 * 1', at(0), at(23)).length, 0)
})

const routine = (extra) => ({ rid: 'r1', name: 'Standup prep', folder: '/Users/x/repos/child-agents', at: at(9, 0, 20), repeat: 'weekdays', enabled: true, history: [], ...extra })

test('a schedule shows today\'s past runs with their sessions and today\'s upcoming runs', () => {
  const lanes = timelineLanes({
    nowMs: NOW,
    routines: [
      routine({ history: [{ at: at(9, 12), sessionId: 's1' }, { at: at(9, 0, 18), sessionId: 'old' }] }),
      routine({ rid: 'r2', name: 'Later today', repeat: 'none', at: at(16, 30) }),
      routine({ rid: 'r3', name: 'Tomorrow only', at: at(9, 0, 20), repeat: 'none' }),
    ],
  })
  assert.deepEqual(lanes.map((l) => l.title), ['Standup prep', 'Later today'])
  assert.deepEqual(lanes[0].events, [{ at: at(9, 12), past: true, sessionId: 's1', error: null }])
  assert.equal(lanes[0].project, 'child-agents')
  assert.deepEqual(lanes[1].events, [{ at: at(16, 30), past: false }])
})

test('a paused schedule keeps its past runs but has no upcoming ones', () => {
  const [lane] = timelineLanes({ nowMs: NOW, routines: [routine({ enabled: false, at: at(16), repeat: 'daily', history: [{ at: at(9), sessionId: 's' }] })] })
  assert.deepEqual(lane.events.map((e) => e.past), [true])
})

const loop = (extra) => ({ sessionId: 'sess', id: 'job', title: 'Watch deploy', project: 'jtb', kind: 'cron', cron: '*/30 * * * *', every: 30, recurring: true, createdAt: at(13, 50), status: 'looping', nextAt: at(14, 30), fires: [at(14, 0)], ...extra })

test('a cron loop shows its fires so far and every run left today', () => {
  const [lane] = timelineLanes({ nowMs: NOW, loops: [loop()] })
  assert.equal(lane.kind, 'cron')
  assert.equal(lane.events[0].past, true)
  assert.equal(hm(lane.events[1].at), '14:30')
  assert.equal(hm(lane.events.at(-1).at), '23:30')
  assert.equal(lane.events.length, 20)
  assert.ok(lane.events.every((e) => e.sessionId === 'sess'))
})

test('a one-shot cron shows only its single run', () => {
  const [lane] = timelineLanes({ nowMs: NOW, loops: [loop({ recurring: false, cron: '45 14 * * *', fires: [] })] })
  assert.deepEqual(lane.events.map((e) => hm(e.at)), ['14:45'])
})

test('a cron loop stops at its seven-day expiry', () => {
  const [lane] = timelineLanes({ nowMs: NOW, loops: [loop({ createdAt: at(15, 0, 12), fires: [] })] })
  assert.equal(hm(lane.events.at(-1).at), '14:30')
})

test('a wakeup loop shows only its next tick', () => {
  const [lane] = timelineLanes({ nowMs: NOW, loops: [loop({ kind: 'wakeup', cron: null, every: null, nextAt: NOW + 270_000, fires: [at(13, 55)] })] })
  assert.equal(lane.kind, 'wakeup')
  assert.deepEqual(lane.events.map((e) => e.past), [true, false])
  assert.equal(lane.events[1].at, NOW + 270_000)
})

test('ended loops appear only when they fired today, and archived ones never', () => {
  const lanes = timelineLanes({
    nowMs: NOW,
    loops: [
      loop({ id: 'a', status: 'ended', fires: [at(10)] }),
      loop({ id: 'b', status: 'ended', fires: [at(10, 0, 18)] }),
      loop({ id: 'c', archived: true }),
    ],
  })
  assert.deepEqual(lanes.map((l) => l.key), ['loop-sess-a'])
  assert.deepEqual(lanes[0].events.map((e) => e.past), [true])
})

test('the filters hide schedules, loops or past runs', () => {
  const input = { nowMs: NOW, routines: [routine({ history: [{ at: at(9), sessionId: 's' }] })], loops: [loop()] }
  assert.deepEqual(timelineLanes({ ...input, show: { schedules: false } }).map((l) => l.kind), ['cron'])
  assert.deepEqual(timelineLanes({ ...input, show: { loops: false } }).map((l) => l.kind), ['schedule'])
  const noPast = timelineLanes({ ...input, show: { past: false } })
  assert.deepEqual(noPast.map((l) => l.kind), ['cron'])
  assert.ok(noPast[0].events.every((e) => !e.past))
})

test('nextEvent picks the soonest upcoming run across lanes', () => {
  const lanes = timelineLanes({ nowMs: NOW, routines: [routine({ repeat: 'none', at: at(16, 30) })], loops: [loop()] })
  assert.equal(nextEvent(lanes, NOW).lane.kind, 'cron')
  assert.equal(nextEvent([], NOW), null)
})

test('splitWindow sorts events into before, inside and after the hours', () => {
  const events = [at(7), at(9), at(17, 59), at(18), at(20)].map((t) => ({ at: t }))
  const { before, inside, after } = splitWindow(events, at(9), at(18))
  assert.deepEqual([before.length, inside.length, after.length], [1, 2, 2])
})

test('countdown reads in seconds close up and minutes or hours further out', () => {
  assert.equal(countdown(NOW + 45_000, NOW), 'in 45s')
  assert.equal(countdown(NOW + 270_000, NOW), 'in 4m 30s')
  assert.equal(countdown(NOW + 25 * 60_000, NOW), 'in 25m')
  assert.equal(countdown(NOW + 150 * 60_000, NOW), 'in 2h 30m')
  assert.equal(countdown(NOW - 1000, NOW), 'due now')
})

test('a queued prompt on a session shows its upcoming runs today and opens that session', () => {
  const lanes = timelineLanes({
    nowMs: NOW,
    prompts: [{ sessionId: 'babysit', title: 'Babysit !2128', project: 'supply-setting', items: [
      { sid: 'p1', prompt: '/csb-babysit url', at: NOW + 270_000, repeat: 'none' },
      { sid: 'p2', prompt: 'tomorrow', at: at(9, 0, 20), repeat: 'none' },
    ] }],
  })
  assert.deepEqual(lanes.map((l) => [l.kind, l.key]), [['prompt', 'prompt-p1']])
  assert.deepEqual(lanes[0].events, [{ at: NOW + 270_000, past: false, sessionId: 'babysit' }])
  assert.equal(timelineLanes({ nowMs: NOW, prompts: [{ sessionId: 's', items: [{ sid: 'x', prompt: 'p', at: NOW + 1000 }] }], show: { schedules: false } }).length, 0)
})

test('hiding finished rows drops rows with nothing left today but keeps past runs on live rows', () => {
  const input = {
    nowMs: NOW,
    routines: [routine({ history: [{ at: at(9), sessionId: 's' }] })],
    loops: [loop(), loop({ id: 'done', status: 'ended', fires: [at(10)] })],
    show: { finished: false },
  }
  const lanes = timelineLanes(input)
  assert.deepEqual(lanes.map((l) => l.key), ['loop-sess-job'])
  assert.equal(lanes[0].events[0].past, true)
})
