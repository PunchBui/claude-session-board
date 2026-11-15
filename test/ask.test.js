import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askFrom, answerLine, permissionRequestFrom, cancelledId, denyLine, errorLine, userMessageLine, tailJsonLines } from '../lib/ask.js'

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
