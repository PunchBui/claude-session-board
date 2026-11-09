import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOCKED_PROMPT } from './commands.js'
import { refusalFor, refusalBody, createClaims, endedCleanly, classifyExit } from './guard.js'
import { spawnDetached, killGroup, logTail } from './run.js'
import { guardAgainstDesktop, POLL_MS } from './interference.js'
import { isSavedRunAlive, adoptedRun, adoptedOutcome, remainingMs, watchUntilGone, liveProbe, signalGroup } from './adopt.js'
import { writeJsonAtomic, readJsonQuarantine } from './atomic.js'
import { eachIsolated, logged, describeError } from './crash.js'
import { newBoardSession, boardRaw, validFolderPath, parseSessionOptions, BAD_FOLDER_MESSAGE } from './boardsessions.js'

export const SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/
export const MAX_PROMPT_CHARS = 8000
export const BLOCKED_MESSAGE = 'That command starts a new session, so the board would lose track of this one. Run it in the desktop app instead.'
export const NO_TRANSCRIPT_MESSAGE = 'This session has no transcript yet, so there is nothing to resume. Send its first message in the desktop app, then try again.'
export const BOARD_NO_TRANSCRIPT_MESSAGE = 'The first run of this board session never started a conversation, so there is nothing to resume. Check the run error on the card, or start a new session.'
export const BOARD_LIMIT_MESSAGE = 'Too many board sessions. Remove old entries from data/board-sessions.json first.'

export const validPrompt = (prompt) => typeof prompt === 'string' && prompt.trim() && prompt.length <= MAX_PROMPT_CHARS
export const isBlocked = (prompt) => typeof prompt === 'string' && BLOCKED_PROMPT.test(prompt)

