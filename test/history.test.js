import test from 'node:test'
import assert from 'node:assert/strict'
import { addEvents, markAllRead, markRead, markSessionRead, unreadCount, HISTORY_LIMIT } from '../public/history.js'

const event = (over = {}) => ({ id: 'local_1', title: 'T', kind: 'finished', message: 'Finished working', ...over })

test('adds newest first and counts unread', () => {
  const first = addEvents([], [event({ message: 'a' })], 1000)
  const second = addEvents(first, [event({ message: 'b' })], 2000)
  assert.deepEqual(second.map((e) => e.message), ['b', 'a'])
  assert.equal(unreadCount(second), 2)
})

test('ignores the same event arriving twice within ten seconds', () => {
  const once = addEvents([], [event()], 1000)
  assert.equal(addEvents(once, [event()], 5000).length, 1)
  assert.equal(addEvents(once, [event()], 20_000).length, 2)
})

test('different kinds or sessions are not duplicates', () => {
  const once = addEvents([], [event()], 1000)
  assert.equal(addEvents(once, [event({ kind: 'question' }), event({ id: 'local_2' })], 1500).length, 3)
})

test('marks one or all entries read', () => {
  const list = addEvents([], [event({ message: 'a' }), event({ message: 'b' })], 1000)
  const one = markRead(list, list[0].uid)
  assert.equal(unreadCount(one), 1)
  assert.equal(unreadCount(markAllRead(one)), 0)
})

test('keeps at most the limit', () => {
  let list = []
  for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) list = addEvents(list, [event({ message: `m${i}` })], i * 20_000)
  assert.equal(list.length, HISTORY_LIMIT)
  assert.equal(list[0].message, `m${HISTORY_LIMIT + 19}`)
})

test('marks only the given session read', () => {
  const list = addEvents([], [event({ message: 'a' }), event({ id: 'local_2', message: 'b' }), event({ message: 'c' })], 1000)
  const next = markSessionRead(list, 'local_1')
  assert.deepEqual(next.filter((e) => !e.read).map((e) => e.id), ['local_2'])
})
