import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, readFile, stat, writeFile, mkdir, rm, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createScanStore } from './lib/scan.js'
import { usageOf, liveOf } from './lib/live.js'
import { gitInfo } from './lib/git.js'
import { REPEATS, nextAfter } from './lib/schedule.js'
import { searchSessions } from './lib/search.js'
import { aggregateUsage } from './lib/usage.js'
import { listCommands, BLOCKED_PROMPT } from './lib/commands.js'
import { pickFolder } from './lib/folder.js'
import { loopOf, loopRecords } from './lib/loops.js'
import { resolveClaudeBin } from './lib/claudebin.js'
import { backgroundTasks, backgroundCounts, safeOutputPath } from './lib/background.js'

const PORT = Number(process.env.PORT ?? 4747)
const HOST = '127.0.0.1'
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? join(homedir(), 'Library/Application Support/Claude/claude-code-sessions')
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? homedir()
const PROJECTS_DIR = process.env.PROJECTS_DIR ?? join(homedir(), '.claude/projects')
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))
const DATA_DIR = process.env.DATA_DIR ?? fileURLToPath(new URL('./data/', import.meta.url))
const UPLOAD_DIR = join(DATA_DIR, 'uploads')
const MAX_UPLOAD_BYTES = 25_000_000
const UPLOAD_TTL_MS = 7 * 86_400_000
const FOCUS_FILE = join(DATA_DIR, 'focus.json')
const QUEUE_FILE = join(DATA_DIR, 'queue.json')
const SCHEDULE_FILE = join(DATA_DIR, 'schedules.json')
const SNIPPET_FILE = join(DATA_DIR, 'snippets.json')
const CLAUDE_BIN = resolveClaudeBin({ configured: process.env.CLAUDE_BIN, home: homedir() })
const PROMPT_PERMISSION_MODE = process.env.PROMPT_PERMISSION_MODE ?? 'bypassPermissions'
const JIRA_BASE_URL = process.env.JIRA_BASE_URL ?? null
const SESSION_FILE = /^local_[A-Za-z0-9-]+\.json$/
const SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])
const PAGES = new Set(['/', '/focus', '/loops', '/background', '/search', '/usage'])
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const ALIASES = { 'favicon.ico': 'favicon.png' }
const ACTIVE_WINDOW_MS = 20_000
const CHAT_ITEMS = 60
const MAX_PROMPT_CHARS = 8000
const MAX_QUEUE = 20
const MAX_SCHEDULES = 50
const MAX_SNIPPETS = 40
const RUN_TIMEOUT_MS = 15 * 60_000
const DEFAULT_SNIPPETS = [
  { sid: 'default-continue', label: 'Continue', text: 'Continue.' },
  { sid: 'default-left', label: 'What is left?', text: 'List briefly what is still left to do.' },
  { sid: 'default-wrap', label: 'Wrap up', text: 'Summarize what you did and what is left, then stop.' },
  { sid: 'default-tests', label: 'Run tests', text: 'Run the relevant tests and report the result.' },
  { sid: 'default-compact', label: 'Compact context', text: '/compact' },
]

const scanStore = createScanStore()
const transcriptPaths = new Map()
const runs = new Map()
const queues = new Map()
let schedules = []
let customSnippets = null
const indexStatus = { done: 0, total: 0, running: false }

async function findSessionFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return findSessionFiles(path)
      return SESSION_FILE.test(entry.name) ? [path] : []
    })
  )
  return nested.flat()
}

function projectRoot(raw) {
  const commonDir = raw.gitAnchors?.[0]?.commonDir
  return commonDir?.endsWith('/.git') ? commonDir.slice(0, -5) : (raw.gitAnchors?.[0]?.gitRoot ?? raw.originCwd ?? raw.cwd ?? null)
}

function projectName(raw) {
  const root = projectRoot(raw)
  return root ? basename(root) : null
}

const TURN_IN_PROGRESS_MS = 5 * 60_000
const lastSummaries = new Map()

