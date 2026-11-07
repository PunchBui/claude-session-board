import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunManager, BLOCKED_MESSAGE, NO_TRANSCRIPT_MESSAGE, BOARD_NO_TRANSCRIPT_MESSAGE, BOARD_LIMIT_MESSAGE, MAX_PROMPT_CHARS } from '../lib/runs.js'
import { boardRaw, newBoardSession } from '../lib/boardsessions.js'

const SID = 'local_aaaa-1111'
const CLI = 'cli-1111'
const SID_B = 'local_bbbb-2222'
const CLI_B = 'cli-2222'
const GRACE_MS = 30
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check, ms = 2000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition')
    await sleep(5)
  }
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.kills = []
    this.closed = false
    this.once('close', () => { this.closed = true })
  }
}

function harness(t, { timeoutMs = 5000, sessions = [{ sessionId: SID, cliSessionId: CLI }], exitOn = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runs-test-'))
  const h = {
    dir,
    spawned: [],
    opened: [],
    logs: [],
    signals: [],
    queues: new Map(),
    transcriptPaths: new Map(),
    raws: sessions.map((session) => ({ cwd: dir, ...session })),
    scan: { path: 'transcript.jsonl', info: { mtimeMs: 0 }, state: { lastStop: 'end_turn' } },
    transcript: true,
    alive: new Map(),
    spawnError: false,
    board: [],
    boardFull: false,
    runsFile: join(dir, 'runs.json'),
  }
  let nextPid = 40_000
  h.card = () => ({ touchedAt: 0, active: false, live: null, loop: null })
  h.persisted = 0
  const manager = createRunManager({
    spawn(bin, args, options) {
      const child = new FakeChild(h.spawnError ? undefined : nextPid++)
      Object.assign(child, { bin, args, options, input: options.input })
      h.spawned.push(child)
      if (h.spawnError) process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
      return child
    },
    kill(child, signal = 'SIGTERM') {
      child.kills.push(signal)
      if (exitOn.includes(signal)) setImmediate(() => child.emit('close', null, signal))
    },
    claudeBin: '/bin/claude-fake',
    env: {},
    uploadDir: join(dir, 'uploads'),
    logDir: join(dir, 'logs'),
    permissionMode: 'bypassPermissions',
    timeoutMs,
    graceMs: GRACE_MS,
    adoptPollMs: 10,
    desktopPollMs: 10,
    homeDir: dir,
    boardStore: { add: async (entry) => { if (h.boardFull) return false; h.board.push(entry); return true } },
    scanSession: async () => h.scan,
    hasTranscript: async () => h.transcript,
    buildCard: async (raw) => h.card(raw),
    readRawSessions: async () => h.raws,
    findRaw: async (id) => h.raws.find((raw) => raw.sessionId === id) ?? null,
    queues: h.queues,
    persistQueues: async () => { h.persisted += 1 },
    runsFile: h.runsFile,
    transcriptPaths: h.transcriptPaths,
    openHandoff: (raw, file) => h.opened.push([raw.sessionId, file]),
    probe: {
      isAlive: (pid) => h.alive.has(pid),
      commandOf: async (pid) => h.alive.get(pid) ?? '',
    },
    signal: (pid, signal) => h.signals.push([pid, signal]),
    log: (line) => h.logs.push(line),
  })
  h.manager = manager
  h.saved = async () => JSON.parse(await readFile(h.runsFile, 'utf8').catch(() => '{}'))
  h.queue = (id, ...prompts) => {
    const queue = { items: prompts.map((prompt, index) => ({ qid: `${id}-${index}`, prompt })), paused: false }
    h.queues.set(id, queue)
    return queue
  }
  t.after(async () => {
    h.queues.clear()
    h.alive.clear()
    for (let pass = 0; pass < 3; pass += 1) {
      for (const child of h.spawned) if (!child.closed) child.emit('close', 0, null)
      await sleep(40)
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return h
}

const start = (h, id = SID, prompt = 'do the thing') => h.manager.requestPrompt({ id }, prompt)
const settled = (run) => () => run.state !== 'running'

test('a run that exits 0 with an end_turn tail ends done and starts the next queued item', async (t) => {
  const h = harness(t)
  const queue = h.queue(SID, 'second prompt')
  assert.equal((await start(h, SID, 'first prompt')).status, 202)
  const first = h.manager.runFor(SID)
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0].input, 'first prompt')
  h.spawned[0].emit('close', 0, null)
  await until(() => h.spawned.length === 2)
  assert.equal(first.state, 'done')
  assert.equal(first.error, null)
  assert.ok(first.endedAt >= first.startedAt)
  assert.equal(h.spawned[1].input, 'second prompt')
  assert.equal(queue.items.length, 0)
  assert.equal(queue.paused, false)
  assert.notEqual(h.manager.runFor(SID), first)
  assert.equal(h.manager.runFor(SID).state, 'running')
})

test('a run that exits 0 without an end_turn tail ends stalled, pauses the queue and starts nothing', async (t) => {
  const h = harness(t)
  h.scan = { ...h.scan, state: { lastStop: 'tool_use' } }
  const queue = h.queue(SID, 'second prompt')
  await start(h)
  const run = h.manager.runFor(SID)
  h.spawned[0].emit('close', 0, null)
  await until(settled(run))
  assert.equal(run.state, 'stalled')
  assert.equal(run.error, 'Exited before finishing its turn.')
  assert.equal(queue.paused, true)
  assert.ok(h.persisted > 0)
  await h.manager.pump()
  await sleep(30)
  assert.equal(h.spawned.length, 1)
  assert.equal(queue.items.length, 1)
})

test('a failed exit pauses the queue and reports the exit code', async (t) => {
  const h = harness(t)
  const queue = h.queue(SID, 'second prompt')
  await start(h)
  const run = h.manager.runFor(SID)
  h.spawned[0].emit('close', 3, null)
  await until(settled(run))
  assert.equal(run.state, 'failed')
  assert.equal(run.error, 'exit code 3')
  assert.equal(queue.paused, true)
  assert.equal(h.spawned.length, 1)
})

test('stop sends SIGTERM, the run stays running until the process closes, then it ends stopped', async (t) => {
  const h = harness(t)
  await start(h)
  const run = h.manager.runFor(SID)
  const child = h.spawned[0]
  const stopped = h.manager.stopPrompt(SID)
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.run.stopRequested, true)
  assert.equal('stop' in stopped.body.run, false)
  assert.deepEqual(child.kills, ['SIGTERM'])
  assert.equal(run.state, 'running')
  child.emit('close', null, 'SIGTERM')
  await until(settled(run))
  assert.equal(run.state, 'stopped')
  assert.equal(run.error, null)
  await sleep(GRACE_MS * 2)
  assert.deepEqual(child.kills, ['SIGTERM'])
})

test('a process that ignores SIGTERM gets SIGKILL after the grace period', async (t) => {
  const h = harness(t)
  await start(h)
  const run = h.manager.runFor(SID)
  const child = h.spawned[0]
  h.manager.stopPrompt(SID)
  assert.deepEqual(child.kills, ['SIGTERM'])
  await until(() => child.kills.includes('SIGKILL'))
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(run.state, 'running')
  child.emit('close', null, 'SIGKILL')
  await until(settled(run))
  assert.equal(run.state, 'stopped')
})

test('stopping a session with nothing running is a 404', (t) => {
  const h = harness(t)
  assert.deepEqual(h.manager.stopPrompt(SID), { status: 404, body: { error: 'nothing running' } })
})

test('the timeout ends the run stalled with the timed-out message and kills the process', async (t) => {
  const h = harness(t, { timeoutMs: 40 })
  await start(h)
  const run = h.manager.runFor(SID)
  const child = h.spawned[0]
  await until(() => run.timedOut)
  assert.equal(child.kills[0], 'SIGTERM')
  assert.equal(run.state, 'running')
  child.emit('close', null, 'SIGTERM')
  await until(settled(run))
  assert.equal(run.state, 'stalled')
  assert.equal(run.error, 'Timed out and was stopped before finishing its turn.')
})

test('two concurrent prompt requests for one session start exactly one run and the other gets the running refusal', async (t) => {
  const h = harness(t)
  const [first, second] = await Promise.all([start(h, SID, 'one'), start(h, SID, 'two')])
  assert.equal(first.status, 202)
  assert.deepEqual(second, {
    status: 409,
    body: { error: 'a prompt is already running for this session', code: 'running', queueable: true },
  })
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0].input, 'one')
})

