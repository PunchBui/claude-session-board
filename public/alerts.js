export const CONTEXT_CAUTION = 100_000
export const CONTEXT_DANGER = 200_000

export function contextLevel(n) {
  return n >= CONTEXT_DANGER ? 'danger' : n >= CONTEXT_CAUTION ? 'caution' : null
}

const LEVEL_RANK = { null: 0, caution: 1, danger: 2 }

export function snapshot(card) {
  return {
    active: Boolean(card.active),
    running: card.run?.state === 'running',
    runState: card.run?.state ?? null,
    status: card.status,
    attention: card.live?.attention?.kind ?? null,
    level: contextLevel(card.usage?.context ?? 0),
    paused: Boolean(card.queue?.paused),
  }
}

export function diffAlerts(previous, cards) {
  const events = []
  const next = new Map()
  for (const card of cards) {
    const now = snapshot(card)
    next.set(card.id, now)
    const before = previous?.get(card.id)
    if (!before) continue
    const add = (kind, message) => events.push({ id: card.id, title: card.title, kind, message })
    if (before.active && !now.active && !now.running) add('finished', 'Finished working')
    if (!before.attention && now.attention === 'question') add('question', `Asking you: ${card.live.attention.text || 'a question'}`.slice(0, 160))
    if (!before.attention && now.attention === 'approval') add('approval', `Possibly waiting for approval: ${card.live.attention.tool}`)
    if (before.status !== 'blocked' && now.status === 'blocked') add('blocked', 'Marked blocked')
    if (before.status !== 'needs-input' && now.status === 'needs-input' && !now.attention) add('question', 'Needs your input')
    if (LEVEL_RANK[now.level] > LEVEL_RANK[before.level]) add('context', `Context passed ${now.level === 'danger' ? '200k' : '100k'}`)
    if (before.runState !== 'failed' && now.runState === 'failed') add('failed', 'A prompt from the board failed')
    if (!before.paused && now.paused) add('paused', 'Queue paused')
  }
  return { events, next }
}
