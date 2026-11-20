import test from 'node:test'
import assert from 'node:assert/strict'
import { isBabysitState, isBabysitActive, isBabysitPrompt, watchAction, PAUSED_NOTE, babysitCaller, createBabysitStore, watchBabysits, KICK_GRACE_MS, KICK_RETRY_MS, recordBabysit, settleMerged, withBabysit, babysitSessions, MAX_BABYSIT, MAX_NOTE, MAX_ATTEMPTS } from '../lib/babysit.js'

const URL_1 = 'https://gitlab.example.com/t/r/-/merge_requests/1'
const URL_2 = 'https://gitlab.example.com/t/r/-/merge_requests/2'
const SESSION = 'local_5dd7e1f0-0000-4000-8000-000000000001'

test('only the known states are accepted', () => {
  assert.equal(isBabysitState('watching'), true)
  assert.equal(isBabysitState('needs-you'), true)
  assert.equal(isBabysitState('merged'), false)
  assert.equal(isBabysitState(undefined), false)
})

test('starting records the session and a fresh start time', () => {
  const store = recordBabysit({}, URL_1, { state: 'starting', sessionId: SESSION }, 1000)
  assert.deepEqual(store[URL_1], { state: 'starting', note: '', attempts: 0, sessionId: SESSION, cliSessionId: null, startedAt: 1000, at: 1000 })
})

test('later updates keep the session, the start time and the attempts while the babysit is active', () => {
  let store = recordBabysit({}, URL_1, { state: 'starting', sessionId: SESSION }, 1000)
  store = recordBabysit(store, URL_1, { state: 'fixing', note: 'Fixing lint', attempts: 1 }, 2000)
  store = recordBabysit(store, URL_1, { state: 'watching', note: 'Pipeline 9 running' }, 3000)
  assert.deepEqual(store[URL_1], { state: 'watching', note: 'Pipeline 9 running', attempts: 1, sessionId: SESSION, cliSessionId: null, startedAt: 1000, at: 3000 })
})

test('clicking Babysit again after a stop starts over', () => {
  let store = recordBabysit({}, URL_1, { state: 'fixing', attempts: 3 }, 1000)
  store = recordBabysit(store, URL_1, { state: 'needs-you', note: 'Runner is down' }, 2000)
  store = recordBabysit(store, URL_1, { state: 'starting', sessionId: SESSION }, 3000)
  assert.equal(store[URL_1].attempts, 0)
  assert.equal(store[URL_1].startedAt, 3000)
})

test('notes are trimmed and capped, attempts are clamped, bad attempts are ignored', () => {
  const long = recordBabysit({}, URL_1, { state: 'needs-you', note: `  ${'x'.repeat(MAX_NOTE + 50)}  `, attempts: 999 }, 1)
  assert.equal(long[URL_1].note.length, MAX_NOTE)
  assert.equal(long[URL_1].attempts, MAX_ATTEMPTS)
  const bad = recordBabysit({}, URL_1, { state: 'watching', note: 42, attempts: 'two' }, 1)
  assert.equal(bad[URL_1].note, '')
  assert.equal(bad[URL_1].attempts, 0)
})

test('the store keeps only the most recently updated entries', () => {
  let store = {}
  for (let i = 0; i < MAX_BABYSIT + 5; i++) store = recordBabysit(store, `https://gitlab.example.com/t/r/-/merge_requests/${i + 1}`, { state: 'watching' }, i)
  assert.equal(Object.keys(store).length, MAX_BABYSIT)
  assert.equal(store['https://gitlab.example.com/t/r/-/merge_requests/1'], undefined)
})

const mr = (url, over = {}) => ({ url, role: 'authored', mergedAt: null, ...over })

test('attaches the entry to authored merge requests only', () => {
  const store = recordBabysit({}, URL_1, { state: 'watching' }, 5)
  const data = withBabysit({ authored: [mr(URL_1), mr(URL_2)], reviewing: [mr(URL_1, { role: 'reviewing' })], merged: [] }, store)
  assert.equal(data.authored[0].babysit.state, 'watching')
  assert.equal(data.authored[1].babysit, undefined)
  assert.equal(data.reviewing[0].babysit, undefined)
})

