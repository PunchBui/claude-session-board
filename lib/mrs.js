import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeSearchDirs } from './claudebin.js'

export const GITLAB_HOST = process.env.GITLAB_HOST ?? ''

const GLAB_TIMEOUT_MS = 20_000
const STALE_MS = 3 * 24 * 60 * 60_000
const PAGE_SIZE = 50
const MERGED_PAGE_SIZE = 20
const MERGED_WINDOW_MS = 7 * 24 * 60 * 60_000
const READY_LABEL = /^ready to (merge|deploy)$/i
const REVIEW_LABEL = /^ready (for|to) review$/i
export const READY_LABEL_NAME = 'Ready to merge'
export const REVIEW_LABEL_NAME = 'Ready for review'
export const ADDABLE_LABELS = [READY_LABEL_NAME, REVIEW_LABEL_NAME]

const FIELDS = `
  iid reference title webUrl draft createdAt updatedAt mergedAt
  sourceBranch targetBranch conflicts detailedMergeStatus approved userNotesCount resolvableDiscussionsCount resolvedDiscussionsCount
  author { username name }
  reviewers { nodes { username name } }
  approvedBy { nodes { username } }
  headPipeline { id status }
  labels { nodes { title } }
  autoMergeEnabled
  project { fullPath }
`

const MERGED_FIELDS = `
  iid reference title webUrl draft createdAt updatedAt mergedAt
  sourceBranch targetBranch userNotesCount resolvableDiscussionsCount resolvedDiscussionsCount
  author { username name }
  reviewers { nodes { username name } }
  headPipeline { id status }
  project { fullPath }
`

const buildQuery = (now) => {
  const since = new Date(now - MERGED_WINDOW_MS).toISOString()
  const merged = `state: merged, first: ${MERGED_PAGE_SIZE}, sort: MERGED_AT_DESC, mergedAfter: "${since}"`
  return `
query {
  currentUser {
    username
    authoredMergeRequests(state: opened, first: ${PAGE_SIZE}, sort: UPDATED_DESC) { nodes { ${FIELDS} } }
    reviewRequestedMergeRequests(state: opened, first: ${PAGE_SIZE}, sort: UPDATED_DESC) { nodes { ${FIELDS} } }
    mergedAuthored: authoredMergeRequests(${merged}) { nodes { ${MERGED_FIELDS} } }
    mergedReviewing: reviewRequestedMergeRequests(${merged}) { nodes { ${MERGED_FIELDS} } }
  }
}`
}

const isExecutable = (path) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveGlabBin({ pathEnv = process.env.PATH ?? '', home = homedir(), exists = isExecutable } = {}) {
  for (const dir of claudeSearchDirs({ pathEnv, home })) {
    const candidate = join(dir, 'glab')
    if (exists(candidate)) return candidate
  }
  return 'glab'
}

export function glab(args) {
  return new Promise((resolve, reject) => {
    execFile(resolveGlabBin(), args, { timeout: GLAB_TIMEOUT_MS, maxBuffer: 16_000_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split('\n')[0]))
      else resolve(stdout)
    })
  })
}

const onConfiguredHost = (url) => {
  try {
    return new URL(url).hostname === GITLAB_HOST
  } catch {
    return false
  }
}

export function normalizeMr(node, me) {
  const reviewers = node.reviewers?.nodes?.map((user) => user.username) ?? []
  const reviewerNames = Object.fromEntries((node.reviewers?.nodes ?? []).map((user) => [user.username, user.name || user.username]))
  const approvedBy = node.approvedBy?.nodes?.map((user) => user.username) ?? []
  const labels = (node.labels?.nodes ?? []).map((label) => label.title)
  const project = node.project?.fullPath ?? ''
  return {
    url: node.webUrl,
    ref: `${project}${node.reference}`,
    project,
    title: node.title,
    draft: Boolean(node.draft),
    author: node.author?.username ?? '',
    authorName: node.author?.name ?? '',
    reviewers,
    reviewerNames,
    approvedBy,
    approvedByMe: approvedBy.includes(me),
    pipeline: node.headPipeline?.status?.toLowerCase() ?? null,
    pipelineId: node.headPipeline?.id ?? null,
    labels,
    readyLabel: labels.find((title) => READY_LABEL.test(title)) ?? null,
    reviewLabel: labels.find((title) => REVIEW_LABEL.test(title)) ?? null,
    autoMerge: Boolean(node.autoMergeEnabled),
    conflicts: Boolean(node.conflicts) || String(node.detailedMergeStatus ?? '').toLowerCase() === 'conflict',
    mergeStatus: String(node.detailedMergeStatus ?? '').toLowerCase(),
    approved: Boolean(node.approved),
    notes: node.userNotesCount ?? 0,
    unresolved: Math.max(0, (node.resolvableDiscussionsCount ?? 0) - (node.resolvedDiscussionsCount ?? 0)),
    source: node.sourceBranch,
    target: node.targetBranch,
    createdAt: Date.parse(node.createdAt),
    updatedAt: Date.parse(node.updatedAt),
    mergedAt: node.mergedAt ? Date.parse(node.mergedAt) : null,
  }
}

