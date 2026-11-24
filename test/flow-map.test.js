import test from 'node:test'
import assert from 'node:assert/strict'
import { mapGraph, reduceEdges, lineage, columns, hiddenNeighbours, flowRows, shape, induced, foldLeaves } from '../public/flowmap.js'

const ticket = (key, over = {}) => ({ key, epic: 'E-1', updatedAt: 10, sessions: [], mrs: [], ...over })
const session = (id, over = {}) => ({ id, title: `Session ${id}`, lastActivityAt: 100, tickets: [], threads: [], mrs: [], ...over })
const mr = (url, over = {}) => ({ url, ref: `p!${url}`, title: url, state: 'opened', createdAt: 50, updatedAt: 60, threads: [], ...over })
const ids = (list) => [...list].sort()

function chain() {
  return mapGraph({
    tickets: [ticket('A-1', { sessions: ['s1', 's2'], mrs: ['m1'] }), ticket('A-2', { epic: 'E-2', sessions: ['s4'] })],
    sessions: [
      session('s1', { tickets: [{ key: 'A-1', why: 'On branch a-1' }], lastActivityAt: 100 }),
      session('s2', { tickets: [{ key: 'A-1', why: 'Mentions A-1' }], mrs: ['m1'], lastActivityAt: 300 }),
      session('s3', { lastActivityAt: 400 }),
      session('s4', { tickets: [{ key: 'A-2', why: 'On branch a-2' }], lastActivityAt: 200 }),
    ],
    sessionLinks: [{ from: 's1', to: 's2', kind: 'fork' }, { from: 's2', to: 's3', kind: 'handoff' }],
    mrs: [mr('m1')],
  })
}

test('a session reached through another session hangs off it, not off the ticket again', () => {
  const g = chain()
  const pairs = g.edges.map((edge) => `${edge.from}>${edge.to}:${edge.kind}`)
  assert.ok(pairs.includes('t:A-1>s:s1:link'))
  assert.ok(pairs.includes('s:s1>s:s2:fork'))
  assert.ok(pairs.includes('s:s2>s:s3:handoff'))
  assert.ok(!pairs.includes('t:A-1>s:s2:link'))
  assert.ok(pairs.includes('s:s2>m:m1:link'))
  assert.ok(!pairs.some((pair) => pair.startsWith('t:A-1>m:m1')))
})

test('a session with no ticket of its own is pulled in by its session link', () => {
  const g = chain()
  assert.equal(g.nodes.get('s:s3').kind, 'session')
  const lonely = mapGraph({ tickets: [], sessions: [session('x')], sessionLinks: [] })
  assert.equal(lonely.nodes.has('s:x'), false)
})

test('reduction keeps session links even when another path reaches the same session', () => {
  const edges = [{ from: 'a', to: 'b', kind: 'link' }, { from: 'b', to: 'c', kind: 'link' }, { from: 'a', to: 'c', kind: 'link' }, { from: 'a', to: 'd', kind: 'link' }, { from: 'd', to: 'c', kind: 'fork' }]
  const kept = reduceEdges(edges).map((edge) => `${edge.from}${edge.to}`)
  assert.deepEqual(kept, ['ab', 'bc', 'ad', 'dc'])
})

test('following a session shows what led to it and what came from it, and nothing beside it', () => {
  const g = chain()
  assert.deepEqual(ids(lineage(g, 's:s2')), ids(['e:E-1', 't:A-1', 's:s1', 's:s2', 's:s3', 'm:m1']))
  assert.deepEqual(ids(lineage(g, 's:s4')), ids(['e:E-2', 't:A-2', 's:s4']))
  assert.equal(lineage(g, 'nope').size, 0)
})

test('columns follow the longest path, so a chain of sessions spreads left to right', () => {
  const g = chain()
  const cols = columns(g, lineage(g, 's:s2'))
  assert.deepEqual(cols.map((col) => ids(col)), [['e:E-1'], ['t:A-1'], ['s:s1'], ['s:s2'], ids(['s:s3', 'm:m1'])])
})

