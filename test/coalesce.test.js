import test from 'node:test'
import assert from 'node:assert/strict'
import { coalesce } from '../public/coalesce.js'

function deferredTask() {
  const calls = []
  let live = 0
  let peak = 0
  const task = () => {
    live += 1
    peak = Math.max(peak, live)
    const index = calls.length
    let finish
    const done = new Promise((resolve, reject) => { finish = { resolve, reject } })
    calls.push(finish)
    return done.then((value) => { live -= 1; return value ?? index }, (error) => { live -= 1; throw error })
  }
  return { task, calls, peak: () => peak }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('a single call runs the task once and resolves with its result', async () => {
  const { task, calls } = deferredTask()
  const run = coalesce(task)
  const result = run()
  await tick()
  assert.equal(calls.length, 1)
  calls[0].resolve('fresh')
  assert.equal(await result, 'fresh')
})

test('calls made while a run is in flight share one follow-up run that starts after it', async () => {
  const { task, calls, peak } = deferredTask()
  const run = coalesce(task)
  const first = run()
  await tick()
  const second = run()
  const third = run()
  assert.equal(second, third)
  await tick()
  assert.equal(calls.length, 1)
  calls[0].resolve('old')
  assert.equal(await first, 'old')
  await tick()
  assert.equal(calls.length, 2)
  calls[1].resolve('new')
  assert.equal(await second, 'new')
  assert.equal(peak(), 1)
})

test('a waiter never resolves with a run that started before it called', async () => {
  const { task, calls } = deferredTask()
  const run = coalesce(task)
  run()
  await tick()
  let settled = false
  const waiter = run().then((value) => { settled = true; return value })
  calls[0].resolve('stale')
  await tick()
  assert.equal(settled, false)
  calls[1].resolve('current')
  assert.equal(await waiter, 'current')
})

test('a failed run still lets the queued run go and later calls start fresh', async () => {
  const { task, calls } = deferredTask()
  const run = coalesce(task)
  const first = run()
  await tick()
  const second = run()
  calls[0].reject(new Error('offline'))
  await assert.rejects(first, /offline/)
  await tick()
  calls[1].resolve('back')
  assert.equal(await second, 'back')
  const third = run()
  await tick()
  assert.equal(calls.length, 3)
  calls[2].resolve('again')
  assert.equal(await third, 'again')
})