test('the prompt request refuses bad input, unknown sessions and missing transcripts', async (t) => {
  const h = harness(t)
  assert.deepEqual(await start(h, SID, '/clear'), { status: 400, body: { error: BLOCKED_MESSAGE } })
  assert.deepEqual(await start(h, SID, '  /New session'), { status: 400, body: { error: BLOCKED_MESSAGE } })
  for (const prompt of ['', '   ', undefined, 42, 'x'.repeat(MAX_PROMPT_CHARS + 1)]) {
    assert.deepEqual(await h.manager.requestPrompt({ id: SID }, prompt), { status: 400, body: { error: 'bad request' } })
  }
  assert.deepEqual(await start(h, 'local_unknown'), { status: 404, body: { error: 'session not found' } })
  assert.deepEqual(await start(h, 'not a session id'), { status: 404, body: { error: 'session not found' } })
  h.raws.push({ sessionId: 'local_nocli' })
  assert.deepEqual(await start(h, 'local_nocli'), { status: 404, body: { error: 'session not found' } })
  h.transcript = false
  assert.deepEqual(await start(h), { status: 409, body: { error: NO_TRANSCRIPT_MESSAGE } })
  assert.equal(h.spawned.length, 0)
  h.transcript = true
  assert.equal((await start(h)).status, 202)
})

