import test from 'node:test'
import assert from 'node:assert/strict'
import { newScanState, absorbLine } from '../lib/scan.js'
import { backgroundTasks, backgroundCounts, runningCount, safeOutputPath } from '../lib/background.js'
import { backgroundTip, byBackgroundOrder, BACKGROUND_FILTERS, backgroundProgress, diffBackground } from '../public/loops.js'

const T0 = Date.parse('2026-10-30T03:00:00.000Z')
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString()
const feed = (state, entry) => absorbLine(state, JSON.stringify(entry))
const use = (id, name, input, at) => ({ type: 'assistant', timestamp: iso(at), message: { id: `m${id}`, content: [{ type: 'tool_use', id, name, input }] } })
const result = (id, content, toolUseResult, at) => ({ type: 'user', timestamp: iso(at), toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
const notify = (body, at) => ({ type: 'user', timestamp: iso(at), origin: { kind: 'task-notification' }, message: { content: `<task-notification>${body}</task-notification>` } })
const tasks = (state, minutes = 0, idleMs = 0) => backgroundTasks(state.background, { nowMs: T0 + minutes * 60_000, idleMs })

function startCommand(state, id = 'bg1', at = 0) {
  feed(state, use(`t-${id}`, 'Bash', { command: 'node server.js', description: 'Start the board server', run_in_background: true }, at))
  feed(state, result(`t-${id}`, `Command running in background with ID: ${id}. Output is being written to: /private/tmp/claude-502/proj/sess/tasks/${id}.output. You will be notified.`, { backgroundTaskId: id }, at))
}

test('a background command is running until its notification arrives', () => {
  const state = newScanState()
  startCommand(state)
  const [task] = tasks(state, 5)
  assert.equal(task.status, 'running')
  assert.equal(task.kind, 'command')
  assert.equal(task.description, 'Start the board server')
  assert.equal(task.hasOutput, true)
  assert.equal(task.durationMs, 5 * 60_000)
  assert.equal(runningCount(state.background), 1)
})

test('foreground commands are ignored', () => {
  const state = newScanState()
  feed(state, use('t1', 'Bash', { command: 'ls' }, 0))
  feed(state, result('t1', 'file', {}, 0))
  assert.equal(tasks(state).length, 0)
})

test('completion and failure notifications set status, exit code and end time', () => {
  const state = newScanState()
  startCommand(state, 'ok1')
  startCommand(state, 'bad1', 1)
  feed(state, notify('<task-id>ok1</task-id><status>completed</status><summary>Background command "x" completed (exit code 0)</summary>', 4))
  feed(state, notify('<task-id>bad1</task-id><status>failed</status><summary>Background command "x" failed with exit code 143</summary>', 6))
  const byId = Object.fromEntries(tasks(state, 10).map((t) => [t.id, t]))
  assert.deepEqual([byId.ok1.status, byId.ok1.exitCode, byId.ok1.durationMs], ['completed', 0, 4 * 60_000])
  assert.deepEqual([byId.bad1.status, byId.bad1.exitCode], ['failed', 143])
  assert.equal(runningCount(state.background), 0)
})

test('a time-limit kill and an orphaned stop are recorded', () => {
  const state = newScanState()
  startCommand(state, 'k1')
  startCommand(state, 's1')
  startCommand(state, 's2')
  feed(state, notify('<task-id>k1</task-id><status>killed</status><summary>stopped after reaching its background time limit</summary>', 10))
  feed(state, notify('<task-id>s1</task-id><task-id>s2</task-id><task-id>__orphan_summary__:shell</task-id><status>stopped</status><summary>2 tasks did not finish</summary>', 20))
  assert.deepEqual(tasks(state, 30).map((t) => t.status), ['killed', 'stopped', 'stopped'])
})

test('a monitor collects events and expires', () => {
  const state = newScanState()
  feed(state, use('m1', 'Monitor', { command: 'watch mr', description: 'MR 478', timeout_ms: 600000 }, 0))
  feed(state, result('m1', 'Monitor started (task mon1, expires in 10m)', { taskId: 'mon1', timeoutMs: 600000, persistent: false }, 0))
  feed(state, notify('<task-id>mon1</task-id><summary>Monitor event: "MR 478"</summary><event>state opened replies 0</event>', 3))
  feed(state, notify('<task-id>mon1</task-id><summary>Monitor event: "MR 478"</summary><event>state opened replies 1</event>', 6))
  let [monitor] = tasks(state, 7)
  assert.deepEqual([monitor.kind, monitor.status, monitor.eventCount, monitor.expiresAt], ['monitor', 'running', 2, T0 + 600_000])
  feed(state, notify('<task-id>mon1</task-id><summary>Monitor event: "MR 478"</summary><event>[Monitor expired after 10m with 2 events delivered. Re-arm it.]</event>', 10))
  ;[monitor] = tasks(state, 11)
  assert.equal(monitor.status, 'expired')
  assert.equal(monitor.events.length, 2)
})

test('a stream that ends is completed', () => {
  const state = newScanState()
  feed(state, use('m1', 'Monitor', { command: 'watch', description: 'w' }, 0))
  feed(state, result('m1', 'Monitor started (task mon2, expires in 10m)', { taskId: 'mon2' }, 0))
  feed(state, notify('<task-id>mon2</task-id><status>completed</status><summary>Monitor "w" stream ended</summary><event>ALL RESOLVED</event>', 5))
  const [monitor] = tasks(state, 6)
  assert.deepEqual([monitor.status, monitor.eventCount], ['completed', 1])
})

test('a task that never reports back on a long-quiet session is unknown', () => {
  const state = newScanState()
  startCommand(state)
  assert.equal(tasks(state, 5, 25 * 3_600_000)[0].status, 'unknown')
  assert.equal(tasks(state, 5, 1000)[0].status, 'running')
})

test('only task output files are readable', () => {
  assert.equal(safeOutputPath('/private/tmp/claude-502/-Users-me-repo/abc-123/tasks/bg1.output'), true)
  assert.equal(safeOutputPath('/etc/passwd'), false)
  assert.equal(safeOutputPath('/private/tmp/claude-502/x/tasks/../../../../etc/passwd'), false)
  assert.equal(safeOutputPath('/private/tmp/claude-502/x/tasks/a.txt'), false)
  assert.equal(safeOutputPath(null), false)
})

test('ordering, filters and tooltip for the page', () => {
  const list = [
    { id: 'old', status: 'completed', startedAt: 1, endedAt: 100, exitCode: 0 },
    { id: 'run-old', status: 'running', startedAt: 2, endedAt: null },
    { id: 'recent', status: 'failed', startedAt: 3, endedAt: 300, exitCode: 1 },
    { id: 'run-new', status: 'running', startedAt: 9, endedAt: null },
  ]
  assert.deepEqual([...list].sort(byBackgroundOrder).map((t) => t.id), ['run-new', 'run-old', 'recent', 'old'])
  assert.deepEqual(list.filter(BACKGROUND_FILTERS.problems).map((t) => t.id), ['recent'])
  assert.deepEqual(list.filter(BACKGROUND_FILTERS.finished).map((t) => t.id), ['old', 'recent'])
  const tip = backgroundTip({ status: 'failed', kind: 'command', startedAt: T0, endedAt: T0 + 60_000, durationMs: 60_000, exitCode: 143, eventCount: 0 }, T0 + 120_000)
  assert.equal(tip.heading, 'failed')
  assert.deepEqual(tip.rows.map((r) => r[0]), ['Type', 'Started', 'Ended', 'Exit code'])
})

test('counts only recent finished tasks and ignores stale running ones', () => {
  const state = newScanState()
  startCommand(state, 'ok1')
  startCommand(state, 'bad1', 1)
  startCommand(state, 'run1', 2)
  feed(state, notify('<task-id>ok1</task-id><status>completed</status><summary>done</summary>', 4))
  feed(state, notify('<task-id>bad1</task-id><status>failed</status><summary>boom</summary>', 6))
  const now = T0 + 10 * 60_000
  assert.deepEqual(backgroundCounts(state.background, { nowMs: now, idleMs: 60_000 }), { running: 1, done: 2, failed: 1, lastEndedAt: T0 + 6 * 60_000 })
  assert.equal(backgroundCounts(state.background, { nowMs: now, idleMs: 2 * 24 * 3_600_000 }).running, 0)
  assert.equal(backgroundCounts(state.background, { nowMs: T0 + 3 * 3_600_000, idleMs: 60_000 }).done, 0)
})

test('backgroundProgress shows running progress, then a finish indicator until seen', () => {
  const session = (id, counts) => ({ id, title: id, background: counts })
  const running = backgroundProgress([session('a', { running: 2, done: 1, failed: 0, lastEndedAt: 5 }), session('b', { running: 1, done: 4, failed: 0, lastEndedAt: 9 })])
  assert.deepEqual([running.mode, running.done, running.total, running.pct], ['running', 5, 8, 63])
  const finished = [session('a', { running: 0, done: 3, failed: 0, lastEndedAt: 100 })]
  assert.equal(backgroundProgress(finished, 50).mode, 'finished')
  assert.equal(backgroundProgress(finished, 100).mode, 'idle')
  assert.equal(backgroundProgress([session('a', { running: 0, done: 3, failed: 1, lastEndedAt: 100 })], 0).mode, 'failed')
  assert.equal(backgroundProgress([{ id: 'x', background: null }]).mode, 'idle')
})

test('diffBackground announces when a session runs out of running tasks', () => {
  const session = (running, over = {}) => ({ id: 's1', title: 'Deploy', background: { running, done: 2, failed: 0, lastEndedAt: 1, ...over } })
  assert.equal(diffBackground(null, [session(2)]).events.length, 0)
  const first = diffBackground(null, [session(2)]).next
  assert.equal(diffBackground(first, [session(1)]).events.length, 0)
  const done = diffBackground(first, [session(0)])
  assert.deepEqual(done.events.map((e) => [e.kind, e.message]), [['bgdone', '2 background tasks finished']])
  assert.equal(diffBackground(done.next, [session(0)]).events.length, 0)
  assert.equal(diffBackground(first, [session(0, { failed: 1 })]).events[0].kind, 'bgfailed')
})
