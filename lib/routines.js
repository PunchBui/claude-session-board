import { randomUUID } from 'node:crypto'
import { REPEATS, nextAfter } from './schedule.js'
import { validFolderPath, parseSessionOptions } from './boardsessions.js'

// A routine is a prompt plus a folder and a time. Each time it fires the board starts a
// brand new board-only session in that folder (the same thing New chat -> Start here does),
// so every run has its own conversation. `lastSessionId` points at the most recent one.
export const MAX_ROUTINES = 50
export const MAX_ROUTINE_PROMPT = 8000
export const MAX_NAME_CHARS = 80

export function parseRoutineInput(body, { now = Date.now(), validPrompt }) {
  const prompt = body?.prompt
  if (!validPrompt(prompt)) return { error: 'Write the prompt to run.' }
  if (!validFolderPath(body.folder)) return { error: 'Use the absolute path of a project folder, like /Users/you/project.' }
  const at = Number(body.at)
  if (!Number.isFinite(at) || at < now - 60_000 || at > now + 365 * 86_400_000) return { error: 'Pick a time in the future.' }
  const repeat = body.repeat ?? 'none'
  if (!REPEATS.has(repeat)) return { error: 'Bad repeat.' }
  const options = parseSessionOptions(body)
  if (options.error) return { error: options.error }
  const name = String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS) || prompt.replace(/\s+/g, ' ').trim().slice(0, 40)
  return {
    routine: {
      rid: randomUUID(), name, prompt: prompt.trim(), folder: body.folder, at: Math.max(at, now), repeat,
      model: options.model, effort: options.effort, permissionMode: options.permissionMode, chrome: options.chrome,
      enabled: true, createdAt: now, lastFiredAt: null, lastSessionId: null, lastError: null, runs: 0,
    },
  }
}

export const isDue = (routine, now) => routine.enabled && routine.at <= now

// Records the outcome of a firing and moves the routine to its next time. A one-off routine
// switches itself off after it fires; it stays in the list as a record.
export function afterFire(routine, { sessionId = null, error = null }, now) {
  const next = nextAfter(routine.at, routine.repeat, now)
  return {
    ...routine,
    at: next ?? routine.at,
    enabled: next !== null,
    lastFiredAt: now,
    lastSessionId: sessionId ?? routine.lastSessionId,
    lastError: error,
    runs: routine.runs + (sessionId ? 1 : 0),
  }
}

export function parseRoutinesFile(parsed) {
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  return items.filter((r) => r && typeof r.rid === 'string' && typeof r.prompt === 'string' && validFolderPath(r.folder) && Number.isFinite(r.at) && REPEATS.has(r.repeat))
    .slice(0, MAX_ROUTINES)
    .map((r) => ({ lastFiredAt: null, lastSessionId: null, lastError: null, runs: 0, createdAt: r.at, name: r.prompt.slice(0, 40), ...r, enabled: r.enabled !== false }))
}

// An edit replaces what the user can change and keeps the history. Saving puts the routine
// back on, because a new time is a request to run it.
export function applyEdit(existing, edited) {
  const { rid, createdAt, enabled, lastFiredAt, lastSessionId, lastError, runs, ...changes } = edited
  return { ...existing, ...changes, enabled: true }
}
