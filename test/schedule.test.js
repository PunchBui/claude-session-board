import test from 'node:test'
import assert from 'node:assert/strict'
import { fireDue, advanceFired, nextAfter } from '../lib/schedule.js'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-03T12:00:00Z')
const item = (over = {}) => ({ sid: 's1', id: 'local_a', prompt: 'go', at: NOW - HOUR, repeat: 'none', ...over })

test('only due schedules whose prompt was queued count as fired', async () => {
  const due = item()
  const later = item({ sid: 's2', at: NOW + HOUR })
  const sent = []
  const fired = await fireDue([due, later], { now: NOW, enqueue: async (id, prompt) => { sent.push([id, prompt]); return true } })
  assert.deepEqual(fired, [due])
  assert.deepEqual(sent, [['local_a', 'go']])
})

test('a schedule stays put when the queue refused its prompt, so the next tick retries', async () => {
  const stuck = item()
  const fired = await fireDue([stuck], { now: NOW, enqueue: async () => false })
  assert.deepEqual(fired, [])
  assert.deepEqual(advanceFired([stuck], fired, NOW), [stuck])
})

test('a fired one-off is removed and a fired repeat moves to its next time', () => {
  const once = item()
  const daily = item({ sid: 's2', repeat: 'daily' })
  const idle = item({ sid: 's3', at: NOW + HOUR })
  const next = advanceFired([once, daily, idle], [once, daily], NOW)
  assert.deepEqual(next.map((entry) => entry.sid), ['s2', 's3'])
  assert.equal(next[0].at, nextAfter(daily.at, 'daily', NOW))
  assert.equal(next[1], idle)
})