export function verdictOf(mr, role, now) {
  if (mr.mergedAt) return { code: 'merged', label: 'Merged', tone: 'dim', rank: 7 }
  const idle = now - mr.updatedAt
  if (role === 'reviewing') {
    if (mr.approvedByMe) return { code: 'approved', label: 'You approved', tone: 'good', rank: 4 }
    if (mr.draft) return { code: 'draft', label: 'Draft', tone: 'dim', rank: 5 }
    return { code: 'needs-review', label: 'Needs your review', tone: 'warn', rank: 0 }
  }
  if (mr.pipeline === 'failed') return { code: 'ci-failed', label: 'CI failed', tone: 'bad', rank: 0 }
  if (mr.conflicts) return { code: 'conflicts', label: 'Has conflicts', tone: 'bad', rank: 1 }
  if (mr.mergeStatus === 'discussions_not_resolved') return { code: 'threads', label: 'Unresolved threads', tone: 'warn', rank: 2 }
  if (mr.draft) return { code: 'draft', label: 'Draft', tone: 'dim', rank: 6 }
  const ciActive = mr.pipeline === 'running' || mr.pipeline === 'pending' || mr.pipeline === 'created'
  if ((mr.readyLabel || mr.autoMerge) && ciActive) return { code: 'merge-ci-running', label: 'Merge CI running', tone: 'info', rank: 5 }
  if (mr.readyLabel) return { code: 'ready', label: mr.readyLabel, tone: 'good', rank: 3 }
  if (mr.approved && mr.pipeline !== 'running' && mr.pipeline !== 'pending') return { code: 'approved', label: 'Approved', tone: 'good', rank: 3 }
  if (mr.pipeline === 'running' || mr.pipeline === 'pending' || mr.pipeline === 'created') return { code: 'ci-running', label: 'CI running', tone: 'info', rank: 5 }
  if (!mr.reviewers.length && mr.reviewLabel) return { code: 'review-requested', label: mr.reviewLabel, tone: 'info', rank: 4 }
  if (!mr.reviewers.length) return { code: 'no-reviewer', label: 'No reviewer', tone: 'warn', rank: 4 }
  if (idle > STALE_MS) return { code: 'stale', label: 'Stale', tone: 'warn', rank: 4 }
  return { code: 'waiting', label: 'Waiting on review', tone: 'info', rank: 5 }
}

export function needsAction(verdict) {
  return verdict.tone === 'bad' || verdict.tone === 'warn' || verdict.code === 'ready' || verdict.code === 'approved'
}

export function withLabel(mr, label, now) {
  const labels = mr.labels.includes(label) ? mr.labels : [...mr.labels, label]
  const next = {
    ...mr,
    labels,
    readyLabel: labels.find((title) => READY_LABEL.test(title)) ?? null,
    reviewLabel: labels.find((title) => REVIEW_LABEL.test(title)) ?? null,
  }
  const verdict = verdictOf(next, 'authored', now)
  return { ...next, verdict, actionable: needsAction(verdict) }
}

