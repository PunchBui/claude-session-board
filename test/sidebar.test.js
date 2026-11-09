import test from 'node:test'
import assert from 'node:assert/strict'
import { groupOf, groupCards, pickSelected, neighbour, shortAge, flatten, sortCards, sortKey, SORTS, moveWithin } from '../public/sidebar.js'

const card = (id, over = {}) => ({ id, title: id, project: 'web', cwd: `/w/${id}`, active: false, ...over })

test('a pending question or approval wins over working', () => {
  assert.equal(groupOf(card('a', { active: true, live: { attention: { kind: 'question' } } })), 'need')
})

test('active sessions and board runs are working, everything else is idle', () => {
  assert.equal(groupOf(card('a', { active: true })), 'working')
  assert.equal(groupOf(card('b', { run: { state: 'running' } })), 'working')
  assert.equal(groupOf(card('c', { run: { state: 'done' } })), 'idle')
})

test('groups keep the incoming order and empty groups are dropped', () => {
  const groups = groupCards([card('i1'), card('w1', { active: true }), card('i2')])
  assert.deepEqual(groups.map((g) => g.key), ['working', 'idle'])
  assert.deepEqual(groups[1].cards.map((c) => c.id), ['i1', 'i2'])
})

test('the filter matches title, project and folder', () => {
  const cards = [card('a', { title: 'Fix checkout', project: 'api' }), card('b', { title: 'Docs', cwd: '/w/checkout-docs' })]
  assert.deepEqual(flatten(groupCards(cards, 'checkout')).map((c) => c.id), ['a', 'b'])
  assert.deepEqual(flatten(groupCards(cards, 'api')).map((c) => c.id), ['a'])
})

test('the selection falls back to the first card shown', () => {
  const groups = groupCards([card('i1'), card('n1', { live: { attention: { kind: 'question' } } })])
  assert.equal(pickSelected(groups, 'i1').id, 'i1')
  assert.equal(pickSelected(groups, 'gone').id, 'n1')
  assert.equal(pickSelected([], 'x'), null)
})

test('stepping follows the order shown and stops at the ends', () => {
  const groups = groupCards([card('i1'), card('w1', { active: true }), card('i2')])
  assert.equal(neighbour(groups, 'w1', 1), 'i1')
  assert.equal(neighbour(groups, 'i2', 1), 'i2')
  assert.equal(neighbour(groups, 'w1', -1), 'w1')
  assert.equal(neighbour(groups, 'unknown', 1), 'w1')
})

test('ages are short', () => {
  const now = 10_000_000
  assert.equal(shortAge(now - 20_000, now), 'now')
  assert.equal(shortAge(now - 3 * 60_000, now), '3m')
  assert.equal(shortAge(now - 5 * 3_600_000, now), '5h')
  assert.equal(shortAge(now - 2 * 86_400_000, now), '2d')
  assert.equal(shortAge(0, now), '')
})

const ids = (cards) => cards.map((c) => c.id)

test('manual order and unknown modes keep the incoming order', () => {
  const cards = [card('b'), card('a'), card('c')]
  assert.deepEqual(ids(sortCards(cards, 'manual')), ['b', 'a', 'c'])
  assert.deepEqual(ids(sortCards(cards, 'nonsense')), ['b', 'a', 'c'])
  assert.equal(sortKey('nonsense'), 'manual')
  assert.deepEqual(SORTS.map((s) => s.key), ['manual', 'prompt', 'activity', 'title', 'project'])
})

test('sorting never changes the input array', () => {
  const cards = [card('b', { title: 'b' }), card('a', { title: 'a' })]
  sortCards(cards, 'title')
  assert.deepEqual(ids(cards), ['b', 'a'])
})

test('last prompt and last activity put the newest first', () => {
  const cards = [card('old', { touchedAt: 1 }), card('new', { touchedAt: 9 }), card('mid', { touchedAt: 5 })]
  const at = { old: 5, new: 1, mid: 3 }
  assert.deepEqual(ids(sortCards(cards, 'prompt', { promptAt: (c) => at[c.id] })), ['old', 'mid', 'new'])
  assert.deepEqual(ids(sortCards(cards, 'activity')), ['new', 'mid', 'old'])
  assert.deepEqual(ids(sortCards([card('x', { lastActivityAt: 2 }), card('y', { lastActivityAt: 7 }), card('z')], 'activity')), ['y', 'x', 'z'])
})

test('name sorting ignores case and orders numbers naturally', () => {
  const cards = [card('1', { title: 'beta' }), card('2', { title: 'Alpha' }), card('3', { title: 'task 10' }), card('4', { title: 'Task 2' })]
  assert.deepEqual(ids(sortCards(cards, 'title')), ['2', '1', '4', '3'])
})

test('project sorting groups by project, then name, with no project last', () => {
  const cards = [card('1', { project: 'web', title: 'b' }), card('2', { project: null, title: 'a' }), card('3', { project: 'api', title: 'z' }), card('4', { project: 'web', title: 'a' })]
  assert.deepEqual(ids(sortCards(cards, 'project')), ['3', '4', '1', '2'])
})

test('sorting applies inside each group, not across them', () => {
  const cards = [card('i2', { title: 'b' }), card('w', { title: 'z', active: true }), card('i1', { title: 'a' })]
  const groups = groupCards(sortCards(cards, 'title'))
  assert.deepEqual(groups.map((g) => ids(g.cards)), [['w'], ['i1', 'i2']])
})

test('moving a session lands before or after the target', () => {
  assert.deepEqual(moveWithin(['a', 'b', 'c', 'd'], 'd', 'b', false), ['a', 'd', 'b', 'c'])
  assert.deepEqual(moveWithin(['a', 'b', 'c', 'd'], 'a', 'c', true), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveWithin(['a', 'b', 'c'], 'a', 'b', false), ['a', 'b', 'c'])
})

test('moves onto itself, unknown ids or another group change nothing', () => {
  const order = ['a', 'b', 'c']
  assert.equal(moveWithin(order, 'a', 'a', true), order)
  assert.equal(moveWithin(order, 'x', 'a', true), order)
  assert.equal(moveWithin(order, 'a', 'x', true), order)
  assert.equal(moveWithin(order, 'a', 'c', true, (x, y) => x === y), order)
})
