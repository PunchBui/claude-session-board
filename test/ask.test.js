import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askFrom, publicAsk, answerLine, permissionRequestFrom, cancelledId, denyLine, errorLine, interruptLine, userMessageLine, tailJsonLines } from '../lib/ask.js'

const request = (extra = {}) => ({
  type: 'control_request',
  request_id: 'r1',
  request: {
    subtype: 'elicitation',
    mcp_server_name: 'supabase',
    message: 'Apply this migration?',
    mode: 'form',
    requested_schema: { type: 'object', required: ['confirm'], properties: { note: { type: 'string', title: 'Note' }, confirm: { type: 'boolean', title: 'Confirm' } } },
    property_order: ['confirm', 'note'],
    ...extra,
  },
})
const parse = (line) => JSON.parse(line)

test('an elicitation control_request becomes an ask with ordered, typed fields', () => {
  const ask = askFrom(request())
  assert.equal(ask.id, 'r1')
  assert.equal(ask.server, 'supabase')
  assert.equal(ask.mode, 'form')
  assert.deepEqual(ask.fields.map((f) => [f.name, f.type, f.required]), [['confirm', 'boolean', true], ['note', 'string', false]])
})

test('other messages are not asks', () => {
  assert.equal(askFrom({ type: 'assistant' }), null)
  assert.equal(askFrom({ type: 'control_request', request_id: 'x', request: { subtype: 'can_use_tool' } }), null)
  assert.equal(askFrom({ type: 'control_request', request: { subtype: 'elicitation' } }), null)
})

test('enum fields become choices and only http(s) urls survive in url mode', () => {
  const ask = askFrom(request({ requested_schema: { properties: { env: { type: 'string', enum: ['a', 'b'], enumNames: ['Alpha', 'Beta'] } } } }))
  assert.deepEqual(ask.fields[0].options, [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }])
  assert.equal(askFrom(request({ mode: 'url', url: 'javascript:alert(1)' })).url, null)
  assert.equal(askFrom(request({ mode: 'url', url: 'https://example.com/x' })).url, 'https://example.com/x')
})

test('accepting sends the declared fields, coerced, and nothing else', () => {
  const ask = askFrom(request())
  const { line, error } = answerLine(ask, { action: 'accept', content: { confirm: 'true', note: 'ok', evil: 'x' } })
  assert.equal(error, undefined)
  assert.deepEqual(parse(line), { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { action: 'accept', content: { confirm: true, note: 'ok' } } } })
})

test('accepting without a required field is refused, declining and cancelling need no content', () => {
  const ask = askFrom(request())
  assert.match(answerLine(ask, { action: 'accept', content: { note: 'x' } }).error, /Confirm.*required/)
  assert.deepEqual(parse(answerLine(ask, { action: 'decline' }).line).response.response, { action: 'decline' })
  assert.deepEqual(parse(answerLine(ask, { action: 'cancel' }).line).response.response, { action: 'cancel' })
  assert.ok(answerLine(ask, { action: 'sure' }).error)
})

test('a choice outside the offered options is dropped', () => {
  const ask = askFrom(request({ requested_schema: { required: ['env'], properties: { env: { type: 'string', enum: ['a', 'b'] } } } }))
  assert.ok(answerLine(ask, { action: 'accept', content: { env: 'c' } }).error)
  assert.equal(parse(answerLine(ask, { action: 'accept', content: { env: 'b' } }).line).response.response.content.env, 'b')
})

