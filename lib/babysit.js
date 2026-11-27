import { withFileLock } from './atomic.js'

export const BABYSIT_STATES = ['starting', 'watching', 'fixing', 'in-review', 'ready-to-merge', 'needs-you', 'stopped']
const ACTIVE = new Set(['starting', 'watching', 'fixing', 'in-review'])
const SETTLES_ON_MERGE = new Set([...ACTIVE, 'ready-to-merge', 'needs-you'])
const CONTINUES = new Set([...ACTIVE, 'needs-you'])
const CLI_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BOARD_PREFIX = 'local_board-'

export const MAX_BABYSIT = 200
export const MAX_NOTE = 300
export const MAX_ATTEMPTS = 20

export const isBabysitState = (value) => BABYSIT_STATES.includes(value)
export const isBabysitActive = (state) => ACTIVE.has(state)
export const isBabysitPrompt = (prompt) => /^\/csb-babysit(\s|$)/.test(String(prompt ?? '').trim())

export const APPROVE_REPLIES_PROMPT = 'Yes. Post the replies as planned and push the changes.'
export const REPLIES_APPROVED_NOTE = 'Replies approved, posting them'
export const replyPlanReady = (entry) => entry?.state === 'needs-you' && Boolean(entry.sessionId) && /reply plan ready/i.test(entry.note ?? '')

export function recordBabysit(store, url, { state, note, attempts, sessionId, cliSessionId }, now) {
  const previous = store[url]
  const otherCaller = Boolean(cliSessionId) && cliSessionId !== previous?.cliSessionId
  if (previous?.state === 'stopped' && !otherCaller && state !== 'starting' && state !== 'stopped') return store
  const continuing = previous && CONTINUES.has(previous.state) && state !== 'starting' && !otherCaller
  const entry = {
    state,
    note: typeof note === 'string' ? note.trim().slice(0, MAX_NOTE) : '',
    attempts: Number.isInteger(attempts) ? Math.min(Math.max(attempts, 0), MAX_ATTEMPTS) : (continuing ? previous.attempts ?? 0 : 0),
    sessionId: sessionId === undefined ? previous?.sessionId ?? null : sessionId,
    cliSessionId: cliSessionId ?? (state === 'starting' ? null : previous?.cliSessionId ?? null),
    startedAt: continuing ? previous.startedAt : now,
    at: now,
  }
  const entries = Object.entries({ ...store, [url]: entry }).sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, MAX_BABYSIT))
}

export function babysitCaller({ sessionId, cliSessionId }, findBoardSession) {
  if (typeof cliSessionId === 'string' && CLI_ID.test(cliSessionId)) {
    return { cliSessionId, sessionId: sessionId ?? findBoardSession(`${BOARD_PREFIX}${cliSessionId}`)?.sessionId ?? null }
  }
  return { cliSessionId: sessionId ? findBoardSession(sessionId)?.cliSessionId : undefined, sessionId }
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

export function settleMerged(store, merged, now) {
  const mergedUrls = new Set(merged.filter((mr) => mr.mergedAt).map((mr) => mr.url))
  let settled = store
  for (const [url, entry] of Object.entries(store)) {
    if (SETTLES_ON_MERGE.has(entry.state) && mergedUrls.has(url)) settled = recordBabysit(settled, url, { state: 'stopped', note: 'Merged' }, now)
  }
  return settled
}

export const MERGED_WINDOW_MS = 7 * 24 * 60 * 60_000
export const MAX_LOOKUPS = 5
export const LOOKUP_RECHECK_MS = 6 * 60 * 60_000

export function lookupCandidates(store, { now, merged, checkedAt = new Map() }) {
  const mergedUrls = new Set(merged.map((mr) => mr.url))
  return Object.entries(store)
    .filter(([url, entry]) => SETTLES_ON_MERGE.has(entry.state)
      && now - entry.at > MERGED_WINDOW_MS
      && !mergedUrls.has(url)
      && now - (checkedAt.get(url) ?? 0) > LOOKUP_RECHECK_MS)
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, MAX_LOOKUPS)
    .map(([url]) => url)
}

export function settleLooked(store, results, now) {
  let settled = store
  for (const [url, state] of results) {
    if (!SETTLES_ON_MERGE.has(settled[url]?.state)) continue
    if (state === 'merged') settled = recordBabysit(settled, url, { state: 'stopped', note: 'Merged' }, now)
    if (state === 'closed') settled = recordBabysit(settled, url, { state: 'stopped', note: 'Closed' }, now)
  }
  return settled
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
export const PAUSED_NOTE = 'The last check did not finish, so this session\'s queue is paused. Press Resume on the session to carry on.'

export function watchAction(entry, { now, running, scheduled, queued, paused = false, kickedAt = 0 }) {
  if (!entry?.sessionId || !ACTIVE.has(entry.state) || running) return null
  if (now - entry.at <= KICK_GRACE_MS) return null
  if (paused) return 'paused'
  if (scheduled || queued) return null
  return now - kickedAt > KICK_RETRY_MS ? 'kick' : null
}

export function createBabysitStore({ file, readJson, writeJson, onChange = () => {} }) {
  async function read() {
    const parsed = await readJson(file, {})
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  }
  const update = (change) => withFileLock(file, async () => {
    const before = await read()
    const after = await change(before)
    if (after !== before) {
      await writeJson(file, after)
      onChange(after)
    }
    return { before, after }
  })
  return { read, update }
}

export async function watchBabysits(store, { loadMerged, now = Date.now, contextFor, exists, enqueueCheck, lookup = null, checkedAt = new Map() }) {
  const merged = await loadMerged()
  const looked = new Map()
  if (lookup) {
    for (const url of lookupCandidates(await store.read(), { now: now(), merged, checkedAt })) {
      checkedAt.set(url, now())
      const state = await lookup(url).catch(() => null)
      if (state === 'merged' || state === 'closed') looked.set(url, state)
    }
  }
  let kicked = false
  await store.update(async (current) => {
    const at = now()
    let next = settleLooked(settleMerged(current, merged, at), looked, at)
    for (const [url, entry] of Object.entries(next)) {
      const sid = entry.sessionId
      const context = contextFor(sid)
      const action = watchAction(entry, { now: at, ...context })
      if (!action || !(await exists(sid))) continue
      if (action === 'paused') next = recordBabysit(next, url, { state: 'needs-you', note: PAUSED_NOTE }, at)
      if (action === 'kick' || !context.queued) kicked = (await enqueueCheck(sid, url)) || kicked
    }
    return next
  })
  return kicked
}

export async function approveReplyPlan(store, url, { now = Date.now, exists, enqueue }) {
  const waiting = (await store.read())[url]
  if (!replyPlanReady(waiting)) return { status: 409, body: { error: 'no reply plan is waiting on this merge request' } }
  if (!(await exists(waiting.sessionId))) return { status: 404, body: { error: 'the babysit session no longer exists' } }
  const { before, after } = await store.update((current) => (replyPlanReady(current[url])
    ? recordBabysit(current, url, { state: 'watching', note: REPLIES_APPROVED_NOTE }, now())
    : current))
  const approved = before[url]
  if (!replyPlanReady(approved)) return { status: 409, body: { error: 'no reply plan is waiting on this merge request' } }
  if (!(await enqueue(approved.sessionId, APPROVE_REPLIES_PROMPT))) {
    await store.update((current) => ({ ...current, [url]: approved }))
    return { status: 429, body: { error: 'that session\'s queue is full' } }
  }
  return { status: 200, body: { ok: true, babysit: after[url] } }
}
