import { mapActivity } from './flow.js'

export const KIND_NAMES = {
  epic: ['epic', 'epics'],
  channel: ['Slack channel', 'Slack channels'],
  ticket: ['ticket', 'tickets'],
  thread: ['Slack thread', 'Slack threads'],
  session: ['session', 'sessions'],
  mr: ['MR', 'MRs'],
}
export const KIND_ORDER = ['epic', 'channel', 'ticket', 'thread', 'session', 'mr']
export const SESSION_LINK_LABEL = { task: 'started', fork: 'forked', handoff: 'handoff', message: 'messaged' }
const GROUP_KINDS = new Set(['epic', 'channel'])

export const kindName = (kind, n) => (KIND_NAMES[kind] ?? [kind, `${kind}s`])[n === 1 ? 0 : 1]

const latest = (...values) => Math.max(0, ...values.filter(Number.isFinite))

export function mapGraph({ tickets = [], threads = [], sessions = [], sessionLinks = [], mrs = [], looseSessions = [], looseMrs = [] }) {
  const at = mapActivity({ tickets, sessions, mrs, looseSessions, looseMrs })
  const nodes = new Map()
  const add = (id, kind, ref, when = at.get(id)) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, ref, at: when ?? 0, loose: false })
    return nodes.get(id)
  }
  const keys = new Set(tickets.map((ticket) => ticket.key))
  const threadKeys = new Set(threads.map((thread) => thread.key))
  const mrByUrl = new Map(mrs.map((mr) => [mr.url, mr]))
  for (const ticket of tickets) {
    if (ticket.epic) add(`e:${ticket.epic}`, 'epic', ticket.epic)
    add(`t:${ticket.key}`, 'ticket', ticket)
  }
  for (const thread of threads) {
    const when = latest(thread.lastActivityAt, thread.at)
    add(`th:${thread.key}`, 'thread', thread, when)
    const channel = add(`c:${thread.channel}`, 'channel', thread.channel, when)
    channel.at = Math.max(channel.at, when)
  }

  const sessionById = new Map(sessions.map((item) => [item.id, item]))
  const looseIds = new Set(looseSessions.map((item) => item.id))
  for (const item of looseSessions) if (!sessionById.has(item.id)) sessionById.set(item.id, { ...item, tickets: [], threads: [], mrs: [] })
  const shown = new Set([...sessionById.values()].filter((item) => looseIds.has(item.id) || item.tickets.some((ref) => keys.has(ref.key)) || (item.threads ?? []).some((ref) => threadKeys.has(ref.key))).map((item) => item.id))
  const queue = [...shown]
  while (queue.length) {
    const id = queue.shift()
    for (const edge of sessionLinks) {
      const other = edge.from === id ? edge.to : edge.to === id ? edge.from : null
      if (other && sessionById.has(other) && !shown.has(other)) {
        shown.add(other)
        queue.push(other)
      }
    }
  }
  for (const id of shown) add(`s:${id}`, 'session', sessionById.get(id)).loose = looseIds.has(id)
  for (const mr of looseMrs) add(`m:${mr.url}`, 'mr', mr, latest(mr.createdAt, mr.mergedAt)).loose = true

  const edges = []
  const seen = new Set()
  const link = (from, to, kind = 'link') => {
    if (from === to || !nodes.has(from) || !nodes.has(to) || seen.has(`${from}|${to}`) || seen.has(`${to}|${from}`)) return
    seen.add(`${from}|${to}`)
    edges.push({ from, to, kind })
  }
  for (const ticket of tickets) if (ticket.epic) link(`e:${ticket.epic}`, `t:${ticket.key}`)
  for (const thread of threads) link(`c:${thread.channel}`, `th:${thread.key}`)
  for (const edge of sessionLinks) link(`s:${edge.from}`, `s:${edge.to}`, edge.kind)
  const viaSession = new Set()
  for (const id of shown) {
    const item = sessionById.get(id)
    for (const ref of item.tickets ?? []) link(`t:${ref.key}`, `s:${id}`)
    for (const ref of item.threads ?? []) link(`th:${ref.key}`, `s:${id}`)
    for (const url of item.mrs ?? []) {
      if (!mrByUrl.has(url)) continue
      add(`m:${url}`, 'mr', mrByUrl.get(url))
      link(`s:${id}`, `m:${url}`)
      viaSession.add(url)
    }
  }
  for (const ticket of tickets) for (const url of ticket.mrs ?? []) if (mrByUrl.has(url) && !viaSession.has(url)) {
    add(`m:${url}`, 'mr', mrByUrl.get(url))
    link(`t:${ticket.key}`, `m:${url}`)
  }
  for (const mr of mrs) for (const key of mr.threads ?? []) if (threadKeys.has(key) && !viaSession.has(mr.url)) {
    add(`m:${mr.url}`, 'mr', mr)
    link(`th:${key}`, `m:${mr.url}`)
  }
  return withMaps(nodes, reduceEdges(edges))
}

function withMaps(nodes, edges) {
  const parents = new Map()
  const children = new Map()
  for (const edge of edges) {
    if (!children.has(edge.from)) children.set(edge.from, [])
    children.get(edge.from).push(edge.to)
    if (!parents.has(edge.to)) parents.set(edge.to, [])
    parents.get(edge.to).push(edge.from)
  }
  return { nodes, edges, parents, children }
}

