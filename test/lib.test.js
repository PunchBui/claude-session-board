import test from 'node:test'
import assert from 'node:assert/strict'
import { nextAfter } from '../lib/schedule.js'
import { searchSessions } from '../lib/search.js'
import { aggregateUsage } from '../lib/usage.js'
import { parseBranchLine } from '../lib/git.js'

test('nextAfter handles none, daily and weekdays and skips past times', () => {
  const friday = new Date(2026, 9, 23, 9, 0).getTime()
  assert.equal(nextAfter(friday, 'none'), null)
  assert.equal(new Date(nextAfter(friday, 'daily', friday)).getDate(), 24)
  assert.equal(new Date(nextAfter(friday, 'weekdays', friday)).getDay(), 1)
  const longAgo = new Date(2026, 0, 1, 9, 0).getTime()
  assert.ok(nextAfter(longAgo, 'daily', friday) > friday)
})

test('search requires every token, groups by session and returns snippets', () => {
  const entries = [
    { id: 'a', title: 'A', project: 'p', cwd: '/p', archived: false, messages: [{ role: 'user', at: '2026-10-01T00:00:00Z', text: 'Fix the deploy migration' }, { role: 'assistant', at: '2026-10-02T00:00:00Z', text: 'Deploy done' }] },
    { id: 'b', title: 'B', project: 'q', cwd: '/q', archived: false, messages: [{ role: 'user', at: '2026-10-03T00:00:00Z', text: 'deploy and migration' }] },
  ]
  const result = searchSessions(entries, 'deploy migration')
  assert.equal(result.totalHits, 2)
  assert.deepEqual(result.sessions.map((s) => s.id), ['b', 'a'])
  assert.match(result.sessions[0].hits[0].snippet, /deploy/)
  assert.equal(searchSessions(entries, '   ').sessions.length, 0)
})

test('usage aggregates per project and day inside the window only', () => {
  const today = new Date(2026, 9, 27)
  const entries = [{ id: 'a', title: 'A', project: 'p', byId: new Map([
    ['1', { input: 1, output: 10, cacheRead: 100, cacheWrite: 5, day: '2026-10-27' }],
    ['2', { input: 1, output: 20, cacheRead: 100, cacheWrite: 5, day: '2026-10-26' }],
    ['3', { input: 1, output: 99, cacheRead: 100, cacheWrite: 5, day: '2026-01-01' }],
  ]) }]
  const result = aggregateUsage(entries, 7, today)
  assert.equal(result.days.length, 7)
  assert.equal(result.series.p['2026-10-27'].output, 10)
  assert.equal(result.sessions[0].output, 30)
})

test('parseBranchLine reads ahead and behind', () => {
  assert.deepEqual(parseBranchLine('## main...origin/main [ahead 2, behind 1]'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
  assert.equal(parseBranchLine('## feature/x').branch, 'feature/x')
})
