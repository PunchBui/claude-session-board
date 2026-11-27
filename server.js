import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile, mkdir, rm, open, chmod, rename } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, extname, basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createScanStore, transcriptTitle, isHandoffFile } from './lib/scan.js'
import { shownSettings, parseOverride, mergeOverride, overridesFromFile } from './lib/sessionsettings.js'
import { usageOf, liveOf } from './lib/live.js'
import { gitInfo } from './lib/git.js'
import { REPEATS, nextAfter, fireDue, advanceFired } from './lib/schedule.js'
import { MAX_ROUTINES, parseRoutineInput, parseRoutinesFile, isDue, afterFire, recordRun, applyEdit } from './lib/routines.js'
import { searchSessions } from './lib/search.js'
import { aggregateUsage } from './lib/usage.js'
import { createLimitsReader } from './lib/limits.js'
import { createRepoStatusReader } from './lib/repostatus.js'
import { createRepoPusher } from './lib/repopush.js'
import { createRepoPuller } from './lib/repopull.js'
import { listCommands, probeSlashCommands } from './lib/commands.js'
import { listSkills, aggregateSkills, skillDetail } from './lib/skills.js'
import { pickFolder } from './lib/folder.js'
import { loopOf, loopRecords } from './lib/loops.js'
import { resolveClaudeBin } from './lib/claudebin.js'
import { createCardCache, cardVersion, timeBucket, parseHave, focusDelta } from './lib/cardcache.js'
import { handoffFile, handoffPrompt, handoffLink } from './lib/handoff.js'
import { pingReviewer, pingChannel, reviewChannelFrom, resolveReviewChannel } from './lib/ping.js'
import { resolveSpawnEnv } from './lib/env.js'
import { createMrCache, InvalidMrUrlError, withSessions, withFocus, withPings, withPingDue, PING_AFTER_MS, recordPing, toggleFocus, autoFocusNew, isMrUrl, addLabel, closeMr, setAutoMerge, mrState, withAutoMerge, withLabel, ADDABLE_LABELS, glab, GITLAB_HOST } from './lib/mrs.js'
import { backgroundTasks, backgroundCounts, sessionBackground, safeOutputPath } from './lib/background.js'
import { writeJsonAtomic, readJsonQuarantine, withFileLock, updateJsonFile } from './lib/atomic.js'
import { actionFrom, isTrackedRoute, recordAction, summarizeActions, recordWhenSent, parseShown } from './lib/actions.js'
import { installCrashGuard, describeError } from './lib/crash.js'
import { readNewSessionDefaults } from './lib/defaults.js'
import { validFolderPath } from './lib/boardsessions.js'
import { reorderFocus } from './lib/focusorder.js'
import { createSubagentStore, isAgentId } from './lib/subagents.js'
import { isBabysitState, isBabysitActive, isBabysitPrompt, recordBabysit, approveReplyPlan, withBabysit, babysitSessions, babysitCaller, createBabysitStore, watchBabysits } from './lib/babysit.js'
import { isDeployState, recordDeploy, withDeploy } from './lib/deploycheck.js'
import { resolveLocal, resolveWithBase, imageType, fileKind, isHtmlFile, contentDisposition, parseRange, withSizeReporter } from './lib/localfile.js'
import { createRemoteCache, createCanonicalCache, resolveFolders, withFolders, siblingFolders, settleWithin } from './lib/mrfolder.js'
import { originUrl } from './lib/git.js'
import { readRemoteConfig, isAuthed, safeEqual, sessionCookie, createLoginLimiter, clientKey, crossOrigin, LOGIN_PAGE } from './lib/remote.js'
import { createBoardStore, boardRaw, keptBoardIds, evictionOrder } from './lib/boardsessions.js'
import { createTitler } from './lib/autotitle.js'
import { readJsonBody, readBytes, BodyTooLargeError, BadBodyError } from './lib/body.js'
import { setBounded } from './lib/cache.js'
import { settleForce } from './lib/queue.js'
import { pruneOldFiles } from './lib/prune.js'
import { createRunManager, SESSION_ID, BLOCKED_MESSAGE, NO_TRANSCRIPT_MESSAGE, validPrompt, isBlocked } from './lib/runs.js'
import { sideChatParent, isSideChat, ownsLoops, isSpawnedTask, spawnedParent, ownChat, forkedAt, firstQuestion, parseClosedFile, setClosed, countOpenSideChats, sideChatRow } from './lib/sidechats.js'
import { jiraConfig, cleanBaseUrl, reusableToken, createJiraClient, mrUrlOf } from './lib/jira.js'
import { buildFlow, reviewPattern, branchKeys, parseMilestoneInput, recordMilestone, recordLink } from './lib/flow.js'
import { createFlowSync } from './lib/flowsync.js'
import { createImagineCache, findAsar, widgetPage } from './lib/imagine.js'
import { runArgs } from './lib/visualize-mcp.js'

