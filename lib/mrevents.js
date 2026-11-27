export const HISTORY_DAYS = 180
export const MAX_EVENT_ENTRIES = 600
const PAGE_SIZE = 100
const MAX_PAGES = 3
const BATCH = 20
const NOTE_PAGES = 5
const EVENT_CONCURRENCY = 4
const REVIEW_LABEL = /^ready[\s_-]*(to|for)[\s_-]*review$/i
const MR_PATH = /^\/(.+)\/-\/merge_requests\/(\d+)$/

const MR_FIELDS = 'iid title webUrl sourceBranch createdAt mergedAt updatedAt state draft author { username } project { fullPath }'

const time = (value) => {
  const ms = Date.parse(value ?? '')
  return Number.isNaN(ms) ? null : ms
}

export function parseMrUrl(url) {
  try {
    const parsed = new URL(url)
    const match = MR_PATH.exec(parsed.pathname)
    return match ? { host: parsed.hostname, project: match[1], iid: match[2] } : null
  } catch {
    return null
  }
}

export function normalizeMrNode(node) {
  const project = node.project?.fullPath ?? ''
  return {
    url: node.webUrl,
    ref: `${project}!${node.iid}`,
    project,
    title: node.title ?? '',
    branch: node.sourceBranch ?? '',
    state: String(node.state ?? '').toLowerCase(),
    draft: Boolean(node.draft),
    author: node.author?.username ?? '',
    createdAt: time(node.createdAt),
    mergedAt: time(node.mergedAt),
    updatedAt: time(node.updatedAt),
  }
}

export async function loadAuthoredMrs({ run, host, now = Date.now(), days = HISTORY_DAYS }) {
  const since = new Date(now - days * 86_400_000).toISOString()
  const mrs = []
  let me = null
  let after = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const cursor = after ? `, after: ${JSON.stringify(after)}` : ''
    const query = `query { currentUser { username authoredMergeRequests(createdAfter: "${since}", first: ${PAGE_SIZE}, sort: CREATED_DESC${cursor}) { pageInfo { hasNextPage endCursor } nodes { ${MR_FIELDS} } } } }`
    const parsed = JSON.parse(await run(['api', '--hostname', host, 'graphql', '-f', `query=${query}`]))
    if (parsed.errors?.length) throw new Error(parsed.errors[0].message)
    if (!parsed.data?.currentUser) throw new Error(`not signed in to ${host}`)
    me = parsed.data.currentUser.username ?? me
    const connection = parsed.data.currentUser.authoredMergeRequests
    mrs.push(...(connection?.nodes ?? []).map(normalizeMrNode))
    if (!connection?.pageInfo?.hasNextPage) break
    after = connection.pageInfo.endCursor
  }
  return { me, mrs }
}

export async function loadMrsByUrl({ run, host, urls }) {
  const wanted = urls.map((url) => ({ url, parts: parseMrUrl(url) })).filter((item) => item.parts?.host === host)
  const mrs = []
  for (let i = 0; i < wanted.length; i += BATCH) {
    const chunk = wanted.slice(i, i + BATCH)
    const body = chunk.map((item, n) => `m${n}: project(fullPath: ${JSON.stringify(item.parts.project)}) { mergeRequest(iid: ${JSON.stringify(item.parts.iid)}) { ${MR_FIELDS} } }`).join('\n')
    try {
      const parsed = JSON.parse(await run(['api', '--hostname', host, 'graphql', '-f', `query=query { ${body} }`]))
      chunk.forEach((item, n) => {
        const node = parsed.data?.[`m${n}`]?.mergeRequest
        if (node) mrs.push(normalizeMrNode(node))
      })
    } catch {}
  }
  return mrs
}

export function eventsFrom(notes, labelEvents) {
  let approvedAt = null
  let readyAt = null
  let everDraft = false
  for (const note of [...notes].sort((a, b) => time(a.created_at) - time(b.created_at))) {
    if (!note.system) continue
    const body = String(note.body ?? '')
    const at = time(note.created_at)
    if (/^approved this merge request/i.test(body)) approvedAt = at
    else if (/^unapproved this merge request/i.test(body)) approvedAt = null
    else if (/marked this merge request as \*\*draft\*\*/i.test(body)) everDraft = true
    else if (/marked this merge request as \*\*ready\*\*/i.test(body)) {
      everDraft = true
      readyAt ??= at
    }
  }
  const reviewLabelAt = labelEvents
    .filter((event) => event.action === 'add' && REVIEW_LABEL.test(event.label?.name ?? ''))
    .map((event) => time(event.created_at))
    .filter((at) => at !== null)
    .sort((a, b) => a - b)[0] ?? null
  return { approvedAt, readyAt, reviewLabelAt, everDraft }
}

export async function loadMrEvents({ run, host, url }) {
  const parts = parseMrUrl(url)
  if (!parts) return null
  const base = `projects/${encodeURIComponent(parts.project)}/merge_requests/${parts.iid}`
  const notes = []
  for (let page = 1; page <= NOTE_PAGES; page++) {
    const batch = JSON.parse(await run(['api', '--hostname', host, `${base}/notes?sort=asc&order_by=created_at&per_page=100&page=${page}`]))
    notes.push(...batch)
    if (batch.length < 100) break
  }
  const labels = JSON.parse(await run(['api', '--hostname', host, `${base}/resource_label_events?per_page=100`]).catch(() => '[]'))
  return eventsFrom(notes, Array.isArray(labels) ? labels : [])
}

export function needsEvents(mr, cached) {
  if (!cached) return true
  if (mr.mergedAt && cached.fetchedAt >= mr.mergedAt) return false
  return (mr.updatedAt ?? 0) > (cached.updatedAt ?? 0)
}

export async function refreshEvents({ run, host, mrs, cache, now = Date.now(), limit = 60 }) {
  const next = { ...cache }
  const todo = mrs.filter((mr) => needsEvents(mr, cache[mr.url])).slice(0, limit)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(EVENT_CONCURRENCY, todo.length) }, async () => {
    while (index < todo.length) {
      const mr = todo[index++]
      const events = await loadMrEvents({ run, host, url: mr.url }).catch(() => null)
      if (events) next[mr.url] = { ...events, updatedAt: mr.updatedAt, fetchedAt: now }
    }
  }))
  return trimEvents(next)
}

export function trimEvents(events, max = MAX_EVENT_ENTRIES) {
  const entries = Object.entries(events)
  if (entries.length <= max) return events
  return Object.fromEntries(entries.sort((a, b) => (b[1]?.fetchedAt ?? 0) - (a[1]?.fetchedAt ?? 0)).slice(0, max))
}
