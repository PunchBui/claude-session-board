import test from 'node:test'
import assert from 'node:assert/strict'
import { reusableToken, cleanBaseUrl, jiraConfig, authHeader, normalizeIssue, mrUrlOf, syncJira, createJiraClient, DEFAULT_JQL } from '../lib/jira.js'

const BASE = 'https://example.atlassian.net'
const categories = new Map([['1', 'new'], ['3', 'indeterminate'], ['4', 'indeterminate'], ['5', 'done']])

const history = (created, ...items) => ({ created, items })
const rawIssue = (key, over = {}) => ({
  key,
  fields: {
    summary: `Summary of ${key}`,
    status: { name: 'Done', statusCategory: { key: 'done' } },
    issuetype: { name: 'Story', hierarchyLevel: 0 },
    created: '2026-11-02T10:00:00.000+0700',
    updated: '2026-11-10T10:00:00.000+0700',
    resolutiondate: '2026-11-10T10:00:00.000+0700',
    parent: { key: 'ABC-1', fields: { summary: 'The epic', status: { name: 'Created', statusCategory: { key: 'new' } }, issuetype: { name: 'Epic', hierarchyLevel: 1 } } },
    customfield_10020: [{ name: 'Sprint 4', state: 'closed', startDate: '2026-11-03T03:00:00.000Z' }],
    ...over.fields,
  },
  changelog: over.changelog ?? {
    total: 3,
    histories: [
      history('2026-11-08T09:00:00.000+0700', { field: 'status', fieldId: 'status', from: '3', fromString: 'In Progress', to: '5', toString: 'Done' }),
      history('2026-11-04T09:00:00.000+0700', { field: 'status', fieldId: 'status', from: '1', fromString: 'Created', to: '3', toString: 'In Progress' }),
      history('2026-11-02T11:00:00.000+0700', { field: 'Sprint', fieldId: 'customfield_10020', fromString: '', toString: 'Sprint 4' }, { field: 'RemoteWorkItemLink', toString: 'This work item links to "Merge request"' }),
    ],
  },
})

test('the site URL keeps only the origin and path, without a trailing slash', () => {
  assert.equal(cleanBaseUrl('https://example.atlassian.net/'), BASE)
  assert.equal(cleanBaseUrl('https://jira.example.com/jira/'), 'https://jira.example.com/jira')
  assert.equal(cleanBaseUrl('ftp://example.com'), '')
  assert.equal(cleanBaseUrl('not a url'), '')
})

test('environment variables win over the saved config, and the default JQL fills in', () => {
  const saved = { baseUrl: BASE, email: 'me@example.com', token: 'saved' }
  assert.deepEqual(jiraConfig({}, saved), { baseUrl: BASE, email: 'me@example.com', token: 'saved', jql: DEFAULT_JQL, ready: true })
  assert.equal(jiraConfig({ JIRA_API_TOKEN: 'env' }, saved).token, 'env')
  assert.equal(jiraConfig({}, { baseUrl: BASE, email: 'me@example.com' }).ready, false)
  assert.equal(jiraConfig({ FLOW_JQL: 'project = ABC' }, saved).jql, 'project = ABC')
})

test('the auth header is basic auth of email and token', () => {
  assert.equal(authHeader({ email: 'a@b.c', token: 't' }), `Basic ${Buffer.from('a@b.c:t').toString('base64')}`)
})

test('an issue is normalized with sorted status changes, sprint changes, epic and link hint', () => {
  const issue = normalizeIssue(rawIssue('ABC-7'), { baseUrl: BASE, categories, sprintField: 'customfield_10020' })
  assert.equal(issue.url, `${BASE}/browse/ABC-7`)
  assert.equal(issue.isEpic, false)
  assert.deepEqual(issue.epic, { key: 'ABC-1', title: 'The epic', status: 'Created', category: 'new' })
  assert.deepEqual(issue.statusChanges.map((change) => [change.to, change.category]), [['In Progress', 'indeterminate'], ['Done', 'done']])
  assert.equal(issue.sprintChanges.length, 1)
  assert.equal(issue.sprints[0].startAt, Date.parse('2026-11-03T03:00:00.000Z'))
  assert.equal(issue.hasRemoteLinks, true)
  assert.equal(issue.assignee, null)
  assert.deepEqual(normalizeIssue(rawIssue('ABC-9', { fields: { assignee: { accountId: 'a1', displayName: 'Ann' } } })).assignee, { id: 'a1', name: 'Ann' })
  assert.equal(issue.createdAt, Date.parse('2026-11-02T10:00:00.000+0700'))
})

test('a parent that is not an epic is not used as the epic', () => {
  const issue = normalizeIssue(rawIssue('ABC-8', { fields: { parent: { key: 'ABC-7', fields: { summary: 'Story', issuetype: { name: 'Story', hierarchyLevel: 0 } } } } }), { baseUrl: BASE })
  assert.equal(issue.epic, null)
})

test('merge request links are cut down to the merge request URL', () => {
  assert.equal(mrUrlOf('https://gitlab.example.com/a/b/-/merge_requests/83/diffs?x=1'), 'https://gitlab.example.com/a/b/-/merge_requests/83')
  assert.equal(mrUrlOf('https://gitlab.example.com/a/b/-/commit/abc'), null)
})