function clip(value, max) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function createRunManager({
  spawn = spawnDetached,
  kill = killGroup,
  claudeBin,
  env,
  uploadDir,
  logDir,
  permissionMode,
  timeoutMs,
  lookaheadMs = 15 * 60_000,
  graceMs,
  adoptPollMs = 2000,
  desktopPollMs = POLL_MS,
  homeDir,
  boardStore,
  isDirectory = (path) => stat(path).then((info) => info.isDirectory(), () => false),
  scanSession,
  hasTranscript,
  buildCard,
  readRawSessions,
  findRaw,
  queues,
  persistQueues,
  readJson = readJsonQuarantine,
  writeJson = writeJsonAtomic,
  runsFile,
  transcriptPaths,
  openHandoff,
  probe = liveProbe,
  signal = signalGroup,
  now = Date.now,
  log = console.error,
}) {
  const claims = createClaims()
  const runs = new Map()
  const savedRuns = new Map()
  let pumping = false

  function publicRun(id) {
    const run = runs.get(id)
    if (!run) return null
    const { stop, ...rest } = run
    return rest
  }

  function pauseQueueAfter(id, run) {
    const queue = queues.get(id)
    if (queue?.items.length && run.state !== 'done') {
      queue.paused = true
      persistQueues()
    }
  }

  function persistRuns() {
    return writeJson(runsFile, Object.fromEntries(savedRuns)).catch((error) => log(`runs.json: ${describeError(error)}`))
  }

  function forgetRun(id, pid) {
    if (savedRuns.get(id)?.pid !== pid) return
    savedRuns.delete(id)
    persistRuns()
  }

  function trackRun(id, child, entry) {
    if (child.pid) {
      savedRuns.set(id, { pid: child.pid, ...entry })
      persistRuns()
    }
    const forget = () => forgetRun(id, child.pid)
    child.once('close', forget)
    child.once('error', forget)
  }

  function finishHandoff(raw, run) {
    return stat(run.handoff.file).catch(() => null).then((found) => {
      if (found) {
        run.handoff.ready = true
        openHandoff(raw, run.handoff.file)
      } else {
        Object.assign(run, { state: 'failed', error: 'The handoff ran but wrote no document.' })
      }
    })
  }

  function startRun(raw, prompt, { handoff = null, first = false } = {}) {
    // A board session keeps the model, effort and permission mode it was started with.
    const board = raw.source === 'board'
    const mode = (board && raw.permissionMode) || permissionMode
    const run = { state: 'running', startedAt: now(), endedAt: null, error: null, mode, stopRequested: false, timedOut: false, prompt: handoff ? null : prompt, handoff: handoff && { file: handoff, ready: false } }
    const args = ['-p', first ? '--session-id' : '--resume', raw.cliSessionId, '--output-format', 'json', '--permission-mode', mode, '--add-dir', uploadDir]
    if (board && raw.model) args.push('--model', raw.model)
    if (board && raw.effort) args.push('--effort', raw.effort)
    if (board && raw.chrome) args.push('--chrome')
    const logFile = join(logDir, `${raw.sessionId}.log`)
    const child = spawn(claudeBin, args, { cwd: raw.cwd ?? raw.originCwd ?? homeDir, logFile, input: prompt, env })
    // The desktop app does not know board sessions, so it cannot write to their transcript.
    const unguard = raw.source === 'board' ? () => {} : guardAgainstDesktop(run, transcriptPaths.get(raw.cliSessionId), { intervalMs: desktopPollMs })
    let exited = false
    run.stop = () => {
      run.stopRequested = true
      kill(child)
      setTimeout(() => { if (!exited) kill(child, 'SIGKILL') }, graceMs).unref()
    }
    const timer = timeoutMs > 0 ? setTimeout(() => { run.timedOut = true; run.stop() }, timeoutMs) : null
    child.on('error', (error) => {
      clearTimeout(timer)
      unguard()
      const missing = error.code === 'ENOENT'
      Object.assign(run, { state: 'failed', endedAt: now(), error: missing ? `Could not start "${claudeBin}": not found. Set CLAUDE_BIN to the full path of the claude binary.` : String(error.message) })
      pauseQueueAfter(raw.sessionId, run)
    })
    child.on('close', async (code, closeSignal) => {
      exited = true
      clearTimeout(timer)
      unguard()
      if (run.state === 'failed' && run.error) return pump()
      const endedAt = now()
      const scanned = await scanSession(raw).catch(() => null)
      const outcome = classifyExit({ code, signal: closeSignal, stopRequested: run.stopRequested, timedOut: run.timedOut, interfered: run.interfered, cleanTail: scanned ? endedCleanly(scanned.state) : null, errorText: clip(logTail(logFile, 2000), 400) })
      Object.assign(run, outcome, { endedAt })
      if (run.handoff && run.state === 'done') await finishHandoff(raw, run)
      pauseQueueAfter(raw.sessionId, run)
      pump()
    })
    runs.set(raw.sessionId, run)
    trackRun(raw.sessionId, child, { startedAt: run.startedAt, mode: run.mode, handoffFile: handoff, cliSessionId: raw.cliSessionId })
  }

  async function settleAdopted(raw, run, entry) {
    const scanned = await scanSession(raw).catch(() => null)
    const outcome = adoptedOutcome({ stopRequested: run.stopRequested, timedOut: run.timedOut, endedCleanly: scanned ? endedCleanly(scanned.state) : false })
    Object.assign(run, outcome, { endedAt: now() })
    if (run.handoff && run.state === 'done') await finishHandoff(raw, run)
    forgetRun(raw.sessionId, entry.pid)
    pauseQueueAfter(raw.sessionId, run)
    pump()
  }

  function adoptRun(id, raw, entry) {
    const run = adoptedRun(entry, { graceMs, signal, isAlive: probe.isAlive })
    const timer = timeoutMs > 0 ? setTimeout(() => { run.timedOut = true; run.stop() }, remainingMs(entry.startedAt, now(), timeoutMs)) : null
    watchUntilGone(entry.pid, {
      pollMs: adoptPollMs,
      isAlive: probe.isAlive,
      onGone: logged(`adopted run ${id}`, async () => {
        clearTimeout(timer)
        await settleAdopted(raw, run, entry)
      }, log),
    })
    savedRuns.set(id, entry)
    runs.set(id, run)
  }

  async function adoptSavedRuns() {
    const stored = await readJson(runsFile, {})
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return
    const raws = await readRawSessions()
    for (const [id, entry] of Object.entries(stored)) {
      if (!SESSION_ID.test(id) || !(await isSavedRunAlive(entry, probe))) continue
      const raw = raws.find((session) => session.sessionId === id) ?? { sessionId: id, cliSessionId: entry.cliSessionId }
      adoptRun(id, raw, entry)
    }
    await persistRuns()
  }

  async function pumpSession([id, queue], raws) {
    const release = claims.claim(id)
    if (!release) return
    try {
      const raw = raws.find((session) => session.sessionId === id)
      if (!raw?.cliSessionId || !(await hasTranscript(raw))) return
      const card = await buildCard(raw)
      if (refusalFor({ card, run: runs.get(id), nowMs: now(), lookaheadMs })) return
      const next = queue.items.shift()
      if (!next) return
      await persistQueues()
      startRun(raw, next.prompt)
    } finally {
      release()
    }
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      const pending = [...queues].filter(([, queue]) => queue.items.length && !queue.paused)
      if (!pending.length) return
      const raws = await readRawSessions()
      await eachIsolated(pending, (entry) => pumpSession(entry, raws), (error, [id]) => log(`pump ${id}: ${describeError(error)}`))
    } catch (error) {
      log(`pump: ${describeError(error)}`)
    } finally {
      pumping = false
    }
  }

  async function requestPrompt(body, prompt, { force = false, ...options } = {}) {
    if (isBlocked(prompt)) return { status: 400, body: { error: BLOCKED_MESSAGE } }
    if (!validPrompt(prompt)) return { status: 400, body: { error: 'bad request' } }
    const release = claims.claim(String(body.id ?? ''))
    if (!release) return { status: 409, body: refusalBody({ code: 'running', message: 'a prompt is already running for this session', queueable: true }) }
    try {
      const raw = await findRaw(body.id)
      if (!raw?.cliSessionId) return { status: 404, body: { error: 'session not found' } }
      if (!(await hasTranscript(raw))) return { status: 409, body: { error: raw.source === 'board' ? BOARD_NO_TRANSCRIPT_MESSAGE : NO_TRANSCRIPT_MESSAGE } }
      const card = await buildCard(raw)
      const refusal = refusalFor({ card, run: runs.get(body.id), nowMs: now(), lookaheadMs })
      if (refusal && !(force && refusal.code !== 'running')) return { status: 409, body: refusalBody(refusal) }
      startRun(raw, prompt.trim(), options)
      return { status: 202, body: { run: publicRun(body.id) } }
    } finally {
      release()
    }
  }

  async function requestNewSession(body) {
    const prompt = body?.prompt
    if (isBlocked(prompt)) return { status: 400, body: { error: BLOCKED_MESSAGE } }
    if (!validPrompt(prompt)) return { status: 400, body: { error: 'Write a first prompt to start a session here.' } }
    if (!validFolderPath(body.folder) || !(await isDirectory(body.folder))) return { status: 400, body: { error: BAD_FOLDER_MESSAGE } }
    const options = parseSessionOptions(body)
    if (options.error) return { status: 400, body: { error: options.error } }
    const entry = newBoardSession({ cwd: body.folder, prompt: prompt.trim(), permissionMode: options.permissionMode ?? permissionMode, model: options.model, effort: options.effort, chrome: options.chrome, now })
    if (!(await boardStore.add(entry))) return { status: 409, body: { error: BOARD_LIMIT_MESSAGE } }
    startRun(boardRaw(entry, { run: null }), prompt.trim(), { first: true })
    return { status: 202, body: { id: entry.sessionId, run: publicRun(entry.sessionId) } }
  }

  function stopPrompt(id) {
    const run = runs.get(id)
    if (!run || run.state !== 'running') return { status: 404, body: { error: 'nothing running' } }
    run.stop()
    return { status: 200, body: { run: publicRun(id) } }
  }

  return {
    runFor: (id) => runs.get(id),
    publicRun,
    requestPrompt,
    requestNewSession,
    stopPrompt,
    startRun,
    pump,
    adoptSavedRuns,
    pauseQueueAfter,
  }
}
