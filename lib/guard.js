import { SETTLE_MS } from './live.js'

const MESSAGES = {
  running: 'a prompt is already running for this session',
  attention: 'session is busy: it is waiting for an answer or approval in the desktop app',
  loop: 'session is busy: a scheduled loop will fire in the desktop app before a run could finish',
  active: 'session is busy in the desktop app; try again when it is idle',
}

const refusal = (code) => ({ code, message: MESSAGES[code], queueable: true })

export function settledAfterOwnRun(run, card) {
  return Boolean(run?.endedAt) && run.state !== 'running' && card.touchedAt <= run.endedAt + SETTLE_MS
}

export function refusalFor({ card, run, nowMs, lookaheadMs }) {
  if (run?.state === 'running') return refusal('running')
  if (card.live?.attention) return refusal('attention')
  const loop = card.loop
  if (loop?.state === 'looping' && loop.nextAt != null && loop.nextAt - nowMs < lookaheadMs) return refusal('loop')
  if (card.active && !settledAfterOwnRun(run, card)) return refusal('active')
  return null
}

export const refusalBody = (found) => ({ error: found.message, code: found.code, queueable: found.queueable })

export function createClaims() {
  const held = new Set()
  return {
    has: (id) => held.has(id),
    claim(id) {
      if (held.has(id)) return null
      held.add(id)
      return () => held.delete(id)
    },
  }
}

export const endedCleanly = (state) => state.lastStop === 'end_turn'

const INTERFERED_MESSAGE = 'Stopped because the desktop app wrote to this session during the run.'

export function classifyExit({ code, signal, stopRequested, timedOut, interfered, cleanTail, errorText }) {
  if (timedOut) return { state: 'stalled', error: 'Timed out and was stopped before finishing its turn.' }
  if (interfered) return { state: 'stalled', error: INTERFERED_MESSAGE }
  if (stopRequested) return { state: 'stopped', error: null }
  const finished = cleanTail !== false
  if (signal) return finished ? { state: 'done', error: null } : { state: 'stalled', error: `Killed by ${signal} before finishing its turn.` }
  if (code === 0) return finished ? { state: 'done', error: null } : { state: 'stalled', error: 'Exited before finishing its turn.' }
  return { state: 'failed', error: errorText || `exit code ${code}` }
}
