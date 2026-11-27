import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic, readJsonQuarantine } from '../lib/atomic.js'
import {
  BOARD_PREFIX, MAX_BOARD_SESSIONS, MAX_TITLE_CHARS, validFolderPath, titleFrom, newBoardSession, validBoardEntry,
  parseBoardFile, resumeCommand, shellQuote, boardStatus, boardRaw, createBoardStore, keptBoardIds, evictionOrder,
} from '../lib/boardsessions.js'

const UUID = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b'
const entry = (over = {}) => newBoardSession({ cwd: '/Users/me/project', prompt: 'hello', permissionMode: 'default', now: () => 1000, uuid: () => UUID, ...over })

test('a new board session keys its id off the CLI session id', () => {
  const e = entry()
  assert.equal(e.sessionId, `${BOARD_PREFIX}${UUID}`)
  assert.equal(e.cliSessionId, UUID)
  assert.deepEqual([e.cwd, e.createdAt, e.title, e.permissionMode], ['/Users/me/project', 1000, 'hello', 'default'])
})

test('titles are one clipped line', () => {
  assert.equal(titleFrom('  two\n\nlines  here '), 'two lines here')
  assert.equal(titleFrom(''), '(untitled)')
  const long = titleFrom('x'.repeat(500))
  assert.equal(long.length, MAX_TITLE_CHARS)
  assert.ok(long.endsWith('…'))
})

test('folders must be absolute, free of control characters and ..', () => {
  assert.ok(validFolderPath('/Users/me/project'))
  assert.ok(validFolderPath('/Users/me/my project'))
  for (const bad of ['relative', '', '/a/../b', '/a/\nb', '/a/‮b', 42, null, `/${'x'.repeat(1100)}`]) assert.ok(!validFolderPath(bad), String(bad))
})

test('entries are validated and the file loader drops bad and duplicate ones', () => {
  const good = entry()
  assert.ok(validBoardEntry(good))
  assert.ok(!validBoardEntry({ ...good, cliSessionId: 'not-a-uuid' }))
  assert.ok(!validBoardEntry({ ...good, sessionId: 'local_board-other' }))
  assert.ok(!validBoardEntry({ ...good, cwd: 'relative' }))
  assert.ok(!validBoardEntry({ ...good, createdAt: 'later' }))
  assert.ok(!validBoardEntry(null))
  assert.deepEqual(parseBoardFile({ items: [good, good, { nope: true }] }), [good])
  assert.deepEqual(parseBoardFile(null), [])
  assert.deepEqual(parseBoardFile({ items: 'x' }), [])
})

test('the resume command quotes the folder', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(resumeCommand(entry({ cwd: "/Users/me/it's here" })), `cd '/Users/me/it'\\''s here' && claude --resume ${UUID}`)
})

test('status follows the board run', () => {
  assert.equal(boardStatus({ state: 'running' }), 'in_progress')
  assert.equal(boardStatus({ state: 'failed' }), 'unknown')
  assert.equal(boardStatus({ state: 'stalled' }), 'unknown')
  assert.equal(boardStatus({ state: 'done' }), 'completed')
  assert.equal(boardStatus(undefined), 'completed')
})

test('a board raw session looks like a desktop one plus the board markers', () => {
  const raw = boardRaw(entry(), { lastActivityAt: 5000, run: { state: 'running' } })
  assert.equal(raw.sessionId, `${BOARD_PREFIX}${UUID}`)
  assert.equal(raw.cliSessionId, UUID)
  assert.equal(raw.cwd, raw.originCwd)
  assert.equal(raw.lastActivityAt, 5000)
  assert.equal(raw.isArchived, false)
  assert.equal(raw.source, 'board')
  assert.equal(raw.postTurnSummary.status_category, 'in_progress')
  assert.match(raw.resume, new RegExp(`claude --resume ${UUID}$`))
  assert.equal(boardRaw(entry(), { run: null }).lastActivityAt, 1000)
})

test('a board session shows the transcript title once Claude names it', () => {
  assert.equal(boardRaw(entry(), { run: null }).title, 'hello')
  assert.equal(boardRaw(entry(), { run: null, title: 'Named by Claude' }).title, 'Named by Claude')
})

test('the store persists entries atomically and reloads them', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'board-sessions.json')
  const make = () => createBoardStore({ file, readJson: readJsonQuarantine, writeJson: writeJsonAtomic })
  const store = make()
  await store.load()
  assert.deepEqual(store.all(), [])
  const e = entry()
  assert.equal(await store.add(e), true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).items, [e])
  const again = make()
  await again.load()
  assert.deepEqual(again.all(), [e])
  assert.deepEqual(again.find(e.sessionId), e)
  assert.equal(again.find('local_board-nope'), null)
  await assert.rejects(again.add({ ...e, cwd: 'relative' }), /invalid/)
})

test('the store refuses entries past the limit and survives a corrupt file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'board-sessions.json')
  const full = Array.from({ length: MAX_BOARD_SESSIONS }, (_, i) => entry({ uuid: () => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }))
  await writeJsonAtomic(file, { items: full })
  const store = createBoardStore({ file, readJson: readJsonQuarantine, writeJson: writeJsonAtomic })
  await store.load()
  assert.equal(store.all().length, MAX_BOARD_SESSIONS)
  assert.equal(await store.add(entry()), false)
  const broken = join(dir, 'broken.json')
  await import('node:fs/promises').then(({ writeFile }) => writeFile(broken, '{not json'))
  const survivor = createBoardStore({ file: broken, readJson: readJsonQuarantine, writeJson: writeJsonAtomic })
  await survivor.load()
  assert.deepEqual(survivor.all(), [])
})

