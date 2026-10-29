import test from 'node:test'
import assert from 'node:assert/strict'
import { newSessionIds } from '../public/autofocus.js'

const session = (id, over = {}) => ({ id, archived: false, ...over })

test('the first load only records a baseline', () => {
  const { fresh, next } = newSessionIds(null, [session('a'), session('b')], [])
  assert.deepEqual(fresh, [])
  assert.deepEqual([...next], ['a', 'b'])
})

test('a session that appears after the baseline is reported once', () => {
  const first = newSessionIds(null, [session('a')], []).next
  const second = newSessionIds(first, [session('a'), session('b')], [])
  assert.deepEqual(second.fresh, ['b'])
  assert.deepEqual(newSessionIds(second.next, [session('a'), session('b')], []).fresh, [])
})

test('archived and already focused sessions are skipped', () => {
  const known = new Set(['a'])
  const { fresh } = newSessionIds(known, [session('a'), session('b', { archived: true }), session('c'), session('d')], ['c'])
  assert.deepEqual(fresh, ['d'])
})

test('a session the user unfocused is not added again', () => {
  const known = newSessionIds(null, [session('a')], ['a']).next
  assert.deepEqual(newSessionIds(known, [session('a')], []).fresh, [])
})