function fakeClient({ search = [], bulk = [], links = {}, changelog = {} } = {}) {
  const calls = { remoteLinks: [], bulk: [], fields: 0 }
  return {
    calls,
    statuses: async () => [{ id: '1', statusCategory: { key: 'new' } }, { id: '3', statusCategory: { key: 'indeterminate' } }, { id: '5', statusCategory: { key: 'done' } }],
    fields: async () => { calls.fields += 1; return [{ id: 'customfield_10020', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }] },
    myself: async () => ({ accountId: 'acc-me', displayName: 'Me' }),
    search: async () => structuredClone(search),
    bulk: async (keys) => { calls.bulk.push(keys); return structuredClone(bulk.filter((raw) => keys.includes(raw.key))) },
    changelog: async (key) => changelog[key] ?? [],
    remoteLinks: async (key) => { calls.remoteLinks.push(key); return links[key] ?? [] },
  }
}

test('a sync searches, fetches extra keys, and reads remote links only for issues that have them', async () => {
  const quiet = rawIssue('ABC-9', { changelog: { total: 0, histories: [] } })
  const client = fakeClient({
    search: [rawIssue('ABC-7'), quiet],
    bulk: [rawIssue('XYZ-2', { changelog: { total: 0, histories: [] } })],
    links: { 'ABC-7': [{ object: { url: 'https://gitlab.example.com/a/b/-/merge_requests/83' } }, { object: { url: 'https://wiki.example.com/page' } }] },
  })
  const result = await syncJira({ client, config: { baseUrl: BASE, jql: 'x' }, extraKeys: ['ABC-12', 'XYZ-2', 'ABC-7'], now: 5 })
  assert.deepEqual(result.issues.map((issue) => issue.key), ['ABC-7', 'ABC-9'])
  assert.deepEqual(client.calls.bulk, [['ABC-12']], 'only keys from projects the search returned are fetched')
  assert.deepEqual(client.calls.remoteLinks, ['ABC-7'])
  assert.deepEqual(result.mrLinks, { 'ABC-7': ['https://gitlab.example.com/a/b/-/merge_requests/83'] })
  assert.equal(result.sprintField, 'customfield_10020')
  assert.equal(result.fetchedAt, 5)
  assert.deepEqual(result.me, { id: 'acc-me', name: 'Me' })
  assert.deepEqual(result.issues.map((issue) => issue.fromSearch), [true, true])
})

test('a second sync reuses remote links and the sprint field when the issue did not change', async () => {
  const first = await syncJira({ client: fakeClient({ search: [rawIssue('ABC-7')], links: { 'ABC-7': [{ object: { url: 'https://g.example.com/a/-/merge_requests/1' } }] } }), config: { baseUrl: BASE, jql: 'x' } })
  const client = fakeClient({ search: [rawIssue('ABC-7')] })
  const second = await syncJira({ client, config: { baseUrl: BASE, jql: 'x' }, previous: first })
  assert.deepEqual(client.calls.remoteLinks, [])
  assert.equal(client.calls.fields, 0)
  assert.deepEqual(second.mrLinks['ABC-7'], ['https://g.example.com/a/-/merge_requests/1'])
})

test('a long changelog is fetched in full', async () => {
  const raw = rawIssue('ABC-7', { changelog: { total: 150, histories: [] } })
  const full = [history('2026-11-04T09:00:00.000+0700', { field: 'status', fieldId: 'status', from: '1', fromString: 'Created', to: '3', toString: 'In Progress' })]
  const result = await syncJira({ client: fakeClient({ search: [raw], changelog: { 'ABC-7': full } }), config: { baseUrl: BASE, jql: 'x' } })
  assert.equal(result.issues[0].statusChanges.length, 1)
})

test('the client pages the search with nextPageToken and reports Jira errors', async () => {
  const bodies = []
  const pages = [{ issues: [{ key: 'A-1' }], nextPageToken: 't2', isLast: false }, { issues: [{ key: 'A-2' }], isLast: true }]
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => pages.shift() }
  }
  const client = createJiraClient({ baseUrl: BASE, email: 'a@b.c', token: 't' }, { fetchImpl })
  assert.deepEqual((await client.search('x', ['summary'])).map((issue) => issue.key), ['A-1', 'A-2'])
  assert.equal(bodies[1].nextPageToken, 't2')
  assert.equal(bodies[0].expand, 'changelog')
  const failing = createJiraClient({ baseUrl: BASE, email: 'a@b.c', token: 't' }, { fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ errorMessages: ['Bad JQL'] }) }) })
  await assert.rejects(failing.myself(), /Jira 400: Bad JQL/)
})

test('a saved token is only reused for the Jira site it was saved for', () => {
  const saved = { baseUrl: 'https://example.atlassian.net/', token: 'saved-token' }
  const base = 'https://example.atlassian.net'
  assert.equal(reusableToken({}, saved, base), 'saved-token')
  assert.equal(reusableToken({ token: '  ' }, saved, base), 'saved-token')
  assert.equal(reusableToken({}, saved, 'https://attacker.example'), '')
  assert.equal(reusableToken({ token: ' typed ' }, saved, 'https://attacker.example'), 'typed')
  assert.equal(reusableToken({}, null, base), '')
  assert.equal(reusableToken({}, saved, ''), '')
})