function statusOf(raw) {
  if (raw.interruptedAwaitingPerson) return 'needs-input'
  const category = raw.postTurnSummary?.status_category
  if (category) {
    lastSummaries.set(raw.sessionId, category)
    return category
  }
  const recent = Date.now() - (raw.lastActivityAt ?? 0) < TURN_IN_PROGRESS_MS
  return recent ? 'in_progress' : (lastSummaries.get(raw.sessionId) ?? 'unknown')
}

function toSummary(raw) {
  return {
    id: raw.sessionId,
    title: raw.title ?? '(untitled)',
    cwd: raw.cwd ?? null,
    project: projectName(raw),
    projectRoot: projectRoot(raw),
    model: raw.model ?? null,
    effort: raw.effort ?? null,
    permissionMode: raw.permissionMode ?? null,
    archived: Boolean(raw.isArchived),
    createdAt: raw.createdAt ?? null,
    lastActivityAt: raw.lastActivityAt ?? raw.createdAt ?? null,
    completedTurns: raw.completedTurns ?? 0,
    status: statusOf(raw),
    detail: raw.postTurnSummary?.status_detail ?? raw.turnWrapUp?.description ?? null,
    cliSessionId: raw.cliSessionId ?? null,
  }
}

const knownTitles = new Map()

function keepTitle(raw) {
  if (raw.title) knownTitles.set(raw.sessionId, raw.title)
  else if (knownTitles.has(raw.sessionId)) raw.title = knownTitles.get(raw.sessionId)
  return raw
}

async function readRawSessions() {
  const files = await findSessionFiles(SESSIONS_DIR)
  const parsed = await Promise.all(
    files.map(async (file) => {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8'))
        return raw.sessionId ? raw : null
      } catch {
        return null
      }
    })
  )
  return parsed.filter(Boolean).map(keepTitle)
}

async function loadSessions() {
  const raws = await readRawSessions()
  for (const raw of raws) {
    if (!raw.isArchived && Date.now() - (raw.lastActivityAt ?? 0) < LOOP_LOOKBACK_MS) scanSession(raw).catch(() => {})
  }
  return raws
    .map((raw) => ({ ...toSummary(raw), loop: loopFor(raw), background: backgroundCountFor(raw) }))
    .map(({ cliSessionId, ...rest }) => rest)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
}

async function findTranscript(cliSessionId) {
  if (!cliSessionId) return null
  const cached = transcriptPaths.get(cliSessionId)
  if (cached && (await stat(cached).catch(() => null))) return cached
  const dirs = await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => [])
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const candidate = join(PROJECTS_DIR, dir.name, `${cliSessionId}.jsonl`)
    if (await stat(candidate).catch(() => null)) {
      transcriptPaths.set(cliSessionId, candidate)
      return candidate
    }
  }
  return null
}

const hasTranscript = async (raw) => Boolean(await findTranscript(raw.cliSessionId))

async function scanSession(raw) {
  const path = await findTranscript(raw.cliSessionId)
  if (!path) return null
  const info = await stat(path)
  return { path, info, state: await scanStore.scan(path, info.size) }
}

async function buildCard(raw) {
  const { cliSessionId, ...base } = toSummary(raw)
  const scanned = await scanSession(raw)
  const touchedAt = Math.max(base.lastActivityAt ?? 0, scanned?.info.mtimeMs ?? 0)
  const active = Date.now() - touchedAt < ACTIVE_WINDOW_MS
  const running = runs.get(raw.sessionId)?.state === 'running'
  return {
    ...base,
    touchedAt,
    active,
    transcriptFound: Boolean(scanned),
    details: scanned ? { chat: scanned.state.chat.slice(-CHAT_ITEMS), toolCount: scanned.state.toolCalls, filesEdited: scanned.state.files.size } : null,
    usage: scanned ? usageOf(scanned.state) : null,
    live: scanned ? liveOf(scanned.state, { nowMs: Date.now(), mtimeMs: scanned.info.mtimeMs, running }) : null,
    loop: scanned ? loopOf(scanned.state.loops, { nowMs: Date.now(), working: active || running, idleMs: Date.now() - scanned.info.mtimeMs }) : null,
  }
}

