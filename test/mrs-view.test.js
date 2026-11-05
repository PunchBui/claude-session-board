import test from 'node:test'
import assert from 'node:assert/strict'
import { FILTERS, mergeMrs, orderMrs, visibleMrs, tempCounts, mrTemperature, mrWarmthTip } from '../public/mrs.js'

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
