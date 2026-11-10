import test from 'node:test'
import assert from 'node:assert/strict'
import { isBabysitState, isBabysitActive, isBabysitPrompt, recordBabysit, withBabysit, babysitSessions, MAX_BABYSIT, MAX_NOTE, MAX_ATTEMPTS } from '../lib/babysit.js'

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
  assert.deepEqual(store[URL_1], { state: 'starting', note: '', attempts: 0, sessionId: SESSION, startedAt: 1000, at: 1000 })
})

test('later updates keep the session, the start time and the attempts while the babysit is active', () => {
  let store = recordBabysit({}, URL_1, { state: 'starting', sessionId: SESSION }, 1000)
  store = recordBabysit(store, URL_1, { state: 'fixing', note: 'Fixing lint', attempts: 1 }, 2000)
  store = recordBabysit(store, URL_1, { state: 'watching', note: 'Pipeline 9 running' }, 3000)
  assert.deepEqual(store[URL_1], { state: 'watching', note: 'Pipeline 9 running', attempts: 1, sessionId: SESSION, startedAt: 1000, at: 3000 })
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
