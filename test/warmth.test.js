import test from 'node:test'
import assert from 'node:assert/strict'
import { warmthOf, warmthTip } from '../public/warmth.js'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const ago = (ms) => NOW - ms
const HOUR = 3_600_000
const DAY = 24 * HOUR

test('tiers follow the time since the last prompt', () => {
  const tier = (ms) => warmthOf({ lastPromptAt: ago(ms) }, NOW).tier
  assert.equal(tier(5 * 60_000), 'hot')
  assert.equal(tier(3 * HOUR), 'warm')
  assert.equal(tier(3 * DAY), 'cooling')
  assert.equal(tier(12 * DAY), 'cold')
})

test('hot and warm are the warm group, cooling and cold the cool group', () => {
  const group = (ms) => warmthOf({ lastPromptAt: ago(ms) }, NOW).group
  assert.equal(group(HOUR - 1), 'warm')
  assert.equal(group(DAY - 1), 'warm')
  assert.equal(group(DAY), 'cool')
  assert.equal(group(30 * DAY), 'cool')
})

test('falls back to last activity when no prompt time is known', () => {
  assert.equal(warmthOf({ lastPromptAt: null, lastActivityAt: ago(2 * DAY) }, NOW).tier, 'cooling')
})

test('a keep timestamp newer than the prompt resets the tier', () => {
  const session = { lastPromptAt: ago(5 * DAY) }
  assert.equal(warmthOf(session, NOW).tier, 'cooling')
  assert.equal(warmthOf(session, NOW, ago(60_000)).tier, 'hot')
})

test('a session with no timestamps is cold', () => {
  assert.equal(warmthOf({}, NOW).tier, 'cold')
})

test('starring does not change the tier', () => {
  assert.equal(warmthOf({ lastPromptAt: ago(10 * DAY), starred: true }, NOW).tier, 'cold')
})

test('the tooltip explains the tier and shows when you last prompted', () => {
  const session = { lastPromptAt: ago(3 * DAY) }
  const tip = warmthTip(session, warmthOf(session, NOW), 0, NOW)
  assert.equal(tip.heading, 'Cooling')
  assert.match(tip.text, /over a day/)
  assert.equal(tip.rows[0][0], 'Last prompt')
  assert.match(tip.rows[0][1], /3d ago/)
})

test('the tooltip mentions a keep only when it is the latest touch', () => {
  const session = { lastPromptAt: ago(5 * DAY) }
  const kept = warmthTip(session, warmthOf(session, NOW, ago(60_000)), ago(60_000), NOW)
  assert.ok(kept.rows.some(([label]) => label === 'Kept warm'))
  const older = warmthTip({ lastPromptAt: ago(60_000) }, warmthOf({ lastPromptAt: ago(60_000) }, NOW), ago(DAY), NOW)
  assert.ok(!older.rows.some(([label]) => label === 'Kept warm'))
})
