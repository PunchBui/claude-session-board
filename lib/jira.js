import { Buffer } from 'node:buffer'

export const DEFAULT_JQL = 'assignee = currentUser() AND (statusCategory != Done OR resolved >= -180d) ORDER BY updated DESC'
export const BASE_FIELDS = ['summary', 'status', 'issuetype', 'created', 'updated', 'resolutiondate', 'parent', 'assignee']
export const MAX_ISSUES = 300
export const MAX_EXTRA_KEYS = 100
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint'
const TIMEOUT_MS = 20_000
const LINK_CONCURRENCY = 6
const MR_LINK = /^(https?:\/\/[^/\s]+\/.+?\/-\/merge_requests\/\d+)(?:[/?#].*)?$/

export class JiraError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function cleanBaseUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  let url
  try {
    url = new URL(text)
  } catch {
    return ''
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function reusableToken(body, saved, baseUrl) {
  if (typeof body?.token === 'string' && body.token.trim()) return body.token.trim().slice(0, 500)
  return saved?.token && baseUrl && cleanBaseUrl(saved.baseUrl) === baseUrl ? saved.token : ''
}

export function jiraConfig(env = {}, saved = null) {
  const baseUrl = cleanBaseUrl(env.JIRA_BASE_URL || saved?.baseUrl)
  const email = String(env.JIRA_EMAIL || saved?.email || '').trim()
  const token = String(env.JIRA_API_TOKEN || saved?.token || '').trim()
  const jql = String(env.FLOW_JQL || saved?.jql || '').trim() || DEFAULT_JQL
  return { baseUrl, email, token, jql, ready: Boolean(baseUrl && email && token) }
}

export const authHeader = ({ email, token }) => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`

function errorMessage(status, text) {
  try {
    const parsed = JSON.parse(text)
    const first = parsed.errorMessages?.[0] ?? Object.values(parsed.errors ?? {})[0] ?? parsed.message
    if (first) return `Jira ${status}: ${first}`
  } catch {}
  if (status === 401) return 'Jira 401: the email or API token was not accepted'
  if (status === 403) return 'Jira 403: this account cannot read that'
  return `Jira ${status}`
}

export function createJiraClient(config, { fetchImpl = fetch } = {}) {
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { authorization: authHeader(config), accept: 'application/json' }
    if (body) headers['content-type'] = 'application/json'
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new JiraError(response.status, errorMessage(response.status, await response.text().catch(() => '')))
    return response.status === 204 ? null : response.json()
  }
  return {
    myself: () => call('/rest/api/3/myself'),
    statuses: () => call('/rest/api/3/status'),
    fields: () => call('/rest/api/3/field'),
    async search(jql, fields) {
      const issues = []
      let nextPageToken
      do {
        const page = await call('/rest/api/3/search/jql', { method: 'POST', body: { jql, fields, expand: 'changelog', maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) } })
        issues.push(...(page.issues ?? []))
        nextPageToken = page.isLast ? undefined : page.nextPageToken
      } while (nextPageToken && issues.length < MAX_ISSUES)
      return issues.slice(0, MAX_ISSUES)
    },
    async bulk(keys, fields) {
      if (!keys.length) return []
      const page = await call('/rest/api/3/issue/bulkfetch', { method: 'POST', body: { issueIdsOrKeys: keys, fields, expand: ['changelog'] } })
      return page.issues ?? []
    },
    async changelog(key) {
      const values = []
      for (let startAt = 0; startAt < 1000; startAt += 100) {
        const page = await call(`/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=100`)
        values.push(...(page.values ?? []))
        if (page.isLast !== false || !(page.values ?? []).length) break
      }
      return values
    },
    remoteLinks: (key) => call(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`),
  }
}

export function mrUrlOf(value) {
  const match = MR_LINK.exec(String(value ?? '').trim())
  return match ? match[1] : null
}

const isEpicType = (type) => (type?.hierarchyLevel ?? 0) >= 1 || /^epic$/i.test(type?.name ?? '')
const time = (value) => {
  const ms = Date.parse(value ?? '')
  return Number.isNaN(ms) ? null : ms
}

