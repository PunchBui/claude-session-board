import { TICKET, TICKET_IGNORE } from './scan.js'
import { threadUrl, channelUrl, tsToMs } from './slack.js'

export const STEP_IDS = ['created', 'sprint', 'progress', 'mr', 'review', 'approved', 'merged', 'deployed', 'experiment', 'done']
export const MILESTONE_STEPS = STEP_IDS.filter((step) => step !== 'created')
export const DEFAULT_REVIEW_STATUS = /review|merge/i
export const LOOSE_SESSION_DAYS = 7
export const MAX_LOOSE = 10
export const MAX_NOTE = 200
export const MAX_MILESTONES = 2000
const MENTION_MIN = 2
const MENTION_TOP = 3
const MR_STEPS = ['mr', 'review', 'approved', 'merged', 'deployed']

export function ticketKeys(text) {
  const keys = []
  for (const key of String(text ?? '').match(TICKET) ?? []) {
    if (TICKET_IGNORE.has(key.split('-')[0]) || keys.includes(key)) continue
    keys.push(key)
  }
  return keys
}

export const branchKeys = (branch) => ticketKeys(String(branch ?? '').toUpperCase())

export function reviewPattern(value) {
  if (!value) return DEFAULT_REVIEW_STATUS
  try {
    return new RegExp(value, 'i')
  } catch {
    return DEFAULT_REVIEW_STATUS
  }
}

const shortRef = (mr) => `!${mr.ref?.split('!').pop() ?? ''}`
const urlRef = (url) => {
  const iid = String(url).split('/merge_requests/')[1]
  return iid ? `!${iid}` : url
}

function sprintStep(issue) {
  const added = issue.sprintChanges.find((change) => change.to.trim())
  const starts = issue.sprints.map((sprint) => sprint.startAt).filter(Boolean)
  if (added) {
    const name = added.to.split(',').map((part) => part.trim()).find((part) => !added.from.includes(part)) ?? added.to.trim()
    const start = issue.sprints.find((sprint) => sprint.name === name)?.startAt
    return { at: start && start > added.at ? start : added.at, source: 'jira', note: start && start > added.at ? `Added on ${new Date(added.at).toISOString().slice(0, 10)}, before ${name} started.` : null }
  }
  if (issue.sprints.length && starts.length) {
    const first = Math.min(...starts)
    return { at: Math.max(issue.createdAt, first), source: 'jira', note: 'Created inside a sprint.' }
  }
  return null
}

function carriedOver(issue) {
  const names = new Set(issue.sprints.map((sprint) => sprint.name).filter(Boolean))
  for (const change of issue.sprintChanges) for (const part of change.to.split(',')) if (part.trim()) names.add(part.trim())
  return Math.max(0, names.size - 1)
}

function jiraSteps(issue, review) {
  const steps = { created: { at: issue.createdAt, source: 'jira' } }
  steps.sprint = sprintStep(issue)
  const started = issue.statusChanges.find((change) => change.category === 'indeterminate' && !review.test(change.to))
  steps.progress = started ? { at: started.at, source: 'jira', note: null } : null
  const reviewed = issue.statusChanges.find((change) => review.test(change.to) && change.category !== 'done')
  steps.review = reviewed ? { at: reviewed.at, source: 'jira', note: null } : null
  if (issue.category === 'done') {
    const closed = [...issue.statusChanges].reverse().find((change) => change.category === 'done')
    steps.done = { at: closed?.at ?? issue.resolvedAt ?? issue.updatedAt, source: 'jira' }
  } else steps.done = null
  return steps
}