test('the prompt request refuses a running, attention, loop or active session with its code and releases the claim', async (t) => {
  const h = harness(t)
  const expectRefusal = async (code, message) => {
    assert.deepEqual(await start(h), { status: 409, body: { error: message, code, queueable: true } })
    assert.equal(h.spawned.length, 0)
  }

  h.card = () => ({ touchedAt: 0, active: false, live: { attention: true }, loop: null })
  await expectRefusal('attention', 'session is busy: it is waiting for an answer or approval in the desktop app')

  h.card = () => ({ touchedAt: 0, active: false, live: null, loop: { state: 'looping', nextAt: Date.now() + 1000 } })
  await expectRefusal('loop', 'session is busy: a scheduled loop will fire in the desktop app before a run could finish')

  h.card = () => ({ touchedAt: 0, active: true, live: null, loop: null })
  await expectRefusal('active', 'session is busy in the desktop app; try again when it is idle')

  h.card = () => ({ touchedAt: 0, active: false, live: null, loop: null })
  assert.equal((await start(h)).status, 202)
  assert.deepEqual(await start(h), {
    status: 409,
    body: { error: 'a prompt is already running for this session', code: 'running', queueable: true },
  })
  assert.equal(h.spawned.length, 1)
})

test('a late close from a replaced run changes neither the new run, its saved entry nor the queue', async (t) => {
  const h = harness(t)
  await start(h, SID, 'old')
  const oldRun = h.manager.runFor(SID)
  const oldChild = h.spawned[0]
  oldChild.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
  assert.equal(oldRun.state, 'failed')

  assert.equal((await start(h, SID, 'new')).status, 202)
  const newRun = h.manager.runFor(SID)
  const newChild = h.spawned[1]
  assert.notEqual(newRun, oldRun)
  const queue = h.queue(SID, 'queued')
  await until(async () => (await h.saved())[SID]?.pid === newChild.pid)

  oldChild.emit('close', -2, null)
  await sleep(40)

  assert.equal(h.manager.runFor(SID), newRun)
  assert.equal(newRun.state, 'running')
  assert.equal(newRun.error, null)
  assert.equal(newRun.endedAt, null)
  assert.equal(queue.paused, false)
  assert.equal(queue.items.length, 1)
  assert.equal(h.spawned.length, 2)
  assert.equal((await h.saved())[SID].pid, newChild.pid)
})

