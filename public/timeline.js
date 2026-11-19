import { runsBetween } from './calendar.js'

const MINUTE = 60_000
const CRON_EXPIRY_MS = 7 * 24 * 60 * MINUTE
const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
const MAX_TIMES = 1500

function parseField(text, [lo, hi]) {
  const values = new Set()
  for (const part of text.split(',')) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part)
    if (!match) return null
    const start = match[1] === '*' ? lo : Number(match[1])
    const end = match[2] !== undefined ? Number(match[2]) : (match[1] === '*' || match[3] ? hi : start)
    const step = match[3] ? Number(match[3]) : 1
    if (start < lo || end > hi || start > end || step < 1) return null
    for (let v = start; v <= end; v += step) values.add(v)
  }
  return values
}

export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5) return null
  const sets = parts.map((part, i) => parseField(part, FIELDS[i]))
  if (sets.some((set) => !set)) return null
  const [minute, hour, dom, month, dow] = sets
  if (dow.has(7)) dow.add(0)
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' }
}

function dayMatches(cron, date) {
  const dom = cron.dom.has(date.getDate())
  const dow = cron.dow.has(date.getDay())
  if (cron.domAny && cron.dowAny) return true
  if (cron.domAny) return dow
  if (cron.dowAny) return dom
  return dom || dow
}

export function cronTimes(expr, from, to) {
  const cron = typeof expr === 'string' ? parseCron(expr) : expr
  if (!cron) return []
  const out = []
  const date = new Date(Math.ceil(from / MINUTE) * MINUTE)
  date.setSeconds(0, 0)
  while (date.getTime() < to && out.length < MAX_TIMES) {
    if (cron.month.has(date.getMonth() + 1) && dayMatches(cron, date) && cron.hour.has(date.getHours())) {
      if (cron.minute.has(date.getMinutes())) out.push(date.getTime())
      date.setMinutes(date.getMinutes() + 1)
    } else {
      date.setHours(date.getHours() + 1, 0, 0, 0)
    }
  }
  return out
}