const LOOP_LOOKBACK_MS = 8 * 24 * 60 * 60_000

function backgroundCountFor(raw) {
  const path = transcriptPaths.get(raw.cliSessionId)
  const state = path ? scanStore.states.get(path) : null
  const idleMs = Date.now() - (raw.lastActivityAt ?? 0)
  return state ? backgroundCounts(state.background, { nowMs: Date.now(), idleMs }) : null
}

function loopFor(raw) {
  const path = transcriptPaths.get(raw.cliSessionId)
  const state = path ? scanStore.states.get(path) : null
  if (!state) return null
  const mtimeMs = raw.lastActivityAt ?? 0
  const working = Date.now() - mtimeMs < ACTIVE_WINDOW_MS
  return loopOf(state.loops, { nowMs: Date.now(), working, idleMs: Date.now() - mtimeMs })
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2))
}

async function readFocus() {
  const parsed = await readJson(FOCUS_FILE, {})
  return Array.isArray(parsed.ids) ? parsed.ids.filter((id) => SESSION_ID.test(id)) : []
}

function queueFor(id) {
  if (!queues.has(id)) queues.set(id, { items: [], paused: false })
  return queues.get(id)
}

async function persistQueues() {
  const out = {}
  for (const [id, queue] of queues) if (queue.items.length) out[id] = queue
  await writeJson(QUEUE_FILE, out)
}

async function loadStores() {
  const storedQueues = await readJson(QUEUE_FILE, {})
  for (const [id, queue] of Object.entries(storedQueues)) {
    if (SESSION_ID.test(id) && Array.isArray(queue.items)) queues.set(id, { items: queue.items, paused: Boolean(queue.paused) })
  }
  const storedSchedules = await readJson(SCHEDULE_FILE, {})
  schedules = Array.isArray(storedSchedules.items) ? storedSchedules.items : []
  const storedSnippets = await readJson(SNIPPET_FILE, null)
  customSnippets = Array.isArray(storedSnippets?.items) ? storedSnippets.items : null
}

const persistSchedules = () => writeJson(SCHEDULE_FILE, { items: schedules })
const snippets = () => customSnippets ?? DEFAULT_SNIPPETS
const persistSnippets = () => writeJson(SNIPPET_FILE, { items: snippets() })

function publicQueue(id) {
  const queue = queues.get(id)
  return { items: queue?.items ?? [], paused: Boolean(queue?.paused) }
}

function publicRun(id) {
  const run = runs.get(id)
  if (!run) return null
  const { stop, ...rest } = run
  return rest
}

function schedulesFor(id) {
  return schedules.filter((item) => item.id === id).sort((a, b) => a.at - b.at)
}

function clip(value, max) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function pauseQueueAfter(id, run) {
  const queue = queues.get(id)
  if (queue?.items.length && run.state !== 'done') {
    queue.paused = true
    persistQueues()
  }
}

function startRun(raw, prompt) {
  const run = { state: 'running', startedAt: Date.now(), endedAt: null, error: null, mode: PROMPT_PERMISSION_MODE }
  const args = ['-p', '--resume', raw.cliSessionId, '--output-format', 'json', '--permission-mode', PROMPT_PERMISSION_MODE, '--add-dir', UPLOAD_DIR]
  const child = spawn(CLAUDE_BIN, args, { cwd: raw.cwd ?? raw.originCwd ?? homedir(), stdio: ['pipe', 'ignore', 'pipe'] })
  run.stop = () => child.kill('SIGTERM')
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
  const timer = setTimeout(() => { run.state = 'stopped'; child.kill('SIGTERM') }, RUN_TIMEOUT_MS)
  child.on('error', (error) => {
    clearTimeout(timer)
    const missing = error.code === 'ENOENT'
    Object.assign(run, { state: 'failed', endedAt: Date.now(), error: missing ? `Could not start "${CLAUDE_BIN}": not found. Set CLAUDE_BIN to the full path of the claude binary.` : String(error.message) })
    pauseQueueAfter(raw.sessionId, run)
  })
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    if (run.state === 'failed' && run.error) return pump()
    run.endedAt = Date.now()
    if (run.state === 'stopped' || signal) run.state = 'stopped'
    else if (code === 0) run.state = 'done'
    else Object.assign(run, { state: 'failed', error: clip(stderr, 400) || `exit code ${code}` })
    pauseQueueAfter(raw.sessionId, run)
    pump()
  })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)
  runs.set(raw.sessionId, run)
}

