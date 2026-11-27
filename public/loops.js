const ACTIVE = new Set(['looping', 'stalled'])

export function diffLoops(previous, sessions) {
  const events = []
  const next = new Map()
  for (const session of sessions) {
    const now = session.loop?.state ?? null
    next.set(session.id, now)
    if (!previous) continue
    const before = previous.get(session.id) ?? null
    const add = (kind, message) => events.push({ id: session.id, title: session.title, kind, message })
    if (ACTIVE.has(before) && now === 'ended') add('loopdone', 'Loop finished')
    if (before === 'looping' && now === 'stalled') add('stalled', 'Loop stalled: the next check-in is overdue')
  }
  return { events, next }
}

export function withoutTickFinishes(events, loopEvents) {
  const done = new Set(loopEvents.map((event) => event.id))
  return events.filter((event) => !(event.kind === 'finished' && done.has(event.id)))
}

export function untilLabel(ms, nowMs = Date.now()) {
  const seconds = Math.round((ms - nowMs) / 1000)
  if (seconds <= 0) return 'due now'
  if (seconds < 60) return `in ${seconds}s`
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`
  return `in ${Math.round(seconds / 3600)}h`
}

const SPAN_UNITS = [[86400, 'd'], [3600, 'h'], [60, 'm']]

export function spanLabel(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  for (const [size, unit] of SPAN_UNITS) if (seconds >= size) return `${Math.round(seconds / size)}${unit}`
  return `${seconds}s`
}

const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
export const ago = (ms, nowMs) => `${when(ms)} (${spanLabel(nowMs - ms)} ago)`
const ahead = (ms, nowMs) => (ms > nowMs ? `${when(ms)} (in ${spanLabel(ms - nowMs)})` : `${when(ms)} (${spanLabel(nowMs - ms)} overdue)`)

export const END_DETAILS = {
  deleted: 'Claude cancelled this job, usually because the thing it was watching was done.',
  fired: 'A one-shot job that ran once, as planned.',
  stopped: 'The session stopped its self-paced loop.',
  finished: 'The last run did not schedule another one, so the loop wound down.',
  removed: 'The session\'s own job list no longer includes it, so it stopped running without being cancelled. This happens when the app restarts or the job never registered.',
  expired: 'Cron jobs are cancelled automatically after 7 days.',
}

export function loopTip(loop, nowMs = Date.now()) {
  const rows = []
  let heading
  let text
  if (loop.status === 'ended' || loop.state === 'ended') {
    heading = 'Loop ended'
    text = END_DETAILS[loop.endReason] ?? 'This loop is no longer scheduled.'
  } else if ((loop.status ?? loop.state) === 'stalled') {
    heading = 'Loop stalled'
    text = 'The next check-in is overdue. The session may be asleep or closed, or the job may never have started.'
  } else {
    heading = 'Loop running'
    text = loop.nextAt ? 'On schedule. Waiting for the next run.' : 'A check is running right now.'
  }
  const state = loop.status ?? loop.state
  if (loop.count > 1) rows.push(['Scheduled tasks', String(loop.count)])
  if (loop.kind === 'wakeup') rows.push(['Type', 'Self-paced (/loop)'])
  else if (loop.recurring === false) rows.push(['Type', `One-shot · ${loop.cron}`])
  else if (loop.every) rows.push(['Schedule', `Every ${loop.every} min`])
  else if (loop.cron) rows.push(['Schedule', loop.cron])
  if (loop.createdAt) rows.push(['Started', ago(loop.createdAt, nowMs)])
  if (loop.fireCount !== undefined) rows.push(['Runs', String(loop.fireCount)])
  rows.push(['Last run', loop.lastFiredAt ? ago(loop.lastFiredAt, nowMs) : 'never'])
  if (state !== 'ended' && loop.nextAt) rows.push([state === 'stalled' ? 'Was due' : 'Next run', ahead(loop.nextAt, nowMs)])
  if (loop.endedAt) rows.push(['Ended', ago(loop.endedAt, nowMs)])
  return { heading, text, rows }
}

export const SESSION_STATUS = {
  in_progress: 'Claude is working on it, or was a moment ago.',
  review_ready: 'Claude finished a piece of work and is waiting for you to review it.',
  completed: 'The task is done.',
  blocked: 'Marked as blocked, usually waiting on something outside the session.',
  'needs-input': 'Claude asked a question and is waiting for your answer.',
  needs_input: 'Claude asked a question and is waiting for your answer.',
  unknown: 'The app has not recorded a status for this session yet.',
}

export function statusTip(status, detail, lastActivityAt, nowMs = Date.now()) {
  const rows = []
  if (detail) rows.push(['Latest', detail])
  if (lastActivityAt) rows.push(['Last activity', ago(lastActivityAt, nowMs)])
  return { heading: status.replace(/[_-]/g, ' '), text: SESSION_STATUS[status] ?? 'Status reported by the Claude app.', rows }
}

export function byLatestEnded(a, b) {
  const aActive = !a.endedAt
  const bActive = !b.endedAt
  if (aActive !== bActive) return aActive ? -1 : 1
  if (aActive) return b.createdAt - a.createdAt
  return b.endedAt - a.endedAt || b.createdAt - a.createdAt
}

export function diffBackground(previous, sessions) {
  const events = []
  const next = new Map()
  for (const session of sessions) {
    const before = previous?.get(session.id) ?? 0
    if (!session.background) {
      next.set(session.id, before)
      continue
    }
    const running = session.background.running ?? 0
    next.set(session.id, running)
    if (!previous) continue
    if (before > 0 && running === 0) {
      const { done, failed } = session.background
      const text = `${before} background ${before === 1 ? 'task' : 'tasks'} finished${failed ? `, ${failed} failed` : ''}`
      events.push({ id: session.id, title: session.title, kind: failed ? 'bgfailed' : 'bgdone', message: done ? text : 'Background tasks stopped' })
    }
  }
  return { events, next }
}
