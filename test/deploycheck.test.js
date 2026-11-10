import test from 'node:test'
import assert from 'node:assert/strict'
import { isDeployState, recordDeploy, withDeploy, MAX_DEPLOY, MAX_NOTE } from '../lib/deploycheck.js'

const URL_1 = 'https://gitlab.example.com/t/r/-/merge_requests/1'
const URL_2 = 'https://gitlab.example.com/t/r/-/merge_requests/2'
const SESSION = 'local_board-5dd7e1f0-0000-4000-8000-000000000001'

test('only the known deploy states are accepted', () => {
  for (const state of ['checking', 'live', 'deploying', 'waiting', 'failed', 'unknown']) assert.equal(isDeployState(state), true)
  assert.equal(isDeployState('merged'), false)
  assert.equal(isDeployState(undefined), false)
})

test('starting a check records the session and the time', () => {
  const store = recordDeploy({}, URL_1, { state: 'checking', sessionId: SESSION }, 1000)
  assert.deepEqual(store[URL_1], { state: 'checking', note: '', sessionId: SESSION, at: 1000 })
})

test('the result keeps the session of the check that started it', () => {
  let store = recordDeploy({}, URL_1, { state: 'checking', sessionId: SESSION }, 1000)
  store = recordDeploy(store, URL_1, { state: 'live', note: 'prod and staging deployed' }, 2000)
  assert.deepEqual(store[URL_1], { state: 'live', note: 'prod and staging deployed', sessionId: SESSION, at: 2000 })
})

test('checking again replaces the earlier result and session', () => {
  let store = recordDeploy({}, URL_1, { state: 'failed', note: 'deploy job failed', sessionId: SESSION }, 1000)
  store = recordDeploy(store, URL_1, { state: 'checking', sessionId: 'local_board-new' }, 3000)
  assert.deepEqual(store[URL_1], { state: 'checking', note: '', sessionId: 'local_board-new', at: 3000 })
})

test('notes are trimmed and capped and a non-string note is dropped', () => {
  assert.equal(recordDeploy({}, URL_1, { state: 'failed', note: `  ${'x'.repeat(MAX_NOTE + 40)}  ` }, 1)[URL_1].note.length, MAX_NOTE)
  assert.equal(recordDeploy({}, URL_1, { state: 'failed', note: 42 }, 1)[URL_1].note, '')
})

test('the store keeps only the most recently updated entries', () => {
  let store = {}
  for (let i = 0; i < MAX_DEPLOY + 5; i++) store = recordDeploy(store, `https://gitlab.example.com/t/r/-/merge_requests/${i + 1}`, { state: 'live' }, i)
  assert.equal(Object.keys(store).length, MAX_DEPLOY)
  assert.equal(store['https://gitlab.example.com/t/r/-/merge_requests/1'], undefined)
})

test('the result is attached to merged merge requests only', () => {
  const store = recordDeploy({}, URL_1, { state: 'live' }, 5)
  const data = withDeploy({ authored: [{ url: URL_1, mergedAt: null }], reviewing: [], merged: [{ url: URL_1, mergedAt: 9 }, { url: URL_2, mergedAt: 9 }] }, store)
  assert.equal(data.merged[0].deploy.state, 'live')
  assert.equal(data.merged[1].deploy, undefined)
  assert.equal(data.authored[0].deploy, undefined)
})