export function normalizeIssue(raw, { baseUrl, categories = new Map(), sprintField = null } = {}) {
  const fields = raw.fields ?? {}
  const items = (raw.changelog?.histories ?? [])
    .flatMap((history) => (history.items ?? []).map((item) => ({ ...item, at: time(history.created) })))
    .filter((item) => item.at !== null)
    .sort((a, b) => a.at - b.at)
  const statusChanges = items
    .filter((item) => item.fieldId === 'status' || item.field === 'status')
    .map((item) => ({ at: item.at, from: item.fromString ?? '', to: item.toString ?? '', category: categories.get(String(item.to)) ?? null }))
  const sprintChanges = items
    .filter((item) => item.field === 'Sprint')
    .map((item) => ({ at: item.at, from: item.fromString ?? '', to: item.toString ?? '' }))
  const sprintValues = Array.isArray(fields[sprintField]) ? fields[sprintField] : []
  const parent = fields.parent
  const epic = parent && isEpicType(parent.fields?.issuetype)
    ? { key: parent.key, title: parent.fields?.summary ?? parent.key, status: parent.fields?.status?.name ?? '', category: parent.fields?.status?.statusCategory?.key ?? null }
    : null
  return {
    key: raw.key,
    url: baseUrl ? `${baseUrl}/browse/${raw.key}` : null,
    title: fields.summary ?? raw.key,
    type: fields.issuetype?.name ?? '',
    isEpic: isEpicType(fields.issuetype),
    status: fields.status?.name ?? '',
    category: fields.status?.statusCategory?.key ?? null,
    createdAt: time(fields.created),
    updatedAt: time(fields.updated),
    resolvedAt: time(fields.resolutiondate),
    epic,
    sprints: sprintValues.map((sprint) => ({ name: sprint.name ?? '', state: sprint.state ?? '', startAt: time(sprint.startDate) })),
    statusChanges,
    sprintChanges,
    hasRemoteLinks: items.some((item) => /remote(work|issue)?(item)?link/i.test(item.field ?? '')),
    assignee: fields.assignee?.accountId ? { id: fields.assignee.accountId, name: fields.assignee.displayName ?? '' } : null,
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index])
    }
  }))
  return out
}

export async function syncJira({ client, config, extraKeys = [], previous = null, now = Date.now() }) {
  const categories = new Map((await client.statuses()).map((status) => [String(status.id), status.statusCategory?.key ?? null]))
  const sprintField = previous?.sprintField ?? (await client.fields()).find((field) => field.schema?.custom === SPRINT_SCHEMA)?.id ?? null
  const fields = [...BASE_FIELDS, ...(sprintField ? [sprintField] : [])]
  const me = await client.myself().then((user) => (user?.accountId ? { id: user.accountId, name: user.displayName ?? '' } : null)).catch(() => previous?.me ?? null)
  const raws = await client.search(config.jql, fields)
  const fromSearch = new Set(raws.map((raw) => raw.key))
  const seen = new Set(raws.map((raw) => raw.key))
  const projects = new Set(raws.map((raw) => raw.key.split('-')[0]))
  const missing = [...new Set(extraKeys)].filter((key) => !seen.has(key) && projects.has(key.split('-')[0])).slice(0, MAX_EXTRA_KEYS)
  if (missing.length) raws.push(...(await client.bulk(missing, fields).catch(() => [])).filter((raw) => !seen.has(raw.key)))
  await mapLimit(raws.filter((raw) => (raw.changelog?.total ?? 0) > (raw.changelog?.histories?.length ?? 0)), LINK_CONCURRENCY, async (raw) => {
    const histories = await client.changelog(raw.key).catch(() => null)
    if (histories) raw.changelog = { total: histories.length, histories }
  })
  const issues = raws.map((raw) => ({ ...normalizeIssue(raw, { baseUrl: config.baseUrl, categories, sprintField }), fromSearch: fromSearch.has(raw.key) }))
  const before = new Map((previous?.issues ?? []).map((issue) => [issue.key, issue]))
  const mrLinks = {}
  await mapLimit(issues.filter((issue) => issue.hasRemoteLinks), LINK_CONCURRENCY, async (issue) => {
    const old = before.get(issue.key)
    if (old && old.updatedAt === issue.updatedAt && previous?.mrLinks?.[issue.key]) {
      mrLinks[issue.key] = previous.mrLinks[issue.key]
      return
    }
    const links = await client.remoteLinks(issue.key).catch(() => null)
    if (links) mrLinks[issue.key] = [...new Set(links.map((link) => mrUrlOf(link.object?.url)).filter(Boolean))]
    else if (previous?.mrLinks?.[issue.key]) mrLinks[issue.key] = previous.mrLinks[issue.key]
  })
  return { fetchedAt: now, sprintField, me, issues, mrLinks }
}
