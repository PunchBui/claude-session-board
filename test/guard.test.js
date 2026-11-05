import test from 'node:test'
import assert from 'node:assert/strict'
import { refusalFor, refusalBody, createClaims, endedCleanly, classifyExit, settledAfterOwnRun } from '../lib/guard.js'
import { liveOf } from '../lib/live.js'
import { newScanState } from '../lib/scan.js'

const NOW = 1_000_000_000
const LOOKAHEAD = 15 * 60_000
const idle = (over = {}) => ({ active: false, touchedAt: NOW - 3_600_000, live: { attention: null }, loop: null, ...over })
const refuse = (card, run = null) => refusalFor({ card, run, nowMs: NOW, lookaheadMs: LOOKAHEAD })

test('an idle session is not refused', () => {
  assert.equal(refuse(idle()), null)
})

test('a running board run is refused as already running', () => {
  assert.equal(refuse(idle(), { state: 'running' }).code, 'running')
})

test('a pending question or approval refuses even though the card looks idle', () => {
  const found = refuse(idle({ live: { attention: { kind: 'approval', tool: 'Bash' } } }))
  assert.equal(found.code, 'attention')
  assert.match(found.message, /busy/)
  assert.equal(refuse(idle({ live: { attention: { kind: 'question' } } })).code, 'attention')
})

test('a loop that fires before a run could finish refuses, a distant one does not', () => {
  const soon = idle({ loop: { state: 'looping', nextAt: NOW + 60_000 } })
  const overdue = idle({ loop: { state: 'looping', nextAt: NOW - 5_000 } })
  const distant = idle({ loop: { state: 'looping', nextAt: NOW + LOOKAHEAD + 1 } })
  assert.equal(refuse(soon).code, 'loop')
  assert.equal(refuse(overdue).code, 'loop')
  assert.equal(refuse(distant), null)
  assert.equal(refuse(idle({ loop: { state: 'stalled', nextAt: NOW - 1_000_000 } })), null)
  assert.equal(refuse(idle({ loop: { state: 'looping', nextAt: null } })), null)
})

test('an active card is refused unless the only recent activity is the board run that just ended', () => {
  assert.equal(refuse(idle({ active: true, touchedAt: NOW - 1000 })).code, 'active')
  const run = { state: 'done', endedAt: NOW - 1000 }
  assert.equal(refuse(idle({ active: true, touchedAt: NOW - 1500 }), run), null)
  assert.equal(refuse(idle({ active: true, touchedAt: NOW + 10_000 }), run).code, 'active')
})

test('a killed run does not block a manual send while its own tail is the latest write', () => {
  const run = { state: 'stalled', endedAt: NOW - 500 }
  assert.equal(settledAfterOwnRun(run, { touchedAt: NOW - 600 }), true)
  assert.equal(settledAfterOwnRun({ ...run, state: 'running' }, { touchedAt: NOW - 600 }), false)
  assert.equal(settledAfterOwnRun(null, { touchedAt: NOW }), false)
})

test('every refusal can be queued and carries a code the client can match', () => {
  const body = refusalBody(refuse(idle({ live: { attention: { kind: 'question' } } })))
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'queueable'])
  assert.equal(body.queueable, true)
})

test('two claims on one session cannot both be held, and releasing frees it', () => {
  const claims = createClaims()
  const first = claims.claim('local_a')
  assert.equal(typeof first, 'function')
  assert.equal(claims.claim('local_a'), null)
  assert.equal(typeof claims.claim('local_b'), 'function')
  first()
  assert.equal(claims.has('local_a'), false)
  assert.equal(typeof claims.claim('local_a'), 'function')
})

test('concurrent sends with an async gap start exactly once', async () => {
  const claims = createClaims()
  let started = 0
  const send = async () => {
    const release = claims.claim('local_a')
    if (!release) return 'refused'
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      started += 1
      return 'started'
    } finally {
      release()
    }
  }
  const results = await Promise.all([send(), send(), send()])
  assert.deepEqual(results.sort(), ['refused', 'refused', 'started'])
  assert.equal(started, 1)
})

test('exit classification', () => {
  const base = { code: 0, signal: null, stopRequested: false, timedOut: false, cleanTail: true, errorText: '' }
  assert.equal(classifyExit(base).state, 'done')
  assert.equal(classifyExit({ ...base, cleanTail: null }).state, 'done')
  assert.equal(classifyExit({ ...base, cleanTail: false }).state, 'stalled')
  assert.equal(classifyExit({ ...base, stopRequested: true, signal: 'SIGTERM', cleanTail: false }).state, 'stopped')
  assert.equal(classifyExit({ ...base, code: null, signal: 'SIGKILL', cleanTail: false }).state, 'stalled')
  assert.match(classifyExit({ ...base, code: null, signal: 'SIGKILL', cleanTail: false }).error, /SIGKILL/)
  assert.equal(classifyExit({ ...base, code: null, signal: 'SIGTERM', cleanTail: true }).state, 'done')
  const timedOut = classifyExit({ ...base, timedOut: true, stopRequested: true, signal: 'SIGTERM', cleanTail: false })
  assert.equal(timedOut.state, 'stalled')
  assert.match(timedOut.error, /Timed out/)
  assert.deepEqual(classifyExit({ ...base, code: 1, errorText: 'auth failed' }), { state: 'failed', error: 'auth failed' })
  assert.equal(classifyExit({ ...base, code: 2 }).error, 'exit code 2')
})

test('a turn ends cleanly only on an end_turn stop', () => {
  assert.equal(endedCleanly({ lastStop: 'end_turn' }), true)
  assert.equal(endedCleanly({ lastStop: 'tool_use' }), false)
  assert.equal(endedCleanly({ lastStop: null }), false)
})

const tailedOn = (lastKind, extra = {}) => ({ ...newScanState(), lastKind, ...extra })
const live = (state, over = {}) => liveOf(state, { nowMs: NOW, mtimeMs: NOW - 120_000, running: false, ...over })

test('a transcript ending on a tool result reads as working when nothing says the run died', () => {
  assert.equal(live(tailedOn('tool_result')).working, true)
})

test('after a board run dies mid-turn the card is idle, not working for fifteen minutes', () => {
  const state = tailedOn('tool_result')
  assert.equal(live(state, { runEndedAt: NOW - 119_000 }).working, false)
  assert.equal(live(state, { runEndedAt: NOW - 119_000 }).phase, 'idle')
})

test('a pending tool left by a dead run does not raise a phantom approval', () => {
  const state = tailedOn('assistant_tool', { lastStop: 'tool_use' })
  state.pending.set('t1', { id: 't1', name: 'Bash', hint: 'sbt test', at: 'x' })
  assert.equal(live(state).attention.kind, 'approval')
  assert.equal(live(state, { runEndedAt: NOW - 119_000 }).attention, null)
})

test('activity after the run ended brings normal working detection back', () => {
  const state = tailedOn('tool_result')
  assert.equal(live(state, { runEndedAt: NOW - 600_000 }).working, true)
})