let pumping = false

async function pump() {
  if (pumping) return
  pumping = true
  try {
    const pending = [...queues].filter(([, queue]) => queue.items.length && !queue.paused)
    if (!pending.length) return
    const raws = await readRawSessions()
    for (const [id, queue] of pending) {
      const raw = raws.find((session) => session.sessionId === id)
      if (!raw?.cliSessionId || !(await hasTranscript(raw))) continue
      const run = runs.get(id)
      if (run?.state === 'running') continue
      const card = await buildCard(raw)
      const idleSinceOwnRun = run?.endedAt && card.touchedAt <= run.endedAt + 3000
      if (card.active && !idleSinceOwnRun) continue
      const next = queue.items.shift()
      await persistQueues()
      startRun(raw, next.prompt)
    }
  } finally {
    pumping = false
  }
}

async function enqueue(id, prompt) {
  const queue = queueFor(id)
  if (queue.items.length >= MAX_QUEUE) return false
  queue.items.push({ qid: randomUUID(), prompt, addedAt: Date.now() })
  await persistQueues()
  return true
}

async function fireDueSchedules() {
  const now = Date.now()
  const due = schedules.filter((item) => item.at <= now)
  if (!due.length) return
  for (const item of due) {
    await enqueue(item.id, item.prompt)
    const next = nextAfter(item.at, item.repeat, now)
    if (next) item.at = next
    else schedules = schedules.filter((existing) => existing !== item)
  }
  await persistSchedules()
  pump()
}

async function tick() {
  try {
    await fireDueSchedules()
    await pump()
  } catch {}
}

async function loadFocusCards() {
  const [ids, raws] = await Promise.all([readFocus(), readRawSessions()])
  const byId = new Map(raws.map((raw) => [raw.sessionId, raw]))
  const cards = await Promise.all(
    ids.filter((id) => byId.has(id)).map((id) =>
      buildCard(byId.get(id)).then((card) => ({
        ...card,
        run: publicRun(id),
        queue: publicQueue(id),
        schedules: schedulesFor(id),
      }))
    )
  )
  return { ids, cards }
}

async function loopHistory() {
  const raws = await readRawSessions()
  await Promise.all(raws.filter((raw) => !raw.isArchived && Date.now() - (raw.lastActivityAt ?? 0) < LOOP_LOOKBACK_MS).map((raw) => scanSession(raw).catch(() => null)))
  const loops = []
  for (const raw of raws) {
    const path = transcriptPaths.get(raw.cliSessionId)
    const state = path ? scanStore.states.get(path) : null
    if (!state?.loops.history.length) continue
    const idleMs = Date.now() - (raw.lastActivityAt ?? 0)
    const summary = toSummary(raw)
    const session = { sessionId: raw.sessionId, title: summary.title, project: summary.project, cwd: summary.cwd, archived: summary.archived }
    for (const record of loopRecords(state.loops, { nowMs: Date.now(), working: idleMs < ACTIVE_WINDOW_MS, idleMs })) loops.push({ ...session, ...record })
  }
  loops.sort((a, b) => b.createdAt - a.createdAt)
  return { loops, indexed: { done: indexStatus.done, total: indexStatus.total, running: indexStatus.running } }
}