const PORT = Number(process.env.PORT ?? 4747)
const HOST = '127.0.0.1'
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? join(homedir(), 'Library/Application Support/Claude/claude-code-sessions')
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? homedir()
const PROJECTS_DIR = process.env.PROJECTS_DIR ?? join(homedir(), '.claude/projects')
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))
const DATA_DIR = process.env.DATA_DIR ?? fileURLToPath(new URL('./data/', import.meta.url))
const UPLOAD_DIR = join(DATA_DIR, 'uploads')
const RUN_LOG_DIR = join(DATA_DIR, 'runs')
const MAX_UPLOAD_BYTES = 25_000_000
const UPLOAD_TTL_MS = 7 * 86_400_000
const FOCUS_FILE = join(DATA_DIR, 'focus.json')
const MR_FOCUS_FILE = join(DATA_DIR, 'mr-focus.json')
const MR_PINGS_FILE = join(DATA_DIR, 'mr-pings.json')
const ACTIONS_FILE = join(DATA_DIR, 'actions.json')
const chipsShown = new Map()
const PING_DUE_MS = (Number(process.env.PING_DUE_HOURS) > 0 ? Number(process.env.PING_DUE_HOURS) : PING_AFTER_MS / 3_600_000) * 3_600_000
const MR_CACHE_FILE = join(DATA_DIR, 'mr-cache.json')
const MR_BABYSIT_FILE = join(DATA_DIR, 'mr-babysit.json')
const MR_DEPLOY_FILE = join(DATA_DIR, 'mr-deploy.json')
const QUEUE_FILE = join(DATA_DIR, 'queue.json')
const SCHEDULE_FILE = join(DATA_DIR, 'schedules.json')
const ROUTINE_FILE = join(DATA_DIR, 'routines.json')
const SNIPPET_FILE = join(DATA_DIR, 'snippets.json')
const RUNS_FILE = join(DATA_DIR, 'runs.json')
const BOARD_SESSIONS_FILE = join(DATA_DIR, 'board-sessions.json')
const SIDE_CHATS_FILE = join(DATA_DIR, 'side-chats.json')
const OVERRIDES_FILE = join(DATA_DIR, 'session-overrides.json')
const JIRA_FILE = join(DATA_DIR, 'jira.json')
const FLOW_CACHE_FILE = join(DATA_DIR, 'flow-cache.json')
const MR_EVENTS_FILE = join(DATA_DIR, 'mr-events.json')
const FLOW_MILESTONES_FILE = join(DATA_DIR, 'flow-milestones.json')
const FLOW_LINKS_FILE = join(DATA_DIR, 'flow-links.json')
const ADOPT_POLL_MS = 2000
const CLAUDE_BIN = resolveClaudeBin({ configured: process.env.CLAUDE_BIN, home: homedir() })
const REVIEW_CHANNEL_ENV = reviewChannelFrom(process.env.REVIEW_SLACK_CHANNEL)
const REVIEW_CHANNEL_FILE = join(DATA_DIR, 'review-channel.json')
const PROMPT_PERMISSION_MODE = process.env.PROMPT_PERMISSION_MODE ?? 'bypassPermissions'
const JIRA_BASE_URL = process.env.JIRA_BASE_URL ?? null
const SESSION_FILE = /^local_[A-Za-z0-9-]+\.json$/
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])
// Hostnames a tunnel (tailscale serve) forwards here; they need the login cookie. See lib/remote.js.
const remote = await readRemoteConfig({ file: join(DATA_DIR, 'remote.json') })
const REMOTE_HOSTS = new Set(remote.hosts)
for (const host of REMOTE_HOSTS) ALLOWED_ORIGINS.add(`https://${host}`)
const loginLimiter = createLoginLimiter()
// Static files the browser fetches without cookies (install prompt, icons). They hold nothing private.
const PUBLIC_ASSETS = new Set(['/manifest.webmanifest', '/favicon.png', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'])
const PAGES = new Set(['/', '/focus', '/loops', '/background', '/mrs', '/flow', '/search', '/usage', '/skills', '/schedule'])
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const ALIASES = { 'favicon.ico': 'favicon.png' }
const ACTIVE_WINDOW_MS = 20_000
const CHAT_ITEMS = 60
const MAX_QUEUE = 20
const MAX_SCHEDULES = 50
const MAX_SNIPPETS = 40
const RUN_TIMEOUT_MS = 0 // 0 = no run timeout
const KILL_GRACE_MS = 5000
const spawnEnv = await resolveSpawnEnv()
const DEFAULT_SNIPPETS = [
  { sid: 'default-continue', label: 'Continue', text: 'Continue.' },
  { sid: 'default-left', label: 'What is left?', text: 'List briefly what is still left to do.' },
  { sid: 'default-wrap', label: 'Wrap up', text: 'Summarize what you did and what is left, then stop.' },
  { sid: 'default-tests', label: 'Run tests', text: 'Run the relevant tests and report the result.' },
  { sid: 'default-compact', label: 'Compact context', text: '/compact' },
  { sid: 'default-ship-push', label: 'Commit and push', text: 'Run the repository\'s format step, commit the finished changes with specific files only, and push the branch.' },
  { sid: 'default-ship-mr', label: 'Commit and create MR', text: 'Run the repository\'s format step, commit the finished changes with specific files only, push the branch and create a merge request with glab.' },
]

const scanStore = createScanStore()
const subagentStore = createSubagentStore()
const transcriptPaths = new Map()
const queues = new Map()
let schedules = []
let routines = []
let firingRoutines = false
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
    source: raw.source ?? 'desktop',
    sideChatOf: sideChatParent(raw),
    unfocused: raw.unfocused === true,
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
  return [...parsed.filter(Boolean).map(keepTitle), ...(await boardRaws())]
}

async function boardRaws() {
  return Promise.all(
    boardStore.all().map(async (entry) => {
      const path = await findTranscript(entry.cliSessionId)
      const info = path ? await stat(path).catch(() => null) : null
      const state = info ? await scanStore.scan(path, info.size).catch(() => null) : null
      return boardRaw(entry, { lastActivityAt: info?.mtimeMs, run: manager.runFor(entry.sessionId), title: transcriptTitle(state) })
    })
  )
}

async function loadSessions() {
  const raws = await readRawSessions()
  for (const raw of raws) {
    if (!raw.isArchived && Date.now() - (raw.lastActivityAt ?? 0) < LOOP_LOOKBACK_MS) scanSession(raw).catch(() => {})
  }
  const summaries = raws.map((raw) => ({ ...toSummary(raw), lastPromptAt: promptAtFor(raw), loop: loopFor(raw), background: backgroundCountFor(raw) }))
  const sideChats = countOpenSideChats(summaries, await readClosedSideChats())
  return summaries
    .map(({ cliSessionId, ...rest }) => ({ ...rest, sideChats: sideChats.get(rest.id) ?? 0 }))
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

let babysitBySession = new Map()

function sessionMrUrls(state) {
  const seen = new Map()
  for (const [url, info] of state.links) {
    const mrUrl = mrUrlOf(url)
    if (mrUrl && !(seen.get(mrUrl) >= String(info.lastAt))) seen.set(mrUrl, String(info.lastAt))
  }
  return [...seen].sort((a, b) => b[1].localeCompare(a[1])).slice(0, 5).map(([url]) => url)
}

async function buildCard(raw) {
  const { cliSessionId, ...base } = toSummary(raw)
  const scanned = await scanSession(raw)
  const touchedAt = Math.max(base.lastActivityAt ?? 0, scanned?.info.mtimeMs ?? 0)
  const run = manager.runFor(raw.sessionId)
  const running = run?.state === 'running'
  const override = (await readOverrides())[raw.sessionId] ?? {}
  const live = scanned ? liveOf(scanned.state, { nowMs: Date.now(), mtimeMs: scanned.info.mtimeMs, running, runEndedAt: run?.endedAt ?? null, asks: running ? run.pending ?? [] : [] }) : null
  const active = Date.now() - touchedAt < ACTIVE_WINDOW_MS || Boolean(live?.working)
  return {
    ...base,
    ...shownSettings(raw, { ...scanned?.state.settings, ...override }),
    ...(override.permissionMode ? { permissionMode: override.permissionMode } : {}),
    override,
    touchedAt,
    lastPromptAt: promptAtOf(scanned?.state),
    active,
    transcriptFound: Boolean(scanned),
    details: scanned ? { chat: (base.sideChatOf ? ownChat(scanned.state.chat, forkedAt(raw)) : scanned.state.chat).slice(-CHAT_ITEMS), toolCount: scanned.state.toolCalls, filesEdited: scanned.state.files.size } : null,
    usage: scanned ? usageOf(scanned.state) : null,
    subagents: scanned ? await subagentStore.summary(scanned.path) : null,
    backgroundTasks: scanned ? sessionBackground(scanned.state.background, { nowMs: Date.now(), idleMs: Date.now() - scanned.info.mtimeMs }) : null,
    babysit: babysitBySession.get(raw.sessionId) ?? null,
    mrUrls: scanned ? sessionMrUrls(scanned.state) : [],
    live,
    loop: scanned && ownsLoops(raw) ? loopOf(scanned.state.loops, { nowMs: Date.now(), working: active || running, idleMs: Date.now() - scanned.info.mtimeMs }) : null,
  }
}

const LOOP_LOOKBACK_MS = 8 * 24 * 60 * 60_000
const WARM_SESSIONS = 50

function backgroundCountFor(raw) {
  const path = transcriptPaths.get(raw.cliSessionId)
  const state = path ? scanStore.states.get(path) : null
  const idleMs = Date.now() - (raw.lastActivityAt ?? 0)
  return state ? backgroundCounts(state.background, { nowMs: Date.now(), idleMs }) : null
}

function promptAtOf(state) {
  const parsed = state?.lastPromptAt ? Date.parse(state.lastPromptAt) : NaN
  return Number.isNaN(parsed) ? null : parsed
}

function promptAtFor(raw) {
  const path = transcriptPaths.get(raw.cliSessionId)
  return promptAtOf(path ? scanStore.states.get(path) : null)
}

function loopFor(raw) {
  const path = transcriptPaths.get(raw.cliSessionId)
  const state = path ? scanStore.states.get(path) : null
  if (!state) return null
  if (!ownsLoops(raw)) return null
  const mtimeMs = raw.lastActivityAt ?? 0
  const working = Date.now() - mtimeMs < ACTIVE_WINDOW_MS
  return loopOf(state.loops, { nowMs: Date.now(), working, idleMs: Date.now() - mtimeMs })
}

const readJson = (file, fallback) =>
  readJsonQuarantine(file, fallback, { onCorrupt: ({ file: path, kept }) => console.error(`${path} did not parse; kept it as ${kept}`) })

const writeJson = writeJsonAtomic
const boardStore = createBoardStore({ file: BOARD_SESSIONS_FILE, readJson, writeJson, evictable: boardEvictable })

async function boardEvictable(items) {
  const [focus, babysit, deploy, closedSideChats] = await Promise.all([readFocus(), readMrBabysit(), readMrDeploy(), readClosedSideChats()])
  const keep = keptBoardIds(items, {
    focus,
    babysit,
    deploy,
    closedSideChats,
    scheduled: schedules,
    running: (id) => manager.runFor(id)?.state === 'running',
    queued: (id) => Boolean(queues.get(id)?.items.length),
  })
  const usedAt = new Map(await Promise.all(items.map(async (entry) => {
    const path = transcriptPaths.get(entry.cliSessionId)
    const info = path ? await stat(path).catch(() => null) : null
    return [entry.sessionId, info?.mtimeMs ?? 0]
  })))
  return evictionOrder(items, { keep, usedAt })
}

const focusIdsOf = (parsed) => (Array.isArray(parsed?.ids) ? parsed.ids.filter((id) => SESSION_ID.test(id)) : [])

async function readFocus() {
  return focusIdsOf(await readJson(FOCUS_FILE, {}))
}

const updateJson = (file, fallback, mutate) => updateJsonFile(file, fallback, mutate, { read: readJson, write: writeJson })
const updateFocus = (change) => updateJson(FOCUS_FILE, {}, (stored) => ({ ids: change(focusIdsOf(stored)) }))

async function readOverrides() {
  return overridesFromFile(await readJson(OVERRIDES_FILE, {}))
}

async function readClosedSideChats() {
  return parseClosedFile(await readJson(SIDE_CHATS_FILE, {}))
}

async function sideChatRows() {
  const [raws, closed] = await Promise.all([readRawSessions(), readClosedSideChats()])
  const shut = new Set(closed)
  const byId = new Map(raws.map((raw) => [raw.sessionId, raw]))
  const sides = raws.filter(isSideChat)
  const scanned = await Promise.all(sides.map((raw) => scanSession(raw).catch(() => null)))
  return sides.map((raw, i) => {
    const summary = toSummary(raw)
    const running = manager.runFor(raw.sessionId)?.state === 'running' || Date.now() - Math.max(summary.lastActivityAt ?? 0, scanned[i]?.info.mtimeMs ?? 0) < ACTIVE_WINDOW_MS
    const parent = byId.get(summary.sideChatOf)
    return sideChatRow(summary, { parent: parent ? toSummary(parent) : null, question: firstQuestion(scanned[i]?.state.chat, forkedAt(raw)), closed: shut.has(raw.sessionId), running })
  }).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
}

async function sideChatCard(id) {
  const raw = await findRaw(id)
  if (!raw || !isSideChat(raw)) return null
  const card = await buildCard(raw)
  return { ...card, run: manager.publicRun(id), queue: publicQueue(id) }
}

const currentReviewChannel = async () => resolveReviewChannel({ env: REVIEW_CHANNEL_ENV, saved: await readJson(REVIEW_CHANNEL_FILE, null) })

const plainObject = (parsed) => (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})

async function readMrPings() {
  return plainObject(await readJson(MR_PINGS_FILE, {}))
}

const savePing = (url, who, at) => updateJson(MR_PINGS_FILE, {}, (stored) => recordPing(plainObject(stored), url, who, at))

const babysitStore = createBabysitStore({ file: MR_BABYSIT_FILE, readJson, writeJson, onChange: (store) => { babysitBySession = babysitSessions(store) } })
const readMrBabysit = babysitStore.read

async function readMrDeploy() {
  return plainObject(await readJson(MR_DEPLOY_FILE, {}))
}

const mrFocusStateOf = (parsed) => ({
  urls: Array.isArray(parsed?.urls) ? parsed.urls.filter(isMrUrl) : [],
  seen: Array.isArray(parsed?.seen) ? parsed.seen.filter(isMrUrl) : null,
})

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
  await boardStore.load()
  babysitBySession = babysitSessions(await readMrBabysit())
  const storedQueues = await readJson(QUEUE_FILE, {})
  for (const [id, queue] of Object.entries(storedQueues)) {
    if (SESSION_ID.test(id) && Array.isArray(queue.items)) queues.set(id, { items: queue.items, paused: Boolean(queue.paused) })
  }
  const storedSchedules = await readJson(SCHEDULE_FILE, {})
  schedules = Array.isArray(storedSchedules.items) ? storedSchedules.items : []
  routines = parseRoutinesFile(await readJson(ROUTINE_FILE, {}))
  const storedSnippets = await readJson(SNIPPET_FILE, null)
  customSnippets = Array.isArray(storedSnippets?.items) ? storedSnippets.items : null
}

