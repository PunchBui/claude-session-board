import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

// Sessions the board starts itself with `claude -p --session-id`. The desktop app never
// hears about them, so they are not in its session folder: the board keeps its own list and
// turns each entry into the same "raw session" shape it reads from the desktop's files.
export const BOARD_PREFIX = 'local_board-'
export const MAX_BOARD_SESSIONS = 200
export const MAX_TITLE_CHARS = 80
export const BAD_FOLDER_MESSAGE = 'Use the absolute path of an existing folder, like /Users/you/project.'

// What a board session can be started with, as `claude` flags. Model is an alias (opus,
// sonnet, ...) or a full model name; effort and permission mode are the CLI's own choices.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const PERMISSION_MODES = ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/

export const validModel = (model) => typeof model === 'string' && MODEL.test(model)
export const validEffort = (effort) => EFFORTS.includes(effort)
export const validPermissionMode = (mode) => PERMISSION_MODES.includes(mode)

// Checks the optional settings of a new session. Empty means "use the default".
export function parseSessionOptions(body) {
  const pick = (value) => (value === undefined || value === null || value === '' ? null : value)
  const model = pick(body?.model)
  const effort = pick(body?.effort)
  const permissionMode = pick(body?.permissionMode)
  const chrome = body?.chrome === 'on' || body?.chrome === true
  if (model !== null && !validModel(model)) return { error: 'That model name is not valid.' }
  if (effort !== null && !validEffort(effort)) return { error: `Effort must be one of ${EFFORTS.join(', ')}.` }
  if (permissionMode !== null && !validPermissionMode(permissionMode)) return { error: 'That permission mode is not valid.' }
  return { model, effort, permissionMode, chrome }
}

const CLI_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

export const isBoardId = (id) => typeof id === 'string' && id.startsWith(BOARD_PREFIX)

export function validFolderPath(folder) {
  return typeof folder === 'string' && folder.length <= 1024 && isAbsolute(folder) && !CONTROL.test(folder) && !folder.split('/').includes('..')
}

export function titleFrom(prompt) {
  const flat = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return '(untitled)'
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 1)}…` : flat
}

export function newBoardSession({ cwd, prompt, permissionMode, model = null, effort = null, chrome = false, now = Date.now, uuid = randomUUID }) {
  const cliSessionId = uuid()
  return {
    sessionId: `${BOARD_PREFIX}${cliSessionId}`,
    cliSessionId,
    cwd,
    createdAt: now(),
    title: titleFrom(prompt),
    permissionMode,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(chrome ? { chrome: true } : {}),
  }
}

export function validBoardEntry(entry) {
  return Boolean(entry)
    && typeof entry.cliSessionId === 'string' && CLI_ID.test(entry.cliSessionId)
    && entry.sessionId === `${BOARD_PREFIX}${entry.cliSessionId}`
    && validFolderPath(entry.cwd)
    && Number.isFinite(entry.createdAt)
    && (entry.model === undefined || validModel(entry.model))
    && (entry.effort === undefined || validEffort(entry.effort))
    && (entry.chrome === undefined || entry.chrome === true)
}

export function parseBoardFile(parsed) {
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  const seen = new Set()
  return items.filter((entry) => {
    if (!validBoardEntry(entry) || seen.has(entry.sessionId)) return false
    seen.add(entry.sessionId)
    return true
  })
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function resumeCommand(entry) {
  return `cd ${shellQuote(entry.cwd)} && claude --resume ${entry.cliSessionId}`
}

// The status the desktop app would have recorded, worked out from the board's own run.
export function boardStatus(run) {
  if (run?.state === 'running') return 'in_progress'
  if (run?.state === 'failed' || run?.state === 'stalled') return 'unknown'
  return 'completed'
}

export function boardRaw(entry, { lastActivityAt, run, title = null }) {
  return {
    sessionId: entry.sessionId,
    cliSessionId: entry.cliSessionId,
    cwd: entry.cwd,
    originCwd: entry.cwd,
    createdAt: entry.createdAt,
    lastActivityAt: lastActivityAt ?? entry.createdAt,
    title: title ?? entry.title,
    permissionMode: entry.permissionMode ?? null,
    model: entry.model ?? null,
    effort: entry.effort ?? null,
    chrome: entry.chrome === true,
    isArchived: false,
    source: 'board',
    resume: resumeCommand(entry),
    postTurnSummary: { status_category: boardStatus(run) },
  }
}

export function createBoardStore({ file, readJson, writeJson }) {
  let items = []
  const persist = () => writeJson(file, { items })
  return {
    async load() {
      items = parseBoardFile(await readJson(file, { items: [] }))
    },
    all: () => items,
    find: (id) => items.find((entry) => entry.sessionId === id) ?? null,
    async add(entry) {
      if (!validBoardEntry(entry)) throw new Error('invalid board session')
      if (items.length >= MAX_BOARD_SESSIONS) return false
      items = [...items, entry]
      await persist()
      return true
    },
    async retitle(id, title) {
      const entry = items.find((item) => item.sessionId === id)
      if (!entry || !title) return false
      items = items.map((item) => (item === entry ? { ...item, title } : item))
      await persist()
      return true
    },
  }
}
