import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { matchesRun, validEntry, isSavedRunAlive, remainingMs, adoptedRun, watchUntilGone, adoptedOutcome, isPidAlive, commandOf } from '../lib/adopt.js'

const ID = '3f2a9c1e-77aa-4b0d-9d3c-0a1b2c3d4e5f'
const COMMAND = `/Users/me/.local/bin/claude -p --resume ${ID} --output-format json --permission-mode bypassPermissions --add-dir /tmp/uploads`
const entry = (over = {}) => ({ pid: 4242, startedAt: 1_000_000, mode: 'bypassPermissions', handoffFile: null, cliSessionId: ID, ...over })
const probe = ({ alive = true, command = COMMAND } = {}) => ({ isAlive: () => alive, commandOf: async () => command })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a claude process resuming the saved cli session counts', () => {
  assert.equal(matchesRun(COMMAND, ID), true)
  assert.equal(matchesRun(`node /opt/claude/cli.js -p --resume ${ID}`, ID), true)
})

test('another session, a missing resume flag, a non-claude process or an interactive claude does not count', () => {
  assert.equal(matchesRun(COMMAND, 'aaaaaaaa-0000-0000-0000-000000000000'), false)
  assert.equal(matchesRun(`/bin/claude -p --resume ${ID}-extra`, ID), false)
  assert.equal(matchesRun(`/bin/claude -p ${ID}`, ID), false)
  assert.equal(matchesRun(`/usr/bin/python server.py -p --resume ${ID}`, ID), false)
  assert.equal(matchesRun(`/bin/claude --resume ${ID}`, ID), false)
  assert.equal(matchesRun('', ID), false)
  assert.equal(matchesRun(undefined, ID), false)
})

test('a cli session id that could change the pattern never matches', () => {
  assert.equal(matchesRun(COMMAND, '.*'), false)
  assert.equal(matchesRun(COMMAND, null), false)
})

test('a saved entry needs a real pid, start time and cli session id', () => {
  assert.equal(validEntry(entry()), true)
  assert.equal(validEntry(null), false)
  assert.equal(validEntry(entry({ pid: 0 })), false)
  assert.equal(validEntry(entry({ pid: 1 })), false)
  assert.equal(validEntry(entry({ pid: '4242' })), false)
  assert.equal(validEntry(entry({ startedAt: 'now' })), false)
  assert.equal(validEntry(entry({ cliSessionId: 'a b' })), false)
  assert.equal(validEntry(entry({ cliSessionId: undefined })), false)
})

test('a saved run is alive only when the pid exists and runs that resume', async () => {
  assert.equal(await isSavedRunAlive(entry(), probe()), true)
  assert.equal(await isSavedRunAlive(entry(), probe({ alive: false })), false)
  assert.equal(await isSavedRunAlive(entry(), probe({ command: '/usr/sbin/cupsd -l' })), false)
  assert.equal(await isSavedRunAlive(entry(), probe({ command: '' })), false)
  assert.equal(await isSavedRunAlive(entry({ pid: -5 }), probe()), false)
})

test('a dead pid is never asked for its command line', async () => {
  let asked = false
  const spy = { isAlive: () => false, commandOf: async () => { asked = true; return COMMAND } }
  assert.equal(await isSavedRunAlive(entry(), spy), false)
  assert.equal(asked, false)
})

test('the remaining timeout counts from the original start and never goes negative', () => {
  assert.equal(remainingMs(1000, 1000, 900_000), 900_000)
  assert.equal(remainingMs(1000, 301_000, 900_000), 600_000)
  assert.equal(remainingMs(1000, 5_000_000, 900_000), 0)
})

test('an adopted run keeps the original start and mode, and is marked adopted', () => {
  const run = adoptedRun(entry(), { graceMs: 50 })
  assert.equal(run.state, 'running')
  assert.equal(run.adopted, true)
  assert.equal(run.startedAt, 1_000_000)
  assert.equal(run.mode, 'bypassPermissions')
  assert.equal(run.endedAt, null)
  assert.equal(run.stopRequested, false)
  assert.equal(run.timedOut, false)
  assert.equal(run.handoff, null)
})

test('an adopted handoff run knows its document', () => {
  const run = adoptedRun(entry({ handoffFile: '/tmp/handoff.md' }), { graceMs: 50 })
  assert.deepEqual(run.handoff, { file: '/tmp/handoff.md', ready: false })
})

test('stopping an adopted run terminates the group, then kills it if it lingers', () => {
  const sent = []
  const timers = []
  const run = adoptedRun(entry(), { graceMs: 5000, signal: (pid, name) => sent.push([pid, name]), isAlive: () => true, schedule: (fn, ms) => { timers.push([fn, ms]); return {} } })
  run.stop()
  assert.equal(run.stopRequested, true)
  assert.deepEqual(sent, [[4242, 'SIGTERM']])
  assert.equal(timers[0][1], 5000)
  timers[0][0]()
  assert.deepEqual(sent, [[4242, 'SIGTERM'], [4242, 'SIGKILL']])
})

test('a run that exits within the grace period is not killed again', () => {
  const sent = []
  const timers = []
  const run = adoptedRun(entry(), { graceMs: 5000, signal: (pid, name) => sent.push(name), isAlive: () => false, schedule: (fn) => { timers.push(fn); return {} } })
  run.stop()
  timers[0]()
  assert.deepEqual(sent, ['SIGTERM'])
})

test('the watcher fires once when the pid disappears, and not before', async () => {
  let alive = true
  let fired = 0
  watchUntilGone(4242, { isAlive: () => alive, pollMs: 5, onGone: () => { fired += 1 } })
  await sleep(40)
  assert.equal(fired, 0)
  alive = false
  await sleep(40)
  assert.equal(fired, 1)
})

test('a cancelled watcher never fires', async () => {
  let fired = 0
  const cancel = watchUntilGone(4242, { isAlive: () => false, pollMs: 5, onGone: () => { fired += 1 } })
  cancel()
  await sleep(30)
  assert.equal(fired, 0)
})

test('an adopted run that ends cleanly is done, otherwise stalled', () => {
  assert.equal(adoptedOutcome({ stopRequested: false, timedOut: false, endedCleanly: true }).state, 'done')
  const stalled = adoptedOutcome({ stopRequested: false, timedOut: false, endedCleanly: false })
  assert.equal(stalled.state, 'stalled')
  assert.match(stalled.error, /before finishing its turn/)
  assert.equal(adoptedOutcome({ stopRequested: false, timedOut: false, endedCleanly: undefined }).state, 'stalled')
})

test('a stop request means stopped and a timeout means stalled, whatever the tail says', () => {
  assert.equal(adoptedOutcome({ stopRequested: true, timedOut: false, endedCleanly: false }).state, 'stopped')
  assert.equal(adoptedOutcome({ stopRequested: true, timedOut: false, endedCleanly: true }).state, 'stopped')
  assert.equal(adoptedOutcome({ stopRequested: true, timedOut: true, endedCleanly: true }).state, 'stalled')
})

test('the real probes see this process and a vanished pid', async () => {
  assert.equal(isPidAlive(process.pid), true)
  const child = spawn('true')
  await once(child, 'close')
  assert.equal(isPidAlive(child.pid), false)
  assert.match(await commandOf(process.pid), /node/)
  assert.equal(await commandOf(child.pid), '')
})