const persistRoutines = () => writeJson(ROUTINE_FILE, { items: routines })
const persistSchedules = () => writeJson(SCHEDULE_FILE, { items: schedules })
const snippets = () => customSnippets ?? DEFAULT_SNIPPETS
const persistSnippets = () => writeJson(SNIPPET_FILE, { items: snippets() })

function publicQueue(id) {
  const queue = queues.get(id)
  return { items: queue?.items ?? [], paused: Boolean(queue?.paused) }
}

function schedulesFor(id) {
  return schedules.filter((item) => item.id === id).sort((a, b) => a.at - b.at)
}

function openHandoff(raw, file) {
  execFile('open', [handoffLink({ folder: raw.cwd ?? raw.originCwd ?? null, file })], () => {})
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
  const fired = await fireDue(schedules, { now, enqueue })
  if (!fired.length) return
  schedules = advanceFired(schedules, fired, now)
  await persistSchedules()
  pump()
}

const babysitKicked = new Map()
const babysitLookedUp = new Map()

async function kickIdleBabysits() {
  const kicked = await watchBabysits(babysitStore, {
    loadMerged: async () => (await mergeRequests()).merged ?? [],
    contextFor: (sid) => ({
      running: manager.runFor(sid)?.state === 'running',
      scheduled: schedules.some((item) => item.id === sid && isBabysitPrompt(item.prompt)),
      queued: Boolean(queues.get(sid)?.items.some((item) => isBabysitPrompt(item.prompt))),
      paused: Boolean(queues.get(sid)?.paused),
      kickedAt: babysitKicked.get(sid) ?? 0,
    }),
    exists: async (sid) => Boolean(await findRaw(sid)),
    lookup: (url) => mrState(url),
    checkedAt: babysitLookedUp,
    enqueueCheck: async (sid, url) => {
      if (!(await enqueue(sid, `/csb-babysit ${url}`))) return false
      babysitKicked.set(sid, Date.now())
      return true
    },
  })
  if (kicked) pump()
}