test('a babysat merge request that merged shows as merged with no note', () => {
  const store = recordBabysit({}, URL_1, { state: 'ready-to-merge', note: 'Approved' }, 5)
  const data = withBabysit({ authored: [], reviewing: [], merged: [mr(URL_1, { mergedAt: 9 })] }, store)
  assert.equal(data.merged[0].babysit.state, 'merged')
  assert.equal(data.merged[0].babysit.note, '')
})

test('a stopped babysit stays stopped after the merge request merges', () => {
  const store = recordBabysit({}, URL_1, { state: 'stopped', note: 'Closed' }, 5)
  const data = withBabysit({ authored: [], reviewing: [], merged: [mr(URL_1, { mergedAt: 9 })] }, store)
  assert.equal(data.merged[0].babysit.state, 'stopped')
})

test('babysit sessions map a session id to its merge request and latest state', () => {
  let store = recordBabysit({}, URL_1, { state: 'watching', note: 'CI running', sessionId: SESSION }, 10)
  store = recordBabysit(store, URL_2, { state: 'starting' }, 20)
  const map = babysitSessions(store)
  assert.deepEqual([...map.keys()], [SESSION])
  assert.deepEqual(map.get(SESSION), { url: URL_1, state: 'watching', note: 'CI running', at: 10 })
})

test('when two merge requests name the same session the most recent one wins', () => {
  let store = recordBabysit({}, URL_1, { state: 'watching', sessionId: SESSION }, 10)
  store = recordBabysit(store, URL_2, { state: 'fixing', sessionId: SESSION }, 20)
  assert.equal(babysitSessions(store).get(SESSION).url, URL_2)
})

test('only the live states are active', () => {
  assert.deepEqual(['starting', 'watching', 'fixing', 'in-review'].map(isBabysitActive), [true, true, true, true])
  assert.deepEqual(['ready-to-merge', 'needs-you', 'stopped', 'merged'].map(isBabysitActive), [false, false, false, false])
})

test('babysit prompts are recognised by their command', () => {
  assert.equal(isBabysitPrompt('/csb-babysit https://gitlab.example.com/t/r/-/merge_requests/1'), true)
  assert.equal(isBabysitPrompt('  /csb-babysit'), true)
  assert.equal(isBabysitPrompt('/csb-babysit-other x'), false)
  assert.equal(isBabysitPrompt('please /csb-babysit'), false)
  assert.equal(isBabysitPrompt(undefined), false)
})

test('a stopped babysit ignores later updates from a check that was already running', () => {
  let store = recordBabysit({}, URL_1, { state: 'watching', sessionId: SESSION }, 10)
  store = recordBabysit(store, URL_1, { state: 'stopped', note: 'Stopped by you' }, 20)
  const late = recordBabysit(store, URL_1, { state: 'in-review', note: 'late' }, 30)
  assert.equal(late, store)
  assert.equal(late[URL_1].state, 'stopped')
  assert.equal(recordBabysit(store, URL_1, { state: 'starting', sessionId: SESSION }, 40)[URL_1].state, 'starting')
})

const idleCtx = (over = {}) => ({ now: 100 * 60_000, running: false, scheduled: false, queued: false, kickedAt: 0, ...over })
const live = (over = {}) => ({ state: 'watching', sessionId: SESSION, at: 100 * 60_000 - KICK_GRACE_MS - 1, ...over })

test('a live babysit with nothing running, scheduled or queued is kicked after a short grace', () => {
  assert.equal(watchAction(live(), idleCtx()), 'kick')
  assert.equal(watchAction(live({ state: 'in-review' }), idleCtx()), 'kick')
  assert.equal(watchAction(live({ at: 100 * 60_000 - KICK_GRACE_MS + 1 }), idleCtx()), null)
})

test('a babysit that has a run, a schedule or a queued check is left alone', () => {
  assert.equal(watchAction(live(), idleCtx({ running: true })), null)
  assert.equal(watchAction(live(), idleCtx({ scheduled: true })), null)
  assert.equal(watchAction(live(), idleCtx({ queued: true })), null)
})

