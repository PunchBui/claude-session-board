import test from 'node:test'
import assert from 'node:assert/strict'
import { newScanState, absorbLine, absorbBuffer, localDay } from '../lib/scan.js'
import { usageOf, liveOf } from '../lib/live.js'

const line = (value) => JSON.stringify(value)
const assistant = (id, content, usage, extra = {}) => line({ type: 'assistant', timestamp: '2026-10-27T08:00:00.000Z', message: { id, model: 'm', content, usage }, ...extra })
const user = (content, extra = {}) => line({ type: 'user', timestamp: '2026-10-27T08:00:05.000Z', message: { content }, ...extra })

test('dedupes usage by message id and keeps the last value', () => {
  const state = newScanState()
  absorbLine(state, assistant('a', [{ type: 'text', text: 'hi' }], { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }))
  absorbLine(state, assistant('a', [{ type: 'text', text: 'again' }], { input_tokens: 1, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }))
  const usage = usageOf(state)
  assert.equal(usage.responses, 1)
  assert.equal(usage.output, 9)
  assert.equal(usage.context, 111)
})

test('keeps long messages whole and skips meta and system-looking user text', () => {
  const state = newScanState()
  const long = 'x'.repeat(5000)
  absorbLine(state, user(long))
  absorbLine(state, user('<system-reminder>hidden</system-reminder>'))
  absorbLine(state, user('skill body', { isMeta: true }))
  absorbLine(state, assistant('b', [{ type: 'text', text: long }], { output_tokens: 1 }))
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[0].text.length, 5000)
  assert.equal(state.messages[1].text.length, 5000)
})

test('tracks edited files, tickets and merge request links', () => {
  const state = newScanState()
  absorbLine(state, assistant('c', [
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/repo/a.js' } },
    { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/repo/a.js' } },
    { type: 'text', text: 'Fixed PROJ-123, see https://gitlab.example.com/g/p/-/merge_requests/54 and UTF-8 / ISO-8601' },
  ], { output_tokens: 1 }))
  assert.equal(state.files.get('/repo/a.js').count, 2)
  assert.deepEqual([...state.tickets.keys()], ['PROJ-123'])
  assert.equal([...state.links.keys()][0], 'https://gitlab.example.com/g/p/-/merge_requests/54')
})

test('a tool result clears the pending tool call', () => {
  const state = newScanState()
  absorbLine(state, assistant('d', [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }], { output_tokens: 1 }))
  assert.equal(state.pending.size, 1)
  absorbLine(state, user([{ type: 'tool_result', tool_use_id: 't9', content: 'ok' }]))
  assert.equal(state.pending.size, 0)
})

test('does not split multibyte characters across chunk boundaries', () => {
  const state = newScanState()
  const bytes = Buffer.from(`${assistant('e', [{ type: 'text', text: 'สวัสดี 你好' }], { output_tokens: 1 })}\n`)
  absorbBuffer(state, bytes.subarray(0, 140))
  absorbBuffer(state, bytes.subarray(140))
  assert.equal(state.messages[0].text, 'สวัสดี 你好')
})

test('live: question and stale approval detection', () => {
  const state = newScanState()
  absorbLine(state, assistant('f', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which env?' }] } }], { output_tokens: 1 }))
  const now = Date.now()
  const asking = liveOf(state, { nowMs: now, mtimeMs: now - 5000, running: false })
  assert.equal(asking.attention.kind, 'question')
  assert.equal(asking.attention.text, 'Which env?')

  const other = newScanState()
  absorbLine(other, assistant('g', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'rm -rf x' } }], { output_tokens: 1 }))
  assert.equal(liveOf(other, { nowMs: now, mtimeMs: now - 5000, running: false }).attention, null)
  assert.equal(liveOf(other, { nowMs: now, mtimeMs: now - 60_000, running: false }).attention.kind, 'approval')
  assert.equal(liveOf(other, { nowMs: now, mtimeMs: now - 5000, running: false }).phase, 'tool')
})

test('live: subagents come from pending Agent calls', () => {
  const state = newScanState()
  absorbLine(state, assistant('h', [{ type: 'tool_use', id: 's1', name: 'Agent', input: { description: 'Explore repo' } }], { output_tokens: 1 }))
  const live = liveOf(state, { nowMs: Date.now(), mtimeMs: Date.now(), running: false })
  assert.equal(live.subagents.length, 1)
  assert.equal(live.subagents[0].text, 'Explore repo')
})

test('localDay formats local dates and rejects junk', () => {
  assert.match(localDay('2026-10-27T08:00:00.000Z'), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(localDay('nope'), null)
})

test('slash commands become a user message and local command output becomes a command item', () => {
  const state = newScanState()
  absorbLine(state, user('<command-message>hello</command-message>\n<command-name>/hello</command-name>\n<command-args>world</command-args>'))
  absorbLine(state, user('<local-command-caveat>ignore me</local-command-caveat>', { isMeta: true }))
  absorbLine(state, user('<command-name>/context</command-name>\n   <command-message>context</command-message>\n   <command-args></command-args>'))
  absorbLine(state, line({ type: 'system', subtype: 'local_command', timestamp: '2026-10-27T08:00:09.000Z', content: '<local-command-stdout>## Context Usage\n\n**Tokens:** 43k / 1m</local-command-stdout>' }))
  const roles = state.chat.map((item) => item.role)
  assert.deepEqual(roles, ['user', 'user', 'command'])
  assert.equal(state.chat[0].text, '/hello world')
  assert.equal(state.chat[1].text, '/context')
  assert.equal(state.chat[2].command, '/context')
  assert.match(state.chat[2].text, /Tokens/)
})

test('empty local command output adds nothing', () => {
  const state = newScanState()
  absorbLine(state, line({ type: 'system', subtype: 'local_command', timestamp: '2026-10-27T08:00:09.000Z', content: '<local-command-stdout></local-command-stdout>' }))
  assert.equal(state.chat.length, 0)
})
