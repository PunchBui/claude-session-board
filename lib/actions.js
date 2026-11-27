export const MAX_ACTIONS = 5000

const IGNORED_ROUTES = new Set([
  '/api/login',
  '/api/upload',
  '/api/mrs/babysit',
  '/api/mrs/deploy',
  '/api/watches/report',
  '/api/flow/milestone',
  '/api/focus/order',
])

const CHIP_LABEL = /^[A-Za-z][A-Za-z ,?]{0,39}$/

const SESSION_ID = /^[A-Za-z0-9_-]{8,80}$/

const REPLY_HEADS = new Set(['yes', 'no', 'push', 'commit', 'check', 'done', 'ok', 'okay', 'do', 'go', 'create', 'run', 'continue', 'proceed'])

export const SHOWN_TTL_MS = 30 * 60_000

export function parseShown(body) {
  const labels = Array.isArray(body?.labels) ? body.labels.filter((label) => typeof label === 'string' && CHIP_LABEL.test(label)).slice(0, 6) : []
  const id = typeof body?.id === 'string' && SESSION_ID.test(body.id) ? body.id : null
  return id && labels.length ? { id, labels } : null
}

export function replyShape(prompt) {
  const words = String(prompt ?? '').toLowerCase().match(/[a-z']+/g) ?? []
  const head = REPLY_HEADS.has(words[0]) ? words[0] : 'other'
  return `${head}:${Math.min(words.length, 9)}`
}

export const isTrackedRoute = (route) => route.startsWith('/api/') && !IGNORED_ROUTES.has(route)

export function promptKind(text) {
  const first = String(text ?? '').trim().split(/\s+/)[0] ?? ''
  return /^\/[\w:-]{1,60}$/.test(first) ? first : 'text'
}

export function actionFrom({ route, body, status, userAgent, now, shown = null }) {
  const entry = {
    at: now,
    route,
    status,
    source: /^curl\//i.test(userAgent ?? '') ? 'skill' : 'ui',
  }
  if (typeof body?.url === 'string') entry.url = body.url.slice(0, 400)
  const session = body?.id ?? body?.sessionId
  if (typeof session === 'string' && SESSION_ID.test(session)) entry.session = session
  if (route === '/api/prompt') entry.kind = promptKind(body?.prompt ?? body?.text)
  const sentPrompt = route === '/api/prompt' || route === '/api/queue'
  if (sentPrompt && typeof body?.chip === 'string' && CHIP_LABEL.test(body.chip)) entry.chip = body.chip
  if (sentPrompt && !entry.chip && shown && now - shown.at <= SHOWN_TTL_MS) {
    entry.chips = shown.labels.join(',')
    entry.typedAfterChips = replyShape(body?.prompt ?? body?.text)
  }
  if (route === '/api/chips/shown') {
    const parsed = parseShown(body)
    if (parsed) entry.chips = parsed.labels.join(',')
  }
  return entry
}

export function recordAction(log, entry) {
  const next = [...(Array.isArray(log) ? log : []), entry]
  return next.length > MAX_ACTIONS ? next.slice(next.length - MAX_ACTIONS) : next
}

export function summarizeActions(log, { now, days = 30, source = 'ui' }) {
  const since = now - days * 24 * 60 * 60_000
  const counts = {}
  for (const entry of Array.isArray(log) ? log : []) {
    if (entry.at < since || entry.source !== source || entry.status >= 400) continue
    const key = entry.typedAfterChips ? `${entry.route} typed-after-chips:${entry.typedAfterChips.split(':')[0]}` : entry.chip ? `${entry.route} chip:${entry.chip}` : entry.route === '/api/chips/shown' && entry.chips ? `${entry.route} ${entry.chips}` : entry.kind && entry.kind !== 'text' ? `${entry.route} ${entry.kind}` : entry.route
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.entries(counts)
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
}

export function recordWhenSent(res, make) {
  res.once('close', () => make(res.statusCode))
}