const OUTPUT_TAIL_BYTES = 12_000

async function scannedSessions() {
  const raws = await readRawSessions()
  await Promise.all(raws.filter((raw) => !raw.isArchived && Date.now() - (raw.lastActivityAt ?? 0) < LOOP_LOOKBACK_MS).map((raw) => scanSession(raw).catch(() => null)))
  return raws.map((raw) => {
    const path = transcriptPaths.get(raw.cliSessionId)
    return { raw, state: path ? scanStore.states.get(path) : null }
  }).filter((entry) => entry.state)
}

async function backgroundHistory() {
  const tasks = []
  for (const { raw, state } of await scannedSessions()) {
    if (!state.background.tasks.size) continue
    const summary = toSummary(raw)
    const session = { sessionId: raw.sessionId, title: summary.title, project: summary.project, cwd: summary.cwd, archived: summary.archived }
    const idleMs = Date.now() - (raw.lastActivityAt ?? 0)
    for (const task of backgroundTasks(state.background, { nowMs: Date.now(), idleMs })) tasks.push({ ...session, ...task })
  }
  tasks.sort((a, b) => b.startedAt - a.startedAt)
  return { tasks, indexed: { done: indexStatus.done, total: indexStatus.total, running: indexStatus.running } }
}

async function backgroundOutput(sessionId, taskId) {
  const raw = await findRaw(sessionId)
  const path = raw ? transcriptPaths.get(raw.cliSessionId) : null
  const task = path ? scanStore.states.get(path)?.background.tasks.get(taskId) : null
  if (!task?.outputFile || !safeOutputPath(task.outputFile)) return { available: false }
  try {
    const info = await stat(task.outputFile)
    const start = Math.max(0, info.size - OUTPUT_TAIL_BYTES)
    const handle = await open(task.outputFile, 'r')
    try {
      const buffer = Buffer.alloc(info.size - start)
      await handle.read(buffer, 0, buffer.length, start)
      return { available: true, size: info.size, truncated: start > 0, text: buffer.toString('utf8'), modifiedAt: info.mtimeMs }
    } finally {
      await handle.close()
    }
  } catch {
    return { available: false }
  }
}

async function warmIndex() {
  if (indexStatus.running) return
  indexStatus.running = true
  try {
    const raws = await readRawSessions()
    indexStatus.total = raws.length
    indexStatus.done = 0
    for (const raw of raws) {
      try {
        await scanSession(raw)
      } catch {}
      indexStatus.done += 1
    }
  } finally {
    indexStatus.running = false
  }
}

async function indexedEntries() {
  const raws = await readRawSessions()
  const entries = []
  for (const raw of raws) {
    const path = transcriptPaths.get(raw.cliSessionId)
    const state = path ? scanStore.states.get(path) : null
    if (!state) continue
    const summary = toSummary(raw)
    entries.push({ id: raw.sessionId, title: summary.title, project: summary.project, cwd: summary.cwd, archived: summary.archived, messages: state.messages, byId: state.byId })
  }
  return entries
}

async function changesFor(id) {
  const raw = (await readRawSessions()).find((session) => session.sessionId === id)
  if (!raw) return null
  const scanned = await scanSession(raw)
  const cwd = raw.cwd ?? raw.originCwd ?? null
  const relative = (path) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
  const state = scanned?.state
  const files = state
    ? [...state.files].map(([path, info]) => ({ path, rel: relative(path), count: info.count, lastAt: info.lastAt, tools: [...info.tools] })).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 80)
    : []
  const tickets = state ? [...state.tickets].map(([key, count]) => ({ key, count, url: JIRA_BASE_URL ? `${JIRA_BASE_URL.replace(/\/$/, '')}/browse/${key}` : null })).sort((a, b) => b.count - a.count).slice(0, 12) : []
  const links = state ? [...state.links].map(([url, info]) => ({ url, count: info.count, lastAt: info.lastAt })).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 12) : []
  return { id, cwd, files, tickets, links, git: await gitInfo(cwd) }
}

