import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { recordWhenSent, actionFrom, isTrackedRoute, promptKind, recordAction, summarizeActions, MAX_ACTIONS, SHOWN_TTL_MS, replyShape, parseShown } from '../lib/actions.js'

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

test('the status is read once the response is sent, so a failure is recorded as it was', () => {
  const res = Object.assign(new EventEmitter(), { statusCode: 200 })
  const seen = []
  recordWhenSent(res, (status) => seen.push(status))
  res.statusCode = 500
  assert.deepEqual(seen, [])
  res.emit('close')
  assert.deepEqual(seen, [500])
})

test('a chip click is logged by label, other bodies are not', () => {
  const chip = actionFrom({ route: '/api/prompt', body: { id: SESSION, prompt: 'yes', chip: 'Yes, push' }, status: 202, userAgent: 'Mozilla', now: 9 })
  assert.equal(chip.chip, 'Yes, push')
  assert.equal(actionFrom({ route: '/api/prompt', body: { id: SESSION, prompt: 'yes', chip: '<script>' }, status: 202, userAgent: 'Mozilla', now: 9 }).chip, undefined)
  assert.equal(actionFrom({ route: '/api/mrs/ping', body: { url: MR, chip: 'Yes' }, status: 200, userAgent: 'Mozilla', now: 9 }).chip, undefined)
})

test('chip clicks are counted per chip, apart from typed prompts', () => {
  const log = [
    { at: 10, route: '/api/prompt', status: 202, source: 'ui', kind: 'text', chip: 'Yes' },
    { at: 11, route: '/api/queue', status: 202, source: 'ui', chip: 'Yes' },
    { at: 12, route: '/api/prompt', status: 202, source: 'ui', kind: 'text' },
  ]
  assert.deepEqual(summarizeActions(log, { now: 20, days: 1 }), [
    { action: '/api/prompt', count: 1 },
    { action: '/api/prompt chip:Yes', count: 1 },
    { action: '/api/queue chip:Yes', count: 1 },
  ])
})

test('a prompt typed while chips were shown logs its shape and the chips, never its text', () => {
  const shown = { at: 1000, labels: ['Yes', 'No'] }
  const entry = actionFrom({ route: '/api/prompt', body: { id: SESSION, prompt: 'yes, check it with the secret token' }, status: 202, userAgent: 'Mozilla', now: 2000, shown })
  assert.equal(entry.chips, 'Yes,No')
  assert.equal(entry.typedAfterChips, 'yes:7')
  assert.equal(JSON.stringify(entry).includes('secret'), false)
})

test('a chip click, a stale display or no display adds no typed-after-chips mark', () => {
  const shown = { at: 1000, labels: ['Yes'] }
  assert.equal(actionFrom({ route: '/api/prompt', body: { id: SESSION, prompt: 'yes', chip: 'Yes' }, status: 202, userAgent: 'Mozilla', now: 2000, shown }).typedAfterChips, undefined)
  assert.equal(actionFrom({ route: '/api/prompt', body: { id: SESSION, prompt: 'yes' }, status: 202, userAgent: 'Mozilla', now: 1000 + SHOWN_TTL_MS + 1, shown }).typedAfterChips, undefined)
  assert.equal(actionFrom({ route: '/api/prompt', body: { id: SESSION, prompt: 'yes' }, status: 202, userAgent: 'Mozilla', now: 2000 }).typedAfterChips, undefined)
})

test('an unknown first word is logged as other', () => {
  assert.equal(replyShape('please rebase it'), 'other:3')
  assert.equal(replyShape(''), 'other:0')
})

test('the shown report keeps only valid chip labels and a valid session', () => {
  assert.deepEqual(parseShown({ id: SESSION, labels: ['Yes', 'No', 'bad<label>', 5] }), { id: SESSION, labels: ['Yes', 'No'] })
  assert.equal(parseShown({ id: 'x', labels: ['Yes'] }), null)
  assert.equal(parseShown({ id: SESSION, labels: [] }), null)
  assert.equal(actionFrom({ route: '/api/chips/shown', body: { id: SESSION, labels: ['Yes', 'No'] }, status: 200, userAgent: 'Mozilla', now: 1 }).chips, 'Yes,No')
})

test('the summary separates typed-after-chips, shown and chip clicks', () => {
  const log = [
    { at: 10, route: '/api/prompt', status: 202, source: 'ui', typedAfterChips: 'yes:3', chips: 'Yes,No' },
    { at: 10, route: '/api/prompt', status: 202, source: 'ui', chip: 'Yes' },
    { at: 10, route: '/api/chips/shown', status: 200, source: 'ui', chips: 'Yes,No' },
  ]
  const actions = Object.fromEntries(summarizeActions(log, { now: 20 }).map((a) => [a.action, a.count]))
  assert.deepEqual(actions, { '/api/prompt typed-after-chips:yes': 1, '/api/prompt chip:Yes': 1, '/api/chips/shown Yes,No': 1 })
})
