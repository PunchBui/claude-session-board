import test from 'node:test'
import assert from 'node:assert/strict'
import { groupOf, cardTitle, visibleGroups, groupSummary, groupCards, pickSelected, neighbour, shortAge, flatten, sortCards, sortKey, SORTS, moveWithin } from '../public/sidebar.js'

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

test('babysit sessions get their own group between Needs you and Working', () => {
  const babysit = { url: 'https://gitlab.example.com/t/r/-/merge_requests/1', state: 'watching' }
  assert.equal(groupOf(card('b', { babysit })), 'babysit')
  assert.equal(groupOf(card('b', { babysit, active: true })), 'babysit')
  assert.equal(groupOf(card('b', { babysit, run: { state: 'running' } })), 'babysit')
  assert.equal(groupOf(card('b', { babysit, live: { attention: { kind: 'question' } } })), 'need')
  const groups = groupCards([card('i1'), card('w1', { active: true }), card('b1', { babysit }), card('n1', { live: { attention: { kind: 'question' } } })])
  assert.deepEqual(groups.map((g) => [g.key, g.label]), [['need', 'Needs you'], ['babysit', 'Babysit'], ['working', 'Working'], ['idle', 'Idle']])
  assert.deepEqual(groups[1].cards.map((c) => c.id), ['b1'])
})

test('a babysit session is titled by its merge request number, other sessions keep their title', () => {
  const babysit = { url: 'https://gitlab.example.com/t/r/-/merge_requests/3481', state: 'watching' }
  assert.equal(cardTitle(card('b', { title: '/csb-babysit https://gitlab.example.com/t/r/-/merge_requests/3481', babysit })), 'Babysit !3481')
  assert.equal(cardTitle(card('x', { title: 'Fix checkout' })), 'Fix checkout')
  assert.equal(cardTitle(card('y', { title: 'Odd', babysit: { url: 'nope', state: 'watching' } })), 'Odd')
})

const babysitCards = () => [card('b1', { babysit: { url: 'u', state: 'watching' } }), card('b2', { babysit: { url: 'u', state: 'watching' } }), card('i1')]

test('a collapsed babysit group hides its cards but keeps the header and the total', () => {
  const [babysit, idle] = visibleGroups(groupCards(babysitCards()), new Set(['babysit']), 'i1')
  assert.deepEqual([babysit.key, babysit.collapsed, babysit.total, babysit.cards.length], ['babysit', true, 2, 0])
  assert.deepEqual(idle.cards.map((c) => c.id), ['i1'])
})

test('the selected card stays visible in a collapsed group', () => {
  const [babysit] = visibleGroups(groupCards(babysitCards()), new Set(['babysit']), 'b2')
  assert.deepEqual(babysit.cards.map((c) => c.id), ['b2'])
})

test('only the babysit group can collapse, and a filter shows every match', () => {
  const groups = groupCards([...babysitCards(), card('w1', { active: true })])
  const collapsed = visibleGroups(groups, new Set(['babysit', 'working', 'idle']), null)
  assert.deepEqual(collapsed.map((g) => [g.key, g.collapsed]), [['babysit', true], ['working', false], ['idle', false]])
  const filtering = visibleGroups(groups, new Set(['babysit']), null, true)
  assert.deepEqual(filtering.map((g) => g.cards.length), [2, 1, 1])
})

test('stepping skips cards hidden in a collapsed group', () => {
  const groups = visibleGroups(groupCards(babysitCards()), new Set(['babysit']), 'i1')
  assert.equal(neighbour(groups, 'i1', -1), 'i1')
})

test('the babysit summary counts running and idle sessions and finds the earliest scheduled check', () => {
  const babysit = { url: 'u', state: 'watching' }
  const cards = [
    card('a', { babysit, active: true, schedules: [{ at: 5000 }] }),
    card('b', { babysit, run: { state: 'running' } }),
    card('c', { babysit, schedules: [{ at: 3000 }, { at: 9000 }] }),
    card('d', { babysit }),
  ]
  assert.deepEqual(groupSummary(cards), { running: 2, idle: 2, nextAt: 3000 })
  assert.deepEqual(groupSummary([card('x', { babysit })]), { running: 0, idle: 1, nextAt: null })
})

test('a collapsed group still summarises all of its sessions', () => {
  const babysit = { url: 'u', state: 'watching' }
  const groups = groupCards([card('a', { babysit, active: true }), card('b', { babysit, schedules: [{ at: 7000 }] })])
  const [group] = visibleGroups(groups, new Set(['babysit']), null)
  assert.equal(group.cards.length, 0)
  assert.deepEqual(group.summary, { running: 1, idle: 1, nextAt: 7000 })
  assert.equal(visibleGroups(groupCards([card('i')]), new Set(), null)[0].summary, null)
})
