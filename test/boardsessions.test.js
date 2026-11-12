import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic, readJsonQuarantine } from '../lib/atomic.js'
import {
  BOARD_PREFIX, MAX_BOARD_SESSIONS, MAX_TITLE_CHARS, isBoardId, validFolderPath, titleFrom, newBoardSession, validBoardEntry,
  parseBoardFile, resumeCommand, shellQuote, boardStatus, boardRaw, createBoardStore,
} from '../lib/boardsessions.js'

const UUID = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b'
const entry = (over = {}) => newBoardSession({ cwd: '/Users/me/project', prompt: 'hello', permissionMode: 'default', now: () => 1000, uuid: () => UUID, ...over })

test('a new board session keys its id off the CLI session id', () => {
  const e = entry()
  assert.equal(e.sessionId, `${BOARD_PREFIX}${UUID}`)
  assert.equal(e.cliSessionId, UUID)
  assert.deepEqual([e.cwd, e.createdAt, e.title, e.permissionMode], ['/Users/me/project', 1000, 'hello', 'default'])
  assert.ok(isBoardId(e.sessionId))
  assert.ok(!isBoardId('local_1234'))
  assert.ok(!isBoardId(undefined))
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
