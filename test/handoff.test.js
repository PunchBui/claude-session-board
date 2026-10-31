import test from 'node:test'
import assert from 'node:assert/strict'
import { handoffFile, handoffPrompt, handoffLink, HANDOFF_FOCUS } from '../lib/handoff.js'

test('handoff file lives in the temp dir and is unique per request', () => {
  const a = handoffFile('local_abcdef12-3456', '/tmp/x', 1)
  assert.equal(a, '/tmp/x/handoff-abcdef12-1.md')
  assert.notEqual(a, handoffFile('local_abcdef12-3456', '/tmp/x', 2))
})

test('handoff prompt runs the skill and names the exact output path', () => {
  const prompt = handoffPrompt('/tmp/x/h.md')
  assert.ok(prompt.startsWith('/handoff '))
  assert.ok(prompt.includes(HANDOFF_FOCUS))
  assert.ok(prompt.endsWith('/tmp/x/h.md'))
})

test('handoff link opens a new chat in the folder and points at the file', () => {
  const url = new URL(handoffLink({ folder: '/Users/me/my repo', file: '/tmp/x/h.md' }))
  assert.equal(url.protocol, 'claude:')
  assert.equal(url.searchParams.get('folder'), '/Users/me/my repo')
  assert.match(url.searchParams.get('q'), /\/tmp\/x\/h\.md/)
  assert.equal(new URL(handoffLink({ file: '/a.md' })).searchParams.has('folder'), false)
})
