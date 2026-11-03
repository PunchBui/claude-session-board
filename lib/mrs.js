import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeSearchDirs } from './claudebin.js'

export const GITLAB_HOST = 'gitlab.example.com'

const GLAB_TIMEOUT_MS = 20_000
const STALE_MS = 3 * 24 * 60 * 60_000
const PAGE_SIZE = 50

const FIELDS = `
  iid reference title webUrl draft createdAt updatedAt
  sourceBranch targetBranch conflicts detailedMergeStatus approved userNotesCount
  author { username name }
  reviewers { nodes { username name } }
  approvedBy { nodes { username } }
  headPipeline { status }
  project { fullPath }
`

const QUERY = `
query {
  currentUser {
    username
    authoredMergeRequests(state: opened, first: ${PAGE_SIZE}, sort: UPDATED_DESC) { nodes { ${FIELDS} } }
    reviewRequestedMergeRequests(state: opened, first: ${PAGE_SIZE}, sort: UPDATED_DESC) { nodes { ${FIELDS} } }
  }
}`

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
  const approvedBy = node.approvedBy?.nodes?.map((user) => user.username) ?? []
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
    approvedBy,
    approvedByMe: approvedBy.includes(me),
    pipeline: node.headPipeline?.status?.toLowerCase() ?? null,
    conflicts: Boolean(node.conflicts),
    mergeStatus: String(node.detailedMergeStatus ?? '').toLowerCase(),
    approved: Boolean(node.approved),
    notes: node.userNotesCount ?? 0,
    source: node.sourceBranch,
    target: node.targetBranch,
    createdAt: Date.parse(node.createdAt),
    updatedAt: Date.parse(node.updatedAt),
  }
}

export function verdictOf(mr, role, now) {
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
  if (mr.approved && mr.pipeline !== 'running' && mr.pipeline !== 'pending') return { code: 'ready', label: 'Ready to merge', tone: 'good', rank: 3 }
  if (mr.pipeline === 'running' || mr.pipeline === 'pending' || mr.pipeline === 'created') return { code: 'ci-running', label: 'CI running', tone: 'info', rank: 5 }
  if (!mr.reviewers.length) return { code: 'no-reviewer', label: 'No reviewer', tone: 'warn', rank: 4 }
  if (idle > STALE_MS) return { code: 'stale', label: 'Stale', tone: 'warn', rank: 4 }
  return { code: 'waiting', label: 'Waiting on review', tone: 'info', rank: 5 }
}

export function needsAction(verdict) {
  return verdict.tone === 'bad' || verdict.tone === 'warn' || verdict.code === 'ready'
}

function shape(nodes, role, me, now) {
  return nodes
    .filter((node) => onConfiguredHost(node.webUrl))
    .map((node) => {
      const mr = normalizeMr(node, me)
      const verdict = verdictOf(mr, role, now)
      return { ...mr, verdict, actionable: needsAction(verdict) }
    })
    .sort((a, b) => a.verdict.rank - b.verdict.rank || a.updatedAt - b.updatedAt)
}

export async function loadMergeRequests({ run = glab, now = Date.now() } = {}) {
  const out = await run(['api', '--hostname', GITLAB_HOST, 'graphql', '-f', `query=${QUERY}`])
  const parsed = JSON.parse(out)
  if (parsed.errors?.length) throw new Error(parsed.errors[0].message)
  const user = parsed.data?.currentUser
  if (!user) throw new Error(`not signed in to ${GITLAB_HOST}`)
  const authored = shape(user.authoredMergeRequests?.nodes ?? [], 'authored', user.username, now)
  const reviewing = shape(user.reviewRequestedMergeRequests?.nodes ?? [], 'reviewing', user.username, now)
  return {
    host: GITLAB_HOST,
    me: user.username,
    fetchedAt: now,
    authored,
    reviewing,
    actionable: authored.filter((mr) => mr.actionable).length + reviewing.filter((mr) => mr.actionable).length,
  }
}

export function withSessions(data, linked) {
  const attach = (mrs) => mrs.map((mr) => ({ ...mr, sessions: linked.get(mr.url) ?? [] }))
  return { ...data, authored: attach(data.authored), reviewing: attach(data.reviewing) }
}

export function createMrCache({ load = loadMergeRequests, ttlMs = 60_000, now = Date.now } = {}) {
  let cached = null
  let inflight = null
  return async function get({ force = false } = {}) {
    if (cached && !force && now() - cached.at < ttlMs) return cached.data
    inflight ??= load({ now: now() })
      .then((data) => {
        cached = { at: now(), data }
        return data
      })
      .catch((error) => {
        if (cached) return { ...cached.data, error: error.message }
        return { host: GITLAB_HOST, me: null, fetchedAt: now(), authored: [], reviewing: [], actionable: 0, error: error.message }
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}