function mrSteps(mrs, events, deploys) {
  const live = mrs.filter((mr) => mr.state !== 'closed')
  if (!live.length) return {}
  const steps = {}
  const first = [...live].sort((a, b) => a.createdAt - b.createdAt)[0]
  steps.mr = { at: first.createdAt, source: 'gitlab', note: live.length > 1 ? `First of ${live.length} MRs: ${shortRef(first)}` : null }
  const ready = live.map((mr) => {
    const event = events[mr.url]
    if (!event) return null
    if (event.reviewLabelAt) return { at: event.reviewLabelAt, note: `"Ready for review" label on ${shortRef(mr)}` }
    if (event.readyAt) return { at: event.readyAt, note: `${shortRef(mr)} left draft` }
    if (!event.everDraft && !mr.draft) return { at: mr.createdAt, note: `${shortRef(mr)} was opened ready for review` }
    return null
  }).filter(Boolean).sort((a, b) => a.at - b.at)[0]
  if (ready) steps.review = { at: ready.at, source: 'gitlab', inferred: true, note: ready.note }
  const approvals = live.map((mr) => events[mr.url]?.approvedAt ?? null)
  if (approvals.some(Boolean) && live.every((mr, i) => approvals[i] || mr.mergedAt)) {
    const at = Math.max(...approvals.filter(Boolean))
    steps.approved = { at, source: 'gitlab', note: live.length > 1 ? 'Last approval across the MRs' : null }
  }
  if (live.every((mr) => mr.mergedAt)) {
    steps.merged = { at: Math.max(...live.map((mr) => mr.mergedAt)), source: 'gitlab', note: live.length > 1 ? 'Last MR merged' : null }
    const checks = live.map((mr) => deploys[mr.url] ?? null)
    if (checks.every((check) => check?.state === 'live')) {
      const guessed = checks.some((check) => !check.deployedAt)
      steps.deployed = {
        at: Math.max(...checks.map((check) => check.deployedAt ?? check.at)),
        source: 'deploy',
        inferred: guessed,
        note: guessed ? 'Time of the deploy check, not of the deploy itself.' : null,
      }
    } else {
      const pending = checks.filter((check) => check && check.state !== 'live').sort((a, b) => b.at - a.at)[0]
      if (pending) steps.deployState = { state: pending.state, note: pending.note }
    }
  }
  return steps
}

function cleanMilestone(value) {
  if (!value || typeof value !== 'object') return null
  if (value.na) return { na: true, source: value.source ?? 'manual', note: value.note ?? null }
  return Number.isFinite(value.at) ? { at: value.at, source: value.source ?? 'manual', note: value.note ?? null } : null
}

function mergeSteps({ issue, jira, gitlab, firstSession, milestones, hasMrs }) {
  const steps = {}
  for (const id of STEP_IDS) steps[id] = null
  Object.assign(steps, jira)
  for (const id of MR_STEPS) if (gitlab[id] && !(id === 'review' && steps.review)) steps[id] = gitlab[id]
  if (!steps.progress && firstSession) steps.progress = { at: firstSession.at, source: 'board', inferred: true, note: `First session on this ticket: ${firstSession.title}` }
  if (!hasMrs && issue.category === 'done') for (const id of MR_STEPS) steps[id] ??= { na: true, note: 'This ticket had no merge request.' }
  steps.experiment = { na: true, note: 'No experiment start was reported.' }
  for (const [id, value] of Object.entries(milestones ?? {})) {
    const clean = STEP_IDS.includes(id) ? cleanMilestone(value) : null
    if (clean) steps[id] = clean
  }
  return steps
}

function sessionLinks(session, tickets, mrTickets) {
  const found = new Map()
  const add = (key, why, rank, at) => {
    const known = found.get(key)
    if (!known || rank < known.rank) found.set(key, { key, why, rank, at: Math.min(at ?? Infinity, known?.at ?? Infinity) })
    else known.at = Math.min(at ?? Infinity, known.at)
  }
  for (const branch of session.branches ?? []) for (const key of branchKeys(branch.name)) if (tickets.has(key)) add(key, `On branch ${branch.name}`, 0, branch.firstAt)
  for (const url of session.mrUrls ?? []) for (const key of mrTickets.get(url) ?? []) add(key, `Worked on ${urlRef(url)}`, 1, session.createdAt ?? null)
  const mentioned = (session.tickets ?? []).filter((item) => tickets.has(item.key) && item.count >= MENTION_MIN).sort((a, b) => b.count - a.count).slice(0, MENTION_TOP)
  for (const item of mentioned) add(item.key, `Mentions ${item.key} ${item.count} times`, 2, item.firstAt)
  return [...found.values()]
}

const SESSION_LINK_RANK = { fork: 0, task: 1, handoff: 2, message: 3 }

