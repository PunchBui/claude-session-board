import { createJiraClient, syncJira } from './jira.js'
import { loadAuthoredMrs, loadMrsByUrl, refreshEvents } from './mrevents.js'
import { ticketKeys, branchKeys } from './flow.js'

export const STALE_MS = 10 * 60_000
const EVENT_LIMIT = 150

export function relevantMrs(mrs, jira) {
  const keys = new Set((jira?.issues ?? []).map((issue) => issue.key))
  const linked = new Set(Object.values(jira?.mrLinks ?? {}).flat())
  return mrs.filter((mr) => linked.has(mr.url) || [...branchKeys(mr.branch), ...ticketKeys(mr.title)].some((key) => keys.has(key)))
}

export function createFlowSync({ readConfig, readCache, writeCache, readEvents, writeEvents, extraKeys, run, host, makeClient = createJiraClient, now = Date.now, staleMs = STALE_MS }) {
  let cache = null
  let loaded = false
  let inflight = null

  async function load() {
    if (loaded) return
    loaded = true
    cache = (await readCache().catch(() => null)) ?? null
  }

  async function sync() {
    const config = await readConfig()
    const at = now()
    const previous = cache
    const next = { fetchedAt: at, error: null, gitlabError: null, me: previous?.me ?? null, jira: config.ready ? previous?.jira ?? null : null, mrs: previous?.mrs ?? [] }
    let authored = null
    if (host) {
      try {
        authored = await loadAuthoredMrs({ run, host, now: at })
        next.me = authored.me ?? next.me
      } catch (error) {
        next.gitlabError = String(error.message ?? error)
      }
    }
    if (config.ready) {
      try {
        const fromMrs = (authored?.mrs ?? next.mrs).flatMap((mr) => [...branchKeys(mr.branch), ...ticketKeys(mr.title)])
        next.jira = await syncJira({ client: makeClient(config), config, extraKeys: [...fromMrs, ...(await extraKeys())], previous: previous?.jira, now: at })
      } catch (error) {
        next.error = String(error.message ?? error)
      }
    }
    if (host && authored) {
      const known = new Set(authored.mrs.map((mr) => mr.url))
      const linked = [...new Set(Object.values(next.jira?.mrLinks ?? {}).flat())].filter((url) => !known.has(url))
      next.mrs = [...authored.mrs, ...(await loadMrsByUrl({ run, host, urls: linked }).catch(() => []))]
      try {
        const events = await refreshEvents({ run, host, mrs: relevantMrs(next.mrs, next.jira), cache: (await readEvents().catch(() => null)) ?? {}, now: at, limit: EVENT_LIMIT })
        await writeEvents(events)
      } catch (error) {
        next.gitlabError ??= String(error.message ?? error)
      }
    }
    cache = next
    await writeCache(next).catch(() => {})
    return next
  }

  function refresh() {
    inflight ??= sync().finally(() => {
      inflight = null
    })
    return inflight
  }

  async function get({ force = false } = {}) {
    await load()
    if (force) return refresh()
    if (!cache) {
      refresh().catch(() => {})
      return { fetchedAt: 0, error: null, gitlabError: null, me: null, jira: null, mrs: [], refreshing: true }
    }
    if (now() - cache.fetchedAt > staleMs) {
      refresh().catch(() => {})
      return { ...cache, refreshing: true }
    }
    return inflight ? { ...cache, refreshing: true } : cache
  }

  return { get, refresh, syncing: () => Boolean(inflight) }
}
