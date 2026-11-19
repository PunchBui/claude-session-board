import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { sideChatParent, isSideChat, ownChat, forkedAt, sideChatTitle, firstQuestion, parseClosedFile, setClosed, countOpenSideChats, sideChatRow, MAX_CLOSED } from '../lib/sidechats.js'
import { mainSessions, sideChatGroups, sideChatCount, ownReplies } from '../public/sidechats.js'
import { newSessionIds } from '../public/autofocus.js'
import { newScanState, absorbLine, createScanStore } from '../lib/scan.js'
import { newBoardSession, validBoardEntry, boardRaw } from '../lib/boardsessions.js'
import { createRunManager, SIDE_CHAT_OF_SIDE_CHAT_MESSAGE, SIDE_CHAT_EFFORT } from '../lib/runs.js'

const PARENT = 'local_c3b4ce8f-9e23-423f-b6bc-d920309bd05e'
const PARENT_CLI = '2c063e0c-3731-4c48-a22a-ec14210f9ca1'
const SIDE_CLI = '9ac8a021-82b8-4548-9ad1-e7e9cf7f0fa6'
const desktopSide = (over = {}) => ({ sessionId: `local_${SIDE_CLI}`, cliSessionId: SIDE_CLI, title: 'btw: what is isCM?', spawnedFrom: { sessionId: PARENT, taskId: 'task_1', sideSession: true, btw: true, userFork: true }, ...over })

test('a desktop side chat is recognised by spawnedFrom.sideSession and names its parent', () => {
  assert.equal(sideChatParent(desktopSide()), PARENT)
  assert.ok(isSideChat(desktopSide()))
  assert.equal(sideChatParent({ sessionId: 'local_x' }), null)
  assert.equal(sideChatParent(desktopSide({ spawnedFrom: { sessionId: PARENT, sideSession: false } })), null)
  assert.equal(sideChatParent(desktopSide({ spawnedFrom: { sessionId: '../etc', sideSession: true } })), null)
})

test('a board side chat is recognised by sideChatOf', () => {
  assert.equal(sideChatParent({ sessionId: 'local_board-1', sideChatOf: PARENT }), PARENT)
  assert.equal(sideChatParent({ sessionId: 'local_board-1', sideChatOf: 'nope' }), null)
})

test('side chat titles drop the btw prefix and the placeholder', () => {
  assert.equal(sideChatTitle('btw: what is isCM?'), 'what is isCM?')
  assert.equal(sideChatTitle('Side chat'), null)
  assert.equal(sideChatTitle(''), null)
  assert.equal(sideChatTitle('Physical bedding adjustment'), 'Physical bedding adjustment')
})

test('own chat drops history a fork copied, by marker or by fork time', () => {
  const chat = [
    { role: 'user', at: '2026-11-19T02:57:56.000Z', text: 'parent question', inherited: true },
    { role: 'user', at: '2026-11-19T02:57:57.000Z', text: 'copied by the CLI' },
    { role: 'user', at: '2026-11-19T02:58:10.000Z', text: 'side question' },
  ]
  assert.deepEqual(ownChat(chat).map((m) => m.text), ['copied by the CLI', 'side question'])
  assert.deepEqual(ownChat(chat, Date.parse('2026-11-19T02:58:00.000Z')).map((m) => m.text), ['side question'])
  assert.equal(firstQuestion(chat, Date.parse('2026-11-19T02:58:00.000Z')), 'side question')
  assert.equal(firstQuestion([]), null)
  assert.equal(firstQuestion([{ role: 'user', text: 'x'.repeat(400) }]).length, 160)
  assert.equal(forkedAt({ forkFrom: PARENT_CLI, createdAt: 5 }), 5)
  assert.equal(forkedAt(desktopSide({ createdAt: 5 })), null)
})

