const REMOTE_TTL_MS = 5 * 60_000
const REMOTE_PATH = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\/|[^@/\s]+@[^:/\s]+:)(.+?)(?:\.git)?\/?$/i

export function repoPath(remote) {
  const match = REMOTE_PATH.exec(String(remote ?? '').trim())
  return match ? match[1].toLowerCase() : null
}

export function createRemoteCache({ read, ttlMs = REMOTE_TTL_MS, now = Date.now }) {
  const entries = new Map()
  return async function remoteOf(cwd) {
    const hit = entries.get(cwd)
    if (hit && now() - hit.at < ttlMs) return hit.path
    const path = repoPath(await read(cwd))
    entries.set(cwd, { at: now(), path })
    return path
  }
}

export function createCanonicalCache({ read }) {
  const entries = new Map()
  return function canonical(path) {
    if (!entries.has(path)) entries.set(path, read(path).then((value) => value?.toLowerCase() ?? null, () => null))
    return entries.get(path)
  }
}

const lastSegment = (path) => path.slice(path.lastIndexOf('/') + 1)

const MAX_SIBLINGS = 400

export async function siblingFolders(cwds, { list, home }) {
  const parents = [...new Set(cwds.map((cwd) => cwd.slice(0, cwd.lastIndexOf('/'))))].filter((parent) => parent && parent !== home)
  const lists = await Promise.all(parents.map(async (parent) => (await list(parent)).map((name) => `${parent}/${name}`)))
  return lists.flat().slice(0, MAX_SIBLINGS)
}

const unique = (list) => [...new Set(list.filter(Boolean))]
const latestFirst = (sessions) => [...sessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))

export async function resolveFolders(mrs, { linked, known, remoteOf, canonical = async () => null }) {
  const open = mrs
  const candidates = (mr) => unique([...latestFirst(linked.get(mr.url) ?? []).map((session) => session.cwd), ...known])
  const all = unique(open.flatMap(candidates))
  const remotes = new Map(await Promise.all(all.map(async (cwd) => [cwd, await remoteOf(cwd)])))
  const folders = new Map()
  for (const mr of open) {
    const want = mr.project.toLowerCase()
    const exact = candidates(mr).find((cwd) => remotes.get(cwd) === want)
    const folder = exact ?? await movedCheckout(candidates(mr), remotes, want, canonical)
    if (folder) folders.set(mr.url, folder)
  }
  return folders
}

async function movedCheckout(cwds, remotes, want, canonical) {
  const renamed = cwds.filter((cwd) => remotes.get(cwd) && lastSegment(remotes.get(cwd)) === lastSegment(want))
  for (const cwd of renamed) {
    if (await canonical(remotes.get(cwd)) === want) return cwd
  }
  return null
}

export function withFolders(data, folders) {
  const mark = (mrs) => mrs.map((mr) => (folders.has(mr.url) ? { ...mr, folder: folders.get(mr.url) } : mr))
  return { ...data, authored: mark(data.authored), merged: mark(data.merged ?? []) }
}

export function settleWithin(task, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, null)
  })
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer))
}
