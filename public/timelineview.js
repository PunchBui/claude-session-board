import { attachTip, hideTip } from './tip.js'
import { icon } from './icons.js'
import { loopTip } from './loops.js'
import { timelineLanes, nextEvent, splitWindow, countdown, dayBounds, HOUR_PRESETS } from './timeline.js'

const KEY = 'board.timeline'
const HOUR = 3_600_000
const DEFAULTS = { collapsed: false, hours: [9, 18], show: { finished: true, schedules: true, loops: true, past: true } }
const FILTERS = [
  ['finished', 'Finished', 'Rows with nothing left to run today'],
  ['schedules', 'Schedules', 'Schedule-tab runs and prompts queued on a session'],
  ['loops', 'Loops', 'Cron and self-paced loops'],
  ['past', 'Past runs', 'Runs that already happened today'],
]

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const pad = (h) => String(h).padStart(2, '0')

function el(tag, className, content) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { ...DEFAULTS, ...saved, show: { ...DEFAULTS.show, ...saved.show } }
  } catch {
    return { ...DEFAULTS, show: { ...DEFAULTS.show } }
  }
}

export function createTimeline(host, { projectColor, openSession, openSchedule }) {
  let settings = loadSettings()
  let data = { routines: [], loops: [], prompts: [] }
  let lanes = []
  let signature = ''
  let builtMinute = -1
  let live = []
  let deferred = false

  host.dataset.ownTips = ''
  host.addEventListener('mouseleave', () => { if (deferred) render() })

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch {} }
  const range = () => {
    const { dayStart } = dayBounds(Date.now())
    return { from: dayStart + settings.hours[0] * HOUR, to: dayStart + settings.hours[1] * HOUR }
  }
  const percent = (at, { from, to }) => `${((at - from) / (to - from)) * 100}%`

  function openLane(lane, event) {
    if (lane.kind === 'schedule' && !(event?.past && event.sessionId)) return openSchedule(lane.rid)
    const id = event?.sessionId ?? lane.sessionId
    if (id) openSession(id)
  }

  function eventTip(lane, event) {
    const now = Date.now()
    if (lane.kind === 'schedule') {
      if (event.past) {
        return {
          heading: event.error ? 'Run failed' : 'Ran today',
          text: `${lane.title}. ${event.sessionId ? 'Click to open the session this run started.' : 'This run did not start a session.'}`,
          rows: [['Ran', hhmm(event.at)], ...(event.error ? [['Error', event.error]] : []), ['Project', lane.project]],
        }
      }
      return { heading: 'Scheduled', text: `${lane.title}. Click to edit this schedule.`, rows: [['Runs', `${hhmm(event.at)} (${countdown(event.at, now)})`], ['Project', lane.project]] }
    }
    if (lane.kind === 'prompt') {
      const prompt = lane.prompt.length > 140 ? `${lane.prompt.slice(0, 140)}…` : lane.prompt
      return { heading: 'Scheduled prompt', text: `${lane.title}. Click to open this session in Focus.`, rows: [['Project', lane.project], ['Runs', `${hhmm(event.at)} (${countdown(event.at, now)})`], ['Prompt', prompt]] }
    }
    const base = loopTip(lane.loop, now)
    return { heading: base.heading, text: `${lane.title}. Click to open this session in Focus.`, rows: [['Project', lane.project], ...base.rows] }
  }

  function header(next) {
    const head = el('div', 'tl-head')
    const title = el('div', 'tl-title')
    title.append(el('b', '', 'Today'), el('span', 'tl-date', `${new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${pad(settings.hours[0])}–${pad(settings.hours[1])}`))
    head.append(title)
    const upcoming = el('button', 'tl-next')
    upcoming.type = 'button'
    if (next) {
      upcoming.append(el('span', 'tl-next-label', 'Next'), el('span', 'tl-next-title', next.lane.title))
      const when = el('span', 'tl-next-when')
      live.push({ node: when, at: next.event.at, format: (at) => `${hhmm(at)} · ${countdown(at)}` })
      upcoming.append(when)
      upcoming.style.setProperty('--project', projectColor(next.lane.project))
      upcoming.onclick = () => openLane(next.lane, next.event)
    } else {
      upcoming.append(el('span', 'tl-next-label', 'Nothing else scheduled today'))
      upcoming.disabled = true
    }
    head.append(upcoming, el('span', 'tl-spacer'))
    const filters = el('div', 'tl-filters')
    for (const [key, label, hint] of FILTERS) {
      const b = el('button', 'tl-filter', label)
      b.type = 'button'
      b.title = `${settings.show[key] ? 'Hide' : 'Show'}: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`
      b.setAttribute('aria-pressed', String(settings.show[key]))
      b.onclick = () => { settings.show[key] = !settings.show[key]; save(); render(true) }
      filters.append(b)
    }
    const hours = el('select', 'tl-hours')
    hours.setAttribute('aria-label', 'Hours shown')
    for (const [start, end] of HOUR_PRESETS) {
      const option = new Option(start === 0 && end === 24 ? 'All day' : `${pad(start)}–${pad(end)}`, `${start}-${end}`)
      hours.append(option)
    }
    hours.value = settings.hours.join('-')
    hours.onchange = () => { settings.hours = hours.value.split('-').map(Number); save(); render(true) }
    const collapse = el('button', 'icon-only tl-collapse')
    collapse.type = 'button'
    collapse.append(icon(settings.collapsed ? 'chevron-down' : 'chevron-up', { size: 15 }))
    const label = settings.collapsed ? 'Show the timeline' : 'Hide the timeline'
    collapse.title = label
    collapse.setAttribute('aria-label', label)
    collapse.setAttribute('aria-expanded', String(!settings.collapsed))
    collapse.onclick = () => { settings.collapsed = !settings.collapsed; save(); render(true) }
    if (!settings.collapsed) head.append(filters, hours)
    head.append(collapse)
    return head
  }

  function grid(window) {
    const overlay = el('div', 'tl-grid')
    const now = Date.now()
    if (now > window.from) {
      const shade = el('div', 'tl-past')
      shade.style.width = now >= window.to ? '100%' : percent(now, window)
      overlay.append(shade)
    }
    const span = settings.hours[1] - settings.hours[0]
    for (let h = 0; h <= span; h++) {
      const line = el('div', 'tl-hour')
      line.style.left = `${(h / span) * 100}%`
      overlay.append(line)
      if (h < span && span <= 12) {
        const half = el('div', 'tl-half')
        half.style.left = `${((h + 0.5) / span) * 100}%`
        overlay.append(half)
      }
    }
    if (now >= window.from && now < window.to) {
      const line = el('div', 'tl-now')
      line.style.left = percent(now, window)
      live.push({ node: line, now: true })
      overlay.append(line)
    }
    return overlay
  }

  function axis(window) {
    const track = el('div', 'tl-axis')
    const span = settings.hours[1] - settings.hours[0]
    const every = span > 12 ? 2 : 1
    const now = Date.now()
    for (let h = 0; h <= span; h += every) {
      const at = window.from + h * HOUR
      const label = el('span', 'tl-axis-hour', `${pad(settings.hours[0] + h)}:00`)
      label.style.left = `${(h / span) * 100}%`
      if (Math.abs(at - now) < HOUR / (span > 12 ? 2 : 4)) label.classList.add('tl-near-now')
      track.append(label)
    }
    if (now >= window.from && now < window.to) {
      const tag = el('span', 'tl-now-tag', hhmm(now))
      tag.style.left = percent(now, window)
      live.push({ node: tag, now: true, clock: true })
      track.append(tag)
    }
    return track
  }

  function laneLabel(lane) {
    const label = el('button', 'tl-label')
    label.type = 'button'
    label.style.setProperty('--project', projectColor(lane.project))
    label.append(el('span', 'tl-dot'))
    const words = el('span', 'tl-words')
    words.append(el('span', 'tl-lane-title', lane.title), el('span', 'tl-lane-sub', `${lane.sub} · ${lane.project}`))
    label.append(words)
    label.title = lane.kind === 'schedule' ? 'Edit this schedule' : 'Open this session in Focus'
    label.onclick = () => openLane(lane)
    return label
  }

  function edge(events, side, window) {
    const mark = el('span', `tl-edge tl-edge-${side}`, side === 'before' ? `‹ ${events.length}` : `${events.length} ›`)
    const times = events.slice(0, 6).map((e) => hhmm(e.at)).join(', ')
    mark.title = `${events.length} ${side === 'before' ? 'earlier' : 'later'} today, outside ${pad(settings.hours[0])}–${pad(settings.hours[1])}: ${times}${events.length > 6 ? '…' : ''}`
    return mark
  }

  function scheduleTrack(lane, track, inside, window) {
    for (const event of inside) {
      const chip = el('button', `tl-run${event.past ? ' tl-run-past' : ''}${event.error ? ' tl-run-error' : ''}`)
      chip.type = 'button'
      chip.style.left = percent(event.at, window)
      chip.append(el('span', '', `${event.past ? (event.error ? '✕' : '✓') : '◷'} ${hhmm(event.at)}`))
      chip.onclick = (e) => { e.stopPropagation(); openLane(lane, event) }
      attachTip(chip, () => eventTip(lane, event))
      track.append(chip)
    }
  }

  function loopTrack(lane, track, inside, window) {
    const now = Date.now()
    const future = inside.filter((e) => !e.past)
    if (lane.kind === 'cron' && future.length > 1) {
      const rail = el('div', 'tl-rail')
      rail.style.left = percent(future[0].at, window)
      rail.style.right = `calc(100% - ${percent(future.at(-1).at, window)})`
      track.append(rail)
    }
    for (const event of inside) {
      const mark = el('span', lane.kind !== 'cron' ? (event.past ? 'tl-fire' : 'tl-wake') : (event.past ? 'tl-fire' : 'tl-tick'))
      mark.style.left = percent(event.at, window)
      track.append(mark)
    }
    const next = future.find((e) => e.running || e.at >= now)
    if (next) {
      const pill = el('span', 'tl-pill')
      pill.style.left = percent(next.at, window)
      if (next.running) pill.textContent = 'running now'
      else live.push({ node: pill, at: next.at, format: (at) => `next ${hhmm(at)} · ${countdown(at)}` })
      track.append(pill)
    }
    track.classList.add('tl-clickable')
    track.onclick = () => openLane(lane)
    attachTip(track, () => eventTip(lane, next ?? inside.at(-1)))
  }

  function body(window) {
    const box = el('div', 'tl-body')
    const rows = Math.max(lanes.length, 1)
    box.style.gridTemplateRows = `26px repeat(${rows}, 30px)`
    const overlay = grid(window)
    overlay.style.gridRow = `2 / ${rows + 2}`
    box.append(el('div', 'tl-corner'), axis(window), overlay)
    if (!lanes.length) {
      const empty = el('div', 'tl-empty', 'No schedules or loops run today.')
      box.append(el('div', 'tl-label-empty'), empty)
      return box
    }
    lanes.forEach((lane, index) => {
      const { before, inside, after } = splitWindow(lane.events, window.from, window.to)
      const track = el('div', `tl-track tl-${lane.kind}${lane.status === 'stalled' || lane.status === 'paused' ? ' tl-dim' : ''}${lane.status === 'ended' ? ' tl-ended' : ''}`)
      track.style.setProperty('--project', projectColor(lane.project))
      if (lane.kind === 'schedule') scheduleTrack(lane, track, inside, window)
      else loopTrack(lane, track, inside, window)
      if (before.length) track.append(edge(before, 'before', window))
      if (after.length) track.append(edge(after, 'after', window))
      const label = laneLabel(lane)
      label.style.gridRow = track.style.gridRow = String(index + 2)
      box.append(label, track)
    })
    return box
  }

  function tick() {
    const window = range()
    const now = Date.now()
    if (Math.floor(now / 60_000) !== builtMinute && !deferred) {
      render()
      if (!deferred) return
    }
    for (const item of live) {
      if (item.now) {
        item.node.style.left = percent(now, window)
        if (item.clock) item.node.textContent = hhmm(now)
      } else item.node.textContent = item.format(item.at)
    }
  }

  function render(force = false) {
    const now = Date.now()
    lanes = timelineLanes({ ...data, nowMs: now, show: settings.show })
    const upcoming = (lane) => lane.events.find((e) => !e.past)
    const nextSignature = JSON.stringify([lanes.map((l) => [l.key, l.status, l.events.length, upcoming(l)?.running ? 'running' : upcoming(l)?.at]), settings])
    const stale = nextSignature !== signature || Math.floor(now / 60_000) !== builtMinute
    if (!force && !stale) return tick()
    if (!force && host.matches(':hover')) {
      deferred = true
      return
    }
    deferred = false
    signature = nextSignature
    builtMinute = Math.floor(now / 60_000)
    hideTip(host)
    live = []
    const window = range()
    host.replaceChildren(header(nextEvent(lanes, now)))
    host.classList.toggle('tl-collapsed', settings.collapsed)
    if (!settings.collapsed) host.append(body(window))
    tick()
  }

  return {
    update(next) {
      data = { ...data, ...next }
      render()
    },
    tick,
  }
}