test('pump skips paused queues, running sessions and refused sessions and starts one item per session per pass', async (t) => {
  const ids = ['paused', 'running', 'refused', 'first', 'second', 'nocli'].map((name) => `local_${name}`)
  const h = harness(t, { sessions: ids.map((sessionId) => ({ sessionId, cliSessionId: `cli-${sessionId}` })) })
  const [paused, running, refused, first, second] = ids
  h.raws.find((raw) => raw.sessionId === 'local_nocli').cliSessionId = undefined
  h.card = (raw) => ({ touchedAt: 0, active: raw.sessionId === refused, live: null, loop: null })
  await start(h, running)
  h.queue(paused, 'p1').paused = true
  h.queue(running, 'r1')
  h.queue(refused, 'f1')
  h.queue(first, 'a1', 'a2')
  h.queue(second, 'b1', 'b2', 'b3')
  h.queue('local_nocli', 'n1')
  h.queue('local_unlisted', 'u1')
  const before = h.spawned.length

  await h.manager.pump()

  const started = h.spawned.slice(before)
  assert.deepEqual(started.map((child) => child.input), ['a1', 'b1'])
  assert.equal(h.queues.get(paused).items.length, 1)
  assert.equal(h.queues.get(running).items.length, 1)
  assert.equal(h.queues.get(refused).items.length, 1)
  assert.equal(h.queues.get(first).items.length, 1)
  assert.equal(h.queues.get(second).items.length, 2)
  assert.equal(h.queues.get('local_nocli').items.length, 1)
  assert.equal(h.queues.get('local_unlisted').items.length, 1)
  assert.deepEqual(h.logs, [])
})

test('pump survives a queue emptied by a concurrent removal and a session that throws', async (t) => {
  const ids = ['throws', 'emptied', 'works'].map((name) => `local_${name}`)
  const h = harness(t, { sessions: ids.map((sessionId) => ({ sessionId, cliSessionId: `cli-${sessionId}` })) })
  const [throws, emptied, works] = ids
  h.queue(throws, 't1')
  h.queue(emptied, 'e1')
  h.queue(works, 'w1')
  h.card = (raw) => {
    if (raw.sessionId === throws) throw new Error('card exploded')
    if (raw.sessionId === emptied) h.queues.get(emptied).items.length = 0
    return { touchedAt: 0, active: false, live: null, loop: null }
  }

  await h.manager.pump()

  assert.deepEqual(h.spawned.map((child) => child.input), ['w1'])
  assert.equal(h.queues.get(throws).items.length, 1)
  assert.equal(h.logs.length, 1)
  assert.match(h.logs[0], /^pump local_throws: .*card exploded/s)
})

test('pump does nothing for sessions whose queues are all empty or paused', async (t) => {
  const h = harness(t)
  h.queue(SID).paused = false
  await h.manager.pump()
  h.queue(SID, 'x').paused = true
  await h.manager.pump()
  assert.equal(h.spawned.length, 0)
})

const alivePid = 777_001
const deadPid = 777_002
const adoptedEntry = (over = {}) => ({ pid: alivePid, startedAt: Date.now(), mode: 'bypassPermissions', handoffFile: null, cliSessionId: CLI, ...over })
const commandFor = (cli) => `/Users/me/.local/bin/claude -p --resume ${cli} --output-format json`

async function restart(h, entries) {
  writeFileSync(h.runsFile, JSON.stringify(entries))
  await h.manager.adoptSavedRuns()
}

