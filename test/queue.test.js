import test from 'node:test'
import assert from 'node:assert/strict'
import { settleForce } from '../lib/queue.js'

const queue = () => ({ items: [{ qid: 'a' }, { qid: 'b' }], paused: true })

test('a forced prompt that started leaves the queue and restores the pause it had before', () => {
  const q = queue()
  settleForce(q, 'a', { status: 202, interrupting: true, wasPaused: false })
  assert.deepEqual(q.items.map((entry) => entry.qid), ['b'])
  assert.equal(q.paused, false)
})

test('a forced prompt that was refused keeps the item and still restores the pause', () => {
  for (const status of [400, 404, 409, 500]) {
    const q = queue()
    settleForce(q, 'a', { status, interrupting: true, wasPaused: false })
    assert.deepEqual(q.items.map((entry) => entry.qid), ['a', 'b'], String(status))
    assert.equal(q.paused, false, String(status))
  }
})

test('without an interrupt the pause is left as it is', () => {
  const q = queue()
  settleForce(q, 'a', { status: 409, interrupting: false, wasPaused: false })
  assert.equal(q.paused, true)
})
