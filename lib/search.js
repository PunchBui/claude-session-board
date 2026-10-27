const HITS_PER_SESSION = 3
const MAX_SESSIONS = 40
const SNIPPET_CONTEXT = 140

export function tokenize(query) {
  return String(query).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)
}

function snippetOf(text, lower, tokens) {
  const first = Math.min(...tokens.map((t) => lower.indexOf(t)).filter((i) => i >= 0))
  const start = Math.max(0, first - SNIPPET_CONTEXT)
  const end = Math.min(text.length, first + SNIPPET_CONTEXT * 2)
  const slice = text.slice(start, end).replace(/\*\*|`/g, '')
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`.replace(/\s+/g, ' ')
}

export function searchSessions(entries, query) {
  const tokens = tokenize(query)
  if (!tokens.length) return { tokens, totalHits: 0, sessions: [] }
  let totalHits = 0
  const sessions = []
  for (const entry of entries) {
    const hits = []
    let count = 0
    for (let i = entry.messages.length - 1; i >= 0; i -= 1) {
      const message = entry.messages[i]
      const lower = message.text.toLowerCase()
      if (!tokens.every((t) => lower.includes(t))) continue
      count += 1
      if (hits.length < HITS_PER_SESSION) hits.push({ role: message.role, at: message.at, snippet: snippetOf(message.text, lower, tokens) })
    }
    if (!count) continue
    totalHits += count
    sessions.push({ id: entry.id, title: entry.title, project: entry.project, cwd: entry.cwd, archived: entry.archived, count, latest: hits[0].at, hits })
  }
  sessions.sort((a, b) => String(b.latest).localeCompare(String(a.latest)))
  return { tokens, totalHits, sessions: sessions.slice(0, MAX_SESSIONS) }
}