test('retitle replaces one entry title, persists it and ignores unknown ids and empty titles', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-retitle-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'board-sessions.json')
  const make = () => createBoardStore({ file, readJson: readJsonQuarantine, writeJson: writeJsonAtomic })
  const store = make()
  await store.load()
  const kept = entry({ uuid: () => '00000000-0000-4000-8000-000000000001' })
  const renamed = entry({ uuid: () => '00000000-0000-4000-8000-000000000002' })
  await store.add(kept)
  await store.add(renamed)
  assert.equal(await store.retitle(renamed.sessionId, 'Short clear title'), true)
  assert.equal(await store.retitle('local_board-missing', 'Anything'), false)
  assert.equal(await store.retitle(kept.sessionId, ''), false)
  const reloaded = make()
  await reloaded.load()
  assert.equal(reloaded.find(renamed.sessionId).title, 'Short clear title')
  assert.equal(reloaded.find(kept.sessionId).title, kept.title)
})

const idFor = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const numbered = (i, over = {}) => entry({ uuid: () => idFor(i), now: () => 1000 + i, ...over })
const boardId = (i) => `${BOARD_PREFIX}${idFor(i)}`

async function smallStore(t, { count, max = 3, evictable }) {
  const dir = mkdtempSync(join(tmpdir(), 'board-evict-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'board-sessions.json')
  await writeJsonAtomic(file, { items: Array.from({ length: count }, (_, i) => numbered(i)) })
  const store = createBoardStore({ file, readJson: readJsonQuarantine, writeJson: writeJsonAtomic, max, evictable })
  await store.load()
  const saved = () => JSON.parse(readFileSync(file, 'utf8')).items.map((item) => item.sessionId)
  return { store, saved }
}

test('a full store evicts the oldest safe entry to make room and persists it', async (t) => {
  const { store, saved } = await smallStore(t, { count: 3, evictable: async (items) => evictionOrder(items) })
  assert.equal(await store.add(numbered(10)), true)
  assert.deepEqual(saved(), [boardId(1), boardId(2), boardId(10)])
  assert.deepEqual(store.all().map((item) => item.sessionId), saved())
})

test('a store loaded over its cap evicts down to make room for one more', async (t) => {
  const { store, saved } = await smallStore(t, { count: 5, evictable: async (items) => evictionOrder(items) })
  assert.equal(await store.add(numbered(10)), true)
  assert.deepEqual(saved(), [boardId(3), boardId(4), boardId(10)])
})

test('entries the predicate keeps are never evicted', async (t) => {
  const keep = new Set([boardId(0), boardId(2)])
  const { store, saved } = await smallStore(t, { count: 3, evictable: async (items) => evictionOrder(items, { keep }) })
  for (const i of [10, 11, 12]) assert.equal(await store.add(numbered(i)), true)
  assert.deepEqual(saved(), [boardId(0), boardId(2), boardId(12)])
})

test('the entry being added is never evicted to make room for itself', async (t) => {
  const { store } = await smallStore(t, { count: 3, evictable: async (items) => items.map((item) => item.sessionId).reverse() })
  assert.equal(await store.add(numbered(10)), true)
  assert.ok(store.find(boardId(10)))
  assert.equal(store.all().length, 3)
})

test('a full store refuses cleanly when nothing can be evicted', async (t) => {
  const keep = new Set([0, 1, 2].map(boardId))
  const { store, saved } = await smallStore(t, { count: 3, evictable: async (items) => evictionOrder(items, { keep }) })
  const before = saved()
  assert.equal(await store.add(numbered(10)), false)
  assert.deepEqual(saved(), before)
  assert.deepEqual(store.all().map((item) => item.sessionId), before)
  const unknown = await smallStore(t, { count: 3, evictable: async () => ['local_board-elsewhere'] })
  assert.equal(await unknown.store.add(numbered(10)), false)
})

test('the eviction order is least recently used first, with createdAt as the fallback', () => {
  const items = [numbered(0), numbered(1), numbered(2)]
  assert.deepEqual(evictionOrder(items), [boardId(0), boardId(1), boardId(2)])
  assert.deepEqual(evictionOrder(items, { usedAt: new Map([[boardId(0), 5000]]) }), [boardId(1), boardId(2), boardId(0)])
  assert.deepEqual(evictionOrder(items, { keep: new Set([boardId(1)]) }), [boardId(0), boardId(2)])
})

test('kept ids cover focus, runs, queues, schedules, active babysits and deploy checks, and open side chats', () => {
  const side = numbered(7, { sideChatOf: boardId(8), forkFrom: idFor(8) })
  const closedSide = numbered(9, { sideChatOf: boardId(6), forkFrom: idFor(6) })
  const items = [0, 1, 2, 3, 4, 5, 6, 8, 11, 12].map((i) => numbered(i)).concat([side, closedSide])
  const keep = keptBoardIds(items, {
    focus: [boardId(0)],
    running: (id) => id === boardId(1),
    queued: (id) => id === boardId(2),
    scheduled: [{ id: boardId(3), prompt: 'later' }],
    babysit: { a: { sessionId: boardId(4), state: 'watching' }, b: { sessionId: boardId(11), state: 'stopped' }, c: { sessionId: boardId(12), state: 'needs-you' } },
    deploy: { a: { sessionId: boardId(5), state: 'checking' }, b: { sessionId: boardId(6), state: 'live' } },
    closedSideChats: [boardId(9)],
  })
  assert.deepEqual([...keep].sort(), [0, 1, 2, 3, 4, 5, 7, 8].map(boardId).sort())
  assert.deepEqual(evictionOrder(items, { keep }), [6, 9, 11, 12].map(boardId))
})
