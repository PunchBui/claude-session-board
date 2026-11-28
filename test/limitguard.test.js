import test from 'node:test'
import assert from 'node:assert/strict'
import { allowedPercent, guardStatus, decideGuard, paused, released, publicGuard, parseGuardsFile } from '../lib/limitguard.js'

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
  assert.equal(guardStatus(limits(99, 0.5), NOW).clear, true)
})

test('a pause is released only once usage is 5 points under the cap', () => {
  const limits = (percent, hours) => ({ available: true, fiveHour: { percent, resetsAt: at(hours) } })
  assert.equal(guardStatus(limits(77, 2), NOW).clear, false)
  assert.equal(guardStatus(limits(75, 2), NOW).clear, true)
  assert.equal(guardStatus(limits(90, 1.5), NOW).clear, false)
  assert.equal(guardStatus(limits(90, 0.9), NOW).clear, true)
})

test('decideGuard pauses a running guarded session over the cap and resumes a paused one when clear', () => {
  const over = { known: true, over: true, clear: false }
  const clear = { known: true, over: false, clear: true }
  const between = { known: true, over: false, clear: false }
  assert.equal(decideGuard({ on: true }, over, true), 'pause')
  assert.equal(decideGuard({ on: true }, over, false), null)
  assert.equal(decideGuard({ on: true }, between, true), null)
  assert.equal(decideGuard({ on: false }, over, true), null)
  assert.equal(decideGuard(undefined, over, true), null)
  assert.equal(decideGuard({ on: true }, { known: false }, true), null)
  assert.equal(decideGuard({ on: true, pausedAt: 5 }, between, false), null)
  assert.equal(decideGuard({ on: true, pausedAt: 5 }, clear, false), 'resume')
  assert.equal(decideGuard({ on: true, pausedAt: 5 }, over, true), null)
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
