import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWatchInput, isWatchDue, watchPrompt, afterCheck, applyReport, toggled, parseWatchesFile, needsNewSession, expireWatches, CHECKS_PER_SESSION } from '../lib/watches.js'

const NOW = 1_000_000
const THREAD = 'https://example.slack.com/archives/C0123ABC/p1795762560799439'
const MR = 'https://git.example.com/group/repo/-/merge_requests/42'
const input = (over = {}) => ({ kind: 'slack-thread', target: THREAD, folder: '/Users/me/project', ...over })
const make = (over = {}) => ({ ...parseWatchInput(input(over), { now: NOW }).watch })

test('a watch starts due now, every 10 minutes for 7 days', () => {
  const { watch } = parseWatchInput(input(), { now: NOW })
  assert.equal(watch.state, 'watching')
  assert.equal(watch.nextAt, NOW)
  assert.equal(watch.everyMin, 10)
  assert.equal(watch.expiresAt, NOW + 7 * 86_400_000)
  assert.equal(isWatchDue(watch, NOW), true)
})

test('each kind checks its own target', () => {
  assert.match(parseWatchInput(input({ target: 'https://example.com/x' })).error, /Slack thread/)
  assert.match(parseWatchInput(input({ kind: 'deploy', target: THREAD })).error, /merge request/)
  assert.equal(parseWatchInput(input({ kind: 'deploy', target: MR })).watch.kind, 'deploy')
  assert.match(parseWatchInput(input({ kind: 'custom', target: 'short' })).error, /sentence/)
  assert.equal(parseWatchInput(input({ kind: 'custom', target: 'the staging build is green' })).watch.name, 'the staging build is green')
  assert.match(parseWatchInput(input({ kind: 'nope' })).error, /Pick/)
})

test('the folder, interval and lifetime are checked', () => {
  assert.match(parseWatchInput(input({ folder: 'relative' })).error, /absolute/)
  assert.match(parseWatchInput(input({ everyMin: 1 })).error, /minutes/)
  assert.match(parseWatchInput(input({ everyMin: 7.5 })).error, /minutes/)
  assert.match(parseWatchInput(input({ days: 90 })).error, /days/)
  assert.equal(parseWatchInput(input({ everyMin: 30, days: 2 }), { now: NOW }).watch.expiresAt, NOW + 2 * 86_400_000)
})

test('the prompt names the watch, the target, the report calls and a read-only rule', () => {
  const watch = make()
  const prompt = watchPrompt(watch, { origin: 'http://localhost:4747', since: null })
  assert.equal(prompt.startsWith(`Board watch: ${watch.name}.`), true)
  assert.match(prompt, new RegExp(watch.wid))
  assert.match(prompt, new RegExp(THREAD))
  assert.match(prompt, /"state":"done"/)
  assert.match(prompt, /"state":"waiting"/)
  assert.match(prompt, /Never post/)
  assert.match(prompt, /origin: http:\/\/localhost:4747/)
})

test('a later check says since when to look for replies', () => {
  const prompt = watchPrompt({ ...make(), checks: 3 }, { origin: 'http://localhost:4747', since: Date.UTC(2026, 10, 27, 7, 0, 0) })
  assert.match(prompt, /since 2026-11-27T07:00:00.000Z/)
  assert.match(prompt, /Check 4,/)
})

test('a check moves the next time on and counts, and the last one past the deadline expires it', () => {
  const watch = make()
  const next = afterCheck(watch, { sessionId: 'local_abc12345' }, NOW)
  assert.equal(next.nextAt, NOW + 10 * 60_000)
  assert.equal(next.checks, 1)
  assert.equal(next.sessionId, 'local_abc12345')
  assert.equal(next.state, 'watching')
  assert.equal(isWatchDue(next, NOW), false)
  assert.equal(afterCheck(watch, {}, watch.expiresAt).state, 'expired')
  assert.equal(afterCheck(next, {}, NOW + 1).sessionId, 'local_abc12345')
})

test('a done report stops the watch and a waiting report only keeps the note', () => {
  const watch = make()
  const waiting = applyReport(watch, { state: 'waiting', note: '  no   reply yet ' }, NOW)
  assert.equal(waiting.watch.state, 'watching')
  assert.equal(waiting.watch.lastNote, 'no reply yet')
  const done = applyReport(waiting.watch, { state: 'done', note: 'Sam replied' }, NOW + 5)
  assert.equal(done.watch.state, 'done')
  assert.equal(done.watch.doneAt, NOW + 5)
  assert.equal(isWatchDue(done.watch, NOW + 99_999_999), false)
  assert.match(applyReport(watch, { state: 'maybe' }, NOW).error, /done or waiting/)
  assert.equal(applyReport(done.watch, { state: 'waiting', note: 'late' }, NOW + 9).watch.state, 'done')
})

test('pause and resume only change a watch that can switch', () => {
  const watch = make()
  const paused = toggled(watch, false, NOW)
  assert.equal(paused.state, 'paused')
  assert.equal(isWatchDue(paused, NOW + 1e9), false)
  const resumed = toggled(paused, true, NOW + 50)
  assert.equal(resumed.state, 'watching')
  assert.equal(resumed.nextAt, NOW + 50)
  const done = { ...watch, state: 'done' }
  assert.equal(toggled(done, true, NOW), done)
  assert.equal(toggled(done, false, NOW), done)
  const expired = toggled({ ...watch, state: 'expired', expiresAt: NOW }, true, NOW + 10)
  assert.equal(expired.state, 'watching')
  assert.ok(expired.expiresAt >= NOW + 86_400_000)
})

test('the file keeps valid watches only and fills in missing fields', () => {
  const watch = make()
  const parsed = parseWatchesFile({ items: [watch, { wid: 'x' }, null, { ...watch, wid: 'y', state: 'weird' }] })
  assert.deepEqual(parsed.map((w) => w.wid), [watch.wid, 'y'])
  assert.equal(parsed[1].state, 'watching')
  assert.equal(parseWatchesFile(undefined).length, 0)
})

test('a watch reuses its session for a dozen checks, then starts a fresh one', () => {
  const watch = make()
  assert.equal(needsNewSession(watch), true)
  assert.equal(needsNewSession({ ...watch, sessionId: 'local_abc12345', checks: 1 }), false)
  assert.equal(needsNewSession({ ...watch, sessionId: 'local_abc12345', checks: CHECKS_PER_SESSION }), true)
})

test('only a watching watch past its deadline expires', () => {
  const [a, b, c] = expireWatches([make(), { ...make(), state: 'done' }, make({ days: 30 })], NOW + 8 * 86_400_000)
  assert.equal(a.state, 'expired')
  assert.equal(b.state, 'done')
  assert.equal(c.state, 'watching')
})
