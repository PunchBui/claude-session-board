import { randomUUID } from 'node:crypto'
import { validFolderPath, parseSessionOptions } from './boardsessions.js'

export const MAX_WATCHES = 30
export const KINDS = new Set(['slack-thread', 'deploy', 'custom'])
export const MIN_EVERY_MIN = 5
export const MAX_EVERY_MIN = 120
export const DEFAULT_EVERY_MIN = 10
export const DEFAULT_DAYS = 7
export const MAX_DAYS = 30
export const MAX_TARGET_CHARS = 1000
export const MAX_NOTE_CHARS = 300
const SLACK_THREAD = /^https:\/\/[A-Za-z0-9.-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d{6,}/
const MR_URL = /^https:\/\/[A-Za-z0-9.-]+\/.+\/-\/merge_requests\/\d+/
export const CHECKS_PER_SESSION = 12

const KIND_LABEL = { 'slack-thread': 'Slack thread', deploy: 'Deploy', custom: 'Condition' }

export const kindLabel = (kind) => KIND_LABEL[kind] ?? kind

function checkTarget(kind, target) {
  if (kind === 'slack-thread') return SLACK_THREAD.test(target) ? null : 'Use the link of a Slack thread (a message link).'
  if (kind === 'deploy') return MR_URL.test(target) ? null : 'Use the link of a merge request.'
  return target.length >= 8 ? null : 'Describe what to wait for in a sentence.'
}

function titleOf(kind, target) {
  if (kind === 'custom') return target.replace(/\s+/g, ' ').slice(0, 60)
  const tail = target.split('/').filter(Boolean).slice(-2).join('/')
  return `${kindLabel(kind)} ${tail}`.slice(0, 80)
}

export function parseWatchInput(body, { now = Date.now() } = {}) {
  const kind = body?.kind
  if (!KINDS.has(kind)) return { error: 'Pick what to watch.' }
  const target = String(body?.target ?? '').trim().slice(0, MAX_TARGET_CHARS)
  const problem = checkTarget(kind, target)
  if (problem) return { error: problem }
  if (!validFolderPath(body?.folder)) return { error: 'Use the absolute path of a project folder, like /Users/you/project.' }
  const everyMin = Number(body?.everyMin ?? DEFAULT_EVERY_MIN)
  if (!Number.isInteger(everyMin) || everyMin < MIN_EVERY_MIN || everyMin > MAX_EVERY_MIN) return { error: `Check every ${MIN_EVERY_MIN} to ${MAX_EVERY_MIN} minutes.` }
  const days = Number(body?.days ?? DEFAULT_DAYS)
  if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) return { error: `Stop after 1 to ${MAX_DAYS} days.` }
  const options = parseSessionOptions(body)
  if (options.error) return { error: options.error }
  return {
    watch: {
      wid: randomUUID(), kind, target, name: titleOf(kind, target), folder: body.folder, everyMin,
      model: options.model, effort: options.effort, permissionMode: options.permissionMode, chrome: options.chrome,
      state: 'watching', createdAt: now, expiresAt: now + Math.round(days * 86_400_000), nextAt: now,
      lastCheckedAt: null, lastNote: null, checks: 0, sessionId: null, doneAt: null,
    },
  }
}

export const isWatchDue = (watch, now) => watch.state === 'watching' && watch.nextAt <= now

export function watchPrompt(watch, { origin, since = null }) {
  const sinceText = since ? new Date(since).toISOString() : 'the start of this watch'
  const report = (state, note) => `curl -s -X POST ${origin}/api/watches/report -H 'content-type: application/json' -H 'origin: ${origin}' -d '{"wid":"${watch.wid}","state":"${state}","note":"${note}"}'`
  const ask = {
    'slack-thread': `Check the Slack thread ${watch.target} for replies written by a person since ${sinceText}. Read only that thread with the Slack tools. Ignore messages from bots, apps and assistants. Done means at least one person has replied; the note is a one-line summary of the reply.`,
    deploy: `Find out whether the merge request ${watch.target} has been deployed to production. Read only: look at the merge pipeline on the target branch and its deploy jobs. Done means the deploy finished, failed or was skipped for good; the note says which job and its result. Waiting means a deploy job is still pending, running or manual and not started.`,
    custom: `Check this condition: ${watch.target}. Use whatever read-only tools you need. Done means the condition is true; the note says what you found.`,
  }[watch.kind]
  return [
    `Board watch: ${watch.name}. Check ${watch.checks + 1}, repeated every ${watch.everyMin} minutes.`,
    ask,
    'Never post, react, edit, merge, deploy or change anything. Keep your answer under five lines.',
    `When the condition is true, run:\n${report('done', '<one line>')}`,
    `When it is not true yet, run:\n${report('waiting', '<one line on what you saw>')}`,
    'If the board is not running (connection refused), say so once and stop.',
  ].join('\n\n')
}

export function afterCheck(watch, { sessionId = null }, now) {
  const expired = now >= watch.expiresAt
  return {
    ...watch,
    sessionId: sessionId ?? watch.sessionId,
    checks: watch.checks + 1,
    lastCheckedAt: now,
    nextAt: now + watch.everyMin * 60_000,
    state: expired ? 'expired' : watch.state,
  }
}

export function applyReport(watch, report, now) {
  const note = String(report?.note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS) || null
  if (!['done', 'waiting'].includes(report?.state)) return { error: 'State must be done or waiting.' }
  if (watch.state !== 'watching') return { watch }
  if (report.state === 'done') return { watch: { ...watch, state: 'done', doneAt: now, lastNote: note } }
  return { watch: { ...watch, lastNote: note } }
}

export function toggled(watch, enabled, now) {
  if (enabled) return watch.state === 'paused' || watch.state === 'expired' ? { ...watch, state: 'watching', nextAt: now, expiresAt: Math.max(watch.expiresAt, now + 86_400_000) } : watch
  return watch.state === 'watching' ? { ...watch, state: 'paused' } : watch
}

export function parseWatchesFile(parsed) {
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  return items
    .filter((w) => w && typeof w.wid === 'string' && KINDS.has(w.kind) && typeof w.target === 'string' && validFolderPath(w.folder) && Number.isFinite(w.nextAt))
    .slice(0, MAX_WATCHES)
    .map((w) => ({ checks: 0, lastCheckedAt: null, lastNote: null, sessionId: null, doneAt: null, everyMin: DEFAULT_EVERY_MIN, name: titleOf(w.kind, w.target), ...w, state: ['watching', 'paused', 'done', 'expired'].includes(w.state) ? w.state : 'watching' }))
}

export const needsNewSession = (watch) => !watch.sessionId || watch.checks % CHECKS_PER_SESSION === 0

export const expireWatches = (watches, now) => watches.map((w) => (w.state === 'watching' && now >= w.expiresAt ? { ...w, state: 'expired' } : w))
