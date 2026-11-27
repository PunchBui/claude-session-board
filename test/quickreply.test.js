import test from 'node:test'
import assert from 'node:assert/strict'
import { quickReplies, lastAssistantText, stalledFor } from '../public/quickreply.js'

const card = (chat, extra = {}) => ({ details: { chat, filesEdited: 0 }, run: null, active: false, live: null, queue: { items: [] }, ...extra })
const say = (text) => ({ role: 'assistant', text })
const labels = (c) => quickReplies(c).map((r) => r.label)

test('a closing question offers Yes and No', () => {
  assert.deepEqual(labels(card([say('I can rename it. Shall I go ahead?')])), ['Yes', 'No'])
})

test('a question about pushing offers the push answer too', () => {
  assert.deepEqual(labels(card([say('Done. Want me to commit and push?')])), ['Yes', 'Yes, push', 'No'])
})

test('a statement with no question and no edits offers nothing', () => {
  assert.deepEqual(labels(card([say('All tests pass.')])), [])
})

test('edited files offer commit and push and commit and create MR', () => {
  const c = card([say('Changed the parser.')])
  c.details.filesEdited = 2
  assert.deepEqual(labels(c), ['Commit and push', 'Commit and create MR'])
})

test('a pipeline mention offers Check again', () => {
  assert.deepEqual(labels(card([say('The pipeline is still running.')])), ['Check again'])
})

test('a reply the user already sent hides the chips', () => {
  assert.deepEqual(labels(card([say('Proceed?'), { role: 'user', text: 'yes' }])), [])
  assert.equal(lastAssistantText([say('a'), { role: 'user', text: 'b' }]), null)
})

test('no chips while the session is busy, asking or has a queue', () => {
  const chat = [say('Proceed?')]
  assert.deepEqual(labels(card(chat, { active: true })), [])
  assert.deepEqual(labels(card(chat, { run: { state: 'running' } })), [])
  assert.deepEqual(labels(card(chat, { live: { attention: { kind: 'question' } } })), [])
  assert.deepEqual(labels(card(chat, { queue: { items: [{}] } })), [])
})

test('tool rows between the question and now do not hide it', () => {
  assert.deepEqual(labels(card([say('Proceed?'), { role: 'tools', tools: [] }])), ['Yes', 'No'])
})

test('commit chips go away once the last message says it was pushed', () => {
  const c = card([say('Committed and pushed to the branch.')])
  c.details.filesEdited = 3
  assert.deepEqual(labels(c), [])
})

test('an offer with no question mark offers Yes, do it', () => {
  assert.deepEqual(labels(card([say('I fixed the parser. Say if you want me to add a test.')])), ['Yes, do it'])
  assert.deepEqual(labels(card([say('Done. I can also write the migration.')])), ['Yes, do it'])
})

test('a question keeps Yes and No instead of the offer chip', () => {
  assert.deepEqual(labels(card([say('Want me to add a test?')])), ['Yes', 'No'])
})

const NOW = 10_000_000
const stuck = (extra = {}) => card([say('Working on it.')], { run: { state: 'running' }, touchedAt: NOW - 11 * 60_000, ...extra })

test('a running session quiet for 10 minutes is stalled and offers Are you stuck', () => {
  assert.equal(stalledFor(stuck(), NOW), 11 * 60_000)
  assert.deepEqual(quickReplies(stuck(), NOW).map((r) => r.label), ['Are you stuck?'])
  assert.equal(quickReplies(stuck(), NOW)[0].stuck, true)
})

test('under 10 minutes quiet, an idle session, a question or subagents are not stalled', () => {
  assert.equal(stalledFor(stuck({ touchedAt: NOW - 9 * 60_000 }), NOW), null)
  assert.equal(stalledFor(card([say('x')], { touchedAt: NOW - 60 * 60_000 }), NOW), null)
  assert.equal(stalledFor(stuck({ live: { attention: { kind: 'question' } } }), NOW), null)
  assert.equal(stalledFor(stuck({ live: { subagents: [{ name: 'Agent' }] } }), NOW), null)
  assert.equal(stalledFor(stuck({ backgroundTasks: { tasks: [{ status: 'running' }] } }), NOW), null)
  assert.equal(stalledFor(stuck({ queue: { items: [{}] } }), NOW), null)
})

test('a desktop session that is working quietly counts as stalled too', () => {
  assert.equal(stalledFor(card([], { live: { working: true }, touchedAt: NOW - 12 * 60_000 }), NOW), 12 * 60_000)
})
