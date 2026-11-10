export const BABYSIT_STATES = ['starting', 'watching', 'fixing', 'in-review', 'ready-to-merge', 'needs-you', 'stopped']
const ACTIVE = new Set(['starting', 'watching', 'fixing', 'in-review'])
const SETTLES_ON_MERGE = new Set([...ACTIVE, 'ready-to-merge', 'needs-you'])

export const MAX_BABYSIT = 200
export const MAX_NOTE = 300
export const MAX_ATTEMPTS = 20

export const isBabysitState = (value) => BABYSIT_STATES.includes(value)
export const isBabysitActive = (state) => ACTIVE.has(state)
export const isBabysitPrompt = (prompt) => /^\/csb-babysit(\s|$)/.test(String(prompt ?? '').trim())

export function recordBabysit(store, url, { state, note, attempts, sessionId }, now) {
  const previous = store[url]
  if (previous?.state === 'stopped' && state !== 'starting' && state !== 'stopped') return store
  const continuing = previous && ACTIVE.has(previous.state) && state !== 'starting'
  const entry = {
    state,
    note: typeof note === 'string' ? note.trim().slice(0, MAX_NOTE) : '',
    attempts: Number.isInteger(attempts) ? Math.min(Math.max(attempts, 0), MAX_ATTEMPTS) : (continuing ? previous.attempts ?? 0 : 0),
    sessionId: sessionId ?? previous?.sessionId ?? null,
    startedAt: continuing ? previous.startedAt : now,
    at: now,
  }
  const entries = Object.entries({ ...store, [url]: entry }).sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, MAX_BABYSIT))
}

export function withBabysit(data, store) {
  const mark = (mrs) => mrs.map((mr) => {
    const entry = store[mr.url]
    if (!entry || mr.role === 'reviewing') return mr
    const merged = mr.mergedAt && SETTLES_ON_MERGE.has(entry.state)
    return { ...mr, babysit: merged ? { ...entry, state: 'merged', note: '' } : entry }
  })
  return { ...data, authored: mark(data.authored), merged: mark(data.merged ?? []) }
}

export function babysitSessions(store) {
  const bySession = new Map()
  for (const [url, entry] of Object.entries(store)) {
    if (!entry?.sessionId) continue
    const known = bySession.get(entry.sessionId)
    if (!known || entry.at > known.at) bySession.set(entry.sessionId, { url, state: entry.state, note: entry.note, at: entry.at })
  }
  return bySession
}

export const KICK_GRACE_MS = 3 * 60_000
export const KICK_RETRY_MS = 10 * 60_000

export function needsKick(entry, { now, running, scheduled, queued, kickedAt = 0 }) {
  if (!entry?.sessionId || !ACTIVE.has(entry.state)) return false
  if (running || scheduled || queued) return false
  return now - entry.at > KICK_GRACE_MS && now - kickedAt > KICK_RETRY_MS
}
