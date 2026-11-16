import test from 'node:test'
import assert from 'node:assert/strict'
import { runsBetween, monthGrid, eventsByDay, dayKey, modelLabel, effortLabel } from '../public/calendar.js'

const r = (extra) => ({ enabled: true, repeat: 'daily', at: new Date(2026, 10, 16, 9).getTime(), ...extra })
const day = (d) => new Date(2026, 10, d).getTime()

test('daily repeats fill the range from the next run on', () => {
  assert.equal(runsBetween(r(), day(1), day(30)).length, 14)
})
test('weekdays skip weekends, weekly steps seven days, none runs once', () => {
  assert.equal(runsBetween(r({ repeat: 'weekdays' }), day(16), day(23)).length, 5)
  assert.equal(runsBetween(r({ repeat: 'weekly' }), day(16), day(30)).length, 2)
  assert.equal(runsBetween(r({ repeat: 'none' }), day(1), day(30)).length, 1)
})
test('paused routines have no runs', () => {
  assert.deepEqual(runsBetween(r({ enabled: false }), day(1), day(30)), [])
})
test('month grid is six Sunday-first weeks and events group by day', () => {
  const grid = monthGrid(new Date(2026, 10, 16))
  assert.equal(grid.length, 42)
  assert.equal(grid[0].getDay(), 0)
  const map = eventsByDay([r({ repeat: 'none' })], grid)
  assert.equal(map.get(dayKey(new Date(2026, 10, 16))).length, 1)
})
test('labels', () => {
  assert.equal(modelLabel(null), 'Default')
  assert.equal(modelLabel('opus'), 'Opus')
  assert.equal(effortLabel('xhigh'), 'Extra high')
})

import { weekGrid, dayGrid, shiftAnchor } from '../public/calendar.js'
test('week and day grids and paging', () => {
  const w = weekGrid(new Date(2026, 10, 18))
  assert.equal(w.length, 7)
  assert.equal(w[0].getDate(), 15)
  assert.equal(dayGrid(new Date(2026, 10, 18)).length, 1)
  assert.equal(shiftAnchor(new Date(2026, 10, 18), 'week', 1).getDate(), 25)
  assert.equal(shiftAnchor(new Date(2026, 10, 30), 'day', 1).getMonth(), 11)
  assert.equal(shiftAnchor(new Date(2026, 10, 18), 'month', -1).getMonth(), 9)
})