test('a saved run whose pid is alive is adopted as running, blocks the pump, and a dead pid is dropped', async (t) => {
  const h = harness(t, { sessions: [{ sessionId: SID, cliSessionId: CLI }, { sessionId: SID_B, cliSessionId: CLI_B }] })
  h.alive.set(alivePid, commandFor(CLI))
  await restart(h, { [SID]: adoptedEntry(), [SID_B]: adoptedEntry({ pid: deadPid, cliSessionId: CLI_B }) })

  const run = h.manager.runFor(SID)
  assert.equal(run.state, 'running')
  assert.equal(run.adopted, true)
  assert.equal(typeof run.stop, 'function')
  assert.equal(h.manager.runFor(SID_B), undefined)
  assert.equal('stop' in h.manager.publicRun(SID), false)
  assert.deepEqual(Object.keys(await h.saved()), [SID])

  h.queue(SID, 'waiting')
  await h.manager.pump()
  assert.equal(h.spawned.length, 0)
  assert.equal(h.queues.get(SID).items.length, 1)
  assert.deepEqual(await start(h), {
    status: 409,
    body: { error: 'a prompt is already running for this session', code: 'running', queueable: true },
  })
})

test('an adopted run whose pid disappears finishes done from an end_turn tail and the queue continues', async (t) => {
  const h = harness(t)
  h.alive.set(alivePid, commandFor(CLI))
  await restart(h, { [SID]: adoptedEntry() })
  const run = h.manager.runFor(SID)
  const queue = h.queue(SID, 'next')

  h.alive.delete(alivePid)
  await until(() => h.spawned.length === 1)

  assert.equal(run.state, 'done')
  assert.equal(run.error, null)
  assert.ok(run.endedAt)
  assert.equal(h.spawned[0].input, 'next')
  assert.equal(queue.items.length, 0)
  await until(async () => (await h.saved())[SID]?.pid === h.spawned[0].pid)
})

test('an adopted run whose pid disappears without an end_turn tail ends stalled and pauses the queue', async (t) => {
  const h = harness(t)
  h.scan = { ...h.scan, state: { lastStop: 'tool_use' } }
  h.alive.set(alivePid, commandFor(CLI))
  await restart(h, { [SID]: adoptedEntry() })
  const run = h.manager.runFor(SID)
  const queue = h.queue(SID, 'next')

  h.alive.delete(alivePid)
  await until(settled(run))

  assert.equal(run.state, 'stalled')
  assert.equal(queue.paused, true)
  await h.manager.pump()
  assert.equal(h.spawned.length, 0)
  await until(async () => !(SID in (await h.saved())))
})

test('an adopted run can be stopped: SIGTERM first, SIGKILL after the grace period if the pid is still alive', async (t) => {
  const h = harness(t)
  h.alive.set(alivePid, commandFor(CLI))
  await restart(h, { [SID]: adoptedEntry() })
  const run = h.manager.runFor(SID)

  assert.equal(h.manager.stopPrompt(SID).status, 200)
  assert.deepEqual(h.signals, [[alivePid, 'SIGTERM']])
  await until(() => h.signals.length === 2)
  assert.deepEqual(h.signals[1], [alivePid, 'SIGKILL'])

  h.alive.delete(alivePid)
  await until(settled(run))
  assert.equal(run.state, 'stopped')
})

test('a saved entry that is not a claude resume of that session is not adopted', async (t) => {
  const h = harness(t)
  h.alive.set(alivePid, '/usr/sbin/cupsd -l')
  await restart(h, { [SID]: adoptedEntry() })
  assert.equal(h.manager.runFor(SID), undefined)
  assert.deepEqual(await h.saved(), {})
})