// Starts one new board-only session for a routine and puts it in Focus.
async function startRoutineSession(routine) {
  try {
    const result = await manager.requestNewSession(routine)
    if (result.status !== 202) return { error: result.body?.error ?? 'Could not start the session.' }
    await updateFocus((ids) => [...new Set([...ids, result.body.id])])
    return { sessionId: result.body.id }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

async function fireDueRoutines() {
  if (firingRoutines) return
  firingRoutines = true
  try {
    for (const routine of routines.filter((r) => isDue(r, Date.now()))) {
      const now = Date.now()
      const outcome = await startRoutineSession(routine)
      routines = routines.map((r) => (r.rid === routine.rid ? afterFire(r, outcome, now) : r))
      await persistRoutines()
    }
  } finally {
    firingRoutines = false
  }
}

async function tick() {
  try {
    await fireDueRoutines()
    await fireDueSchedules()
    await pump()
  } catch (error) {
    console.error(`scheduler tick: ${describeError(error)}`)
  }
}

const focusCardCache = createCardCache()

async function focusVersion(raw, override) {
  const path = await findTranscript(raw.cliSessionId)
  const info = path ? await stat(path).catch(() => null) : null
  const id = raw.sessionId
  return cardVersion([toSummary(raw), ownsLoops(raw), info?.mtimeMs ?? null, info?.size ?? null, manager.publicRun(id), publicQueue(id), schedulesFor(id), babysitBySession.get(id) ?? null, override ?? null, timeBucket(Date.now(), Math.max(info?.mtimeMs ?? 0, raw.lastActivityAt ?? 0))])
}

async function loadFocusCards(have = new Map()) {
  const [ids, raws, overrides] = await Promise.all([readFocus(), readRawSessions(), readOverrides()])
  const sideIds = new Set(raws.filter(isSideChat).map((raw) => raw.sessionId))
  const byId = new Map(raws.map((raw) => [raw.sessionId, raw]))
  const shown = ids.filter((id) => !sideIds.has(id))
  const present = shown.filter((id) => byId.has(id))
  const { cards, same } = await focusDelta(present, {
    have,
    cache: focusCardCache,
    versionOf: (id) => focusVersion(byId.get(id), overrides[id]),
    build: async (id) => ({ ...(await buildCard(byId.get(id))), run: manager.publicRun(id), queue: publicQueue(id), schedules: schedulesFor(id) }),
  })
  return { ids: shown, cards, same }
}

const mergeRequests = createMrCache({
  restore: () => readJson(MR_CACHE_FILE, null),
  persist: (data) => { writeJson(MR_CACHE_FILE, data).catch(() => {}) },
})

async function mrSessionLinks() {
  const linked = new Map()
  for (const raw of await readRawSessions()) {
    const path = transcriptPaths.get(raw.cliSessionId)
    const state = path ? scanStore.states.get(path) : null
    if (!state) continue
    const { title, project, archived, cwd } = toSummary(raw)
    const mtimeMs = (await stat(path).catch(() => null))?.mtimeMs ?? 0
    const run = manager.runFor(raw.sessionId)
    const working = Boolean(liveOf(state, { nowMs: Date.now(), mtimeMs, running: run?.state === 'running', runEndedAt: run?.endedAt ?? null }).working)
    for (const url of state.links.keys()) {
      const sessions = linked.get(url) ?? []
      sessions.push({ sessionId: raw.sessionId, title, project, archived, cwd, working, lastActivityAt: raw.lastActivityAt ?? 0 })
      linked.set(url, sessions)
    }
  }
  return linked
}

const readJiraSaved = () => readJson(JIRA_FILE, null)

async function writeSecretJson(file, value) {
  await mkdir(DATA_DIR, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, file)
}
const readJiraConfig = async () => jiraConfig(process.env, await readJiraSaved())

async function flowSessions() {
  const sessions = []
  for (const raw of await readRawSessions()) {
    if (isSideChat(raw) && !isSpawnedTask(raw)) continue
    const path = transcriptPaths.get(raw.cliSessionId)
    const state = path ? scanStore.states.get(path) : null
    if (!state) continue
    const summary = toSummary(raw)
    sessions.push({
      parent: spawnedParent(raw),
      peers: [...new Set((Array.isArray(raw.peerReceipts) ? raw.peerReceipts : []).map((receipt) => receipt?.targetSessionId).filter((id) => typeof id === 'string'))],
      handoffReads: [...(state.handoffReads ?? [])],
      handoffWrites: [...state.files].filter(([file, info]) => info.tools.has('Write') && isHandoffFile(file)).map(([file]) => file),
      id: raw.sessionId,
      title: summary.title,
      project: summary.project,
      status: summary.status,
      archived: summary.archived,
      createdAt: summary.createdAt,
      lastActivityAt: summary.lastActivityAt,
      branches: [...state.branches].map(([name, info]) => ({ name, firstAt: info.firstAt })),
      tickets: [...state.tickets].map(([key, count]) => ({ key, count, firstAt: state.ticketFirstAt.get(key) ?? null })),
      mrUrls: [...new Set([...state.links.keys()].map(mrUrlOf).filter(Boolean))],
      slack: [...state.slack.values()].map(({ key, host, channel, ts, firstAt, via, title, author }) => ({ key, host, channel, ts, firstAt, via, title: title ?? null, author: author ?? null })),
      slackChannels: [...state.slackChannels],
    })
  }
  return sessions
}

const FLOW_KEY_DAYS = 180
const FLOW_KEY_MENTIONS = 3

async function flowExtraKeys() {
  const since = Date.now() - FLOW_KEY_DAYS * 86_400_000
  const keys = []
  for (const session of (await flowSessions()).filter((item) => (item.lastActivityAt ?? 0) >= since).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))) {
    for (const branch of session.branches) keys.push(...branchKeys(branch.name))
    keys.push(...session.tickets.filter((item) => item.count >= FLOW_KEY_MENTIONS).sort((a, b) => b.count - a.count).slice(0, 3).map((item) => item.key))
  }
  return [...new Set(keys)]
}

const flowSync = createFlowSync({
  readConfig: readJiraConfig,
  readCache: () => readJson(FLOW_CACHE_FILE, null),
  writeCache: (data) => writeJson(FLOW_CACHE_FILE, data),
  readEvents: () => readJson(MR_EVENTS_FILE, {}),
  writeEvents: (data) => writeJson(MR_EVENTS_FILE, data),
  extraKeys: flowExtraKeys,
  run: glab,
  host: GITLAB_HOST,
})

async function flowPage({ force = false } = {}) {
  const [config, saved] = await Promise.all([readJiraConfig(), readJiraSaved()])
  const data = await flowSync.get({ force })
  const [events, deploys, milestones, links, sessions] = await Promise.all([
    readJson(MR_EVENTS_FILE, {}),
    readMrDeploy(),
    readJson(FLOW_MILESTONES_FILE, {}),
    readJson(FLOW_LINKS_FILE, {}),
    flowSessions(),
  ])
  const slackChannels = Object.fromEntries(sessions.flatMap((session) => session.slackChannels ?? []))
  const flow = buildFlow({ jira: data.jira, mrs: data.mrs ?? [], events, deploys, sessions, milestones, links, slackChannels, me: data.me, review: reviewPattern(saved?.reviewStatus) })
  return {
    configured: config.ready,
    jira: config.ready ? { baseUrl: config.baseUrl, email: config.email, jql: config.jql, fromEnv: Boolean(process.env.JIRA_API_TOKEN) } : null,
    gitlab: Boolean(GITLAB_HOST),
    fetchedAt: data.fetchedAt || null,
    error: data.error ?? null,
    gitlabError: data.gitlabError ?? null,
    refreshing: Boolean(data.refreshing) || flowSync.syncing(),
    ...flow,
  }
}

const FOLDER_WAIT_MS = 1500
let lastFolders = new Map()
const remoteOf = createRemoteCache({ read: originUrl })
const canonicalProject = createCanonicalCache({
  read: async (path) => JSON.parse(await glab(['api', '--hostname', GITLAB_HOST, `projects/${encodeURIComponent(path)}`])).path_with_namespace,
})

const listFolders = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name)
}

async function mrFolders(data, linked) {
  const raws = (await readRawSessions()).filter((raw) => raw.cwd).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  const sessionFolders = raws.map((raw) => raw.cwd)
  const siblings = await siblingFolders(sessionFolders, { list: listFolders, home: homedir() })
  const mine = [...data.authored, ...(data.merged ?? []).filter((mr) => mr.role === 'authored')]
  return resolveFolders(mine, { linked, known: [...sessionFolders, ...siblings], remoteOf, canonical: canonicalProject })
}

async function loopHistory() {
  const raws = await readRawSessions()
  await Promise.all(raws.filter((raw) => !raw.isArchived && Date.now() - (raw.lastActivityAt ?? 0) < LOOP_LOOKBACK_MS).map((raw) => scanSession(raw).catch(() => null)))
  const loops = []
  for (const raw of raws) {
    const path = transcriptPaths.get(raw.cliSessionId)
    const state = path ? scanStore.states.get(path) : null
    if (!state?.loops.history.length || !ownsLoops(raw)) continue
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
    const raws = (await readRawSessions()).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, WARM_SESSIONS)
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
    entries.push({ id: raw.sessionId, title: summary.title, project: summary.project, cwd: summary.cwd, projectRoot: summary.projectRoot, archived: summary.archived, messages: state.messages, byId: state.byId, skills: state.skills })
  }
  return entries
}

async function installedSkills() {
  const projects = new Map()
  for (const raw of await readRawSessions()) {
    const { project, projectRoot } = toSummary(raw)
    if (project && projectRoot && !projects.has(project)) projects.set(project, projectRoot)
  }
  return listSkills({ projects, home: CLAUDE_HOME })
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
  const jiraBase = JIRA_BASE_URL ? JIRA_BASE_URL.replace(/\/$/, '') : (await readJiraConfig()).baseUrl
  const tickets = state ? [...state.tickets].map(([key, count]) => ({ key, count, url: jiraBase ? `${jiraBase}/browse/${key}` : null })).sort((a, b) => b.count - a.count).slice(0, 12) : []
  const links = state ? [...state.links].map(([url, info]) => ({ url, count: info.count, lastAt: info.lastAt })).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 12) : []
  return { id, cwd, files, tickets, links, git: await gitInfo(cwd) }
}

function send(res, status, body, type) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

const json = (res, status, value) => send(res, status, JSON.stringify(value), 'application/json')

const readBody = (req) => readJsonBody(req)

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