function send(res, status, body, type) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

const json = (res, status, value) => send(res, status, JSON.stringify(value), 'application/json')

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 20_000) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function serveStatic(res, pathname) {
  const trimmed = pathname.replace(/(.)\/+$/, '$1')
  const requested = pathname.slice(1)
  const name = PAGES.has(trimmed) ? 'index.html' : (ALIASES[requested] ?? requested)
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return send(res, 404, 'not found', 'text/plain')
  const file = join(PUBLIC_DIR, name)
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return send(res, 404, 'not found', 'text/plain')
  send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream')
}

const IMAGE_TYPE = /^image\/(png|jpe?g|gif|webp)$/

function safeName(value) {
  const name = basename(String(value ?? '')).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(-120)
  return name || 'file'
}

async function readUpload(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_UPLOAD_BYTES) throw new Error('file too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function saveUpload(req, res, url) {
  if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) return json(res, 413, { error: `File is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB.` })
  const data = await readUpload(req).catch(() => null)
  if (!data?.length) return json(res, 400, { error: 'Empty or oversized file.' })
  const name = safeName(url.searchParams.get('name'))
  const dir = join(UPLOAD_DIR, randomUUID())
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, data)
  return json(res, 201, { path, name, size: data.length, image: IMAGE_TYPE.test(req.headers['content-type'] ?? '') })
}

async function pruneUploads() {
  const dirs = await readdir(UPLOAD_DIR, { withFileTypes: true }).catch(() => [])
  for (const dir of dirs) {
    const path = join(UPLOAD_DIR, dir.name)
    const info = await stat(path).catch(() => null)
    if (info && Date.now() - info.mtimeMs > UPLOAD_TTL_MS) await rm(path, { recursive: true, force: true })
  }
}

const validPrompt = (prompt) => typeof prompt === 'string' && prompt.trim() && prompt.length <= MAX_PROMPT_CHARS
const BLOCKED_MESSAGE = 'That command starts a new session, so the board would lose track of this one. Run it in the desktop app instead.'
const NO_TRANSCRIPT_MESSAGE = 'This session has no transcript yet, so there is nothing to resume. Send its first message in the desktop app, then try again.'
const isBlocked = (prompt) => typeof prompt === 'string' && BLOCKED_PROMPT.test(prompt)
const commandCache = new Map()

async function commandsFor(cwd) {
  const hit = commandCache.get(cwd)
  if (hit && Date.now() - hit.at < 30_000) return hit.items
  const items = await listCommands({ cwd, home: CLAUDE_HOME })
  commandCache.set(cwd, { at: Date.now(), items })
  return items
}
const findRaw = async (id) => (SESSION_ID.test(id ?? '') ? (await readRawSessions()).find((s) => s.sessionId === id) : null)