test('a desktop write to the transcript during the run stops it and ends it stalled with the interference message', async (t) => {
  const h = harness(t)
  const transcript = join(h.dir, 'transcript.jsonl')
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', entrypoint: 'cli' })}\n`)
  h.transcriptPaths.set(CLI, transcript)
  const queue = h.queue(SID, 'next')
  await start(h)
  const run = h.manager.runFor(SID)
  const child = h.spawned[0]
  assert.equal(h.queues.get(SID), queue)

  appendFileSync(transcript, `${JSON.stringify({ type: 'user', entrypoint: 'claude-desktop' })}\n`)
  await until(() => run.interfered)
  assert.equal(child.kills[0], 'SIGTERM')
  assert.equal(run.state, 'running')

  child.emit('close', null, 'SIGTERM')
  await until(settled(run))
  assert.equal(run.state, 'stalled')
  assert.equal(run.error, 'Stopped because the desktop app wrote to this session during the run.')
  assert.equal(queue.paused, true)
})

test('a handoff run that wrote its document opens it and marks it ready', async (t) => {
  const h = harness(t)
  const file = join(h.dir, 'handoff.md')
  writeFileSync(file, '# handoff')
  const result = await h.manager.requestPrompt({ id: SID }, '/handoff continue', { handoff: file })
  assert.equal(result.status, 202)
  const run = h.manager.runFor(SID)
  assert.equal(run.prompt, null)
  assert.deepEqual(run.handoff, { file, ready: false })
  assert.equal(h.spawned[0].input, '/handoff continue')
  await until(async () => (await h.saved())[SID]?.handoffFile === file)

  h.spawned[0].emit('close', 0, null)
  await until(settled(run))
  assert.equal(run.state, 'done')
  assert.equal(run.handoff.ready, true)
  assert.deepEqual(h.opened, [[SID, file]])
})

test('a handoff run that wrote no document ends failed', async (t) => {
  const h = harness(t)
  const file = join(h.dir, 'missing-handoff.md')
  await h.manager.requestPrompt({ id: SID }, '/handoff continue', { handoff: file })
  const run = h.manager.runFor(SID)
  h.spawned[0].emit('close', 0, null)
  await until(settled(run))
  assert.equal(run.state, 'failed')
  assert.equal(run.error, 'The handoff ran but wrote no document.')
  assert.equal(run.handoff.ready, false)
  assert.deepEqual(h.opened, [])
})

test('a spawn error ends the run failed with the not-found message and leaves no claim or saved entry', async (t) => {
  const h = harness(t)
  h.spawnError = true
  const queue = h.queue(SID, 'next')
  const result = await start(h)
  assert.equal(result.status, 202)
  const run = h.manager.runFor(SID)
  await until(settled(run))

  assert.equal(run.state, 'failed')
  assert.equal(run.error, 'Could not start "/bin/claude-fake": not found. Set CLAUDE_BIN to the full path of the claude binary.')
  assert.ok(run.endedAt)
  assert.equal(queue.paused, true)
  assert.deepEqual(await h.saved(), {})

  h.spawned[0].emit('close', -2, null)
  await sleep(20)
  assert.equal(h.spawned.length, 1)

  h.spawnError = false
  const retry = await start(h)
  assert.equal(retry.status, 202)
  assert.equal(h.manager.runFor(SID).state, 'running')
})

test('a running child is saved with its pid and forgotten when it closes', async (t) => {
  const h = harness(t)
  await start(h)
  const child = h.spawned[0]
  await until(async () => (await h.saved())[SID]?.pid === child.pid)
  assert.equal((await h.saved())[SID].cliSessionId, CLI)
  assert.equal((await h.saved())[SID].mode, 'bypassPermissions')
  child.emit('close', 0, null)
  await until(async () => !(SID in (await h.saved())))
})

