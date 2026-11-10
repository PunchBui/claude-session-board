import { warmthOf } from './warmth.js'
import { ago, spanLabel } from './loops.js'

export const FILTERS = {
  all: () => true,
  merged: (mr) => Boolean(mr.mergedAt),
  authored: (mr) => mr.role === 'authored',
  reviewing: (mr) => mr.role === 'reviewing',
  action: (mr) => mr.actionable,
  focus: (mr) => mr.focused,
}

const MEANING = {
  hot: 'Something happened on this MR within the last hour.',
  warm: 'Something happened on this MR within the last day.',
  cooling: 'No activity for over a day. It may be getting forgotten.',
  cold: 'No activity for over a week. Nudge it, merge it or close it.',
}

export const mrTemperature = (mr, now = Date.now()) => warmthOf({ lastPromptAt: mr.updatedAt }, now)

export function mergeMrs(data) {
  const own = new Set(data.authored.map((mr) => mr.url))
  return [
    ...data.authored.map((mr) => ({ ...mr, role: 'authored' })),
    ...data.reviewing.filter((mr) => !own.has(mr.url)).map((mr) => ({ ...mr, role: 'reviewing' })),
    ...(data.merged ?? []),
  ]
}

export function orderMrs(list) {
  return [...list].sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)) || b.updatedAt - a.updatedAt)
}

export function visibleMrs(all, { filter = 'all', temp = null, now = Date.now() } = {}) {
  const match = FILTERS[filter] ?? FILTERS.all
  return orderMrs(all.filter((mr) => match(mr) && (!temp || mrTemperature(mr, now).group === temp)))
}

export function tempCounts(all, now = Date.now()) {
  const counts = { warm: 0, cool: 0 }
  for (const mr of all) counts[mrTemperature(mr, now).group] += 1
  return counts
}

export const fixOffered = (mr) => !mr.mergedAt && Boolean(mr.folder)

export function startOutcome(result) {
  if (!result.ok) return { label: 'Retry', title: result.data?.error ?? 'Could not start a session', disabled: false, record: false }
  return { label: 'Started', title: 'Started in a new session, now in your Focus list', disabled: true, record: true }
}

export function mrWarmthTip(mr, warmth, now = Date.now()) {
  return {
    heading: warmth.label,
    text: MEANING[warmth.tier],
    rows: [['Last activity', ago(mr.updatedAt, now)], ['Warm', 'Hot under 1h, Warm under 1 day'], ['Cool', 'Cooling under 7 days, Cold after']],
  }
}

export const BABYSIT_STALL_MS = 30 * 60_000
const BABYSIT_ACTIVE = new Set(['starting', 'watching', 'fixing', 'in-review'])

const BABYSIT_VIEWS = {
  starting: { label: 'Babysit starting', tone: 'info' },
  watching: { label: 'Watching CI', tone: 'info' },
  fixing: { label: 'Fixing CI', tone: 'warn' },
  'in-review': { label: 'Waiting for approval', tone: 'info' },
  'ready-to-merge': { label: 'Marked ready to merge', tone: 'good' },
  'needs-you': { label: 'Needs you', tone: 'bad' },
  stopped: { label: 'Babysit stopped', tone: 'dim' },
  merged: { label: 'Merged', tone: 'good' },
}

export function babysitView(entry, now = Date.now()) {
  if (!entry) return null
  const view = BABYSIT_VIEWS[entry.state] ?? { label: entry.state, tone: 'dim' }
  const stalled = BABYSIT_ACTIVE.has(entry.state) && now - entry.at > BABYSIT_STALL_MS
  const attempts = entry.state === 'fixing' && entry.attempts ? ` (${entry.attempts}/3)` : ''
  return {
    label: stalled ? 'Babysit stalled' : `${view.label}${attempts}`,
    tone: stalled ? 'warn' : view.tone,
    stalled,
    active: BABYSIT_ACTIVE.has(entry.state) && !stalled,
    note: stalled ? `No update for ${spanLabel(now - entry.at)}. ${entry.note}`.trim() : entry.note,
  }
}

export const babysitOffered = (mr, now = Date.now()) =>
  mr.role === 'authored' && fixOffered(mr) && !babysitView(mr.babysit, now)?.active && mr.babysit?.state !== 'merged'

export const folderName = (mr) => mr.folder?.split('/').filter(Boolean).pop() ?? ''

export const babysitFocusId = (mr) => (mr.mergedAt ? null : mr.babysit?.sessionId ?? null)

export const babysitStoppable = (mr) => !mr.mergedAt && BABYSIT_ACTIVE.has(mr.babysit?.state)

export const DEPLOY_STALL_MS = 15 * 60_000

const DEPLOY_VIEWS = {
  checking: { label: 'Checking deploy', tone: 'info' },
  live: { label: 'Deployed', tone: 'good' },
  deploying: { label: 'Deploying', tone: 'info' },
  waiting: { label: 'Deploy waiting', tone: 'warn' },
  failed: { label: 'Deploy failed', tone: 'bad' },
  unknown: { label: 'Deploy unknown', tone: 'dim' },
}

export function deployView(entry, now = Date.now()) {
  if (!entry) return null
  const view = DEPLOY_VIEWS[entry.state] ?? { label: entry.state, tone: 'dim' }
  const stalled = entry.state === 'checking' && now - entry.at > DEPLOY_STALL_MS
  return {
    label: stalled ? 'Check stalled' : view.label,
    tone: stalled ? 'warn' : view.tone,
    active: entry.state === 'checking' && !stalled,
    stalled,
    note: stalled ? `No result for ${spanLabel(now - entry.at)}. ${entry.note}`.trim() : entry.note,
    checkedAt: entry.at,
  }
}

export const deployOffered = (mr, now = Date.now()) =>
  mr.role === 'authored' && Boolean(mr.mergedAt) && Boolean(mr.folder) && !deployView(mr.deploy, now)?.active

export const deployFocusId = (mr) => mr.deploy?.sessionId ?? null

export const MRS_POLL_MS = 60_000

export function refreshStatus({ fetchedAt, at, loading, autoOff }, now, format) {
  const updated = `updated ${format(fetchedAt)} (${spanLabel(now - fetchedAt)} ago)`
  if (loading) return `${updated} · refreshing now`
  if (autoOff) return `${updated} · auto refresh off`
  const remaining = at + MRS_POLL_MS - now
  return `${updated} · ${remaining > 0 ? `next refresh in ${spanLabel(remaining)}` : 'next refresh due'}`
}
