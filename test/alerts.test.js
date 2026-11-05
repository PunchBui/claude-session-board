import test from 'node:test'
import assert from 'node:assert/strict'
import { diffAlerts, contextLevel } from '../public/alerts.js'

const card = (over = {}) => ({ id: 'local_1', title: 'T', active: false, status: 'completed', usage: { context: 1000 }, live: { attention: null }, run: null, queue: { paused: false }, ...over })

test('no events on the first snapshot', () => {
  assert.equal(diffAlerts(null, [card()]).events.length, 0)
})

test('working to idle fires finished, but not while a run is going', () => {
  const first = diffAlerts(null, [card({ active: true })]).next
  assert.equal(diffAlerts(first, [card({ active: false })]).events[0].kind, 'finished')
  assert.equal(diffAlerts(first, [card({ active: false, run: { state: 'running' } })]).events.length, 0)
})

test('attention, blocked and failure each fire once', () => {
  const first = diffAlerts(null, [card()]).next
  const second = diffAlerts(first, [card({ live: { attention: { kind: 'question', text: 'Which env?' } }, status: 'blocked', usage: { context: 150000 }, run: { state: 'failed' }, queue: { paused: true } })])
  assert.deepEqual(second.events.map((e) => e.kind).sort(), ['blocked', 'failed', 'paused', 'question'])
  const third = diffAlerts(second.next, [card({ live: { attention: { kind: 'question', text: 'Which env?' } }, status: 'blocked', usage: { context: 150000 }, run: { state: 'failed' }, queue: { paused: true } })])
  assert.equal(third.events.length, 0)
})

test('a stalled board run alerts once and does not also claim the session finished', () => {
  const first = diffAlerts(null, [card({ active: true, run: { state: 'running' } })]).next
  const second = diffAlerts(first, [card({ active: false, run: { state: 'stalled' }, queue: { paused: true } })])
  assert.deepEqual(second.events.map((e) => e.kind).sort(), ['paused', 'stalled'])
  assert.equal(diffAlerts(second.next, [card({ active: false, run: { state: 'stalled' }, queue: { paused: true } })]).events.length, 0)
})

test('context level thresholds', () => {
  assert.equal(contextLevel(99999), null)
  assert.equal(contextLevel(100000), 'caution')
  assert.equal(contextLevel(200000), 'danger')
})

test('crossing a context threshold does not raise an alert', () => {
  const first = diffAlerts(null, [card()]).next
  const caution = diffAlerts(first, [card({ usage: { context: 150000 } })])
  assert.equal(caution.events.length, 0)
  assert.equal(diffAlerts(caution.next, [card({ usage: { context: 250000 } })]).events.length, 0)
})