test('final states, missing sessions and recently kicked babysits are not kicked', () => {
  for (const state of ['needs-you', 'stopped', 'ready-to-merge']) assert.equal(watchAction(live({ state }), idleCtx()), null)
  assert.equal(watchAction(live({ sessionId: null }), idleCtx()), null)
  assert.equal(watchAction(undefined, idleCtx()), null)
  assert.equal(watchAction(live(), idleCtx({ kickedAt: 100 * 60_000 - KICK_RETRY_MS + 1 })), null)
  assert.equal(watchAction(live(), idleCtx({ kickedAt: 100 * 60_000 - KICK_RETRY_MS - 1 })), 'kick')
})

test('a live babysit whose merge request merged is stopped as merged', () => {
  const store = recordBabysit({}, URL_1, { state: 'watching', note: 'Approved; pipeline running', sessionId: SESSION }, 10)
  const settled = settleMerged(store, [mr(URL_1, { mergedAt: 9 })], 500)
  assert.equal(settled[URL_1].state, 'stopped')
  assert.equal(settled[URL_1].note, 'Merged')
  assert.equal(settled[URL_1].sessionId, SESSION)
  assert.equal(watchAction(settled[URL_1], idleCtx()), null)
})

test('settling leaves open, final and unrelated entries alone and is idempotent', () => {
  let store = recordBabysit({}, URL_1, { state: 'watching', sessionId: SESSION }, 10)
  store = recordBabysit(store, URL_2, { state: 'ready-to-merge' }, 20)
  assert.equal(settleMerged(store, [mr(URL_1, { mergedAt: null })], 500), store)
  assert.equal(settleMerged(store, [mr(URL_2, { mergedAt: 9 })], 500), store)
  assert.equal(settleMerged(store, [], 500), store)
  const once = settleMerged(store, [mr(URL_1, { mergedAt: 9 })], 500)
  assert.equal(settleMerged(once, [mr(URL_1, { mergedAt: 9 })], 600), once)
})

const SESSION_2 = 'local_board-5dd7e1f0-0000-4000-8000-000000000002'
const CLI_A = '5dd7e1f0-0000-4000-8000-00000000000a'
const CLI_B = '5dd7e1f0-0000-4000-8000-00000000000b'

function stoppedByBoard() {
  let store = recordBabysit({}, URL_1, { state: 'starting', sessionId: SESSION, cliSessionId: CLI_A }, 1000)
  store = recordBabysit(store, URL_1, { state: 'fixing', attempts: 2, cliSessionId: CLI_A }, 2000)
  return recordBabysit(store, URL_1, { state: 'stopped', note: 'Stopped by you' }, 3000)
}

test('a run by hand in another session restarts a babysit the board stopped, under its own session', () => {
  const store = recordBabysit(stoppedByBoard(), URL_1, { state: 'watching', note: 'Pipeline 7 running', sessionId: null, cliSessionId: CLI_B }, 4000)
  assert.deepEqual(store[URL_1], { state: 'watching', note: 'Pipeline 7 running', attempts: 0, sessionId: null, cliSessionId: CLI_B, startedAt: 4000, at: 4000 })
})

test('after a stop, late updates from the stopped session or from an unknown caller are still ignored', () => {
  const stopped = stoppedByBoard()
  assert.equal(recordBabysit(stopped, URL_1, { state: 'watching', sessionId: SESSION, cliSessionId: CLI_A }, 4000), stopped)
  assert.equal(recordBabysit(stopped, URL_1, { state: 'watching' }, 4000), stopped)
  assert.equal(stopped[URL_1].cliSessionId, CLI_A)
})

test('the reporting session id wins over the one the entry had', () => {
  let store = recordBabysit({}, URL_1, { state: 'starting', sessionId: SESSION, cliSessionId: CLI_A }, 1000)
  store = recordBabysit(store, URL_1, { state: 'needs-you', note: 'Runner is down', cliSessionId: CLI_A }, 2000)
  const byHand = recordBabysit(store, URL_1, { state: 'watching', sessionId: null, cliSessionId: CLI_B }, 3000)
  assert.equal(byHand[URL_1].sessionId, null)
  assert.equal(babysitSessions(byHand).has(SESSION), false)
  assert.equal(watchAction(byHand[URL_1], idleCtx()), null)
  const otherBoard = recordBabysit(store, URL_1, { state: 'watching', sessionId: SESSION_2, cliSessionId: CLI_B }, 3000)
  assert.equal(otherBoard[URL_1].sessionId, SESSION_2)
})

