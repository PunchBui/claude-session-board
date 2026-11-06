import test from 'node:test'
import assert from 'node:assert/strict'
import { listOps, phaseLabel } from '../public/patch.js'

test('an unchanged list keeps every node', () => {
  assert.deepEqual(listOps(['a', 'b'], ['a', 'b']), { ops: ['keep', 'keep'], remove: 0 })
})

test('a new message is appended and the old ones are untouched', () => {
  assert.deepEqual(listOps(['a', 'b'], ['a', 'b', 'c']), { ops: ['keep', 'keep', 'append'], remove: 0 })
})

test('only the node whose html changed is replaced', () => {
  assert.deepEqual(listOps(['a', 'b', 'w1'], ['a', 'b', 'w2']), { ops: ['keep', 'keep', 'replace'], remove: 0 })
})

test('a finished working row is removed', () => {
  assert.deepEqual(listOps(['a', 'w'], ['a']), { ops: ['keep'], remove: 1 })
})

test('phase labels follow the live state', () => {
  assert.equal(phaseLabel(null), null)
  assert.equal(phaseLabel({ phase: 'idle' }), null)
  assert.equal(phaseLabel({ phase: 'thinking' }), 'Thinking…')
  assert.equal(phaseLabel({ phase: 'writing' }), 'Writing a reply…')
  assert.equal(phaseLabel({ phase: 'tool', current: { name: 'Bash' } }), 'Running Bash')
})
