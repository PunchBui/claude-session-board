import { SESSION_ID } from './boardsessions.js'

export const MAX_CLOSED = 1000
const QUESTION_CHARS = 160

export function sideChatParent(raw) {
  const spawned = raw?.spawnedFrom
  if (spawned?.sideSession === true && typeof spawned.sessionId === 'string' && SESSION_ID.test(spawned.sessionId)) return spawned.sessionId
  return typeof raw?.sideChatOf === 'string' && SESSION_ID.test(raw.sideChatOf) ? raw.sideChatOf : null
}

export const isSideChat = (raw) => sideChatParent(raw) !== null

export const forkedAt = (raw) => (raw?.forkFrom && Number.isFinite(raw.createdAt) ? raw.createdAt : null)

export const ownChat = (chat, since = null) => (chat ?? []).filter((item) => !item.inherited && (since === null || !(Date.parse(item.at) < since)))

export function sideChatTitle(title) {
  const stripped = String(title ?? '').replace(/^btw:\s*/i, '').trim()
  return stripped && stripped !== 'Side chat' ? stripped : null
}

export function firstQuestion(chat, since = null) {
  const first = ownChat(chat, since).find((item) => item.role === 'user')
  const flat = first?.text?.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > QUESTION_CHARS ? `${flat.slice(0, QUESTION_CHARS - 1)}…` : flat
}

export function parseClosedFile(parsed) {
  const ids = Array.isArray(parsed?.closed) ? parsed.closed : []
  return [...new Set(ids.filter((id) => typeof id === 'string' && SESSION_ID.test(id)))].slice(-MAX_CLOSED)
}

export function setClosed(ids, id, closed) {
  const rest = ids.filter((existing) => existing !== id)
  return closed ? [...rest, id].slice(-MAX_CLOSED) : rest
}

export function countOpenSideChats(summaries, closed = []) {
  const shut = new Set(closed)
  const counts = new Map()
  for (const s of summaries) {
    if (!s.sideChatOf || s.archived || shut.has(s.id)) continue
    counts.set(s.sideChatOf, (counts.get(s.sideChatOf) ?? 0) + 1)
  }
  return counts
}

export function sideChatRow(summary, { parent = null, question = null, closed = false, running = false } = {}) {
  return {
    id: summary.id,
    parentId: summary.sideChatOf,
    parentTitle: parent?.title ?? null,
    title: question ?? sideChatTitle(summary.title) ?? 'Side chat',
    project: summary.project,
    cwd: summary.cwd,
    source: summary.source,
    status: summary.status,
    createdAt: summary.createdAt,
    lastActivityAt: summary.lastActivityAt,
    closed: closed || summary.archived,
    running,
  }
}
