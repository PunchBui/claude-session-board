import test from 'node:test'
import assert from 'node:assert/strict'
import { quickReplies, lastAssistantText } from '../public/quickreply.js'

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
