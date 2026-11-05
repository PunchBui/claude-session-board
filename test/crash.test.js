import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describeError, installCrashGuard, eachIsolated, logged } from '../lib/crash.js'

test('an error is described by its stack and anything else by its text', () => {
  assert.match(describeError(new Error('boom')), /boom/)
  assert.equal(describeError('plain'), 'plain')
  assert.equal(describeError(undefined), 'undefined')
})

test('an unhandled rejection is logged and can be uninstalled', () => {
  const proc = new EventEmitter()
  const lines = []
  const remove = installCrashGuard(proc, (line) => lines.push(line))
  proc.emit('unhandledRejection', new Error('lost promise'))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /unhandled rejection: .*lost promise/s)
  remove()
  assert.equal(proc.listenerCount('unhandledRejection'), 0)
})

const CRASH_MODULE = fileURLToPath(new URL('../lib/crash.js', import.meta.url))

function runScript(body) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import { installCrashGuard } from ${JSON.stringify(CRASH_MODULE)}\n${body}`], { encoding: 'utf8' })
}

test('a real unhandled rejection kills a process without the guard', () => {
  const result = runScript(`Promise.reject(new Error('nobody awaits me')); setTimeout(() => console.log('still alive'), 50)`)
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /still alive/)
})

test('a real unhandled rejection is logged to stderr and the process keeps running with the guard', () => {
  const result = runScript(`installCrashGuard(); Promise.reject(new Error('nobody awaits me')); setTimeout(() => console.log('still alive'), 50)`)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /still alive/)
  assert.match(result.stderr, /unhandled rejection: .*nobody awaits me/s)
})

test('one failing item does not stop the others and is reported with its item', async () => {
  const done = []
  const failures = []
  await eachIsolated(['a', 'b', 'c'], async (item) => {
    if (item === 'b') throw new Error('bad session')
    done.push(item)
  }, (error, item) => failures.push([item, error.message]))
  assert.deepEqual(done, ['a', 'c'])
  assert.deepEqual(failures, [['b', 'bad session']])
})

test('items are handled one at a time, in order', async () => {
  const order = []
  await eachIsolated([1, 2, 3], async (item) => {
    order.push(`start ${item}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push(`end ${item}`)
  }, () => {})
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
})

test('a logged function returns its value, and swallows and logs a failure', async () => {
  const lines = []
  const ok = logged('ok', async (a, b) => a + b, (line) => lines.push(line))
  const bad = logged('bad', async () => { throw new Error('nope') }, (line) => lines.push(line))
  assert.equal(await ok(1, 2), 3)
  assert.equal(await bad(), undefined)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^bad: .*nope/s)
})