test('a new board session is recorded and its first run uses --session-id, not --resume', async (t) => {
  const h = harness(t)
  const result = await h.manager.requestNewSession({ folder: h.dir, prompt: '  build the thing  ' })
  assert.equal(result.status, 202)
  assert.match(result.body.id, /^local_board-[0-9a-f-]{36}$/)
  assert.equal(h.board.length, 1)
  assert.equal(h.board[0].sessionId, result.body.id)
  assert.equal(h.board[0].cwd, h.dir)
  assert.equal(h.board[0].title, 'build the thing')
  const [child] = h.spawned
  const flag = child.args.indexOf('--session-id')
  assert.equal(child.args[0], '-p')
  assert.equal(child.args[flag + 1], h.board[0].cliSessionId)
  assert.ok(!child.args.includes('--resume'))
  assert.equal(child.options.cwd, h.dir)
  assert.equal(child.input, 'build the thing')
  assert.equal(h.manager.runFor(result.body.id).state, 'running')
  await until(async () => (await h.saved())[result.body.id])
  assert.equal((await h.saved())[result.body.id].cliSessionId, h.board[0].cliSessionId)
})

test('a new board session rejects a missing prompt, a relative or missing folder, and blocked commands', async (t) => {
  const h = harness(t)
  assert.equal((await h.manager.requestNewSession({ folder: h.dir, prompt: '   ' })).status, 400)
  assert.equal((await h.manager.requestNewSession({ folder: 'relative/dir', prompt: 'hi' })).status, 400)
  assert.equal((await h.manager.requestNewSession({ folder: join(h.dir, 'nope'), prompt: 'hi' })).status, 400)
  assert.equal((await h.manager.requestNewSession({ folder: `${h.dir}/../x`, prompt: 'hi' })).status, 400)
  const blocked = await h.manager.requestNewSession({ folder: h.dir, prompt: '/clear' })
  assert.equal(blocked.status, 400)
  assert.equal(blocked.body.error, BLOCKED_MESSAGE)
  assert.equal((await h.manager.requestNewSession({ folder: h.dir, prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) })).status, 400)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.board.length, 0)
})

test('a full board list refuses a new session before spawning anything', async (t) => {
  const h = harness(t)
  h.boardFull = true
  const result = await h.manager.requestNewSession({ folder: h.dir, prompt: 'hi' })
  assert.equal(result.status, 409)
  assert.equal(result.body.error, BOARD_LIMIT_MESSAGE)
  assert.equal(h.spawned.length, 0)
})

test('follow-up prompts on a board session resume it and never start the desktop guard', async (t) => {
  const entry = newBoardSession({ cwd: tmpdir(), prompt: 'first', permissionMode: 'bypassPermissions' })
  const raw = boardRaw(entry, { run: null })
  const h = harness(t, { sessions: [raw] })
  assert.equal((await start(h, raw.sessionId, 'second')).status, 202)
  const [child] = h.spawned
  assert.equal(child.args[child.args.indexOf('--resume') + 1], entry.cliSessionId)
  assert.ok(!child.args.includes('--session-id'))
  // Bytes the desktop app would write mid-run must not stop a board run.
  const transcript = join(h.dir, 'board.jsonl')
  writeFileSync(transcript, '')
  h.transcriptPaths.set(entry.cliSessionId, transcript)
  appendFileSync(transcript, `${JSON.stringify({ type: 'user', entry: 'desktop' })}\n`)
  await sleep(60)
  assert.equal(h.manager.runFor(raw.sessionId).interfered, undefined)
  assert.equal(h.manager.runFor(raw.sessionId).state, 'running')
})

test('a board session whose first run left no transcript gets the board-specific message', async (t) => {
  const entry = newBoardSession({ cwd: tmpdir(), prompt: 'first', permissionMode: 'bypassPermissions' })
  const h = harness(t, { sessions: [boardRaw(entry, { run: null })] })
  h.transcript = false
  const result = await start(h, entry.sessionId, 'again')
  assert.equal(result.status, 409)
  assert.equal(result.body.error, BOARD_NO_TRANSCRIPT_MESSAGE)
  assert.notEqual(result.body.error, NO_TRANSCRIPT_MESSAGE)
})
