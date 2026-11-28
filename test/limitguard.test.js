import test from 'node:test'
import assert from 'node:assert/strict'
import { allowedPercent, guardStatus, decideGuard, windowMoved, resumesAt, paused, released, publicGuard, parseGuardsFile } from '../lib/limitguard.js'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 28, 10, 0, 0)
const at = (hours) => new Date(NOW + hours * HOUR).toISOString()

test('the allowed percent falls by 20 for every extra hour before the reset', () => {
  assert.equal(allowedPercent(at(0.5), NOW), 100)
  assert.equal(allowedPercent(at(1), NOW), 100)
  assert.equal(allowedPercent(at(1.01), NOW), 80)
  assert.equal(allowedPercent(at(2), NOW), 80)
  assert.equal(allowedPercent(at(2.5), NOW), 60)
  assert.equal(allowedPercent(at(3.2), NOW), 40)
  assert.equal(allowedPercent(at(4.9), NOW), 20)
  assert.equal(allowedPercent(at(5), NOW), 20)
})

test('a missing or odd reset time counts as a full window, and a past one as no limit', () => {
  assert.equal(allowedPercent(null, NOW), 20)
  assert.equal(allowedPercent('nonsense', NOW), 20)
  assert.equal(allowedPercent(at(-1), NOW), 100)
  assert.equal(allowedPercent(at(9), NOW), 20)
})

test('guardStatus is unknown without limits, and over only when a cap applies', () => {
  assert.equal(guardStatus({ available: false }, NOW).known, false)
  assert.equal(guardStatus({ available: true, fiveHour: null }, NOW).over, false)
  const limits = (percent, hours) => ({ available: true, fiveHour: { percent, resetsAt: at(hours) } })
  assert.equal(guardStatus(limits(79, 2), NOW).over, false)
  assert.equal(guardStatus(limits(80, 2), NOW).over, true)
  assert.equal(guardStatus(limits(99, 0.5), NOW).over, false)
})

test('windowMoved sees a new 5h window but not a small shift in the reset time', () => {
  assert.equal(windowMoved({ resetsAt: at(1) }, { resetsAt: at(1.001) }), false)
  assert.equal(windowMoved({ resetsAt: at(1) }, { resetsAt: at(5.2) }), true)
  assert.equal(windowMoved({ resetsAt: null }, { resetsAt: at(5) }), false)
  assert.equal(windowMoved({ resetsAt: at(1) }, { resetsAt: null }), false)
})

test('resumesAt is one hour before the reset', () => {
  assert.equal(resumesAt({ resetsAt: at(2) }), NOW + HOUR)
  assert.equal(resumesAt({ resetsAt: null }), null)
})

test('decideGuard pauses a running guarded session over the cap', () => {
  const over = { known: true, over: true, allowed: 60 }
  assert.equal(decideGuard({ on: true }, over, true, NOW), 'pause')
  assert.equal(decideGuard({ on: true }, over, false, NOW), null)
  assert.equal(decideGuard({ on: true }, { known: true, over: false, allowed: 60 }, true, NOW), null)
  assert.equal(decideGuard({ on: false }, over, true, NOW), null)
  assert.equal(decideGuard(undefined, over, true, NOW), null)
  assert.equal(decideGuard({ on: true }, { known: false }, true, NOW), null)
})

test('a paused session waits for the last hour or a new window, not for the cap to rise', () => {
  const guard = { on: true, pausedAt: 5, resetsAt: at(2.5) }
  const status = (allowed, resetsAt, over = false) => ({ known: true, over, allowed, resetsAt })
  assert.equal(decideGuard(guard, status(60, at(2.5), true), false, NOW), null)
  assert.equal(decideGuard(guard, status(60, at(2.5), false), false, NOW), null)
  assert.equal(decideGuard(guard, status(80, at(1.5), false), false, NOW + HOUR), null)
  assert.equal(decideGuard(guard, status(100, at(0.9), false), false, NOW + 1.6 * HOUR), 'resume')
  assert.equal(decideGuard(guard, status(20, at(5), false), false, NOW + 3 * HOUR), 'resume')
})

test('a paused session is released once its reset time has passed, whatever the new reading says', () => {
  const guard = { on: true, pausedAt: 5, resetsAt: at(1) }
  const fresh = { known: true, over: false, allowed: 20, resetsAt: null }
  assert.equal(decideGuard(guard, fresh, false, NOW + 0.5 * HOUR), null)
  assert.equal(decideGuard(guard, fresh, false, NOW + 1.1 * HOUR), 'resume')
  assert.equal(decideGuard(guard, { known: true, over: true, allowed: 20, resetsAt: at(1.1 + 5) }, false, NOW + 1.1 * HOUR), 'resume')
})

test('a paused session whose reset has long passed is released even if usage cannot be read', () => {
  const guard = { on: true, pausedAt: 5, resetsAt: at(1) }
  assert.equal(decideGuard(guard, { known: false }, false, NOW + 0.5 * HOUR), null)
  assert.equal(decideGuard(guard, { known: false }, false, NOW + 1.5 * HOUR), 'resume')
  assert.equal(decideGuard({ on: true, pausedAt: 5, resetsAt: null }, { known: false }, false, NOW + 9 * HOUR), null)
})

test('paused and released round-trip the guard', () => {
  const status = { percent: 82, allowed: 80, resetsAt: 'r' }
  const stopped = paused({ on: true }, status, 7, true)
  assert.deepEqual(publicGuard(stopped), { on: true, pausedAt: 7, percent: 82, allowed: 80, resetsAt: 'r' })
  assert.equal(stopped.resumeWithPrompt, true)
  assert.deepEqual(released(stopped), { on: true })
  assert.equal(publicGuard({ on: false }), null)
  assert.equal(publicGuard(undefined), null)
})

test('parseGuardsFile keeps only valid switched-on entries', () => {
  const out = parseGuardsFile({ items: { local_a: { on: true, pausedAt: 4, percent: 80, allowed: 60, resumeWithPrompt: true }, local_b: { on: false }, 'bad id': { on: true }, local_c: { on: true, pausedAt: 'x' } } })
  assert.deepEqual(Object.keys(out), ['local_a', 'local_c'])
  assert.equal(out.local_a.pausedAt, 4)
  assert.equal(out.local_c.pausedAt, null)
  assert.deepEqual(parseGuardsFile(null), {})
})