test('the scanner marks lines whose sessionId is not the transcript own id as inherited', () => {
  const state = newScanState({ ownId: SIDE_CLI })
  const line = (sessionId, type, content, at) => JSON.stringify({ type, sessionId, timestamp: at, message: { id: `${sessionId}-${at}`, content } })
  absorbLine(state, line(PARENT_CLI, 'user', 'parent question', '2026-11-19T01:00:00.000Z'))
  absorbLine(state, line(PARENT_CLI, 'assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }], '2026-11-19T01:00:01.000Z'))
  absorbLine(state, line(SIDE_CLI, 'assistant', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/b' } }], '2026-11-19T01:00:02.000Z'))
  absorbLine(state, line(SIDE_CLI, 'user', 'side question', '2026-11-19T01:00:03.000Z'))
  assert.deepEqual(state.chat.map((item) => [item.role, Boolean(item.inherited)]), [['user', true], ['tools', true], ['tools', false], ['user', false]])
  assert.deepEqual(ownChat(state.chat).map((item) => item.text ?? item.tools[0].hint), ['/b', 'side question'])
})

test('the scan store takes the own id from the transcript file name, but not for subagents', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'side-scan-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, `${SIDE_CLI}.jsonl`)
  writeFileSync(path, `${JSON.stringify({ type: 'user', sessionId: PARENT_CLI, timestamp: '2026-11-19T01:00:00.000Z', message: { content: 'copied' } })}\n`)
  const size = Buffer.byteLength(`${JSON.stringify({ type: 'user', sessionId: PARENT_CLI, timestamp: '2026-11-19T01:00:00.000Z', message: { content: 'copied' } })}\n`)
  assert.equal((await createScanStore().scan(path, size)).chat[0].inherited, true)
  assert.equal((await createScanStore({ sidechain: true }).scan(path, size)).chat[0].inherited, undefined)
})

test('closed side chats are a deduped, bounded list', () => {
  assert.deepEqual(parseClosedFile({ closed: ['local_a', 'local_a', 'bad', 7] }), ['local_a'])
  assert.deepEqual(parseClosedFile(null), [])
  assert.deepEqual(setClosed(['local_a'], 'local_b', true), ['local_a', 'local_b'])
  assert.deepEqual(setClosed(['local_a', 'local_b'], 'local_a', false), ['local_b'])
  const many = Array.from({ length: MAX_CLOSED }, (_, i) => `local_${i}`)
  assert.equal(setClosed(many, 'local_new', true).length, MAX_CLOSED)
})

test('parents count only open side chats', () => {
  const summaries = [
    { id: PARENT },
    { id: 'local_s1', sideChatOf: PARENT },
    { id: 'local_s2', sideChatOf: PARENT, archived: true },
    { id: 'local_s3', sideChatOf: PARENT },
  ]
  assert.deepEqual([...countOpenSideChats(summaries, ['local_s3'])], [[PARENT, 1]])
})

test('a side chat row prefers the first question over the stored title', () => {
  const summary = { id: 'local_s1', sideChatOf: PARENT, title: 'btw: short', project: 'p', cwd: '/p', source: 'desktop', status: 'completed', createdAt: 1, lastActivityAt: 2, archived: false }
  assert.equal(sideChatRow(summary, { question: 'the whole question' }).title, 'the whole question')
  assert.equal(sideChatRow(summary).title, 'short')
  assert.equal(sideChatRow({ ...summary, title: 'Side chat' }).title, 'Side chat')
  assert.equal(sideChatRow({ ...summary, archived: true }).closed, true)
  assert.equal(sideChatRow(summary, { parent: { title: 'Parent' } }).parentTitle, 'Parent')
})

test('the browser hides side chats from lists and never auto-focuses them', () => {
  const sessions = [{ id: 'a', sideChats: 2 }, { id: 'b', sideChatOf: 'a' }, { id: 'c', sideChatOf: 'a' }]
  assert.deepEqual(mainSessions(sessions).map((s) => s.id), ['a'])
  assert.equal(sideChatCount(sessions, 'a'), 2)
  assert.equal(sideChatCount(sessions, 'zzz'), 0)
  const known = new Set(['a'])
  assert.deepEqual(newSessionIds(known, [...sessions, { id: 'd' }], []).fresh, ['d'])
})

test('the panel groups side chats into open and closed, newest first', () => {
  const items = [
    { id: '1', parentId: 'a', lastActivityAt: 1 },
    { id: '2', parentId: 'a', lastActivityAt: 3 },
    { id: '3', parentId: 'a', lastActivityAt: 2, closed: true },
    { id: '4', parentId: 'b', lastActivityAt: 9 },
  ]
  const mine = sideChatGroups(items, 'a')
  assert.deepEqual(mine.open.map((r) => r.id), ['2', '1'])
  assert.deepEqual(mine.closed.map((r) => r.id), ['3'])
  assert.deepEqual(sideChatGroups(items).open.map((r) => r.id), ['4', '2', '1'])
  assert.ok(ownReplies([{ role: 'user', at: '2026-11-19T01:00:05.000Z' }], Date.parse('2026-11-19T01:00:06.000Z')))
  assert.ok(!ownReplies([{ role: 'assistant', at: '2026-11-19T01:00:09.000Z' }], Date.parse('2026-11-19T01:00:06.000Z')))
})

test('a board side chat entry keeps its parent and fork source, and validates them', () => {
  const entry = newBoardSession({ cwd: '/Users/me/p', prompt: 'why?', permissionMode: 'default', sideChatOf: PARENT, forkFrom: PARENT_CLI })
  assert.ok(validBoardEntry(entry))
  assert.equal(boardRaw(entry, {}).sideChatOf, PARENT)
  assert.equal(boardRaw(entry, {}).forkFrom, PARENT_CLI)
  assert.ok(!validBoardEntry({ ...entry, forkFrom: 'not-a-uuid' }))
  assert.ok(!validBoardEntry({ ...entry, sideChatOf: 'bad id' }))
  const plain = newBoardSession({ cwd: '/Users/me/p', prompt: 'hi', permissionMode: 'default' })
  assert.ok(!('sideChatOf' in plain))
  assert.ok(!('sideChatOf' in boardRaw(plain, {})))
})

class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.kills = []
  }
}

function sideHarness(t, { parent = { sessionId: PARENT, cliSessionId: PARENT_CLI, permissionMode: 'acceptEdits', model: 'claude-opus-5-5' }, transcript = true, settings = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'side-runs-'))
  const h = { dir, spawned: [], board: [], raws: [{ cwd: dir, ...parent }] }
  let pid = 50_000
  h.manager = createRunManager({
    spawn(bin, args, options) {
      const child = new FakeChild(pid++)
      Object.assign(child, { args, options })
      h.spawned.push(child)
      return child
    },
    kill: () => {},
    claudeBin: '/bin/claude-fake',
    env: {},
    uploadDir: join(dir, 'uploads'),
    logDir: join(dir, 'logs'),
    permissionMode: 'bypassPermissions',
    timeoutMs: 0,
    graceMs: 10,
    homeDir: dir,
    boardStore: { add: async (entry) => { h.board.push(entry); return true }, retitle: async () => true },
    scanSession: async () => ({ path: 't.jsonl', info: { mtimeMs: 0 }, state: { lastStop: 'end_turn', settings } }),
    hasTranscript: async () => transcript,
    buildCard: async () => ({ touchedAt: 0, active: false, live: null, loop: null }),
    readRawSessions: async () => h.raws,
    findRaw: async (id) => h.raws.find((raw) => raw.sessionId === id) ?? null,
    queues: new Map(),
    persistQueues: async () => {},
    runsFile: join(dir, 'runs.json'),
    transcriptPaths: new Map(),
    openHandoff: () => {},
    probe: { isAlive: () => false, commandOf: async () => '' },
    signal: () => {},
    log: () => {},
  })
  t.after(async () => {
    for (const child of h.spawned) child.emit('close', 0, null)
    await new Promise((resolve) => setTimeout(resolve, 30))
    rmSync(dir, { recursive: true, force: true })
  })
  return h
}

