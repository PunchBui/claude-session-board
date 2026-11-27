import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newScanState, absorbLine, absorbBuffer, localDay, transcriptTitle, isHandoffFile, isSystemWrapper, createScanStore } from '../lib/scan.js'
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

test('live: a board run waiting on a question needs the person even while it runs', () => {
  const state = newScanState()
  absorbLine(state, assistant('h', [{ type: 'tool_use', id: 'q2', name: 'AskUserQuestion', input: { questions: [{ question: 'Which env?' }] } }], { output_tokens: 1 }))
  const now = Date.now()
  const ask = { id: 'r1', kind: 'question', questions: [{ question: 'Which env?', header: 'Env', multiSelect: false, options: [] }], at: now - 1000 }
  const waiting = liveOf(state, { nowMs: now, mtimeMs: now - 5000, running: true, asks: [ask] })
  assert.deepEqual(waiting.attention, { kind: 'question', tool: 'AskUserQuestion', text: 'Which env?', since: now - 1000, board: true })
  assert.equal(waiting.working, true)
  assert.equal(waiting.phase, 'idle')
  assert.equal(liveOf(state, { nowMs: now, mtimeMs: now - 5000, running: true }).attention, null)
  const mcp = liveOf(state, { nowMs: now, mtimeMs: now - 5000, running: true, asks: [{ id: 'r2', kind: 'elicitation', server: 'supabase', message: 'Apply?', at: now }] })
  assert.equal(mcp.attention.tool, 'supabase')
  assert.equal(mcp.attention.text, 'Apply?')
})

