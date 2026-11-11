import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRoutineInput, isDue, afterFire, recordRun, parseRoutinesFile, applyEdit, MAX_HISTORY } from '../lib/routines.js'

const NOW = Date.parse('2026-11-09T08:00:00')
const validPrompt = (p) => typeof p === 'string' && p.trim().length > 0
const base = { prompt: 'Check the logs', folder: '/Users/me/app', at: NOW + 3600_000, repeat: 'daily' }
const parse = (extra = {}) => parseRoutineInput({ ...base, ...extra }, { now: NOW, validPrompt })

test('a valid routine is enabled and named from the prompt', () => {
  const { routine } = parse()
  assert.equal(routine.enabled, true)
  assert.equal(routine.name, 'Check the logs')
  assert.equal(routine.repeat, 'daily')
  assert.equal(routine.runs, 0)
})

test('rejects bad prompt, folder, time, repeat and options', () => {
  assert.ok(parse({ prompt: '  ' }).error)
  assert.ok(parse({ folder: 'relative/path' }).error)
  assert.ok(parse({ folder: '/a/../b' }).error)
  assert.ok(parse({ at: NOW - 3600_000 }).error)
  assert.ok(parse({ at: 'soon' }).error)
  assert.ok(parse({ repeat: 'hourly' }).error)
  assert.ok(parse({ effort: 'ultra' }).error)
})

test('isDue needs enabled and a past time', () => {
  const { routine } = parse()
  assert.equal(isDue(routine, NOW), false)
  assert.equal(isDue(routine, routine.at), true)
  assert.equal(isDue({ ...routine, enabled: false }, routine.at + 1), false)
})

test('a repeating routine moves to its next time and counts the run', () => {
  const { routine } = parse()
  const fired = afterFire(routine, { sessionId: 'local_board-x' }, routine.at)
  assert.equal(fired.enabled, true)
  assert.equal(fired.at, routine.at + 86_400_000)
  assert.equal(fired.lastSessionId, 'local_board-x')
  assert.equal(fired.runs, 1)
})

test('a one-off routine switches off after firing and keeps its session link', () => {
  const { routine } = parse({ repeat: 'none' })
  const fired = afterFire(routine, { sessionId: 'local_board-y' }, routine.at)
  assert.equal(fired.enabled, false)
  assert.equal(fired.lastSessionId, 'local_board-y')
})

test('a failed start records the error, keeps the old session link and does not count a run', () => {
  const { routine } = parse()
  const first = afterFire(routine, { sessionId: 'local_board-a' }, routine.at)
  const failed = afterFire(first, { error: 'Too many board sessions.' }, first.at)
  assert.equal(failed.lastError, 'Too many board sessions.')
  assert.equal(failed.lastSessionId, 'local_board-a')
  assert.equal(failed.runs, 1)
})

test('missed days are skipped, not replayed', () => {
  const { routine } = parse()
  const late = afterFire(routine, { sessionId: 's' }, routine.at + 3 * 86_400_000 + 1000)
  assert.ok(late.at > routine.at + 3 * 86_400_000)
})

test('parseRoutinesFile drops broken entries and fills defaults', () => {
  const { routine } = parse()
  const { runs, lastFiredAt, ...bare } = routine
  const items = parseRoutinesFile({ items: [bare, { rid: 1 }, null, { ...bare, folder: 'nope' }] })
  assert.equal(items.length, 1)
  assert.equal(items[0].runs, 0)
  assert.deepEqual(parseRoutinesFile(null), [])
})

test('an edit changes the settings, keeps the history and turns a finished one-off back on', () => {
  const { routine } = parse({ repeat: 'none' })
  const done = afterFire(routine, { sessionId: 'local_board-z' }, routine.at)
  assert.equal(done.enabled, false)
  const { routine: edited } = parse({ prompt: 'New prompt', repeat: 'weekdays', name: 'Renamed', model: 'opus' })
  const next = applyEdit(done, edited)
  assert.equal(next.rid, done.rid)
  assert.equal(next.prompt, 'New prompt')
  assert.equal(next.repeat, 'weekdays')
  assert.equal(next.model, 'opus')
  assert.equal(next.enabled, true)
  assert.equal(next.runs, 1)
  assert.equal(next.lastSessionId, 'local_board-z')
  assert.equal(next.createdAt, done.createdAt)
})

test('every run is kept in history, newest first, including failed starts', () => {
  const { routine } = parse()
  const one = afterFire(routine, { sessionId: 'local_board-1' }, routine.at)
  const two = afterFire(one, { error: 'Too many board sessions.' }, one.at)
  const three = recordRun(two, { sessionId: 'local_board-3' }, two.at + 1000)
  assert.deepEqual(three.history.map((run) => run.sessionId), ['local_board-3', null, 'local_board-1'])
  assert.equal(three.history[1].error, 'Too many board sessions.')
  assert.equal(three.runs, 2)
})

test('history is capped and survives an edit', () => {
  let { routine } = parse()
  for (let i = 0; i < MAX_HISTORY + 5; i++) routine = recordRun(routine, { sessionId: `local_board-${i}` }, NOW + i)
  assert.equal(routine.history.length, MAX_HISTORY)
  assert.equal(routine.history[0].sessionId, `local_board-${MAX_HISTORY + 4}`)
  const { routine: edited } = parse({ prompt: 'Changed' })
  assert.equal(applyEdit(routine, edited).history.length, MAX_HISTORY)
})

test('a routine saved before history existed gets its last run as the first entry', () => {
  const { routine } = parse()
  const { history, ...old } = { ...routine, lastSessionId: 'local_board-old', lastFiredAt: NOW, runs: 4 }
  const [loaded] = parseRoutinesFile({ items: [old] })
  assert.deepEqual(loaded.history, [{ at: NOW, sessionId: 'local_board-old', error: null }])
  assert.deepEqual(parseRoutinesFile({ items: [{ ...old, lastSessionId: null, lastFiredAt: null }] })[0].history, [])
})