export function sessionGraph(sessions) {
  const ids = new Set(sessions.map((session) => session.id))
  const writers = new Map()
  for (const session of [...sessions].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) for (const file of session.handoffWrites ?? []) if (!writers.has(file)) writers.set(file, session.id)
  const edges = new Map()
  const add = (from, to, kind) => {
    if (!from || from === to || !ids.has(from) || !ids.has(to)) return
    const pair = [from, to].sort().join('|')
    const known = edges.get(pair)
    if (!known || SESSION_LINK_RANK[kind] < SESSION_LINK_RANK[known.kind]) edges.set(pair, { from, to, kind })
  }
  for (const session of sessions) {
    if (session.parent) add(session.parent.id, session.id, session.parent.kind)
    for (const file of session.handoffReads ?? []) add(writers.get(file), session.id, 'handoff')
    for (const target of session.peers ?? []) add(session.id, target, 'message')
  }
  return [...edges.values()]
}

export function buildFlow({ jira, mrs = [], events = {}, deploys = {}, sessions = [], milestones = {}, links = {}, slackChannels = {}, me = null, now = Date.now(), review = DEFAULT_REVIEW_STATUS }) {
  const issues = jira?.issues ?? []
  const ticketIssues = issues.filter((issue) => !issue.isEpic)
  const tickets = new Map(ticketIssues.map((issue) => [issue.key, issue]))
  const epics = new Map()
  for (const issue of issues) if (issue.isEpic) epics.set(issue.key, { key: issue.key, url: issue.url, title: issue.title, status: issue.status, category: issue.category })
  for (const issue of ticketIssues) if (issue.epic && !epics.has(issue.epic.key)) epics.set(issue.epic.key, { ...issue.epic, url: issue.url ? issue.url.replace(/[^/]+$/, issue.epic.key) : null })

  const mrByUrl = new Map(mrs.filter((mr) => mr.url).map((mr) => [mr.url, mr]))
  const mrTickets = new Map()
  const mrWhy = new Map()
  const linkMr = (url, key, why) => {
    if (!tickets.has(key)) return
    const keys = mrTickets.get(url) ?? []
    if (!keys.includes(key)) keys.push(key)
    mrTickets.set(url, keys)
    const reasons = mrWhy.get(`${url}|${key}`) ?? []
    if (!reasons.includes(why)) reasons.push(why)
    mrWhy.set(`${url}|${key}`, reasons)
  }
  for (const [key, urls] of Object.entries(jira?.mrLinks ?? {})) for (const url of urls) linkMr(url, key, 'Jira link')
  for (const mr of mrByUrl.values()) {
    const fromBranch = branchKeys(mr.branch).filter((key) => tickets.has(key))
    for (const key of fromBranch) linkMr(mr.url, key, `Branch ${mr.branch}`)
    if (!fromBranch.length && !mrTickets.has(mr.url)) for (const key of ticketKeys(mr.title).filter((k) => tickets.has(k)).slice(0, 1)) linkMr(mr.url, key, 'Title')
  }
  for (const [url, key] of Object.entries(links.mr ?? {})) linkMr(url, key, 'Linked by hand')

  const sessionRows = []
  const threadMap = new Map()
  const threadMrs = new Map()
  const ticketSessions = new Map()
  for (const session of sessions) {
    const found = sessionLinks(session, tickets, mrTickets)
    const manual = links.session?.[session.id]
    if (manual && tickets.has(manual) && !found.some((item) => item.key === manual)) found.push({ key: manual, why: 'Linked by hand', rank: 0, at: null })
    const threads = (session.slack ?? []).filter((thread) => thread.channel && thread.ts)
    if (!found.length && !threads.length) continue
    const ticketMrs = (session.mrUrls ?? []).filter((url) => mrTickets.get(url)?.some((key) => found.some((item) => item.key === key)))
    const slackMrs = threads.length ? (session.mrUrls ?? []).filter((url) => !mrTickets.has(url) && mrByUrl.has(url) && mrByUrl.get(url).state !== 'closed') : []
    const mrUrls = [...ticketMrs, ...slackMrs]
    for (const url of slackMrs) threadMrs.set(url, [...new Set([...(threadMrs.get(url) ?? []), ...threads.map((thread) => thread.key)])])
    for (const thread of threads) {
      const known = threadMap.get(thread.key) ?? { key: thread.key, host: null, channel: thread.channel, ts: thread.ts, at: tsToMs(thread.ts), title: null, author: null, sessions: [], lastActivityAt: 0 }
      known.host ??= thread.host ?? null
      known.title ??= thread.title ?? null
      known.author ??= thread.author ?? null
      if (!known.sessions.includes(session.id)) known.sessions.push(session.id)
      known.lastActivityAt = Math.max(known.lastActivityAt, session.lastActivityAt ?? 0)
      threadMap.set(thread.key, known)
    }
    sessionRows.push({ id: session.id, title: session.title, project: session.project, status: session.status, archived: session.archived, createdAt: session.createdAt ?? null, lastActivityAt: session.lastActivityAt, tickets: found.map(({ key, why }) => ({ key, why })), mrs: mrUrls, threads: threads.map((thread) => ({ key: thread.key, why: thread.via?.includes('link') ? 'Slack link in a prompt' : 'Read the Slack thread' })) })
    for (const item of found) {
      const list = ticketSessions.get(item.key) ?? []
      list.push({ session, at: Number.isFinite(item.at) ? item.at : null })
      ticketSessions.set(item.key, list)
    }
  }

  const sessionEdges = sessionGraph(sessions)
  const rowIds = new Set(sessionRows.map((row) => row.id))
  const extraMrs = new Set()
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const known = new Set([...mrTickets.keys(), ...threadMrs.keys()])
  const queue = [...rowIds]
  while (queue.length) {
    const id = queue.shift()
    for (const edge of sessionEdges) {
      const other = edge.from === id ? edge.to : edge.to === id ? edge.from : null
      if (!other || rowIds.has(other)) continue
      const session = byId.get(other)
      const urls = (session.mrUrls ?? []).filter((url) => known.has(url) || (mrByUrl.has(url) && mrByUrl.get(url).state !== 'closed'))
      for (const url of urls) if (!known.has(url)) extraMrs.add(url)
      sessionRows.push({ id: session.id, title: session.title, project: session.project, status: session.status, archived: session.archived, createdAt: session.createdAt ?? null, lastActivityAt: session.lastActivityAt, tickets: [], mrs: urls, threads: [] })
      rowIds.add(other)
      queue.push(other)
    }
  }

  const ticketRows = ticketIssues.map((issue) => {
    const urls = [...mrTickets].filter(([, keys]) => keys.includes(issue.key)).map(([url]) => url)
    const linked = urls.map((url) => mrByUrl.get(url)).filter(Boolean)
    const firstSession = (ticketSessions.get(issue.key) ?? []).filter((item) => item.at).sort((a, b) => a.at - b.at)[0]
    const gitlab = mrSteps(linked, events, deploys)
    const steps = mergeSteps({
      issue,
      jira: jiraSteps(issue, review),
      gitlab,
      firstSession: firstSession ? { at: firstSession.at, title: firstSession.session.title } : null,
      milestones: milestones[issue.key],
      hasMrs: linked.some((mr) => mr.state !== 'closed') || urls.length > linked.length,
    })
    const deployState = gitlab.deployState ?? null
    return {
      key: issue.key,
      url: issue.url,
      title: issue.title,
      type: issue.type,
      status: issue.status,
      category: issue.category,
      epic: issue.epic?.key ?? null,
      mine: jira?.me?.id && issue.assignee !== undefined ? issue.assignee?.id === jira.me.id : issue.fromSearch !== false,
      assignee: issue.assignee?.name ?? null,
      steps,
      deployState,
      carried: carriedOver(issue),
      mrs: urls,
      sessions: (ticketSessions.get(issue.key) ?? []).map((item) => item.session.id),
      updatedAt: issue.updatedAt,
    }
  })

  const mrRows = [...new Set([...mrTickets.keys(), ...threadMrs.keys(), ...extraMrs])].map((url) => {
    const mr = mrByUrl.get(url)
    const keys = mrTickets.get(url) ?? []
    const event = events[url] ?? {}
    const deploy = deploys[url] ?? null
    return {
      url,
      ref: mr?.ref ?? url.replace(/^https?:\/\/[^/]+\//, '').replace('/-/merge_requests/', '!'),
      title: mr?.title ?? '',
      state: mr?.state ?? 'unknown',
      draft: Boolean(mr?.draft),
      author: mr?.author ?? '',
      createdAt: mr?.createdAt ?? null,
      updatedAt: mr?.updatedAt ?? null,
      approvedAt: event.approvedAt ?? null,
      mergedAt: mr?.mergedAt ?? null,
      deploy: deploy ? { state: deploy.state, note: deploy.note ?? '', at: deploy.deployedAt ?? deploy.at, exact: Boolean(deploy.deployedAt) } : null,
      tickets: keys.map((key) => ({ key, why: mrWhy.get(`${url}|${key}`) ?? [] })),
      threads: threadMrs.get(url) ?? [],
    }
  })

  const hosts = new Map([...threadMap.values()].filter((thread) => thread.host).map((thread) => [thread.channel, thread.host]))
  const threadRows = [...threadMap.values()].map((thread) => {
    const host = thread.host ?? hosts.get(thread.channel) ?? null
    return { ...thread, host, url: threadUrl({ host, channel: thread.channel, ts: thread.ts }) }
  })
  const channelRows = new Map()
  for (const thread of threadRows) {
    const known = channelRows.get(thread.channel) ?? { id: thread.channel, host: thread.host, name: slackChannels[thread.channel] ?? null, url: channelUrl({ host: thread.host, id: thread.channel }), threads: 0, lastActivityAt: 0 }
    known.threads += 1
    known.lastActivityAt = Math.max(known.lastActivityAt, thread.lastActivityAt)
    channelRows.set(thread.channel, known)
  }

  const looseMrs = mrs
    .filter((mr) => !mrTickets.has(mr.url) && !threadMrs.has(mr.url) && !extraMrs.has(mr.url) && mr.state !== 'closed' && (!me || mr.author === me))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_LOOSE)
    .map((mr) => ({ url: mr.url, ref: mr.ref, title: mr.title, state: mr.state, createdAt: mr.createdAt, mergedAt: mr.mergedAt }))
  const looseSessions = sessions
    .filter((session) => !rowIds.has(session.id) && !session.archived && now - (session.lastActivityAt ?? 0) < LOOSE_SESSION_DAYS * 86_400_000)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .slice(0, MAX_LOOSE)
    .map((session) => ({ id: session.id, title: session.title, project: session.project, status: session.status, lastActivityAt: session.lastActivityAt }))
  const shownSessions = new Set([...rowIds, ...looseSessions.map((session) => session.id)])

  return {
    tickets: ticketRows,
    epics: [...epics.values()],
    mrs: mrRows,
    sessions: sessionRows,
    threads: threadRows,
    channels: [...channelRows.values()],
    sessionLinks: sessionEdges.filter((edge) => shownSessions.has(edge.from) && shownSessions.has(edge.to)),
    loose: { mrs: looseMrs, sessions: looseSessions },
  }
}