test('live: a quiet pending tool is not an approval when the session never prompts', () => {
  const now = Date.now()
  const build = (mode) => {
    const state = newScanState()
    if (mode) absorbLine(state, line({ type: 'user', timestamp: '2026-10-27T08:00:00.000Z', permissionMode: mode, message: { role: 'user', content: 'run it' } }))
    absorbLine(state, assistant('p', [{ type: 'tool_use', id: 'm1', name: 'mcp__superset__call_tool', input: { query: 'select 1' } }], { output_tokens: 1 }))
    return liveOf(state, { nowMs: now, mtimeMs: now - 120_000, running: false })
  }
  assert.equal(build('default').attention.kind, 'approval')
  assert.equal(build(null).attention.kind, 'approval')
  assert.equal(build('bypassPermissions').attention, null)
  assert.equal(build('dontAsk').attention, null)
  assert.equal(build('bypassPermissions').phase, 'tool')
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

test('takes the session title from the transcript, preferring a rename over the AI title', () => {
  const state = newScanState()
  assert.equal(transcriptTitle(state), null)
  absorbLine(state, JSON.stringify({ type: 'ai-title', aiTitle: 'Generated name', sessionId: 's' }))
  assert.equal(transcriptTitle(state), 'Generated name')
  absorbLine(state, JSON.stringify({ type: 'custom-title', customTitle: 'First name', sessionId: 's' }))
  absorbLine(state, JSON.stringify({ type: 'custom-title', customTitle: 'Renamed', sessionId: 's' }))
  absorbLine(state, JSON.stringify({ type: 'custom-title', customTitle: '  ', sessionId: 's' }))
  assert.equal(transcriptTitle(state), 'Renamed')
  assert.equal(state.messages.length, 0)
})

test('a local command output ends the turn, so the run is not stalled and the card is not thinking', () => {
  const state = newScanState()
  absorbLine(state, line({ type: 'user', timestamp: '2026-11-11T10:00:00Z', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' } }))
  assert.equal(state.lastKind, 'user')
  absorbLine(state, line({ type: 'system', subtype: 'local_command', timestamp: '2026-11-11T10:00:01Z', content: '<local-command-stdout>Current model: Opus</local-command-stdout>', commandRun: { command: 'model', args: '' } }))
  assert.equal(state.lastKind, 'command')
  assert.equal(state.lastStop, 'end_turn')
  const live = liveOf(state, { nowMs: Date.parse('2026-11-11T10:05:00Z'), mtimeMs: Date.parse('2026-11-11T10:00:01Z'), running: false })
  assert.equal(live.working, false)
})

test('a prompt that points at a handoff document is recorded, and only handoff markdown counts as one', () => {
  const state = newScanState({ ownId: 'own' })
  absorbLine(state, user('Read the handoff document at /var/folders/T/handoff-elmo-20261119-134841.md and continue.', { sessionId: 'own' }))
  absorbLine(state, user('Look at /tmp/notes.md and ~/handoff-x.md', { sessionId: 'own' }))
  absorbLine(state, user('Inherited /tmp/handoff-old.md', { sessionId: 'parent' }))
  assert.deepEqual([...state.handoffReads], ['/var/folders/T/handoff-elmo-20261119-134841.md', '~/handoff-x.md'])
  assert.equal(isHandoffFile('/tmp/handoff-34f7807b-1795059846934.md'), true)
  assert.equal(isHandoffFile('/tmp/handoff/notes.md'), false)
  assert.equal(isHandoffFile('/tmp/handoff.txt'), false)
})

test('a show_widget call becomes a widget in the chat and read_me stays hidden', () => {
  const state = newScanState()
  absorbLine(state, assistant('w', [
    { type: 'tool_use', id: 'r', name: 'mcp__visualize__read_me', input: { modules: ['diagram'] } },
    { type: 'tool_use', id: 'v', name: 'mcp__visualize__show_widget', input: { title: 'login_flow', loading_messages: ['x'], widget_code: '<svg viewBox="0 0 10 10"></svg>' } },
    { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } },
  ], { output_tokens: 1 }))
  assert.deepEqual(state.chat.map((item) => item.role), ['widget', 'tools'])
  assert.deepEqual(state.chat[0], { role: 'widget', at: '2026-10-27T08:00:00.000Z', title: 'login_flow', code: '<svg viewBox="0 0 10 10"></svg>' })
  assert.deepEqual(state.chat[1].tools.map((tool) => tool.name), ['Bash'])
  assert.equal(state.toolCalls, 3)
})

test('an oversized or empty widget keeps its place without the code', () => {
  const state = newScanState()
  absorbLine(state, assistant('w', [
    { type: 'tool_use', id: 'v', name: 'mcp__visualize__show_widget', input: { title: 'huge', widget_code: 'x'.repeat(400_001) } },
    { type: 'tool_use', id: 'e', name: 'mcp__visualize__show_widget', input: { title: 'empty' } },
  ], { output_tokens: 1 }))
  assert.deepEqual(state.chat.map(({ code, size }) => ({ code, size })), [{ code: null, size: 400_001 }, { code: null, size: 0 }])
})

test('pasted markup is indexed as a prompt while command and system wrappers stay skipped', () => {
  const state = newScanState()
  absorbLine(state, user('<div class="x">why does this render twice?</div>'))
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].text, '<div class="x">why does this render twice?</div>')
  assert.equal(state.lastKind, 'user')
  assert.equal(state.lastPromptAt, '2026-10-27T08:00:05.000Z')
  const skipped = new Set(['<system-reminder>x</system-reminder>', '<local-command-stdout>ok</local-command-stdout>', '<local-command-caveat>c</local-command-caveat>', '<task-notification><task-id>1</task-id></task-notification>', '<command-message>x</command-message>'])
  for (const text of skipped) assert.ok(isSystemWrapper(text), text)
  for (const text of ['<div>', '<xml><a/></xml>', 'plain', '<commandline>']) assert.ok(!isSystemWrapper(text), text)
  const before = state.messages.length
  for (const text of skipped) absorbLine(state, user(text))
  absorbLine(state, user([{ type: 'text', text: '<system-reminder>x</system-reminder>' }]))
  assert.equal(state.messages.length, before)
  absorbLine(state, user([{ type: 'text', text: '<b>bold question</b>' }]))
  assert.equal(state.messages.length, before + 1)
})

test('the scan store keeps the most recently used states and rescans an evicted file from the start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-scan-'))
  try {
    const store = createScanStore({ maxStates: 2 })
    const files = ['a', 'b', 'c'].map((name) => {
      const path = join(dir, `${name}.jsonl`)
      writeFileSync(path, `${user(`prompt ${name}`)}\n`)
      return path
    })
    const size = () => Buffer.byteLength(`${user('prompt x')}\n`)
    await store.scan(files[0], size())
    await store.scan(files[1], size())
    await store.scan(files[0], size())
    await store.scan(files[2], size())
    assert.deepEqual([...store.states.keys()], [files[0], files[2]])
    const again = await store.scan(files[1], size())
    assert.equal(again.messages.length, 1)
    assert.equal(again.messages[0].text, 'prompt b')
    assert.deepEqual([...store.states.keys()], [files[2], files[1]])
    appendFileSync(files[1], `${user('later')}\n`)
    const grown = await store.scan(files[1], size() * 2 + 1)
    assert.ok(grown.messages.length >= 1)
    assert.equal(store.states.size, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
