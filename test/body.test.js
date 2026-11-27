import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readJsonBody, readBytes, BodyTooLargeError, BadBodyError, MAX_BODY_BYTES } from '../lib/body.js'
import { MAX_PROMPT_CHARS, validPrompt } from '../lib/runs.js'
import { MAX_NAME_CHARS } from '../lib/routines.js'

const request = (text, headers = {}) => Object.assign(Readable.from([Buffer.from(text)]), { headers })

test('a body is parsed as JSON and an empty body is an empty object', async () => {
  assert.deepEqual(await readJsonBody(request('{"prompt":"สวัสดี"}')), { prompt: 'สวัสดี' })
  assert.deepEqual(await readJsonBody(request('')), {})
})

test('the longest prompt in the costliest characters fits in a body', async () => {
  const longest = MAX_PROMPT_CHARS
  assert.ok(validPrompt('x'.repeat(longest)))
  assert.ok(!validPrompt('x'.repeat(longest + 1)))
  for (const char of ['ก', '😀'.slice(0, 1), '\u0001', '"', '€']) {
    const routine = { name: char.repeat(MAX_NAME_CHARS), prompt: char.repeat(longest), folder: `/${char.repeat(1023)}`, at: Date.now(), repeat: 'weekdays', model: 'opus', effort: 'max', permissionMode: 'bypassPermissions' }
    const text = JSON.stringify(routine)
    assert.ok(Buffer.byteLength(text) < MAX_BODY_BYTES, `${JSON.stringify(char)} needs ${Buffer.byteLength(text)} bytes`)
    assert.equal((await readJsonBody(request(text))).prompt.length, longest)
  }
})

test('a Thai prompt at the character limit is read', async () => {
  const prompt = 'ภาษาไทย'.repeat(Math.floor(MAX_PROMPT_CHARS / 7))
  assert.ok(Buffer.byteLength(prompt) > 20_000)
  assert.equal((await readJsonBody(request(JSON.stringify({ id: 'local_x', prompt })))).prompt, prompt)
})

test('an oversize body is refused with a typed error, by header or by bytes read', async () => {
  await assert.rejects(readJsonBody(request('{}', { 'content-length': String(MAX_BODY_BYTES + 1) })), BodyTooLargeError)
  await assert.rejects(readJsonBody(request(JSON.stringify({ prompt: 'x'.repeat(MAX_BODY_BYTES) }))), BodyTooLargeError)
  await assert.rejects(readJsonBody(request('{"a":1}'), { maxBytes: 4 }), (error) => error instanceof BodyTooLargeError && /larger than/.test(error.message))
})

test('invalid JSON, null and non-object bodies are a typed bad request that keeps the cause', async () => {
  for (const text of ['{nope', 'null', '[1]', '"x"', '7']) {
    await assert.rejects(readJsonBody(request(text)), (error) => error instanceof BadBodyError && !/nope|Unexpected/.test(error.message) && Boolean(error.cause), text)
  }
})

test('raw bytes stop at the limit even when the request is chunked without a length', async () => {
  const chunked = () => Object.assign(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), { headers: {} })
  assert.equal((await readBytes(chunked(), { maxBytes: 12 })).length, 12)
  await assert.rejects(readBytes(chunked(), { maxBytes: 11 }), BodyTooLargeError)
})
