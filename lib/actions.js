export const MAX_ACTIONS = 5000

const IGNORED_ROUTES = new Set([
  '/api/login',
  '/api/upload',
  '/api/mrs/babysit',
  '/api/mrs/deploy',
  '/api/flow/milestone',
  '/api/focus/order',
])

const CHIP_LABEL = /^[A-Za-z][A-Za-z ,]{0,39}$/

const SESSION_ID = /^[A-Za-z0-9_-]{8,80}$/

export const isTrackedRoute = (route) => route.startsWith('/api/') && !IGNORED_ROUTES.has(route)

export function promptKind(text) {
  const first = String(text ?? '').trim().split(/\s+/)[0] ?? ''
  return /^\/[\w:-]{1,60}$/.test(first) ? first : 'text'
}

export function actionFrom({ route, body, status, userAgent, now }) {
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
  if ((route === '/api/prompt' || route === '/api/queue') && typeof body?.chip === 'string' && CHIP_LABEL.test(body.chip)) entry.chip = body.chip
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
    const key = entry.chip ? `${entry.route} chip:${entry.chip}` : entry.kind && entry.kind !== 'text' ? `${entry.route} ${entry.kind}` : entry.route
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.entries(counts)
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
}

export function recordWhenSent(res, make) {
  res.once('close', () => make(res.statusCode))
}