async function saveUpload(req, res, url) {
  if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) return json(res, 413, { error: `File is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB.` })
  const data = await readBytes(req, { maxBytes: MAX_UPLOAD_BYTES }).catch((error) => (error instanceof BodyTooLargeError ? error : null))
  if (data instanceof BodyTooLargeError) return json(res, 413, { error: `File is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB.` })
  if (!data?.length) return json(res, 400, { error: 'Empty or oversized file.' })
  const name = safeName(url.searchParams.get('name'))
  const dir = join(UPLOAD_DIR, randomUUID())
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, data)
  return json(res, 201, { path, name, size: data.length, image: IMAGE_TYPE.test(req.headers['content-type'] ?? '') })
}

// Serves an image the board saved, so queued prompts can show a preview. Only files inside
// the upload folder, and only common image types.
const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
async function serveUpload(res, url) {
  const path = resolve(url.searchParams.get('path') ?? '')
  const type = IMAGE_EXT[extname(path).toLowerCase()]
  if (!type || !path.startsWith(`${resolve(UPLOAD_DIR)}${sep}`)) return send(res, 404, 'not found', 'text/plain')
  const data = await readFile(path).catch(() => null)
  if (!data) return send(res, 404, 'not found', 'text/plain')
  res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' })
  return res.end(data)
}

const pruneRunLogs = () => pruneOldFiles(RUN_LOG_DIR)

async function pruneUploads() {
  const dirs = await readdir(UPLOAD_DIR, { withFileTypes: true }).catch(() => [])
  for (const dir of dirs) {
    const path = join(UPLOAD_DIR, dir.name)
    const info = await stat(path).catch(() => null)
    if (info && Date.now() - info.mtimeMs > UPLOAD_TTL_MS) await rm(path, { recursive: true, force: true })
  }
}

const commandCache = new Map()
const probeCache = new Map()
const PROBE_TTL_MS = 10 * 60_000
const MAX_PROBE_CACHE = 50
const MAX_COMMAND_CACHE = 50

function probedFor(cwd) {
  const hit = probeCache.get(cwd)
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.names
  const names = probeSlashCommands({ bin: CLAUDE_BIN, cwd: cwd ?? homedir(), env: spawnEnv }).then((found) => {
    if (!found) probeCache.delete(cwd)
    return found
  })
  setBounded(probeCache, cwd, { at: Date.now(), names }, MAX_PROBE_CACHE)
  return names
}

async function commandsFor(cwd) {
  const hit = commandCache.get(cwd)
  if (hit && Date.now() - hit.at < 30_000) return hit.items
  const items = await listCommands({ cwd, home: CLAUDE_HOME, probed: await probedFor(cwd) })
  setBounded(commandCache, cwd, { at: Date.now(), items }, MAX_COMMAND_CACHE)
  return items
}
const findRaw = async (id) => (SESSION_ID.test(id ?? '') ? (await readRawSessions()).find((s) => s.sessionId === id) : null)

const manager = createRunManager({
  claudeBin: CLAUDE_BIN,
  env: spawnEnv,
  uploadDir: UPLOAD_DIR,
  logDir: RUN_LOG_DIR,
  permissionMode: PROMPT_PERMISSION_MODE,
  timeoutMs: RUN_TIMEOUT_MS,
  graceMs: KILL_GRACE_MS,
  adoptPollMs: ADOPT_POLL_MS,
  homeDir: homedir(),
  boardStore,
  suggestTitle: createTitler({ bin: CLAUDE_BIN, env: spawnEnv }),
  scanSession,
  hasTranscript,
  buildCard,
  readRawSessions,
  findRaw,
  queues,
  persistQueues,
  readJson,
  readOverride: async (id) => (await readOverrides())[id] ?? {},
  writeJson,
  runsFile: RUNS_FILE,
  transcriptPaths,
  openHandoff,
  extraArgs: () => runArgs(Boolean(findAsar())),
})
const pump = manager.pump
const imagine = createImagineCache()

const reply = (res, { status, body }) => json(res, status, body)
const WIDGET_MISSING_PAGE = '<!doctype html><meta charset="utf-8"><body style="font:13px system-ui;color:#888;margin:8px">This visualization needs the Claude desktop app installed on this Mac.</body>'

const mrFailure = (res, error) => json(res, error instanceof InvalidMrUrlError ? 400 : 502, { error: String(error.message ?? error) })

