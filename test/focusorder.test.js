import test from 'node:test'
import assert from 'node:assert/strict'
import { reorderFocus } from '../lib/focusorder.js'

test('the requested order wins', () => {
  assert.deepEqual(reorderFocus(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b'])
})

test('ids that are not in Focus are dropped and duplicates collapse', () => {
  assert.deepEqual(reorderFocus(['a', 'b'], ['x', 'b', 'b', 'a']), ['b', 'a'])
})

test('sessions the request left out keep their order at the end', () => {
  assert.deepEqual(reorderFocus(['a', 'b', 'c', 'd'], ['c', 'a']), ['c', 'a', 'b', 'd'])
})

test('a bad request changes nothing', () => {
  assert.deepEqual(reorderFocus(['a', 'b'], null), ['a', 'b'])
  assert.deepEqual(reorderFocus([], ['a']), [])
})