test('permission prompts are denied, unknown requests get an error, cancels are recognised', () => {
  const perm = { type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool' } }
  assert.equal(permissionRequestFrom(perm), 'p1')
  assert.equal(parse(denyLine('p1')).response.response.behavior, 'deny')
  assert.equal(parse(errorLine('q', 'no')).response.subtype, 'error')
  assert.equal(cancelledId({ type: 'control_cancel_request', request_id: 'r1' }), 'r1')
})

test('the first prompt is one stream-json user line', () => {
  const line = userMessageLine('hi\nthere')
  assert.ok(line.endsWith('\n'))
  assert.deepEqual(parse(line), { type: 'user', message: { role: 'user', content: 'hi\nthere' } })
})

test('the tail hands over complete lines as they are appended, including split multibyte text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-test-'))
  const file = join(dir, 'out.jsonl')
  writeFileSync(file, '')
  const seen = []
  const tail = tailJsonLines(file, (m) => seen.push(m), { pollMs: 1e6 })
  const bytes = Buffer.from('{"a":"สวัสดี"}\n{"b":2}\n')
  appendFileSync(file, bytes.subarray(0, 8))
  tail.drain()
  assert.deepEqual(seen, [])
  appendFileSync(file, bytes.subarray(8))
  tail.drain()
  assert.deepEqual(seen, [{ a: 'สวัสดี' }, { b: 2 }])
  appendFileSync(file, 'not json\n{"c":3}\n')
  tail.stop()
  assert.deepEqual(seen.at(-1), { c: 3 })
  rmSync(dir, { recursive: true, force: true })
})

test('interruptLine is a stream-json interrupt control request', () => {
  assert.deepEqual(parse(interruptLine('req-1')), { type: 'control_request', request_id: 'req-1', request: { subtype: 'interrupt' } })
  assert.ok(interruptLine('req-1').endsWith('\n'))
})

const questionRequest = (questions) => ({
  type: 'control_request',
  request_id: 'q1',
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions }, tool_use_id: 'toolu_1', requires_user_interaction: true },
})
const colour = { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }
const fruit = { question: 'Which fruits?', header: 'Fruits', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Mango' }, { label: 'Kiwi' }] }

test('an AskUserQuestion permission request becomes a question ask and is not denied', () => {
  const message = questionRequest([colour, fruit])
  const ask = askFrom(message)
  assert.equal(ask.kind, 'question')
  assert.equal(ask.id, 'q1')
  assert.deepEqual(ask.questions.map((q) => [q.question, q.header, q.multiSelect, q.options.map((o) => o.label)]), [['Which colour?', 'Colour', false, ['Red', 'Blue']], ['Which fruits?', 'Fruits', true, ['Apple', 'Mango', 'Kiwi']]])
  assert.equal(ask.questions[1].options[0].description, '')
  assert.equal('input' in publicAsk(ask), false)
  assert.equal(publicAsk(ask).questions.length, 2)
})

test('an AskUserQuestion request with no usable question is left to the permission denial', () => {
  assert.equal(askFrom(questionRequest([{ header: 'x' }])), null)
  assert.equal(askFrom(questionRequest('nope')), null)
})

test('answering questions allows the tool with the answers the CLI expects, joined like Claude Code', () => {
  const ask = askFrom(questionRequest([colour, fruit]))
  const { line, error } = answerLine(ask, { action: 'accept', answers: { 'Which colour?': ['Blue'], 'Which fruits?': ['Apple', 'Mango', 'Apple', ' '], 'Not asked?': ['x'] } })
  assert.equal(error, undefined)
  assert.deepEqual(parse(line), {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'q1', response: { behavior: 'allow', updatedInput: { questions: [colour, fruit], answers: { 'Which colour?': 'Blue', 'Which fruits?': 'Apple, Mango' } } } },
  })
})

test('a typed answer outside the options is sent as is, like Other in Claude Code', () => {
  const ask = askFrom(questionRequest([colour]))
  const { line } = answerLine(ask, { action: 'accept', answers: { 'Which colour?': 'Green, please' } })
  assert.equal(parse(line).response.response.updatedInput.answers['Which colour?'], 'Green, please')
})

test('every question needs an answer and single-choice questions take one', () => {
  const ask = askFrom(questionRequest([colour, fruit]))
  assert.match(answerLine(ask, { action: 'accept', answers: { 'Which colour?': ['Red'] } }).error, /Fruits/)
  assert.match(answerLine(ask, { action: 'accept', answers: { 'Which colour?': ['Red', 'Blue'], 'Which fruits?': ['Kiwi'] } }).error, /one answer.*Colour/)
  assert.ok(answerLine(ask, { action: 'sure' }).error)
})

test('skipping the questions denies the tool so the run carries on without answers', () => {
  const ask = askFrom(questionRequest([colour]))
  const response = parse(answerLine(ask, { action: 'decline' }).line).response.response
  assert.equal(response.behavior, 'deny')
  assert.match(response.message, /chose not to answer/)
})