test('a side chat forks the parent once with its own id, then resumes itself', async (t) => {
  const h = sideHarness(t)
  const result = await h.manager.requestSideChat({ id: PARENT, prompt: '  what is isCM?  ' })
  assert.equal(result.status, 202)
  const [entry] = h.board
  assert.equal(entry.sideChatOf, PARENT)
  assert.equal(entry.forkFrom, PARENT_CLI)
  assert.equal(entry.cwd, h.dir)
  assert.equal(entry.permissionMode, 'acceptEdits')
  assert.equal(entry.model, 'claude-opus-5-5')
  assert.equal(entry.effort, SIDE_CHAT_EFFORT)
  const args = h.spawned[0].args
  assert.deepEqual(args.slice(0, 6), ['-p', '--resume', PARENT_CLI, '--fork-session', '--session-id', entry.cliSessionId])
  assert.equal(h.spawned[0].options.input, 'what is isCM?')
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'low'])
  h.spawned[0].emit('close', 0, null)
  await new Promise((resolve) => setTimeout(resolve, 20))
  h.raws.push({ ...boardRaw(entry, {}) })
  assert.equal((await h.manager.requestPrompt({ id: entry.sessionId }, 'and then?')).status, 202)
  assert.deepEqual(h.spawned[1].args.slice(0, 3), ['-p', '--resume', entry.cliSessionId])
  assert.ok(!h.spawned[1].args.includes('--fork-session'))
})

test('a side chat uses the model the parent switched to with /model', async (t) => {
  const h = sideHarness(t, { settings: { model: 'claude-sonnet-5-5' } })
  await h.manager.requestSideChat({ id: PARENT, prompt: 'q' })
  assert.equal(h.board[0].model, 'claude-sonnet-5-5')
})

test('a side chat is refused for side chats, missing parents, empty prompts and parents with no transcript', async (t) => {
  const nested = sideHarness(t, { parent: { ...desktopSide(), sessionId: PARENT, cliSessionId: PARENT_CLI } })
  assert.deepEqual((await nested.manager.requestSideChat({ id: PARENT, prompt: 'q' })).body, { error: SIDE_CHAT_OF_SIDE_CHAT_MESSAGE })
  const h = sideHarness(t)
  assert.equal((await h.manager.requestSideChat({ id: 'local_missing', prompt: 'q' })).status, 404)
  assert.equal((await h.manager.requestSideChat({ id: PARENT, prompt: '  ' })).status, 400)
  assert.equal((await h.manager.requestSideChat({ id: PARENT, prompt: '/clear' })).status, 400)
  const empty = sideHarness(t, { transcript: false })
  assert.equal((await empty.manager.requestSideChat({ id: PARENT, prompt: 'q' })).status, 409)
  assert.equal(h.spawned.length + nested.spawned.length + empty.spawned.length, 0)
})
