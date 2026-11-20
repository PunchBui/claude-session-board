import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveTicket, outOfOrder, workingMs, fmtSpan, percentile, gapRows, kpiValues, inRange, matchesFilter, DAY_MS } from '../public/flow.js'

const H = 3_600_000
const MON = new Date(2026, 10, 16, 9).getTime()
const at = (hours) => MON + hours * H
const jira = (hours) => ({ at: at(hours), source: 'jira' })
const gitlab = (hours) => ({ at: at(hours), source: 'gitlab' })

test('spans format as minutes, hours and days', () => {
  assert.equal(fmtSpan(35 * 60_000), '35m')
  assert.equal(fmtSpan(5 * H + 10 * 60_000), '5h 10m')
  assert.equal(fmtSpan(2 * DAY_MS + 4 * H), '2d 4h')
  assert.equal(fmtSpan(12 * DAY_MS + 4 * H), '12d')
  assert.equal(fmtSpan(null), '—')
})

test('working time skips Saturday and Sunday', () => {
  const friday = new Date(2026, 10, 20, 12).getTime()
  const monday = new Date(2026, 10, 23, 12).getTime()
  assert.equal(workingMs(friday, monday), DAY_MS)
})

test('percentiles interpolate', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(percentile([], 0.5), null)
})

test('a step set long after the rest is out of order, and the rest are kept', () => {
  const steps = { created: jira(0), sprint: jira(100), progress: { ...jira(1), inferred: true, source: 'board' }, mr: gitlab(2), done: jira(99) }
  assert.deepEqual([...outOfOrder(steps)], ['sprint'])
})

test('when an MR came before In progress, the Jira move is the one flagged', () => {
  const steps = { created: jira(0), progress: jira(10), mr: gitlab(5), approved: gitlab(20) }
  assert.deepEqual([...outOfOrder(steps)], ['progress'])
})

test('Created and Done are never the steps flagged, even against several later ones', () => {
  const steps = { created: jira(0), progress: jira(1), mr: gitlab(30), approved: gitlab(31), merged: gitlab(32), deployed: { at: at(33), source: 'deploy' }, experiment: { at: at(34), source: 'skill' }, done: jira(20) }
  assert.deepEqual([...outOfOrder(steps)].sort(), ['approved', 'deployed', 'experiment', 'merged', 'mr'])
  assert.equal(deriveTicket({ key: 'A-9', steps }, { now: at(40) }).done, true)
})

test('gaps run between reached steps, skipping n/a, missing and out-of-order ones', () => {
  const ticket = { key: 'A-1', steps: { created: jira(0), sprint: null, progress: jira(2), mr: gitlab(5), review: gitlab(6), approved: gitlab(10), merged: gitlab(11), deployed: { at: at(12), source: 'deploy' }, experiment: { na: true }, done: jira(30) } }
  const derived = deriveTicket(ticket, { now: at(40) })
  assert.deepEqual(derived.gaps.map((gap) => [gap.from, gap.to, gap.ms / H]), [['created', 'progress', 2], ['progress', 'mr', 3], ['mr', 'review', 1], ['review', 'approved', 4], ['approved', 'merged', 1], ['merged', 'deployed', 1], ['deployed', 'done', 18]])
  assert.equal(derived.done, true)
  assert.equal(derived.state.label, 'Done')
  assert.equal(derived.lead, 30 * H)
})

test('an open ticket waits on its next step and turns to a warning after five days', () => {
  const ticket = { key: 'A-2', steps: { created: jira(0), sprint: jira(1), progress: jira(2), mr: gitlab(3), review: gitlab(4), experiment: { na: true } } }
  const soon = deriveTicket(ticket, { now: at(30) })
  assert.deepEqual([soon.state.label, soon.state.tone, soon.next.id], ['Waiting on review', 'info', 'approved'])
  assert.equal(soon.open.ms, 26 * H)
  const late = deriveTicket(ticket, { now: at(4 + 6 * 24) })
  assert.equal(late.state.tone, 'warn')
  assert.match(late.flags[0], /Waiting on review for 6d/)
})

test('a running experiment and a waiting deploy get their own labels', () => {
  const running = deriveTicket({ key: 'A-3', steps: { created: jira(0), merged: gitlab(1), deployed: { at: at(2), source: 'deploy' }, experiment: { at: at(3), source: 'skill' } } }, { now: at(200) })
  assert.deepEqual([running.state.label, running.state.tone], ['Experiment running', 'ok'])
  const waiting = deriveTicket({ key: 'A-4', deployState: { state: 'waiting' }, steps: { created: jira(0), merged: gitlab(1), experiment: { na: true } } }, { now: at(2) })
  assert.deepEqual([waiting.state.label, waiting.state.tone], ['Deploy waiting', 'warn'])
})

test('gap rows take the median, 75th percentile and slowest ticket per step', () => {
  const make = (key, hours) => deriveTicket({ key, steps: { created: jira(0), progress: jira(hours), experiment: { na: true } } }, { now: at(500) })
  const rows = gapRows([make('A-1', 1), make('A-2', 3), make('A-3', 9)])
  const progress = rows.find((row) => row.step === 'progress')
  assert.deepEqual([progress.n, progress.median / H, progress.slowest.key], [3, 3, 'A-3'])
  assert.deepEqual(progress.froms, ['Created'])
  assert.equal(rows.find((row) => row.step === 'mr').median, null)
})

test('headline numbers ignore tickets whose ends are out of order', () => {
  const good = deriveTicket({ key: 'A-1', steps: { created: jira(0), done: jira(10), experiment: { na: true } } }, { now: at(20) })
  const lead = kpiValues([good]).find((kpi) => kpi.id === 'lead')
  assert.deepEqual([lead.n, lead.median / H, lead.slowest.key], [1, 10, 'A-1'])
})

test('range keeps open tickets and tickets done inside it; filters match epic, status and text', () => {
  const now = at(24 * 60)
  const old = deriveTicket({ key: 'A-1', epic: 'E-1', title: 'Old one', steps: { created: jira(0), done: jira(1), experiment: { na: true } } }, { now })
  const open = deriveTicket({ key: 'A-2', epic: null, title: 'Open one', steps: { created: jira(0), experiment: { na: true } } }, { now })
  assert.equal(inRange(old, 30, now), false)
  assert.equal(inRange(old, 90, now), true)
  assert.equal(inRange(open, 30, now), true)
  assert.equal(matchesFilter(old, { epic: 'E-1' }), true)
  assert.equal(matchesFilter(open, { epic: 'null' }), true)
  assert.equal(matchesFilter(open, { status: 'done' }), false)
  assert.equal(matchesFilter(open, { query: 'open' }), true)
})