export function parseMilestoneInput(body) {
  const key = typeof body?.ticket === 'string' ? body.ticket.trim().toUpperCase() : ''
  if (!/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(key)) return { error: 'ticket must be a Jira key such as ABC-123' }
  if (!MILESTONE_STEPS.includes(body.step)) return { error: `step must be one of ${MILESTONE_STEPS.join(', ')}` }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_NOTE) : null
  const source = body.source === 'skill' ? 'skill' : 'manual'
  if (body.clear === true) return { key, step: body.step, value: null }
  if (body.na === true) return { key, step: body.step, value: { na: true, note, source } }
  const at = typeof body.at === 'number' ? body.at : Date.parse(body.at ?? '')
  if (!Number.isFinite(at) || at < Date.UTC(2000, 0, 1) || at > Date.now() + 86_400_000) return { error: 'at must be a time (ISO string or milliseconds)' }
  return { key, step: body.step, value: { at, note, source, ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId.slice(0, 80) } : {}) } }
}

export function recordMilestone(store, { key, step, value }, now = Date.now()) {
  const current = { ...(store[key] ?? {}) }
  if (value) current[step] = { ...value, recordedAt: now }
  else delete current[step]
  const next = { ...store }
  if (Object.keys(current).length) next[key] = current
  else delete next[key]
  const entries = Object.entries(next)
  return entries.length > MAX_MILESTONES ? Object.fromEntries(entries.slice(-MAX_MILESTONES)) : next
}

export function recordLink(store, { kind, id, ticket }) {
  const next = { mr: { ...(store.mr ?? {}) }, session: { ...(store.session ?? {}) } }
  if (ticket) next[kind][id] = ticket
  else delete next[kind][id]
  return next
}