const postRoutes = {
  async '/api/reveal'(body, res) {
    const found = await resolveWithBase(body.path, body.base)
    if (!found) return json(res, 404, { error: 'That file or folder no longer exists.' })
    execFile('open', ['-R', found.path], () => {})
    return json(res, 200, { ok: true })
  },
  async '/api/repo/push'(body, res) {
    const result = await commitAndPushRepo({ pull: body.pull === true })
    if (!result.ok) return json(res, result.status, { error: result.error, conflict: result.conflict ? { ...result.conflict, folder: REPO_DIR } : undefined })
    return json(res, 200, { committed: result.committed, pulled: result.pulled, pushed: result.pushed, status: await readRepoStatus({ force: true }) })
  },
  async '/api/repo/pull'(body, res) {
    const result = await pullRepo()
    if (!result.ok) return json(res, result.status, { error: result.error })
    return json(res, 200, { pulled: result.pulled, status: await readRepoStatus({ force: true }) })
  },
  async '/api/pick-folder'(body, res) {
    try {
      return json(res, 200, await pickFolder())
    } catch (error) {
      return json(res, 500, { error: String(error.message ?? error) })
    }
  },
  async '/api/mrs/focus'(body, res) {
    if (!isMrUrl(body.url) || typeof body.focused !== 'boolean') return json(res, 400, { error: 'bad request' })
    const { after } = await updateJson(MR_FOCUS_FILE, {}, (parsed) => {
      const stored = mrFocusStateOf(parsed)
      return { urls: toggleFocus(stored.urls, body.url, body.focused), seen: stored.seen ?? undefined }
    })
    return json(res, 200, { urls: after.urls })
  },
  async '/api/mrs/label'(body, res) {
    if (!isMrUrl(body.url) || !ADDABLE_LABELS.includes(body.label)) return json(res, 400, { error: 'bad request' })
    let added
    try {
      added = await addLabel(body.url, body.label)
    } catch (error) {
      return mrFailure(res, error)
    }
    const mr = mergeRequests.patchAuthored(body.url, (current) => added.reduce((mr, name) => withLabel(mr, name, Date.now()), current))
    return json(res, 200, { ok: true, mr })
  },
  async '/api/mrs/auto-merge'(body, res) {
    if (!isMrUrl(body.url)) return json(res, 400, { error: 'bad request' })
    try {
      await setAutoMerge(body.url)
    } catch (error) {
      return mrFailure(res, error)
    }
    const mr = mergeRequests.patchAuthored(body.url, (current) => withAutoMerge(current, Date.now()))
    return json(res, 200, { ok: true, mr })
  },
  async '/api/mrs/close'(body, res) {
    if (!isMrUrl(body.url)) return json(res, 400, { error: 'bad request' })
    try {
      await closeMr(body.url)
    } catch (error) {
      return mrFailure(res, error)
    }
    mergeRequests.removeAuthored(body.url)
    return json(res, 200, { ok: true })
  },
  async '/api/mrs/babysit'(body, res) {
    const badSession = body.sessionId !== undefined && !SESSION_ID.test(body.sessionId)
    if (!isMrUrl(body.url) || !isBabysitState(body.state) || badSession) return json(res, 400, { error: 'bad request' })
    const update = { ...body, ...babysitCaller(body, (id) => boardStore.find(id)) }
    const { after } = await babysitStore.update((current) => recordBabysit(current, body.url, update, Date.now()))
    return json(res, 200, { ok: true, babysit: after[body.url] })
  },
  async '/api/mrs/babysit/stop'(body, res) {
    if (!isMrUrl(body.url)) return json(res, 400, { error: 'bad request' })
    const stop = (current) => (isBabysitActive(current[body.url]?.state) ? recordBabysit(current, body.url, { state: 'stopped', note: 'Stopped by you' }, Date.now()) : current)
    const { before, after: store } = await babysitStore.update(stop)
    const entry = before[body.url]
    if (!entry || !isBabysitActive(entry.state)) return json(res, 409, { error: 'no active babysit on this merge request' })
    if (entry.sessionId) {
      schedules = schedules.filter((item) => !(item.id === entry.sessionId && isBabysitPrompt(item.prompt)))
      await persistSchedules()
      const queue = queues.get(entry.sessionId)
      if (queue) {
        queue.items = queue.items.filter((item) => !isBabysitPrompt(item.prompt))
        await persistQueues()
      }
      manager.stopPrompt(entry.sessionId)
    }
    return json(res, 200, { ok: true, babysit: store[body.url] })
  },
  async '/api/mrs/babysit/approve'(body, res) {
    if (!isMrUrl(body.url)) return json(res, 400, { error: 'bad request' })
    const result = await approveReplyPlan(babysitStore, body.url, { exists: async (sid) => Boolean(await findRaw(sid)), enqueue })
    if (result.status === 200) pump()
    return reply(res, result)
  },
  async '/api/mrs/deploy'(body, res) {
    const badSession = body.sessionId !== undefined && !SESSION_ID.test(body.sessionId)
    if (!isMrUrl(body.url) || !isDeployState(body.state) || badSession) return json(res, 400, { error: 'bad request' })
    const { after } = await updateJson(MR_DEPLOY_FILE, {}, (stored) => recordDeploy(plainObject(stored), body.url, body, Date.now()))
    return json(res, 200, { ok: true, deploy: after[body.url] })
  },
  async '/api/flow/sync'(body, res) {
    await flowSync.refresh()
    return json(res, 200, await flowPage())
  },
  async '/api/flow/jira'(body, res) {
    if (body.disconnect === true) {
      await rm(JIRA_FILE, { force: true })
      flowSync.refresh().catch(() => {})
      return json(res, 200, { ok: true })
    }
    const saved = await readJiraSaved()
    const baseUrl = cleanBaseUrl(body.baseUrl)
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 200) : ''
    const token = reusableToken(body, saved, baseUrl)
    const jql = typeof body.jql === 'string' ? body.jql.trim().slice(0, 2000) : saved?.jql ?? ''
    const reviewStatus = typeof body.reviewStatus === 'string' ? body.reviewStatus.trim().slice(0, 200) : saved?.reviewStatus ?? ''
    if (!baseUrl || !email || !token) return json(res, 400, { error: 'Fill in the Jira site, your email and an API token.' })
    const config = jiraConfig({}, { baseUrl, email, token, jql })
    let me
    try {
      me = await createJiraClient(config).myself()
    } catch (error) {
      return json(res, 400, { error: String(error.message ?? error) })
    }
    await writeSecretJson(JIRA_FILE, { baseUrl, email, token, jql, reviewStatus })
    flowSync.refresh().catch(() => {})
    return json(res, 200, { ok: true, name: me?.displayName ?? email })
  },
  async '/api/flow/milestone'(body, res) {
    const parsed = parseMilestoneInput(body)
    if (parsed.error) return json(res, 400, { error: parsed.error })
    const { after } = await updateJson(FLOW_MILESTONES_FILE, {}, (stored) => recordMilestone(plainObject(stored), parsed, Date.now()))
    return json(res, 200, { ok: true, milestones: after[parsed.key] ?? {} })
  },
  async '/api/flow/link'(body, res) {
    const kind = body.kind === 'mr' || body.kind === 'session' ? body.kind : null
    const ticket = body.ticket === null ? null : typeof body.ticket === 'string' ? body.ticket.trim().toUpperCase() : undefined
    const validId = kind === 'mr' ? isMrUrl(body.id) : kind === 'session' && SESSION_ID.test(body.id ?? '')
    if (!kind || !validId || ticket === undefined || (ticket && !/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(ticket))) return json(res, 400, { error: 'bad request' })
    await updateJson(FLOW_LINKS_FILE, {}, (stored) => recordLink(plainObject(stored), { kind, id: body.id, ticket }))
    return json(res, 200, { ok: true })
  },
  async '/api/mrs/ping'(body, res) {
    if (!isMrUrl(body.url) || typeof body.reviewer !== 'string') return json(res, 400, { error: 'bad request' })
    const data = await mergeRequests()
    const mr = data.authored.find((item) => item.url === body.url)
    if (!mr || !mr.reviewers.includes(body.reviewer)) return json(res, 404, { error: 'reviewer not found on this merge request' })
    try {
      const { name } = await pingReviewer({ mr, username: body.reviewer, bin: CLAUDE_BIN, env: spawnEnv })
      const pingedAt = Date.now()
      await savePing(body.url, body.reviewer, pingedAt)
      return json(res, 200, { ok: true, name, pingedAt })
    } catch (error) {
      return json(res, 502, { error: String(error.message ?? error) })
    }
  },
  async '/api/mrs/ping-channel'(body, res) {
    if (!isMrUrl(body.url)) return json(res, 400, { error: 'bad request' })
    const reviewChannel = await currentReviewChannel()
    if (!reviewChannel) return json(res, 409, { error: 'set the Slack channel to ask for reviews in first' })
    const data = await mergeRequests()
    const mr = data.authored.find((item) => item.url === body.url)
    if (!mr) return json(res, 404, { error: 'merge request not found' })
    try {
      const { channel } = await pingChannel({ mr, channel: reviewChannel, bin: CLAUDE_BIN, env: spawnEnv })
      const pingedAt = Date.now()
      await savePing(body.url, `#${channel}`, pingedAt)
      return json(res, 200, { ok: true, channel, pingedAt })
    } catch (error) {
      console.error(`ask team failed for ${body.url}: ${error.message ?? error}`)
      return json(res, 502, { error: String(error.message ?? error) })
    }
  },
  async '/api/mrs/review-channel'(body, res) {
    if (REVIEW_CHANNEL_ENV) return json(res, 409, { error: 'REVIEW_SLACK_CHANNEL is set, so it overrides this setting' })
    if (typeof body.channel !== 'string') return json(res, 400, { error: 'bad request' })
    const channel = reviewChannelFrom(body.channel)
    if (body.channel.trim() && !channel) return json(res, 400, { error: 'Use a Slack channel name: lowercase letters, numbers, hyphens and underscores.' })
    if (channel) await writeJson(REVIEW_CHANNEL_FILE, { channel })
    else await rm(REVIEW_CHANNEL_FILE, { force: true })
    return json(res, 200, { ok: true, channel: channel || null })
  },
  async '/api/focus'(body, res) {
    if (!SESSION_ID.test(body.id ?? '') || typeof body.focused !== 'boolean') return json(res, 400, { error: 'bad request' })
    const { after } = await updateFocus((current) => (body.focused ? [...new Set([...current, body.id])] : current.filter((existing) => existing !== body.id)))
    return json(res, 200, { ids: after.ids })
  },
  async '/api/focus/clear'(body, res) {
    await updateFocus(() => [])
    return json(res, 200, { ids: [] })
  },
  async '/api/focus/order'(body, res) {
    if (!Array.isArray(body.ids) || body.ids.length > 500 || !body.ids.every((id) => SESSION_ID.test(id ?? ''))) return json(res, 400, { error: 'bad request' })
    const { after } = await updateFocus((current) => reorderFocus(current, body.ids))
    return json(res, 200, { ids: after.ids })
  },
  async '/api/prompt'(body, res) {
    return reply(res, await manager.requestPrompt(body, body.prompt))
  },
  async '/api/new-session'(body, res) {
    const result = await manager.requestNewSession(body)
    if (result.status === 202 && body.focus !== false) await updateFocus((ids) => [...new Set([...ids, result.body.id])])
    return reply(res, result)
  },
  async '/api/session/settings'(body, res) {
    if (!SESSION_ID.test(body.id ?? '')) return json(res, 400, { error: 'bad request' })
    const parsed = parseOverride(body)
    if (parsed.error) return json(res, 400, { error: parsed.error })
    if (!(await findRaw(body.id))) return json(res, 404, { error: 'session not found' })
    let next
    await updateJson(OVERRIDES_FILE, {}, (stored) => {
      const all = overridesFromFile(stored)
      next = mergeOverride(all[body.id] ?? {}, parsed.override)
      if (Object.keys(next).length) all[body.id] = next
      else delete all[body.id]
      return { items: all }
    })
    return json(res, 200, { override: next })
  },
  async '/api/side-chats'(body, res) {
    return reply(res, await manager.requestSideChat(body))
  },
  async '/api/side-chats/close'(body, res) {
    if (!SESSION_ID.test(body.id ?? '') || typeof body.closed !== 'boolean') return json(res, 400, { error: 'bad request' })
    const raw = await findRaw(body.id)
    if (!raw || !isSideChat(raw)) return json(res, 404, { error: 'side chat not found' })
    await updateJson(SIDE_CHATS_FILE, {}, (stored) => ({ closed: setClosed(parseClosedFile(stored), body.id, body.closed) }))
    return json(res, 200, { ok: true })
  },
  async '/api/handoff'(body, res) {
    const file = handoffFile(String(body.id ?? ''), tmpdir())
    return reply(res, await manager.requestPrompt(body, handoffPrompt(file), { handoff: file }))
  },
  async '/api/prompt/stop'(body, res) {
    return reply(res, manager.stopPrompt(body.id))
  },
  async '/api/prompt/answer'(body, res) {
    return reply(res, manager.answerPrompt(String(body.id ?? ''), body))
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
  async '/api/chips/shown'(body, res) {
    const parsed = parseShown(body)
    if (!parsed) return json(res, 400, { error: 'bad request' })
    if (chipsShown.get(parsed.id)?.labels.join() !== parsed.labels.join()) chipsShown.set(parsed.id, { at: Date.now(), labels: parsed.labels })
    if (chipsShown.size > 200) chipsShown.delete(chipsShown.keys().next().value)
    return json(res, 200, { ok: true })
  },
  async '/api/queue/force'(body, res) {
    if (!SESSION_ID.test(body.id ?? '')) return json(res, 400, { error: 'bad request' })
    const queue = queueFor(body.id)
    const item = queue.items.find((entry) => entry.qid === body.qid)
    if (!item) return json(res, 404, { error: 'queued message not found' })
    const interrupting = manager.runFor(body.id)?.state === 'running'
    const wasPaused = queue.paused
    if (interrupting) {
      const stopped = await manager.interruptPrompt(body.id)
      if (stopped.status !== 200) return reply(res, stopped)
    }
    let result = { status: 500, body: { error: 'could not start the prompt' } }
    try {
      result = await manager.requestPrompt({ id: body.id }, item.prompt, { force: true })
    } finally {
      settleForce(queue, body.qid, { status: result.status, interrupting, wasPaused })
      await persistQueues()
    }
    return reply(res, result)
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
  async '/api/schedule/run'(body, res) {
    const item = schedules.find((entry) => entry.sid === body.sid)
    if (!item) return json(res, 404, { error: 'schedule not found' })
    if (!(await enqueue(item.id, item.prompt))) return json(res, 409, { error: `queue is full (${MAX_QUEUE})` })
    if (item.repeat === 'none') {
      schedules = schedules.filter((entry) => entry !== item)
      await persistSchedules()
    }
    pump()
    return json(res, 200, { schedules: schedulesFor(item.id) })
  },
  async '/api/schedule/remove'(body, res) {
    const before = schedules.length
    schedules = schedules.filter((item) => item.sid !== body.sid)
    if (schedules.length !== before) await persistSchedules()
    return json(res, 200, { ok: true })
  },
  async '/api/routines'(body, res) {
    const parsed = parseRoutineInput(body, { validPrompt })
    if (parsed.error) return json(res, 400, { error: parsed.error })
    if (isBlocked(parsed.routine.prompt)) return json(res, 400, { error: BLOCKED_MESSAGE })
    if (routines.length >= MAX_ROUTINES) return json(res, 409, { error: `Too many schedules (${MAX_ROUTINES}). Delete one first.` })
    routines = [...routines, parsed.routine]
    await persistRoutines()
    return json(res, 201, { routines })
  },
  async '/api/routines/update'(body, res) {
    const existing = routines.find((r) => r.rid === body.rid)
    if (!existing) return json(res, 404, { error: 'not found' })
    const parsed = parseRoutineInput(body, { validPrompt })
    if (parsed.error) return json(res, 400, { error: parsed.error })
    if (isBlocked(parsed.routine.prompt)) return json(res, 400, { error: BLOCKED_MESSAGE })
    routines = routines.map((r) => (r.rid === existing.rid ? applyEdit(r, parsed.routine) : r))
    await persistRoutines()
    return json(res, 200, { routines })
  },
  async '/api/routines/toggle'(body, res) {
    const routine = routines.find((r) => r.rid === body.rid)
    if (!routine) return json(res, 404, { error: 'not found' })
    const enabled = Boolean(body.enabled)
    // Switching a finished one-off back on needs a new time, otherwise it would fire at once.
    if (enabled && routine.at < Date.now() && routine.repeat === 'none') return json(res, 400, { error: 'This one-off already ran. Create a new schedule for another run.' })
    routines = routines.map((r) => (r.rid === routine.rid ? { ...r, enabled, at: enabled && r.at < Date.now() ? (nextAfter(r.at, r.repeat) ?? r.at) : r.at } : r))
    await persistRoutines()
    return json(res, 200, { routines })
  },
  async '/api/routines/run'(body, res) {
    const routine = routines.find((r) => r.rid === body.rid)
    if (!routine) return json(res, 404, { error: 'not found' })
    const outcome = await startRoutineSession(routine)
    routines = routines.map((r) => (r.rid === routine.rid ? recordRun(r, outcome, Date.now()) : r))
    await persistRoutines()
    if (outcome.error) return json(res, 409, { error: outcome.error, routines })
    return json(res, 202, { routines, sessionId: outcome.sessionId })
  },
  async '/api/routines/remove'(body, res) {
    const before = routines.length
    routines = routines.filter((r) => r.rid !== body.rid)
    if (routines.length !== before) await persistRoutines()
    return json(res, 200, { routines })
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

function logAction(entry) {
  withFileLock(ACTIONS_FILE, async () => writeJson(ACTIONS_FILE, recordAction(await readJson(ACTIONS_FILE, []), entry))).catch(() => {})
}

const getRoutes = {
  async '/api/actions'(url, res) {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365)
    return json(res, 200, { days, actions: summarizeActions(await readJson(ACTIONS_FILE, []), { now: Date.now(), days }) })
  },
  async '/visualize/widget.html'(url, res) {
    const html = await imagine()?.widgetHtml()
    if (!html) return send(res, 404, WIDGET_MISSING_PAGE, 'text/html; charset=utf-8')
    send(res, 200, widgetPage(html), 'text/html; charset=utf-8')
  },
  async '/api/file'(url, res, req) {
    const rawPath = url.searchParams.get('path') ?? ''
    const base = url.searchParams.get('base')
    const joined = base && base.startsWith('/') && isHtmlFile(rawPath) && !/^[/~]/.test(rawPath) && !rawPath.split('/').includes('..') ? `${base.replace(/\/+$/, '')}/${rawPath}` : rawPath
    const found = await resolveLocal(joined)
    const kind = fileKind(found)
    if (kind?.tooLarge) return send(res, 413, 'file too large', 'text/plain')
    if (kind?.kind === 'html') {
      const page = await readFile(found.path).catch(() => null)
      if (!page) return send(res, 404, 'not found', 'text/plain')
      // Opaque origin: scripts may run (whiteboards animate) but cannot touch the board's cookies or API.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': 'sandbox allow-scripts allow-popups', 'x-content-type-options': 'nosniff' })
      return res.end(url.searchParams.get('viewer') === '1' ? withSizeReporter(page.toString('utf8')) : page)
    }
    if (kind?.kind === 'pdf') {
      // iOS fetches PDFs in byte ranges; a server that ignores Range leaves its viewer blank.
      const headers = { 'content-type': 'application/pdf', 'content-disposition': contentDisposition(found.path, url.searchParams.get('download') === '1'), 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' }
      const range = parseRange(req.headers.range, found.size)
      if (range === 'unsatisfiable') {
        res.writeHead(416, { 'content-range': `bytes */${found.size}` })
        return res.end()
      }
      if (range) res.writeHead(206, { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${found.size}`, 'content-length': range.end - range.start + 1 })
      else res.writeHead(200, { ...headers, 'content-length': found.size })
      const stream = createReadStream(found.path, range ?? undefined)
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy())
      return stream.pipe(res)
    }
    if (kind?.kind !== 'image') return send(res, 404, 'not found', 'text/plain')
    const image = await readFile(found.path).catch(() => null)
    if (!image) return send(res, 404, 'not found', 'text/plain')
    res.writeHead(200, { 'content-type': imageType(found.path), 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' })
    return res.end(image)
  },
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
    return json(res, 200, await loadFocusCards(parseHave(url.searchParams.get('have'))))
  },
  async '/api/side-chats'(url, res) {
    return json(res, 200, { items: await sideChatRows() })
  },
  async '/api/side-chat'(url, res) {
    const card = await sideChatCard(url.searchParams.get('id'))
    return card ? json(res, 200, card) : json(res, 404, { error: 'side chat not found' })
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
  async '/api/mrs'(url, res) {
    const data = await mergeRequests({ force: url.searchParams.get('force') === '1' })
    let next
    await updateJson(MR_FOCUS_FILE, {}, (parsed) => {
      next = autoFocusNew(data, mrFocusStateOf(parsed))
      return next.changed ? { urls: next.urls, seen: next.seen } : parsed
    })
    const linked = await mrSessionLinks()
    const withLinks = withSessions(data, linked)
    const resolving = mrFolders(withLinks, linked).then((resolved) => (lastFolders = resolved))
    resolving.catch(() => {})
    const folders = await settleWithin(resolving, FOLDER_WAIT_MS)
    const shown = withFolders(folders ? withLinks : { ...withLinks, refreshing: true }, lastFolders)
    const reviewChannel = await currentReviewChannel()
    return json(res, 200, withDeploy(withBabysit({ ...withPingDue(withPings(withFocus(shown, next.urls), await readMrPings(), reviewChannel), { events: await readJson(MR_EVENTS_FILE, {}), now: Date.now(), afterMs: PING_DUE_MS }), reviewChannel: reviewChannel || null, reviewChannelLocked: Boolean(REVIEW_CHANNEL_ENV) }, await readMrBabysit()), await readMrDeploy()))
  },
  async '/api/flow'(url, res) {
    return json(res, 200, await flowPage())
  },
  async '/api/loops'(url, res) {
    return json(res, 200, await loopHistory())
  },
  async '/api/new-defaults'(url, res) {
    const folder = url.searchParams.get('folder')
    return json(res, 200, await readNewSessionDefaults({ home: CLAUDE_HOME, folder: validFolderPath(folder) ? folder : null, permissionMode: PROMPT_PERMISSION_MODE }))
  },
  async '/api/routines'(url, res) {
    return json(res, 200, { routines })
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
  async '/api/subagents'(url, res) {
    const id = url.searchParams.get('id')
    const raw = await findRaw(id)
    const path = raw ? await findTranscript(raw.cliSessionId) : null
    if (!path) return json(res, 404, { error: 'session not found' })
    const agent = url.searchParams.get('agent')
    if (agent === null) return json(res, 200, { items: await subagentStore.list(path) })
    if (!isAgentId(agent)) return json(res, 400, { error: 'bad request' })
    const result = await subagentStore.chat(path, agent)
    return result ? json(res, 200, result) : json(res, 404, { error: 'subagent not found' })
  },
  async '/api/commands'(url, res, req) {
    if (crossOrigin(req.headers, ALLOWED_ORIGINS)) return send(res, 403, 'forbidden', 'text/plain')
    const folder = url.searchParams.get('folder')
    if (folder) return validFolderPath(folder) ? json(res, 200, { items: await commandsFor(folder) }) : json(res, 400, { error: 'bad folder' })
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
  async '/api/skills'(url, res) {
    const [entries, installed] = await Promise.all([indexedEntries(), installedSkills()])
    return json(res, 200, {
      skills: aggregateSkills(entries, installed),
      indexed: { done: indexStatus.done, total: indexStatus.total, running: indexStatus.running },
    })
  },
  async '/api/skill'(url, res) {
    const key = (url.searchParams.get('key') ?? '').slice(0, 400)
    const skill = (await installedSkills()).find((item) => item.key === key)
    return skill ? json(res, 200, await skillDetail(skill)) : json(res, 404, { error: 'skill not found' })
  },
  async '/api/limits'(url, res) {
    return json(res, 200, await readLimits())
  },
  async '/api/repo-status'(url, res) {
    return json(res, 200, await readRepoStatus({ force: url.searchParams.has('force') }))
  },
  async '/api/usage'(url, res) {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 120)
    return json(res, 200, aggregateUsage(await indexedEntries(), days))
  },
}

const readLimits = createLimitsReader()
const REPO_DIR = fileURLToPath(new URL('./', import.meta.url))
const readRepoStatus = createRepoStatusReader({ cwd: REPO_DIR })
const commitAndPushRepo = createRepoPusher({ cwd: REPO_DIR })
const pullRepo = createRepoPuller({ cwd: REPO_DIR })

installCrashGuard()
await loadStores()
await manager.adoptSavedRuns().catch((error) => console.error(`adopting runs: ${describeError(error)}`))
pruneUploads()
pruneRunLogs().catch((error) => console.error(`pruning run logs: ${describeError(error)}`))
setInterval(tick, 2000)
warmIndex()
setInterval(warmIndex, 60_000)
setInterval(() => kickIdleBabysits().catch((error) => console.error(`babysit watchdog: ${describeError(error)}`)), 60_000)

async function login(req, res) {
  const who = clientKey(req.headers, req.socket)
  if (loginLimiter.blocked(who)) return json(res, 429, { error: 'Too many attempts. Try again later.' })
  const body = await readBody(req)
  if (typeof body.token !== 'string' || !safeEqual(body.token, remote.token)) {
    loginLimiter.fail(who)
    return json(res, 401, { error: 'Wrong token.' })
  }
  loginLimiter.reset(who)
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': sessionCookie(remote.token) })
  res.end('{"ok":true}')
}

createServer(async (req, res) => {
  const host = (req.headers.host ?? '').toLowerCase()
  const viaTunnel = REMOTE_HOSTS.has(host)
  if (!ALLOWED_HOSTS.has(host) && !viaTunnel) return send(res, 403, 'forbidden', 'text/plain')
  const url = new URL(req.url, `http://${host}`)
  try {
    if (viaTunnel && !isAuthed(req.headers.cookie, remote.token) && !PUBLIC_ASSETS.has(url.pathname)) {
      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (!ALLOWED_ORIGINS.has(req.headers.origin ?? '')) return send(res, 403, 'forbidden', 'text/plain')
        return await login(req, res)
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return send(res, 401, LOGIN_PAGE, 'text/html; charset=utf-8')
      return json(res, 401, { error: 'Login required.' })
    }
    if (req.method === 'POST') {
      if (!ALLOWED_ORIGINS.has(req.headers.origin ?? '')) return send(res, 403, 'forbidden', 'text/plain')
      if (url.pathname === '/api/upload') return await saveUpload(req, res, url)
      const route = postRoutes[url.pathname]
      if (!route) return send(res, 404, 'not found', 'text/plain')
      const body = await readBody(req)
      if (isTrackedRoute(url.pathname)) {
        const shown = chipsShown.get(body?.id) ?? null
        recordWhenSent(res, (status) => {
          logAction(actionFrom({ route: url.pathname, body, status, userAgent: req.headers['user-agent'], now: Date.now(), shown }))
          if (shown && status < 400 && (url.pathname === '/api/prompt' || url.pathname === '/api/queue')) chipsShown.delete(body.id)
        })
      }
      return await route(body, res)
    }
    if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain')
    if (url.pathname === '/api/upload') return await serveUpload(res, url)
    const route = getRoutes[url.pathname]
    if (route) return await route(url, res, req)
    return await serveStatic(res, url.pathname)
  } catch (error) {
    if (res.headersSent) {
      console.error(`${req.method} ${url.pathname} failed after the response started: ${describeError(error)}`)
      return res.destroy()
    }
    if (error instanceof BodyTooLargeError) return json(res, 413, { error: error.message })
    if (error instanceof BadBodyError) {
      console.error(`bad request body on ${url.pathname}: ${describeError(error.cause)}`)
      return json(res, 400, { error: error.message })
    }
    console.error(`${req.method} ${url.pathname}: ${describeError(error)}`)
    return send(res, 500, 'internal error', 'text/plain')
  }
}).listen(PORT, HOST, () => console.log(`Claude session board on http://localhost:${PORT}`))
