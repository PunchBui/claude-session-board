import test from 'node:test'
import assert from 'node:assert/strict'
import { setBounded } from '../lib/cache.js'

test('a bounded map drops its oldest entries and a rewritten key counts as newest', () => {
  const map = new Map()
  for (const key of ['a', 'b', 'c']) setBounded(map, key, key.toUpperCase(), 3)
  setBounded(map, 'a', 'A2', 3)
  setBounded(map, 'd', 'D', 3)
  assert.deepEqual([...map.keys()], ['c', 'a', 'd'])
  assert.equal(map.get('a'), 'A2')
  for (let n = 0; n < 100; n++) setBounded(map, `k${n}`, n, 3)
  assert.equal(map.size, 3)
})