export function reduceEdges(edges) {
  const out = new Map()
  for (const edge of edges) {
    if (!out.has(edge.from)) out.set(edge.from, [])
    out.get(edge.from).push(edge.to)
  }
  const reachesAround = ({ from, to }) => {
    const seen = new Set([from])
    const stack = (out.get(from) ?? []).filter((next) => next !== to)
    while (stack.length) {
      const id = stack.pop()
      if (id === to) return true
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...(out.get(id) ?? []))
    }
    return false
  }
  return edges.filter((edge) => edge.kind !== 'link' || !reachesAround(edge))
}

const walk = (map, start, into) => {
  const stack = [start]
  while (stack.length) for (const next of map.get(stack.pop()) ?? []) if (!into.has(next)) { into.add(next); stack.push(next) }
  return into
}

export const induced = (graph, ids) => withMaps(graph.nodes, graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)))

export function lineage(graph, focus) {
  if (!graph.nodes.has(focus)) return new Set()
  const ids = new Set([focus])
  walk(graph.parents, focus, ids)
  walk(graph.children, focus, ids)
  return ids
}

export function hiddenNeighbours(graph, ids) {
  const counts = new Map()
  for (const id of ids) {
    const near = [...(graph.parents.get(id) ?? []), ...(graph.children.get(id) ?? [])].filter((other) => !ids.has(other))
    if (near.length) counts.set(id, near.length)
  }
  return counts
}

export function columns(graph, ids) {
  const within = (map, id) => (map.get(id) ?? []).filter((other) => ids.has(other))
  const layer = new Map()
  const visiting = new Set()
  const depth = (id) => {
    if (layer.has(id)) return layer.get(id)
    if (visiting.has(id)) return 0
    visiting.add(id)
    const value = Math.max(-1, ...within(graph.parents, id).map(depth)) + 1
    visiting.delete(id)
    layer.set(id, value)
    return value
  }
  for (const id of ids) depth(id)
  const cols = []
  for (const [id, value] of layer) (cols[value] ??= []).push(id)
  const at = (id) => graph.nodes.get(id)?.at ?? 0
  const filled = cols.filter(Boolean)
  filled[0]?.sort((a, b) => at(a) - at(b))
  const place = (col, near, ref) => {
    const index = new Map(ref.map((id, i) => [id, i]))
    const centre = (id) => {
      const spots = within(near, id).map((other) => index.get(other)).filter((i) => i !== undefined)
      return spots.length ? spots.reduce((sum, i) => sum + i, 0) / spots.length : Infinity
    }
    col.sort((a, b) => centre(a) - centre(b) || at(a) - at(b))
  }
  for (let i = 1; i < filled.length; i += 1) place(filled[i], graph.parents, filled[i - 1])
  for (let i = filled.length - 2; i >= 0; i -= 1) place(filled[i], graph.children, filled[i + 1])
  for (let i = 1; i < filled.length; i += 1) place(filled[i], graph.parents, filled[i - 1])
  return filled
}

export function flowRows(graph) {
  const rows = []
  for (const [id, node] of graph.nodes) {
    const root = !(graph.parents.get(id) ?? []).some((parent) => !GROUP_KINDS.has(graph.nodes.get(parent)?.kind))
    if (GROUP_KINDS.has(node.kind) || !(node.kind === 'ticket' || node.kind === 'thread' || root)) continue
    const ids = walk(graph.children, id, new Set([id]))
    const members = [...ids].map((member) => graph.nodes.get(member))
    rows.push({
      ids,
      anchor: id,
      groups: (graph.parents.get(id) ?? []).filter((parent) => GROUP_KINDS.has(graph.nodes.get(parent)?.kind)),
      at: Math.max(0, ...members.map((member) => member.at)),
      loose: members.every((member) => member.loose),
    })
  }
  return rows.sort((a, b) => b.at - a.at)
}

export function shape(graph, ids) {
  return columns(graph, ids).map((col) => {
    const counts = new Map()
    for (const id of col) {
      const kind = graph.nodes.get(id).kind
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    return { ids: col, kinds: KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => [kind, counts.get(kind)]) }
  })
}

export const FOLD_OVER = 5

export function foldLeaves(sub, cols, { keep = new Set(), open = new Set(), over = FOLD_OVER } = {}) {
  const stacks = new Map()
  const moved = new Map()
  const out = cols.map((col, index) => {
    const next = [...col]
    for (const kind of ['session', 'mr']) {
      const id = `g:${index}:${kind}`
      const leaves = col.filter((member) => sub.nodes.get(member)?.kind === kind && !(sub.children.get(member) ?? []).length && !keep.has(member))
      if (leaves.length <= over) continue
      stacks.set(id, { id, kind, ids: leaves, open: open.has(id) })
      if (open.has(id)) continue
      for (const member of leaves) moved.set(member, id)
      next.splice(next.indexOf(leaves[0]), 0, id)
    }
    return next.filter((member) => !moved.has(member))
  })
  const seen = new Set()
  const edges = []
  for (const edge of sub.edges) {
    const to = moved.get(edge.to) ?? edge.to
    const key = `${edge.from}|${to}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ ...edge, to })
  }
  return { ...withMaps(sub.nodes, edges), cols: out, stacks }
}