function shape(nodes, role, me, now) {
  return nodes
    .filter((node) => onConfiguredHost(node.webUrl))
    .map((node) => {
      const mr = normalizeMr(node, me)
      const verdict = verdictOf(mr, role, now)
      return { ...mr, verdict, actionable: needsAction(verdict) }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadMergeRequests({ run = glab, now = Date.now() } = {}) {
  if (!GITLAB_HOST) throw new Error('set GITLAB_HOST to your GitLab hostname to list merge requests')
  const out = await run(['api', '--hostname', GITLAB_HOST, 'graphql', '-f', `query=${buildQuery(now)}`])
  const parsed = JSON.parse(out)
  if (parsed.errors?.length) throw new Error(parsed.errors[0].message)
  const user = parsed.data?.currentUser
  if (!user) throw new Error(`not signed in to ${GITLAB_HOST}`)
  const authored = shape(user.authoredMergeRequests?.nodes ?? [], 'authored', user.username, now)
  const reviewing = shape(user.reviewRequestedMergeRequests?.nodes ?? [], 'reviewing', user.username, now)
  const ownMerged = shape(user.mergedAuthored?.nodes ?? [], 'authored', user.username, now).map((mr) => ({ ...mr, role: 'authored' }))
  const ownUrls = new Set(ownMerged.map((mr) => mr.url))
  const reviewedMerged = shape(user.mergedReviewing?.nodes ?? [], 'reviewing', user.username, now)
    .filter((mr) => !ownUrls.has(mr.url))
    .map((mr) => ({ ...mr, role: 'reviewing' }))
  return {
    host: GITLAB_HOST,
    me: user.username,
    fetchedAt: now,
    authored,
    reviewing,
    merged: [...ownMerged, ...reviewedMerged].sort((a, b) => b.mergedAt - a.mergedAt),
    actionable: authored.filter((mr) => mr.actionable).length + reviewing.filter((mr) => mr.actionable).length,
  }
}

const MR_URL = new RegExp(`^https://${GITLAB_HOST.replaceAll('.', '\\.')}/.+/-/merge_requests/\\d+$`)
export const MAX_FOCUSED = 200

async function readyLabelsFor(project, run) {
  try {
    const out = await run(['api', '--hostname', GITLAB_HOST, `projects/${encodeURIComponent(project)}/labels?search=ready&per_page=100`])
    const names = JSON.parse(out).map((label) => label.name).filter((name) => READY_LABEL.test(name))
    return [READY_LABEL_NAME, ...names.filter((name) => name !== READY_LABEL_NAME)]
  } catch {
    return [READY_LABEL_NAME]
  }
}

export async function addLabel(url, label, run = glab) {
  if (!isMrUrl(url)) throw new Error('not a merge request url')
  if (!ADDABLE_LABELS.includes(label)) throw new Error('label not allowed')
  const [, project, iid] = new URL(url).pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)$/)
  const labels = label === READY_LABEL_NAME ? await readyLabelsFor(project, run) : [label]
  await run(['mr', 'update', iid, ...labels.flatMap((name) => ['--label', name]), '--repo', `${GITLAB_HOST}/${project}`])
  return labels
}

export const isMrUrl = (value) => typeof value === 'string' && value.length <= 400 && MR_URL.test(value)

export function toggleFocus(urls, url, focused) {
  const rest = urls.filter((existing) => existing !== url)
  return focused ? [...rest, url].slice(-MAX_FOCUSED) : rest
}

export const MAX_SEEN = 1000

export function autoFocusNew(data, { urls, seen }) {
  if (data.error || !data.me) return { urls, seen, changed: false }
  const current = [...data.authored, ...data.reviewing].map((mr) => mr.url)
  if (!seen) return { urls, seen: current.slice(-MAX_SEEN), changed: true }
  const known = new Set(seen)
  const fresh = [...new Set(current.filter((url) => !known.has(url)))]
  if (!fresh.length) return { urls, seen, changed: false }
  return {
    urls: fresh.reduce((acc, url) => toggleFocus(acc, url, true), urls),
    seen: [...seen, ...fresh].slice(-MAX_SEEN),
    changed: true,
  }
}

export function withFocus(data, urls) {
  const focused = new Set(urls)
  const mark = (mrs) => mrs.map((mr) => ({ ...mr, focused: focused.has(mr.url) }))
  return { ...data, authored: mark(data.authored), reviewing: mark(data.reviewing), merged: mark(data.merged ?? []) }
}

export const MAX_PINGS = 500
export const pingKey = (url, reviewer) => `${url}|${reviewer}`

export function recordPing(pings, url, reviewer, at) {
  const entries = Object.entries({ ...pings, [pingKey(url, reviewer)]: at }).sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, MAX_PINGS))
}

export function withPings(data, pings) {
  const mark = (mrs) => mrs.map((mr) => ({
    ...mr,
    pinged: Object.fromEntries((mr.reviewers ?? []).map((name) => [name, pings[pingKey(mr.url, name)]]).filter(([, at]) => at)),
  }))
  return { ...data, authored: mark(data.authored), reviewing: mark(data.reviewing), merged: mark(data.merged ?? []) }
}

export function withSessions(data, linked) {
  const latestFirst = (sessions = []) => [...sessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  const attach = (mrs) => mrs.map((mr) => ({ ...mr, sessions: latestFirst(linked.get(mr.url)) }))
  return { ...data, authored: attach(data.authored), reviewing: attach(data.reviewing), merged: attach(data.merged ?? []) }
}

export function createMrCache({ load = loadMergeRequests, ttlMs = 60_000, now = Date.now } = {}) {
  let cached = null
  let inflight = null
  async function get({ force = false } = {}) {
    if (cached && !force && now() - cached.at < ttlMs) return cached.data
    inflight ??= load({ now: now() })
      .then((data) => {
        cached = { at: now(), data }
        return data
      })
      .catch((error) => {
        if (cached) return { ...cached.data, error: error.message }
        return { host: GITLAB_HOST, me: null, fetchedAt: now(), authored: [], reviewing: [], merged: [], actionable: 0, error: error.message }
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
  get.patchAuthored = (url, patch) => {
    if (!cached) return null
    let found = null
    const authored = cached.data.authored.map((mr) => {
      if (mr.url !== url) return mr
      found = patch(mr)
      return found
    })
    if (!found) return null
    const reviewing = cached.data.reviewing
    const actionable = authored.filter((mr) => mr.actionable).length + reviewing.filter((mr) => mr.actionable).length
    cached = { ...cached, data: { ...cached.data, authored, actionable } }
    return found
  }
  return get
}
