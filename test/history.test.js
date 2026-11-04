import test from 'node:test'
import assert from 'node:assert/strict'
import { addEvents, markAllRead, markRead, markSessionRead, unreadCount, HISTORY_LIMIT } from '../public/history.js'

const event = (over = {}) => ({ id: 'local_1', title: 'T', kind: 'finished', message: 'Finished working', ...over })

test('adds newest first and counts unread', () => {
  const first = addEvents([], [event({ id: 'local_1', message: 'a' })], 1000)
  const second = addEvents(first, [event({ id: 'local_2', message: 'b' })], 2000)
  assert.deepEqual(second.map((e) => e.message), ['b', 'a'])
  assert.equal(unreadCount(second), 2)
})

test('ignores the same event arriving twice within ten seconds', () => {
  const once = addEvents([], [event()], 1000)
  assert.equal(addEvents(once, [event()], 5000).length, 1)
  assert.equal(addEvents(once, [event()], 5000)[0].at, 1000)
})

test('a session keeps only its latest notification', () => {
  const first = addEvents([], [event({ message: 'Finished working' })], 1000)
  const second = addEvents(first, [event({ kind: 'question', message: 'Asking you: which env?' })], 2000)
  assert.equal(second.length, 1)
  assert.deepEqual([second[0].kind, second[0].message, second[0].at], ['question', 'Asking you: which env?', 2000])
  assert.equal(addEvents(second, [event({ message: 'Finished working' })], 30_000).length, 1)
})

test('the latest replaces an older read one and comes back unread', () => {
  const first = addEvents([], [event({ message: 'a' })], 1000)
  const read = markAllRead(first)
  const next = addEvents(read, [event({ message: 'b' })], 20_000)
  assert.equal(next.length, 1)
  assert.equal(unreadCount(next), 1)
})

test('events for other sessions are untouched and ordered newest first', () => {
  let list = addEvents([], [event({ id: 'local_1', message: 'one' }), event({ id: 'local_2', message: 'two' })], 1000)
  list = addEvents(list, [event({ id: 'local_1', message: 'one again' })], 20_000)
  assert.deepEqual(list.map((e) => [e.id, e.message]), [['local_1', 'one again'], ['local_2', 'two']])
})

test('several events for one session in the same batch collapse to the last', () => {
  const list = addEvents([], [event({ kind: 'finished', message: 'x' }), event({ kind: 'context', message: 'Context passed 100k' })], 1000)
  assert.deepEqual(list.map((e) => e.kind), ['context'])
})

test('marks one or all entries read', () => {
  const list = addEvents([], [event({ id: 'local_1', message: 'a' }), event({ id: 'local_2', message: 'b' })], 1000)
  const one = markRead(list, list[0].uid)
  assert.equal(unreadCount(one), 1)
  assert.equal(unreadCount(markAllRead(one)), 0)
})

test('keeps at most the limit', () => {
  let list = []
  for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) list = addEvents(list, [event({ id: `local_${i}`, message: `m${i}` })], i * 20_000)
  assert.equal(list.length, HISTORY_LIMIT)
  assert.equal(list[0].message, `m${HISTORY_LIMIT + 19}`)
})

test('marks only the given session read', () => {
  const list = addEvents([], [event({ message: 'a' }), event({ id: 'local_2', message: 'b' }), event({ message: 'c' })], 1000)
  const next = markSessionRead(list, 'local_1')
  assert.deepEqual(next.filter((e) => !e.read).map((e) => e.id), ['local_2'])
})