test('cards in a column sit near their parents, oldest first among equals', () => {
  const g = mapGraph({
    tickets: [ticket('A-1', { updatedAt: 5 }), ticket('A-2', { updatedAt: 1 })],
    sessions: [
      session('late', { tickets: [{ key: 'A-1' }], lastActivityAt: 900 }),
      session('early', { tickets: [{ key: 'A-1' }], lastActivityAt: 100 }),
      session('other', { tickets: [{ key: 'A-2' }], lastActivityAt: 500 }),
    ],
  })
  const cols = columns(g, lineage(g, 'e:E-1'))
  assert.deepEqual(cols[1], ['t:A-2', 't:A-1'])
  assert.deepEqual(cols[2], ['s:other', 's:early', 's:late'])
})

test('a card with links off the path counts them as more', () => {
  const g = chain()
  const shown = lineage(g, 's:s1')
  assert.equal(hiddenNeighbours(g, shown).size, 0)
  const ticketOnly = lineage(g, 's:s4')
  assert.equal(hiddenNeighbours(g, ticketOnly).get('e:E-2'), undefined)
  const one = mapGraph({ tickets: [ticket('A-1')], sessions: [session('a', { tickets: [{ key: 'A-1' }] }), session('b', { tickets: [{ key: 'A-1' }] })] })
  assert.equal(hiddenNeighbours(one, lineage(one, 's:a')).get('t:A-1'), 1)
})

test('flows are one row per piece of work, latest first, anchored on its ticket and tagged with its epic', () => {
  const g = chain()
  const rows = flowRows(g)
  assert.deepEqual(rows.map((row) => row.anchor), ['t:A-1', 't:A-2'])
  assert.deepEqual(rows[0].groups, ['e:E-1'])
  assert.deepEqual(ids(rows[0].ids), ids(['t:A-1', 's:s1', 's:s2', 's:s3', 'm:m1']))
  assert.deepEqual(shape(g, rows[0].ids).map((step) => step.kinds), [[['ticket', 1]], [['session', 1]], [['session', 1]], [['session', 1], ['mr', 1]]])
})

test('a loose session is its own dashed flow, anchored on itself', () => {
  const g = mapGraph({ looseSessions: [{ id: 'l1', title: 'Loose', lastActivityAt: 5 }], looseMrs: [{ url: 'lm', ref: 'p!1', createdAt: 3 }] })
  const rows = flowRows(g)
  assert.deepEqual(rows.map((row) => [row.anchor, row.loose]), [['s:l1', true], ['m:lm', true]])
})

test('a Slack thread anchors its sessions and an MR only the thread knows about', () => {
  const g = mapGraph({
    threads: [{ key: 'C1:1', channel: 'C1', at: 10, lastActivityAt: 20 }],
    sessions: [session('t1', { threads: [{ key: 'C1:1' }] })],
    mrs: [mr('m9', { threads: ['C1:1'] })],
  })
  const pairs = g.edges.map((edge) => `${edge.from}>${edge.to}`)
  assert.deepEqual(pairs.sort(), ['c:C1>th:C1:1', 'th:C1:1>m:m9', 'th:C1:1>s:t1'])
  assert.deepEqual(flowRows(g)[0].groups, ['c:C1'])
  assert.equal(induced(g, new Set(['th:C1:1', 's:t1'])).edges.length, 1)
})

test('more than five dead-end MRs or sessions in a column fold into one card that can be opened', () => {
  const urls = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
  const g = mapGraph({ tickets: [ticket('A-1', { mrs: urls })], mrs: urls.map((url) => mr(url)) })
  const ids = lineage(g, 't:A-1')
  const sub = induced(g, ids)
  const cols = columns(g, ids)
  const shut = foldLeaves(sub, cols)
  assert.deepEqual(shut.cols, [['e:E-1'], ['t:A-1'], ['g:2:mr']])
  assert.deepEqual(shut.stacks.get('g:2:mr').ids.sort(), urls.map((url) => `m:${url}`))
  assert.deepEqual(shut.edges.map((edge) => `${edge.from}>${edge.to}`), ['e:E-1>t:A-1', 't:A-1>g:2:mr'])
  const opened = foldLeaves(sub, cols, { open: new Set(['g:2:mr']) })
  assert.equal(opened.cols[2].length, 6)
  assert.equal(opened.stacks.get('g:2:mr').open, true)
  assert.deepEqual(foldLeaves(sub, cols, { keep: new Set(['m:m1']), over: 4 }).cols[2].includes('m:m1'), true)
  assert.equal(foldLeaves(sub, cols, { keep: new Set(['m:m1']), over: 4 }).cols[2].length, 2)
  assert.equal(foldLeaves(sub, cols, { over: 6 }).stacks.size, 0)
})