test('attempts and the start time carry over a needs-you the user answers in the same session', () => {
  let store = recordBabysit({}, URL_1, { state: 'starting', sessionId: SESSION, cliSessionId: CLI_A }, 1000)
  store = recordBabysit(store, URL_1, { state: 'fixing', attempts: 2, cliSessionId: CLI_A }, 2000)
  store = recordBabysit(store, URL_1, { state: 'needs-you', note: '2 review threads: reply plan ready', cliSessionId: CLI_A }, 3000)
  store = recordBabysit(store, URL_1, { state: 'watching', cliSessionId: CLI_A }, 4000)
  assert.equal(store[URL_1].attempts, 2)
  assert.equal(store[URL_1].startedAt, 1000)
  assert.equal(store[URL_1].sessionId, SESSION)
  const legacy = recordBabysit(recordBabysit(store, URL_1, { state: 'needs-you' }, 5000), URL_1, { state: 'in-review' }, 6000)
  assert.equal(legacy[URL_1].attempts, 2)
  assert.equal(legacy[URL_1].startedAt, 1000)
  const again = recordBabysit(store, URL_1, { state: 'starting', sessionId: SESSION_2, cliSessionId: CLI_B }, 7000)
  assert.equal(again[URL_1].attempts, 0)
  assert.equal(again[URL_1].startedAt, 7000)
})

test('the caller is resolved from its CLI session id, and only board sessions get a session id', () => {
  const boards = new Map([[SESSION_2, { sessionId: SESSION_2, cliSessionId: '5dd7e1f0-0000-4000-8000-000000000002' }]])
  const find = (id) => boards.get(id) ?? null
  assert.deepEqual(babysitCaller({ cliSessionId: '5dd7e1f0-0000-4000-8000-000000000002' }, find), { cliSessionId: '5dd7e1f0-0000-4000-8000-000000000002', sessionId: SESSION_2 })
  assert.deepEqual(babysitCaller({ cliSessionId: CLI_B }, find), { cliSessionId: CLI_B, sessionId: null })
  assert.deepEqual(babysitCaller({ sessionId: SESSION_2 }, find), { cliSessionId: '5dd7e1f0-0000-4000-8000-000000000002', sessionId: SESSION_2 })
  assert.deepEqual(babysitCaller({ cliSessionId: '${CLAUDE_SESSION_ID}' }, find), { cliSessionId: undefined, sessionId: undefined })
  assert.deepEqual(babysitCaller({}, find), { cliSessionId: undefined, sessionId: undefined })
})

test('a babysit behind a paused queue is surfaced once its grace has passed, even with a check queued', () => {
  assert.equal(watchAction(live(), idleCtx({ paused: true })), 'paused')
  assert.equal(watchAction(live(), idleCtx({ paused: true, queued: true, scheduled: true, kickedAt: 100 * 60_000 })), 'paused')
  assert.equal(watchAction(live(), idleCtx({ paused: true, running: true })), null)
  assert.equal(watchAction(live({ at: 100 * 60_000 - KICK_GRACE_MS + 1 }), idleCtx({ paused: true })), null)
  assert.equal(watchAction(live({ state: 'needs-you' }), idleCtx({ paused: true })), null)
})

let virtualFiles = 0

function memoryStore(initial) {
  const file = `/virtual/mr-babysit-${virtualFiles++}.json`
  const files = { [file]: structuredClone(initial) }
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const store = createBabysitStore({
    file,
    readJson: async (path, fallback) => { await tick(); return structuredClone(files[path] ?? fallback) },
    writeJson: async (path, value) => { await tick(); files[path] = structuredClone(value) },
  })
  return { store, saved: () => files[file] }
}

const quiet = { running: false, scheduled: false, queued: false, paused: false, kickedAt: 0 }
const wait = () => new Promise((resolve) => setTimeout(resolve, 10))

function watchOptions(over = {}) {
  const kicks = []
  return {
    kicks,
    options: {
      loadMerged: async () => [],
      now: () => 100 * 60_000,
      contextFor: () => quiet,
      exists: async () => true,
      enqueueCheck: async (sid, url) => { kicks.push(url); return true },
      ...over,
    },
  }
}

