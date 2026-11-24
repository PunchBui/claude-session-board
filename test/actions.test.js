import test from 'node:test'
import assert from 'node:assert/strict'
import { actionFrom, isTrackedRoute, promptKind, recordAction, summarizeActions, MAX_ACTIONS } from '../lib/actions.js'

const MR = 'https://gitlab.example.com/t/r/-/merge_requests/1'
const SESSION = 'local_5dd7e1f0-0000-4000-8000-000000000001'

test('skill-reported and noisy routes are not tracked', () => {
  assert.equal(isTrackedRoute('/api/mrs/ping'), true)
  assert.equal(isTrackedRoute('/api/prompt'), true)
  assert.equal(isTrackedRoute('/api/mrs/babysit'), false)
  assert.equal(isTrackedRoute('/api/mrs/deploy'), false)
  assert.equal(isTrackedRoute('/api/focus/order'), false)
  assert.equal(isTrackedRoute('/api/login'), false)
  assert.equal(isTrackedRoute('/healthz'), false)
})

test('prompts are logged by kind and never by text', () => {
  assert.equal(promptKind('/csb-babysit https://x'), '/csb-babysit')
  assert.equal(promptKind('push the branch'), 'text')
  assert.equal(promptKind(''), 'text')
  assert.equal(promptKind(undefined), 'text')
  const entry = actionFrom({ route: '/api/prompt', body: { id: SESSION, prompt: 'secret words here' }, status: 200, userAgent: 'Mozilla', now: 5 })
  assert.deepEqual(entry, { at: 5, route: '/api/prompt', status: 200, source: 'ui', session: SESSION, kind: 'text' })
  assert.equal(JSON.stringify(entry).includes('secret'), false)
})

test('curl callers count as the skill, browsers as the ui', () => {
  assert.equal(actionFrom({ route: '/api/mrs/label', body: { url: MR }, status: 200, userAgent: 'curl/8.4.0', now: 1 }).source, 'skill')
  assert.equal(actionFrom({ route: '/api/mrs/label', body: { url: MR }, status: 200, userAgent: 'Mozilla/5.0', now: 1 }).source, 'ui')
  assert.equal(actionFrom({ route: '/api/mrs/label', body: { url: MR }, status: 200, now: 1 }).source, 'ui')
})

test('the log keeps only the newest entries', () => {
  let log = []
  for (let at = 0; at < MAX_ACTIONS + 3; at += 1) log = recordAction(log, { at, route: '/api/focus', status: 200, source: 'ui' })
  assert.equal(log.length, MAX_ACTIONS)
  assert.equal(log[0].at, 3)
  assert.deepEqual(recordAction('broken', { at: 1 }), [{ at: 1 }])
})

test('the summary counts your own successful actions inside the window', () => {
  const day = 24 * 60 * 60_000
  const now = 100 * day
  const log = [
    { at: now - day, route: '/api/mrs/ping', status: 200, source: 'ui' },
    { at: now - 2 * day, route: '/api/mrs/ping', status: 200, source: 'ui' },
    { at: now - 3 * day, route: '/api/mrs/ping', status: 502, source: 'ui' },
    { at: now - 3 * day, route: '/api/mrs/label', status: 200, source: 'skill' },
    { at: now - 40 * day, route: '/api/mrs/ping', status: 200, source: 'ui' },
    { at: now - day, route: '/api/prompt', status: 200, source: 'ui', kind: '/handoff' },
    { at: now - day, route: '/api/prompt', status: 200, source: 'ui', kind: 'text' },
  ]
  assert.deepEqual(summarizeActions(log, { now }), [
    { action: '/api/mrs/ping', count: 2 },
    { action: '/api/prompt', count: 1 },
    { action: '/api/prompt /handoff', count: 1 },
  ])
  assert.deepEqual(summarizeActions(log, { now, source: 'skill' }), [{ action: '/api/mrs/label', count: 1 }])
  assert.deepEqual(summarizeActions(null, { now }), [])
})
