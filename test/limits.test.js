import test from 'node:test'
import assert from 'node:assert/strict'
import { shapeLimits, tokenFromCredentials, createLimitsReader } from '../lib/limits.js'

test('shapeLimits keeps percent and reset for both windows', () => {
  const out = shapeLimits({ five_hour: { utilization: 28.6, resets_at: 'a' }, seven_day: { utilization: 3, resets_at: 'b' } })
  assert.deepEqual(out, { fiveHour: { percent: 29, resetsAt: 'a' }, weekly: { percent: 3, resetsAt: 'b' } })
  assert.deepEqual(shapeLimits({}), { fiveHour: null, weekly: null })
})

test('tokenFromCredentials tolerates junk', () => {
  assert.equal(tokenFromCredentials('{"claudeAiOauth":{"accessToken":"t"}}'), 't')
  assert.equal(tokenFromCredentials('nope'), '')
})

test('reader caches, and reports unavailable without a token', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ five_hour: { utilization: 10, resets_at: 'x' } }) } }
  const read = createLimitsReader({ getToken: async () => 't', fetchImpl, now: () => 1000 })
  await read(); const second = await read()
  assert.equal(calls, 1)
  assert.equal(second.fiveHour.percent, 10)
  const none = await createLimitsReader({ getToken: async () => '' })()
  assert.equal(none.available, false)
})
