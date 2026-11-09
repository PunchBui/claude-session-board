export const GROUPS = [
  { key: 'need', label: 'Needs you' },
  { key: 'working', label: 'Working' },
  { key: 'idle', label: 'Idle' },
]

export function groupOf(card) {
  if (card.live?.attention) return 'need'
  if (card.active || card.run?.state === 'running') return 'working'
  return 'idle'
}

export const SORTS = [
  { key: 'manual', label: 'Manual order' },
  { key: 'prompt', label: 'Last prompt' },
  { key: 'activity', label: 'Last activity' },
  { key: 'title', label: 'Name (A–Z)' },
  { key: 'project', label: 'Project (A–Z)' },
]

export const sortKey = (value) => (SORTS.some((s) => s.key === value) ? value : 'manual')

const byText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base', numeric: true })

// Orders the cards inside each group. `promptAt(card)` says when each was last prompted.
export function sortCards(cards, mode, { promptAt = () => 0 } = {}) {
  const by = {
    prompt: (a, b) => promptAt(b) - promptAt(a),
    activity: (a, b) => (b.touchedAt ?? b.lastActivityAt ?? 0) - (a.touchedAt ?? a.lastActivityAt ?? 0),
    title: (a, b) => byText(a.title, b.title),
    // A session with no project sorts after the named ones.
    project: (a, b) => (a.project ? 0 : 1) - (b.project ? 0 : 1) || byText(a.project, b.project) || byText(a.title, b.title),
  }[sortKey(mode)]
  return by ? [...cards].sort(by) : cards
}

export function groupCards(cards, query = '') {
  const q = query.trim().toLowerCase()
  const shown = q ? cards.filter((c) => `${c.title} ${c.project} ${c.cwd}`.toLowerCase().includes(q)) : cards
  return GROUPS
    .map((g) => ({ ...g, cards: shown.filter((c) => groupOf(c) === g.key) }))
    .filter((g) => g.cards.length)
}

// Moves `id` next to `targetId` (before it, or after it when `after`), only within the same group.
export function moveWithin(order, id, targetId, after, sameGroup = () => true) {
  if (id === targetId || !order.includes(id) || !order.includes(targetId) || !sameGroup(id, targetId)) return order
  const rest = order.filter((x) => x !== id)
  const at = rest.indexOf(targetId) + (after ? 1 : 0)
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

export const flatten = (groups) => groups.flatMap((g) => g.cards)

export function pickSelected(groups, selected) {
  const all = flatten(groups)
  return all.find((c) => c.id === selected) ?? all[0] ?? null
}

export function neighbour(groups, id, step) {
  const all = flatten(groups)
  if (!all.length) return null
  const at = all.findIndex((c) => c.id === id)
  if (at === -1) return all[0].id
  return all[Math.min(all.length - 1, Math.max(0, at + step))].id
}

export function shortAge(ms, now = Date.now()) {
  if (!ms) return ''
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
