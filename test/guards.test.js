import test from 'node:test'
import assert from 'node:assert/strict'
import { latestOnly, forcedRerun, polledPane, broadcastState, defaultTicked, differs, navigationMode, BROADCAST_LIMIT } from '../public/guards.js'

const gate = () => {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

test('only the latest request is allowed to render', () => {
  const next = latestOnly()
  const first = next()
  const second = next()
  assert.equal(first(), false)
  assert.equal(second(), true)
  const third = next()
  assert.equal(second(), false)
  assert.equal(third(), true)
})

test('a forced load during an in-flight load runs once more after it', async () => {
  const calls = []
  const gates = []
  const run = forcedRerun((force) => {
    calls.push(force)
    const g = gate()
    gates.push(g)
    return g.promise
  })
  const first = run()
  const polled = run()
  const forcedA = run(true)
  const forcedB = run(true)
  assert.equal(calls.length, 1)
  gates[0].release()
  await first
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2)
  assert.equal(calls[1], true)
  gates[1].release()
  await Promise.all([polled, forcedA, forcedB])
  assert.equal(calls.length, 2)
  run()
  assert.equal(calls.length, 3)
})

test('a plain load while one is in flight is dropped', () => {
  let calls = 0
  const g = gate()
  const run = forcedRerun(() => { calls++; return g.promise })
  run()
  run()
  run()
  assert.equal(calls, 1)
  g.release()
})

test('only the selected card on the Focus view is polled', () => {
  const paneOf = (id) => ({ a: 'changes', b: 'agents' })[id] ?? 'chat'
  assert.equal(polledPane({ tab: 'focus', draft: false, selectedId: 'a', paneOf }), 'changes')
  assert.equal(polledPane({ tab: 'focus', draft: false, selectedId: 'b', paneOf }), 'agents')
  assert.equal(polledPane({ tab: 'mrs', draft: false, selectedId: 'a', paneOf }), null)
  assert.equal(polledPane({ tab: 'focus', draft: true, selectedId: 'a', paneOf }), null)
  assert.equal(polledPane({ tab: 'focus', draft: false, selectedId: null, paneOf }), null)
})

test('broadcast ticks at most the server limit and blocks sending beyond it', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `s${i}`)
  assert.equal(defaultTicked(ids).length, BROADCAST_LIMIT)
  assert.deepEqual(defaultTicked(['a', 'b']), ['a', 'b'])
  const limited = broadcastState(30, 20)
  assert.equal(limited.canSend, true)
  assert.match(limited.note, /first 20 of 30/)
  const over = broadcastState(30, 22)
  assert.equal(over.canSend, false)
  assert.match(over.note, /untick 2/)
  assert.deepEqual(broadcastState(5, 5), { over: false, note: '', canSend: true })
  assert.equal(broadcastState(5, 0).canSend, false)
})

test('differs compares data by value', () => {
  assert.equal(differs({ a: [1] }, { a: [1] }), false)
  assert.equal(differs({ a: [1] }, { a: [2] }), true)
  assert.equal(differs(null, { a: 1 }), true)
})

test('navigating from the drawer replaces its history entry', () => {
  assert.equal(navigationMode({}, false), 'push')
  assert.equal(navigationMode(null, true), 'none')
  assert.equal(navigationMode({ drawer: true }, false), 'replace')
  assert.equal(navigationMode({ drawer: true }, true), 'back')
})