const postRoutes = {
  async '/api/pick-folder'(body, res) {
    try {
      return json(res, 200, await pickFolder())
    } catch (error) {
      return json(res, 500, { error: String(error.message ?? error) })
    }
  },
  async '/api/focus'(body, res) {
    if (!SESSION_ID.test(body.id ?? '') || typeof body.focused !== 'boolean') return json(res, 400, { error: 'bad request' })
    const current = await readFocus()
    const next = body.focused ? [...new Set([...current, body.id])] : current.filter((existing) => existing !== body.id)
    await writeJson(FOCUS_FILE, { ids: next })
    return json(res, 200, { ids: next })
  },
  async '/api/prompt'(body, res) {
    if (isBlocked(body.prompt)) return json(res, 400, { error: BLOCKED_MESSAGE })
    if (!validPrompt(body.prompt)) return json(res, 400, { error: 'bad request' })
    const raw = await findRaw(body.id)
    if (!raw?.cliSessionId) return json(res, 404, { error: 'session not found' })
    if (!(await hasTranscript(raw))) return json(res, 409, { error: NO_TRANSCRIPT_MESSAGE })
    if (runs.get(body.id)?.state === 'running') return json(res, 409, { error: 'a prompt is already running for this session' })
    const card = await buildCard(raw)
    if (card.active) return json(res, 409, { error: 'session is busy in the desktop app; try again when it is idle' })
    startRun(raw, body.prompt.trim())
    return json(res, 202, { run: publicRun(body.id) })
  },
  async '/api/prompt/stop'(body, res) {
    const run = runs.get(body.id)
    if (!run || run.state !== 'running') return json(res, 404, { error: 'nothing running' })
    run.state = 'stopped'
    run.stop()
    return json(res, 200, { run: publicRun(body.id) })
  },
  async '/api/queue'(body, res) {
    if (isBlocked(body.prompt)) return json(res, 400, { error: BLOCKED_MESSAGE })
    if (!validPrompt(body.prompt)) return json(res, 400, { error: 'bad request' })
    const raw = await findRaw(body.id)
    if (!raw?.cliSessionId) return json(res, 404, { error: 'session not found' })
    if (!(await hasTranscript(raw))) return json(res, 409, { error: NO_TRANSCRIPT_MESSAGE })
    if (!(await enqueue(body.id, body.prompt.trim()))) return json(res, 409, { error: `queue is full (${MAX_QUEUE})` })
    pump()
    return json(res, 202, { queue: publicQueue(body.id) })
  },
  async '/api/queue/remove'(body, res) {
    if (!SESSION_ID.test(body.id ?? '')) return json(res, 400, { error: 'bad request' })
    const queue = queueFor(body.id)
    queue.items = queue.items.filter((item) => item.qid !== body.qid)
    await persistQueues()
    return json(res, 200, { queue: publicQueue(body.id) })
  },
  async '/api/queue/resume'(body, res) {
    if (!SESSION_ID.test(body.id ?? '')) return json(res, 400, { error: 'bad request' })
    queueFor(body.id).paused = false
    await persistQueues()
    pump()
    return json(res, 200, { queue: publicQueue(body.id) })
  },
  async '/api/broadcast'(body, res) {
    if (isBlocked(body.prompt)) return json(res, 400, { error: BLOCKED_MESSAGE })
    if (!validPrompt(body.prompt) || !Array.isArray(body.ids) || body.ids.length > 20) return json(res, 400, { error: 'bad request' })
    const raws = await readRawSessions()
    const queued = []
    const skipped = []
    for (const id of body.ids) {
      const raw = raws.find((s) => s.sessionId === id)
      if (raw?.cliSessionId && (await hasTranscript(raw)) && (await enqueue(id, body.prompt.trim()))) queued.push(id)
      else skipped.push(id)
    }
    pump()
    return json(res, 202, { queued, skipped })
  },
  async '/api/schedule'(body, res) {
    if (isBlocked(body.prompt)) return json(res, 400, { error: BLOCKED_MESSAGE })
    const now = Date.now()
    if (!validPrompt(body.prompt) || !Number.isFinite(body.at) || body.at < now - 60_000 || body.at > now + 365 * 86_400_000) return json(res, 400, { error: 'pick a time in the future' })
    const repeat = body.repeat ?? 'none'
    if (!REPEATS.has(repeat)) return json(res, 400, { error: 'bad repeat' })
    const raw = await findRaw(body.id)
    if (!raw?.cliSessionId) return json(res, 404, { error: 'session not found' })
    if (schedules.length >= MAX_SCHEDULES) return json(res, 409, { error: `too many schedules (${MAX_SCHEDULES})` })
    schedules.push({ sid: randomUUID(), id: body.id, prompt: body.prompt.trim(), at: Math.max(body.at, now), repeat })
    await persistSchedules()
    return json(res, 201, { schedules: schedulesFor(body.id) })
  },
  async '/api/schedule/remove'(body, res) {
    const before = schedules.length
    schedules = schedules.filter((item) => item.sid !== body.sid)
    if (schedules.length !== before) await persistSchedules()
    return json(res, 200, { ok: true })
  },
  async '/api/snippets'(body, res) {
    const label = String(body.label ?? '').trim().slice(0, 40)
    if (!label || !validPrompt(body.text)) return json(res, 400, { error: 'bad request' })
    if (snippets().length >= MAX_SNIPPETS) return json(res, 409, { error: `too many snippets (${MAX_SNIPPETS})` })
    customSnippets = [...snippets(), { sid: randomUUID(), label, text: body.text.trim() }]
    await persistSnippets()
    return json(res, 201, { items: snippets() })
  },
  async '/api/snippets/remove'(body, res) {
    customSnippets = snippets().filter((item) => item.sid !== body.sid)
    await persistSnippets()
    return json(res, 200, { items: snippets() })
  },
}