test('the watchdog kicks an idle babysit and settles merged ones', async () => {
  let seed = recordBabysit({}, URL_1, { state: 'watching', sessionId: SESSION }, 1)
  seed = recordBabysit(seed, URL_2, { state: 'watching', sessionId: SESSION_2 }, 2)
  const { store, saved } = memoryStore(seed)
  const { kicks, options } = watchOptions({ loadMerged: async () => [mr(URL_1, { mergedAt: 9 })] })
  assert.equal(await watchBabysits(store, options), true)
  assert.deepEqual(kicks, [URL_2])
  assert.equal(saved()[URL_1].note, 'Merged')
  assert.equal(saved()[URL_2].state, 'watching')
})

test('a stop pressed while the watchdog waits for GitLab is neither overwritten nor kicked', async () => {
  let seed = recordBabysit({}, URL_1, { state: 'watching', sessionId: SESSION }, 1)
  seed = recordBabysit(seed, URL_2, { state: 'watching', sessionId: SESSION_2 }, 2)
  const { store, saved } = memoryStore(seed)
  let release
  const merged = new Promise((resolve) => { release = resolve })
  const { kicks, options } = watchOptions({ loadMerged: () => merged })
  const watching = watchBabysits(store, options)
  await store.update((current) => recordBabysit(current, URL_2, { state: 'stopped', note: 'Stopped by you' }, 100 * 60_000 - 1))
  release([mr(URL_1, { mergedAt: 9 })])
  assert.equal(await watching, false)
  assert.deepEqual(kicks, [])
  assert.equal(saved()[URL_2].state, 'stopped')
  assert.equal(saved()[URL_2].note, 'Stopped by you')
  assert.equal(saved()[URL_1].note, 'Merged')
})

test('a status posted while the watchdog is deciding waits for it and lands on top of its write', async () => {
  let seed = recordBabysit({}, URL_1, { state: 'watching', sessionId: SESSION }, 1)
  seed = recordBabysit(seed, URL_2, { state: 'watching', sessionId: SESSION_2 }, 2)
  const { store, saved } = memoryStore(seed)
  let unblock
  const blocked = new Promise((resolve) => { unblock = resolve })
  const { kicks, options } = watchOptions({
    loadMerged: async () => [mr(URL_1, { mergedAt: 9 })],
    exists: async (sid) => { if (sid === SESSION_2) await blocked; return true },
  })
  const watching = watchBabysits(store, options)
  await wait()
  let landed = false
  const posted = store.update((current) => recordBabysit(current, URL_2, { state: 'needs-you', note: 'MR is a draft' }, 100 * 60_000 + 1)).then(() => { landed = true })
  await wait()
  assert.equal(landed, false)
  unblock()
  await watching
  await posted
  assert.deepEqual(kicks, [URL_2])
  assert.equal(saved()[URL_1].note, 'Merged')
  assert.equal(saved()[URL_2].state, 'needs-you')
  assert.equal(saved()[URL_2].note, 'MR is a draft')
})

test('a babysit stuck behind a paused queue turns into needs-you, with a check queued for Resume to send', async () => {
  let seed = recordBabysit({}, URL_1, { state: 'fixing', attempts: 1, sessionId: SESSION }, 1)
  seed = recordBabysit(seed, URL_2, { state: 'watching', sessionId: SESSION_2 }, 2)
  const { store, saved } = memoryStore(seed)
  const contexts = { [SESSION]: { ...quiet, paused: true, queued: true }, [SESSION_2]: { ...quiet, paused: true } }
  const { kicks, options } = watchOptions({ contextFor: (sid) => contexts[sid] })
  await watchBabysits(store, options)
  assert.deepEqual(kicks, [URL_2])
  for (const url of [URL_1, URL_2]) {
    assert.equal(saved()[url].state, 'needs-you')
    assert.equal(saved()[url].note, PAUSED_NOTE)
  }
  assert.equal(saved()[URL_1].sessionId, SESSION)
  assert.equal(saved()[URL_1].attempts, 1)
  await watchBabysits(store, options)
  assert.deepEqual(kicks, [URL_2])
})