export function dayBounds(nowMs) {
  const start = new Date(nowMs)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { dayStart: start.getTime(), dayEnd: end.getTime() }
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const REPEAT_LABELS = { none: 'once', daily: 'daily', weekdays: 'weekdays', weekly: 'weekly' }
const folderName = (folder) => String(folder ?? '').split('/').filter(Boolean).pop() ?? folder

function scheduleLane(routine, { dayStart, dayEnd, nowMs }) {
  const past = (routine.history ?? [])
    .filter((run) => run.at >= dayStart && run.at < Math.min(nowMs, dayEnd))
    .map((run) => ({ at: run.at, past: true, sessionId: run.sessionId ?? null, error: run.error ?? null }))
  const future = runsBetween(routine, Math.max(nowMs, dayStart), dayEnd).map((at) => ({ at, past: false }))
  return {
    key: `schedule-${routine.rid}`,
    kind: 'schedule',
    title: routine.name,
    project: folderName(routine.folder),
    rid: routine.rid,
    sessionId: routine.lastSessionId ?? null,
    status: routine.enabled ? 'scheduled' : 'paused',
    sub: `Schedule · ${REPEAT_LABELS[routine.repeat] ?? routine.repeat} ${hhmm(routine.at)}`,
    events: [...past, ...future].sort((a, b) => a.at - b.at),
  }
}

function loopFuture(loop, { dayStart, dayEnd, nowMs }) {
  if (loop.status === 'ended') return []
  if (loop.kind === 'wakeup') return loop.nextAt && loop.nextAt >= dayStart && loop.nextAt < dayEnd ? [loop.nextAt] : []
  const until = Math.min(dayEnd, loop.createdAt + CRON_EXPIRY_MS)
  const times = cronTimes(loop.cron, Math.max(nowMs, dayStart, loop.createdAt), until)
  return loop.recurring === false ? times.slice(0, 1) : times
}

function loopLane(loop, window) {
  const { dayStart, dayEnd, nowMs } = window
  const past = (loop.fires ?? [])
    .filter((at) => at >= dayStart && at < Math.min(nowMs, dayEnd))
    .map((at) => ({ at, past: true, sessionId: loop.sessionId }))
  const future = loopFuture(loop, window).map((at) => ({ at, past: false, sessionId: loop.sessionId }))
  const how = loop.kind === 'wakeup' ? 'self-paced' : (loop.recurring === false ? `once · ${loop.cron}` : (loop.every ? `every ${loop.every}m` : loop.cron))
  return {
    key: `loop-${loop.sessionId}-${loop.id}`,
    kind: loop.kind === 'wakeup' ? 'wakeup' : 'cron',
    title: loop.title,
    project: loop.project,
    sessionId: loop.sessionId,
    status: loop.status,
    sub: `Loop · ${how}${loop.status === 'looping' ? '' : ` · ${loop.status}`}`,
    loop,
    events: [...past, ...future].sort((a, b) => a.at - b.at),
  }
}

function promptLanes(session, { dayStart, dayEnd, nowMs }) {
  return (session.items ?? []).map((item) => ({
    key: `prompt-${item.sid}`,
    kind: 'prompt',
    title: session.title,
    project: session.project,
    sessionId: session.sessionId,
    status: 'scheduled',
    sub: `Queued prompt · ${REPEAT_LABELS[item.repeat ?? 'none'] ?? item.repeat}`,
    prompt: item.prompt,
    repeat: item.repeat ?? 'none',
    events: runsBetween({ enabled: true, at: item.at, repeat: item.repeat ?? 'none' }, Math.max(nowMs, dayStart), dayEnd)
      .map((at) => ({ at, past: false, sessionId: session.sessionId })),
  }))
}

export function timelineLanes({ routines = [], loops = [], prompts = [], nowMs = Date.now(), show = {} }) {
  const window = { ...dayBounds(nowMs), nowMs }
  const { schedules = true, loops: showLoops = true, past = true } = show
  const keep = (lane) => {
    const events = past ? lane.events : lane.events.filter((event) => !event.past)
    return events.length ? { ...lane, events } : null
  }
  const first = (lane) => lane.events[0].at
  const scheduleLanes = schedules ? routines.map((routine) => keep(scheduleLane(routine, window))).filter(Boolean).sort((a, b) => first(a) - first(b)) : []
  const promptRows = schedules ? prompts.flatMap((session) => promptLanes(session, window)).map(keep).filter(Boolean).sort((a, b) => first(a) - first(b)) : []
  const loopLanes = showLoops ? loops.filter((loop) => !loop.archived).map((loop) => keep(loopLane(loop, window))).filter(Boolean).sort((a, b) => first(a) - first(b)) : []
  return [...scheduleLanes, ...promptRows, ...loopLanes]
}

export function nextEvent(lanes, nowMs = Date.now()) {
  let best = null
  for (const lane of lanes) {
    const event = lane.events.find((e) => !e.past && e.at >= nowMs)
    if (event && (!best || event.at < best.event.at)) best = { lane, event }
  }
  return best
}

export function splitWindow(events, from, to) {
  const inside = []
  const before = []
  const after = []
  for (const event of events) (event.at < from ? before : event.at >= to ? after : inside).push(event)
  return { inside, before, after }
}

export function countdown(ms, nowMs = Date.now()) {
  const seconds = Math.round((ms - nowMs) / 1000)
  if (seconds <= 0) return 'due now'
  if (seconds < 90) return `in ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 10) return `in ${minutes}m ${seconds % 60}s`
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `in ${hours}h ${minutes % 60}m` : `in ${hours}h`
}

export const HOUR_PRESETS = [[7, 19], [8, 17], [9, 18], [10, 19], [0, 24]]