const getRoutes = {
  async '/api/health'(url, res) {
    return json(res, 200, {
      ok: true,
      pid: process.pid,
      port: PORT,
      node: process.version,
      startedAt: Date.now() - Math.round(process.uptime() * 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      managed: Boolean(process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== '0'),
    })
  },
  async '/api/sessions'(url, res) {
    return json(res, 200, await loadSessions())
  },
  async '/api/focus'(url, res) {
    return json(res, 200, await loadFocusCards())
  },
  async '/api/background'(url, res) {
    return json(res, 200, await backgroundHistory())
  },
  async '/api/background/output'(url, res) {
    const session = url.searchParams.get('session')
    const task = url.searchParams.get('task') ?? ''
    if (!SESSION_ID.test(session ?? '') || !/^[A-Za-z0-9_-]{1,40}$/.test(task)) return json(res, 400, { error: 'bad request' })
    return json(res, 200, await backgroundOutput(session, task))
  },
  async '/api/loops'(url, res) {
    return json(res, 200, await loopHistory())
  },
  async '/api/snippets'(url, res) {
    return json(res, 200, { items: snippets() })
  },
  async '/api/changes'(url, res) {
    const id = url.searchParams.get('id')
    if (!SESSION_ID.test(id ?? '')) return json(res, 400, { error: 'bad request' })
    const result = await changesFor(id)
    return result ? json(res, 200, result) : json(res, 404, { error: 'session not found' })
  },
  async '/api/commands'(url, res) {
    const raw = await findRaw(url.searchParams.get('id'))
    if (!raw) return json(res, 404, { error: 'session not found' })
    return json(res, 200, { items: await commandsFor(raw.cwd ?? raw.originCwd ?? null) })
  },
  async '/api/search'(url, res) {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200)
    const project = (url.searchParams.get('project') ?? '').slice(0, 200)
    const result = searchSessions(await indexedEntries(), q, project)
    return json(res, 200, { ...result, query: q, project, indexed: { done: indexStatus.done, total: indexStatus.total, running: indexStatus.running } })
  },
  async '/api/usage'(url, res) {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 120)
    return json(res, 200, aggregateUsage(await indexedEntries(), days))
  },
}

await loadStores()
pruneUploads()
setInterval(tick, 2000)
warmIndex()
setInterval(warmIndex, 60_000)

createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(res, 403, 'forbidden', 'text/plain')
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (req.method === 'POST') {
      if (!ALLOWED_ORIGINS.has(req.headers.origin ?? '')) return send(res, 403, 'forbidden', 'text/plain')
      if (url.pathname === '/api/upload') return await saveUpload(req, res, url)
      const route = postRoutes[url.pathname]
      if (!route) return send(res, 404, 'not found', 'text/plain')
      return await route(await readBody(req), res)
    }
    if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain')
    const route = getRoutes[url.pathname]
    if (route) return await route(url, res)
    return await serveStatic(res, url.pathname)
  } catch (error) {
    return send(res, 500, String(error), 'text/plain')
  }
}).listen(PORT, HOST, () => console.log(`Claude session board on http://localhost:${PORT}`))
