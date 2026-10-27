import { CONTEXT_CAUTION, CONTEXT_DANGER, contextLevel, diffAlerts } from './alerts.js'
import { icon } from './icons.js'
import { splitFences } from './richtext.js'
import { addEvents, markAllRead, markRead, unreadCount } from './history.js'

const ROUTES = { '/': 'all', '/focus': 'focus', '/search': 'search', '/usage': 'usage' }
const PAGE_TITLES = { all: 'Sessions', focus: 'Focus', search: 'Search', usage: 'Usage' }
const ALERT_ICONS = { finished: 'check-circle', question: 'help-circle', approval: 'pause-circle', blocked: 'octagon-x', context: 'triangle-alert', failed: 'x-circle', paused: 'pause-circle' }
const $ = (id) => document.getElementById(id)

const state = {
  tab: 'all',
  sessions: [],
  focusIds: [],
  cards: [],
  status: null,
  signature: '',
  timer: null,
  cols: 'auto',
  expanded: null,
  flashId: null,
  history: [],
  commands: new Map(),
  historyOpen: false,
  historyNew: new Set(),
  flashUntil: 0,
  drafts: new Map(),
  notes: new Map(),
  ui: new Map(),
  changes: new Map(),
  snippets: [],
  alertsOn: false,
  alertSnap: null,
  unseen: 0,
  search: { timer: null, runId: 0 },
  usage: { days: 30, metric: 'output', data: null, at: 0 },
}

try {
  state.cols = localStorage.getItem('board.cols') || 'auto'
  state.alertsOn = localStorage.getItem('board.alerts') === '1'
  state.usage.days = Number(localStorage.getItem('board.usageDays')) || 30
  state.usage.metric = localStorage.getItem('board.usageMetric') || 'output'
} catch {}

const remember = (key, value) => { try { localStorage.setItem(key, value) } catch {} }

const relative = (ms) => {
  if (!ms) return '—'
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
const duration = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '')
const dateTime = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
const compact = (n) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
  return String(n)
}
const projectColor = (name) => {
  let hash = 0
  for (const ch of name ?? '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${hash % 360} 52% 46%)`
}
const home = (p) => (p ? p.replace(/^\/Users\/[^/]+/, '~') : '—')
const text = (value) => document.createTextNode(value ?? '')

function el(tag, className, content) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.append(text(content))
  return node
}
function cell(...nodes) {
  const td = document.createElement('td')
  td.append(...nodes)
  return td
}
function sinceSpan(iso) {
  const span = el('span', 'since')
  const at = Date.parse(iso)
  if (Number.isFinite(at)) {
    span.dataset.since = String(at)
    span.textContent = duration(Date.now() - at)
  }
  return span
}
const projectChip = (s) => {
  const chip = el('span', 'chip', s.project ?? 'unknown')
  chip.style.setProperty('--project', projectColor(s.project))
  return chip
}
const openLink = (id, primary) => {
  const a = el('a', `btn${primary ? ' primary' : ''}`, 'Open')
  a.append(icon('arrow-up-right', { size: 14 }))
  a.href = `claude://code/continue?session=${encodeURIComponent(id)}`
  a.title = 'Open in Claude desktop'
  return a
}
const statusBadge = (status) => {
  const span = el('span', `status ${status}`)
  span.append(el('span', 'dot'), text(status.replace(/_/g, ' ')))
  return span
}
const uiOf = (id) => {
  if (!state.ui.has(id)) state.ui.set(id, { pane: 'chat', popover: null, at: '', repeat: 'none', snippetLabel: '' })
  return state.ui.get(id)
}

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}
const getJson = (path) => fetch(path, { cache: 'no-store' }).then((r) => r.json())
const resync = async () => { state.signature = ''; await refresh() }

function setNote(id, message) {
  if (message) state.notes.set(id, message)
  else state.notes.delete(id)
}

function toast(event) {
  const box = el('div', `toast ${event.kind}`)
  const heading = el('b')
  heading.append(icon(ALERT_ICONS[event.kind] ?? 'check-circle', { size: 16 }), el('span', undefined, event.title))
  box.append(heading, el('span', 'msg-text', event.message))
  box.onclick = () => {
    box.remove()
    if (state.cards.some((c) => c.id === event.id)) goToCard(event.id)
    else navigate('/focus')
  }
  $('toasts').append(box)
  setTimeout(() => box.remove(), 9000)
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
    osc.start()
    osc.stop(ctx.currentTime + 0.4)
  } catch {}
}

function readHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem('board.history') ?? '[]')
    return Array.isArray(stored) ? stored : []
  } catch {
    return []
  }
}

function writeHistory(history) {
  state.history = history
  try { localStorage.setItem('board.history', JSON.stringify(history)) } catch {}
  renderHistoryBadge()
  if (state.historyOpen) renderHistoryPanel()
}

function recordHistory(events) {
  writeHistory(addEvents(readHistory(), events))
}

function renderHistoryBadge() {
  const count = unreadCount(state.history)
  const badge = $('history-count')
  badge.hidden = count === 0
  badge.textContent = count > 9 ? '9+' : String(count)
  $('history').title = count ? `Notification history (${count} unread)` : 'Notification history'
}

function openFromHistory(entry) {
  writeHistory(markRead(state.history, entry.uid))
  setHistoryOpen(false)
  if (state.cards.some((c) => c.id === entry.id)) goToCard(entry.id)
  else window.location.href = `claude://code/continue?session=${encodeURIComponent(entry.id)}`
}

function renderHistoryPanel() {
  const panel = $('notif-panel')
  panel.replaceChildren()
  const head = el('div', 'notif-head')
  head.append(el('h3', undefined, 'Notifications'))
  const readAll = el('button', 'btn', 'Mark all read')
  readAll.disabled = unreadCount(state.history) === 0
  readAll.onclick = () => { state.historyNew = new Set(); writeHistory(markAllRead(state.history)) }
  const clear = el('button', 'btn', 'Clear')
  clear.disabled = state.history.length === 0
  clear.onclick = () => { state.historyNew = new Set(); writeHistory([]) }
  head.append(readAll, clear)
  const list = el('div', 'notif-list')
  if (!state.history.length) {
    list.append(el('div', 'notif-empty', 'Nothing yet. Alerts are listed here when a focused session finishes, asks a question or may need approval.'))
  }
  for (const entry of state.history) {
    const row = el('button', `notif-item ${entry.kind}${entry.read && !state.historyNew.has(entry.uid) ? '' : ' unread'}`)
    row.type = 'button'
    const body = el('div', 'notif-body')
    const top = el('div', 'notif-top')
    top.append(el('span', 't', entry.title), el('time', undefined, relative(entry.at)))
    body.append(top, el('div', 'm', entry.message))
    row.append(icon(ALERT_ICONS[entry.kind] ?? 'check-circle', { size: 18 }), body)
    row.onclick = () => openFromHistory(entry)
    list.append(row)
  }
  panel.append(head, list)
}

function setHistoryOpen(open) {
  if (open === state.historyOpen) return
  state.historyOpen = open
  $('history').setAttribute('aria-expanded', String(open))
  $('notif-panel').hidden = !open
  if (open) {
    state.history = readHistory()
    state.historyNew = new Set(state.history.filter((entry) => !entry.read).map((entry) => entry.uid))
    renderHistoryPanel()
  } else {
    state.historyNew = new Set()
    writeHistory(markAllRead(readHistory()))
  }
}

function updateTitle() {
  const base = `${PAGE_TITLES[state.tab]} · Claude Session Board`
  document.title = state.unseen > 0 ? `(${state.unseen}) ${base}` : base
}

function notify(events) {
  events.forEach(toast)
  beep()
  if ('Notification' in window && Notification.permission === 'granted') {
    for (const event of events) {
      const n = new Notification(event.title, { body: event.message, tag: `${event.id}:${event.kind}` })
      n.onclick = () => { window.focus(); goToCard(event.id) }
    }
  }
  if (document.hidden) {
    state.unseen += events.length
    updateTitle()
  }
}

function renderAlertsButton() {
  const button = $('alerts')
  button.setAttribute('aria-pressed', String(state.alertsOn))
  button.replaceChildren(icon(state.alertsOn ? 'volume-2' : 'volume-x', { size: 16 }), text(state.alertsOn ? 'Alerts on' : 'Alerts off'))
}

async function toggleAlerts() {
  if (!state.alertsOn && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission() } catch {}
  }
  state.alertsOn = !state.alertsOn
  remember('board.alerts', state.alertsOn ? '1' : '0')
  renderAlertsButton()
  if (state.alertsOn) toast({ id: 'alerts', title: 'Alerts on', kind: 'finished', message: 'You will be told when a focused session finishes, asks a question or needs approval.' })
}

async function setFocus(id, focused) {
  const { ok, data } = await postJson('/api/focus', { id, focused })
  if (ok) {
    state.focusIds = data.ids
    await resync()
  }
}

function starButton(id) {
  const on = state.focusIds.includes(id)
  const b = el('button', 'star')
  b.append(icon('star', { size: 18, fill: on }))
  b.setAttribute('aria-pressed', String(on))
  b.title = on ? 'Remove from Focus' : 'Add to Focus'
  b.onclick = () => setFocus(id, !on)
  return b
}

function visible() {
  const q = $('q').value.trim().toLowerCase()
  return state.sessions.filter((s) =>
    ($('archived').checked || !s.archived) &&
    (!state.status || s.status === state.status) &&
    (!q || `${s.title} ${s.cwd} ${s.project}`.toLowerCase().includes(q)))
}

function renderSummary() {
  const pool = state.sessions.filter((s) => $('archived').checked || !s.archived)
  const counts = pool.reduce((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {})
  const box = $('summary')
  box.replaceChildren()
  const make = (label, value) => {
    const b = el('button', 'pill', label)
    b.setAttribute('aria-pressed', String(state.status === value))
    b.onclick = () => { state.status = state.status === value ? null : value; renderSummary(); renderRows(); writeFilters() }
    box.append(b)
  }
  make(`All ${pool.length}`, null)
  Object.entries(counts).forEach(([status, n]) => make(`${status.replace(/_/g, ' ')} ${n}`, status))
}

function renderRows() {
  const rows = visible()
  const body = $('rows')
  body.replaceChildren()
  $('empty').hidden = rows.length > 0
  for (const s of rows) {
    const tr = document.createElement('tr')
    const title = el('div')
    title.append(el('div', 'row-title', s.title))
    if (s.detail) title.append(el('div', 'row-sub', s.detail))
    const project = el('div')
    project.append(projectChip(s), el('div', 'path', home(s.cwd)))
    tr.append(
      cell(starButton(s.id)),
      cell(title),
      cell(project),
      cell(statusBadge(s.status)),
      cell(el('span', 'num', s.model ?? '—')),
      cell(el('span', 'num', String(s.completedTurns))),
      cell(el('span', 'num', relative(s.lastActivityAt))),
      cell(openLink(s.id))
    )
    body.append(tr)
  }
}

const LINK_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(\S+?\)|https?:\/\/[^\s<>"'`]+)/g
const SAFE_PROTOCOLS = new Set(['http:', 'https:'])

function safeUrl(value) {
  try {
    const url = new URL(value)
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function splitTrailing(value) {
  let url = value
  let tail = ''
  while (/[.,;:!?'"]$/.test(url) || (url.endsWith(')') && (url.match(/\)/g) ?? []).length > (url.match(/\(/g) ?? []).length)) {
    tail = url.slice(-1) + tail
    url = url.slice(0, -1)
  }
  return [url, tail]
}

function linkNode(href, label) {
  const a = el('a', 'chat-link')
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.title = href
  if (typeof label === 'string') a.append(text(label))
  else a.append(label)
  return a
}

function inline(parent, value) {
  value.split(LINK_PATTERN).forEach((part) => {
    if (!part) return
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      const code = el('code', undefined, part.slice(1, -1))
      const href = /^https?:\/\/\S+$/.test(part.slice(1, -1)) ? safeUrl(part.slice(1, -1)) : null
      parent.append(href ? linkNode(href, code) : code)
    } else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      const strong = el('strong')
      inline(strong, part.slice(2, -2))
      parent.append(strong)
    } else if (part.startsWith('[') && /\]\(\S+\)$/.test(part)) {
      const split = part.lastIndexOf('](')
      const label = part.slice(1, split)
      const href = safeUrl(part.slice(split + 2, -1))
      parent.append(href ? linkNode(href, label) : text(part))
    } else if (/^https?:\/\//.test(part)) {
      const [url, tail] = splitTrailing(part)
      const href = safeUrl(url)
      if (href) parent.append(linkNode(href, url), text(tail))
      else parent.append(text(part))
    } else {
      parent.append(text(part))
    }
  })
}

function linkifyPlain(parent, value) {
  value.split(/(https?:\/\/[^\s<>"'`]+)/g).forEach((part) => {
    if (!part) return
    if (/^https?:\/\//.test(part)) {
      const [url, tail] = splitTrailing(part)
      const href = safeUrl(url)
      if (href) parent.append(linkNode(href, url), text(tail))
      else parent.append(text(part))
    } else {
      parent.append(text(part))
    }
  })
}

function codeBlock(part) {
  const wrap = el('div', 'codeblock')
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  linkifyPlain(code, part.text)
  pre.append(code)
  const bar = el('div', 'code-bar')
  if (part.lang) bar.append(el('span', 'lang', part.lang))
  const copy = el('button', 'copy')
  copy.type = 'button'
  copy.title = 'Copy'
  copy.append(icon('copy', { size: 14 }))
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(part.text)
      copy.replaceChildren(icon('check', { size: 14 }))
      setTimeout(() => copy.replaceChildren(icon('copy', { size: 14 })), 1400)
    } catch {}
  }
  bar.append(copy)
  wrap.append(bar, pre)
  return wrap
}

function richText(parent, value) {
  for (const part of splitFences(value)) {
    if (part.type === 'code') {
      parent.append(codeBlock(part))
    } else {
      const para = el('div', 'para')
      inline(para, part.text)
      parent.append(para)
    }
  }
}

function renderMessage(m) {
  if (m.role === 'command') {
    const wrap = el('div', 'msg command')
    const box = el('div', 'cmd-output')
    const head = el('div', 'cmd-head')
    head.append(icon('terminal', { size: 14 }), text(m.command ? `${m.command} output` : 'Command output'))
    const pre = document.createElement('pre')
    linkifyPlain(pre, m.text)
    box.append(head, pre)
    wrap.append(box)
    return wrap
  }
  if (m.role === 'tools') {
    const wrap = el('div', 'msg tools')
    const box = document.createElement('details')
    box.className = 'toolbox'
    const names = [...new Set(m.tools.map((t) => t.name))].join(', ')
    box.append(el('summary', undefined, `${m.tools.length} tool call${m.tools.length > 1 ? 's' : ''} · ${names}`))
    const list = document.createElement('ul')
    for (const t of m.tools) {
      const li = document.createElement('li')
      li.append(el('b', undefined, t.name), el('span', undefined, t.hint))
      list.append(li)
    }
    box.append(list)
    wrap.append(box)
    return wrap
  }
  const wrap = el('div', `msg ${m.role}`)
  const body = el('div', 'body')
  richText(body, m.text)
  wrap.append(body, el('time', undefined, clock(m.at)))
  return wrap
}

function autosize(box) {
  box.style.height = 'auto'
  box.style.height = `${Math.min(box.scrollHeight, 180)}px`
}

async function submitPrompt(id, box) {
  const prompt = box.value.trim()
  if (!prompt) return
  const card = state.cards.find((c) => c.id === id)
  const busy = card?.run?.state === 'running' || card?.active || card?.queue?.items.length > 0
  setNote(id, 'Sending…')
  let result = await postJson(busy ? '/api/queue' : '/api/prompt', { id, prompt })
  if (!result.ok && !busy && /busy|already running/.test(result.data.error ?? '')) {
    result = await postJson('/api/queue', { id, prompt })
  }
  if (result.ok) {
    state.drafts.delete(id)
    setNote(id, null)
  } else {
    setNote(id, result.data.error ?? 'Could not send')
  }
  await resync()
}

async function createSchedule(c, box) {
  const ui = uiOf(c.id)
  const prompt = box.value.trim()
  const at = new Date(ui.at).getTime()
  if (!prompt) return setNote(c.id, 'Type the prompt to schedule first.') || renderFocus()
  if (!Number.isFinite(at)) return setNote(c.id, 'Pick a date and time.') || renderFocus()
  const { ok, data } = await postJson('/api/schedule', { id: c.id, prompt, at, repeat: ui.repeat })
  if (ok) {
    state.drafts.delete(c.id)
    ui.popover = null
    setNote(c.id, null)
  } else {
    setNote(c.id, data.error ?? 'Could not schedule')
  }
  await resync()
}

async function loadCommands(id) {
  const known = state.commands.get(id)
  if (known && (known.loading || Date.now() - known.at < 60_000)) return
  state.commands.set(id, { items: known?.items ?? null, loading: true, at: Date.now() })
  let items = known?.items ?? []
  try {
    items = (await getJson(`/api/commands?id=${encodeURIComponent(id)}`)).items ?? []
  } catch {}
  state.commands.set(id, { items, loading: false, at: Date.now() })
  resyncSlash(id)
}

function slashMatches(id, value) {
  if (!value.startsWith('/') || /\s/.test(value)) return null
  const items = state.commands.get(id)?.items
  if (!items) return null
  const query = value.slice(1).toLowerCase()
  const starts = []
  const contains = []
  for (const item of items) {
    const name = item.name.toLowerCase()
    if (name.startsWith(query)) starts.push(item)
    else if (name.includes(query) || (query.length > 1 && item.description.toLowerCase().includes(query))) contains.push(item)
  }
  return [...starts, ...contains].slice(0, 40)
}

function acceptSlash(id, box, item) {
  const next = `/${item.name} `
  box.value = next
  state.drafts.set(id, next)
  autosize(box)
  box.focus()
  box.setSelectionRange(next.length, next.length)
  resyncSlash(id)
}

function syncSlash(id, dock, box) {
  dock.querySelector('.slash-menu')?.remove()
  const ui = uiOf(id)
  if (box.value.startsWith('/') && !state.commands.has(id)) loadCommands(id)
  const matches = ui.slashDismissed === box.value ? null : slashMatches(id, box.value)
  ui.slashItems = matches ?? []
  if (!matches?.length) return
  ui.slashIndex = Math.min(ui.slashIndex ?? 0, matches.length - 1)
  const menu = el('div', 'popover slash-menu')
  matches.forEach((item, index) => {
    const row = el('div', `slash-item${index === ui.slashIndex ? ' active' : ''}`)
    const main = el('div', 'slash-main')
    main.append(el('span', 'slash-name', `/${item.name}`))
    if (item.hint) main.append(el('span', 'slash-hint', item.hint))
    main.append(el('span', `slash-src ${item.source}`, item.source))
    row.append(main)
    if (item.description) row.append(el('div', 'slash-desc', item.description))
    row.onmousedown = (event) => { event.preventDefault(); acceptSlash(id, box, item) }
    menu.append(row)
  })
  dock.append(menu)
  menu.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
}

function resyncSlash(id) {
  const box = document.querySelector(`[data-keep="composer:${id}"]`)
  const dock = box?.closest('.dock')
  if (box && dock) syncSlash(id, dock, box)
}

function renderQueue(c) {
  const queue = c.queue ?? { items: [], paused: false }
  if (!queue.items.length) return null
  const wrap = el('div', 'queue')
  const head = el('div', `queue-head${queue.paused ? ' paused' : ''}`)
  head.append(text(queue.paused ? `Queue paused (${queue.items.length}) after a failed or stopped run` : `Queued (${queue.items.length}) · sent in order when the session is idle`))
  if (queue.paused) {
    const resume = el('button', 'btn', 'Resume')
    resume.onclick = () => postJson('/api/queue/resume', { id: c.id }).then(resync)
    head.append(resume)
  }
  wrap.append(head)
  queue.items.forEach((item, index) => {
    const row = el('div', 'queue-item')
    const remove = el('button')
    remove.append(icon('x', { size: 14 }))
    remove.title = 'Remove from queue'
    remove.onclick = () => postJson('/api/queue/remove', { id: c.id, qid: item.qid }).then(resync)
    row.append(el('span', 'n', String(index + 1)), el('span', 't', item.prompt), remove)
    wrap.append(row)
  })
  return wrap
}

function renderSchedules(c) {
  const items = c.schedules ?? []
  if (!items.length) return null
  const wrap = el('div', 'sched-list')
  for (const item of items) {
    const row = el('div', 'sched-item')
    const repeat = item.repeat === 'none' ? '' : ` · ${item.repeat}`
    const remove = el('button')
    remove.append(icon('x', { size: 14 }))
    remove.title = 'Cancel schedule'
    remove.onclick = () => postJson('/api/schedule/remove', { sid: item.sid }).then(resync)
    row.append(icon('clock', { size: 15 }), el('span', 'when', `${dateTime(item.at)}${repeat}`), el('span', 't', item.prompt), remove)
    wrap.append(row)
  }
  return wrap
}

function insertSnippet(c, box, snippet) {
  const next = box.value ? `${box.value}\n${snippet.text}` : snippet.text
  state.drafts.set(c.id, next)
  uiOf(c.id).popover = null
  renderFocus()
  const field = document.querySelector(`[data-keep="composer:${c.id}"]`)
  if (field) { field.focus(); field.setSelectionRange(next.length, next.length) }
}

function renderSnippetPopover(c, box) {
  const ui = uiOf(c.id)
  const pop = el('div', 'popover')
  pop.append(el('h4', undefined, 'Prompt shortcuts'))
  const list = el('div', 'snip-list')
  for (const snippet of state.snippets) {
    const row = el('div', 'snip')
    const remove = el('button')
    remove.append(icon('x', { size: 14 }))
    remove.title = 'Delete shortcut'
    remove.onclick = (event) => { event.stopPropagation(); postJson('/api/snippets/remove', { sid: snippet.sid }).then(({ data }) => { state.snippets = data.items ?? state.snippets; renderFocus() }) }
    row.append(el('span', 'l', snippet.label), el('span', 't', snippet.text), remove)
    row.onclick = () => insertSnippet(c, box, snippet)
    list.append(row)
  }
  pop.append(list)
  const save = el('div', 'row')
  const label = document.createElement('input')
  label.className = 'field'
  label.placeholder = 'Name for the text in the box'
  label.value = ui.snippetLabel
  label.dataset.keep = `snippet-label:${c.id}`
  label.oninput = () => { ui.snippetLabel = label.value }
  const button = el('button', 'btn', 'Save as shortcut')
  button.onclick = async () => {
    const draft = state.drafts.get(c.id) ?? ''
    if (!ui.snippetLabel.trim() || !draft.trim()) return setNote(c.id, 'Type the prompt in the box and a name first.') || renderFocus()
    const { ok, data } = await postJson('/api/snippets', { label: ui.snippetLabel, text: draft })
    if (ok) { state.snippets = data.items; ui.snippetLabel = ''; setNote(c.id, null) } else setNote(c.id, data.error ?? 'Could not save')
    renderFocus()
  }
  save.append(label, button)
  pop.append(save)
  return pop
}

function renderSchedulePopover(c, box) {
  const ui = uiOf(c.id)
  if (!ui.at) ui.at = toLocalInput(Date.now() + 3600_000)
  const pop = el('div', 'popover')
  pop.append(el('h4', undefined, 'Send the text in the box later'))
  const row = el('div', 'row')
  const when = document.createElement('input')
  when.type = 'datetime-local'
  when.className = 'field'
  when.value = ui.at
  when.dataset.keep = `schedule-at:${c.id}`
  when.oninput = () => { ui.at = when.value }
  const repeat = document.createElement('select')
  repeat.className = 'field'
  for (const [value, label] of [['none', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays']]) {
    const option = el('option', undefined, label)
    option.value = value
    repeat.append(option)
  }
  repeat.value = ui.repeat
  repeat.onchange = () => { ui.repeat = repeat.value }
  row.append(when, repeat)
  const presets = el('div', 'presets')
  const nextAt = (hour) => {
    const d = new Date()
    d.setHours(hour, 0, 0, 0)
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  for (const [label, value] of [['In 30 min', () => Date.now() + 30 * 60_000], ['In 1 hour', () => Date.now() + 3600_000], ['In 3 hours', () => Date.now() + 3 * 3600_000], ['Next 9:00', () => nextAt(9)], ['Next 18:00', () => nextAt(18)]]) {
    const b = el('button', undefined, label)
    b.onclick = () => { ui.at = toLocalInput(value()); renderFocus() }
    presets.append(b)
  }
  const go = el('button', 'btn primary', 'Schedule')
  go.onclick = () => createSchedule(c, box)
  pop.append(row, presets, go)
  return pop
}

function renderComposer(c) {
  const ui = uiOf(c.id)
  const dock = el('div', 'dock')
  const running = c.run?.state === 'running'
  const busy = running || c.active || c.queue?.items.length > 0
  const composer = el('div', 'composer')
  const box = document.createElement('textarea')
  box.rows = 1
  box.placeholder = busy ? 'Add a prompt to the queue · / for commands' : 'Reply to this session · / for commands'
  box.value = state.drafts.get(c.id) ?? ''
  box.dataset.keep = `composer:${c.id}`
  box.onfocus = () => loadCommands(c.id)
  box.oninput = () => {
    state.drafts.set(c.id, box.value)
    ui.slashDismissed = null
    ui.slashIndex = 0
    autosize(box)
    syncSlash(c.id, dock, box)
  }
  box.onkeydown = (event) => {
    const options = ui.slashItems ?? []
    if (options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        ui.slashIndex = (ui.slashIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        syncSlash(c.id, dock, box)
        return
      }
      const chosen = options[ui.slashIndex]
      const typedInFull = box.value === `/${chosen.name}`
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !typedInFull)) {
        event.preventDefault()
        acceptSlash(c.id, box, chosen)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        ui.slashDismissed = box.value
        syncSlash(c.id, dock, box)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submitPrompt(c.id, box)
    }
  }
  composer.append(box)

  const tools = el('div', 'tools')
  for (const [name, glyph, title] of [['snippets', 'zap', 'Prompt shortcuts'], ['schedule', 'clock', 'Schedule this prompt']]) {
    const b = el('button', 'tool')
    b.append(icon(glyph, { size: 18 }))
    b.title = title
    b.setAttribute('aria-pressed', String(ui.popover === name))
    b.onclick = () => { ui.popover = ui.popover === name ? null : name; renderFocus() }
    tools.append(b)
  }
  composer.append(tools)
  if (running) {
    const stop = el('button', 'send stop-side wide')
    stop.append(icon('square', { size: 12, fill: true }), text('Stop'))
    stop.title = 'Stop the running prompt'
    stop.onclick = () => postJson('/api/prompt/stop', { id: c.id }).then(refresh)
    composer.append(stop)
  }
  const send = el('button', busy ? 'send wide' : 'send')
  if (busy) send.append(text('Queue'))
  else send.append(icon('arrow-up', { size: 18, strokeWidth: 2.5 }))
  send.title = busy ? 'Add to queue (Enter)' : 'Send (Enter)'
  send.onclick = () => submitPrompt(c.id, box)
  composer.append(send)

  const note = el('div', 'run-note')
  const local = state.notes.get(c.id)
  if (local) {
    note.textContent = local
    note.classList.add(local === 'Sending…' ? 'running' : 'error')
  } else if (running) {
    note.textContent = `Running headless (${c.run.mode}) · started ${relative(c.run.startedAt)}`
    note.classList.add('running')
  } else if (c.run?.state === 'failed') {
    note.textContent = `Last prompt failed: ${c.run.error}`
    note.classList.add('error')
  } else if (c.run?.state === 'stopped') {
    note.textContent = 'Last prompt was stopped.'
  } else if (c.active) {
    note.textContent = 'Busy in the desktop app. New prompts are queued until it is idle.'
  }

  for (const part of [renderSchedules(c), renderQueue(c)]) if (part) dock.append(part)
  if (ui.popover === 'snippets') dock.append(renderSnippetPopover(c, box))
  if (ui.popover === 'schedule') dock.append(renderSchedulePopover(c, box))
  dock.append(composer, note)
  syncSlash(c.id, dock, box)
  requestAnimationFrame(() => autosize(box))
  return dock
}

function renderUsage(c, head) {
  if (!c.usage) return
  const level = contextLevel(c.usage.context)
  const row = el('div', 'usage')
  const stat = (label, value, className) => {
    const s = el('span', `stat${className ? ` ${className}` : ''}`)
    s.title = `${value.toLocaleString()} tokens`
    s.append(el('b', undefined, compact(value)), text(label))
    row.append(s)
  }
  stat('context', c.usage.context, level ? `context ${level}` : 'context')
  stat('out', c.usage.output)
  stat('in', c.usage.input)
  stat('cache read', c.usage.cacheRead)
  stat('cache write', c.usage.cacheWrite)
  row.append(el('span', 'stat', `${c.usage.responses} responses`))
  if (level) {
    const limit = level === 'danger' ? CONTEXT_DANGER : CONTEXT_CAUTION
    const verb = level === 'danger' ? 'compact or start a new session' : 'consider compacting'
    row.prepend(el('span', `context-alert ${level}`, `Over ${compact(limit)} · ${verb}`))
  }
  head.append(row)
}

function renderAttention(c) {
  const a = c.live?.attention
  if (!a) return null
  const box = el('div', `attention ${a.kind}`)
  const body = el('div')
  const title = el('b', undefined, a.kind === 'question' ? `Waiting for your answer (${a.tool})` : `Possibly waiting for approval · ${a.tool} pending `)
  body.append(title)
  if (a.kind === 'approval') body.append(sinceSpan(a.since))
  if (a.text) body.append(el('div', 'what', a.text))
  box.append(icon(a.kind === 'question' ? 'help-circle' : 'pause-circle', { size: 18 }), body)
  return box
}

function renderNowDoing(c) {
  const live = c.live
  if (!live || (live.phase === 'idle' && !live.subagents.length)) return null
  const box = el('div', 'nowdoing')
  if (live.phase !== 'idle') {
    const line = el('div', 'line')
    line.append(el('span', 'pulse'))
    if (live.phase === 'tool') {
      const body = el('div')
      const top = el('div')
      top.append(el('b', undefined, `Running ${live.current.name}`), text(' '), sinceSpan(live.current.since))
      body.append(top)
      if (live.current.text) body.append(el('div', 'what', live.current.text))
      line.append(body)
    } else {
      line.append(el('b', undefined, live.phase === 'thinking' ? 'Thinking…' : 'Writing a reply…'))
    }
    box.append(line)
  }
  for (const sub of live.subagents) {
    const line = el('div', 'line sub')
    line.append(icon('corner-down-right', { size: 14 }), el('b', undefined, sub.name), el('span', 'what', sub.text), sinceSpan(sub.since))
    box.append(line)
  }
  return box
}

function renderChat(c) {
  const chat = el('div', 'chat')
  const inner = el('div', 'chat-inner')
  const messages = c.details?.chat ?? []
  if (!c.transcriptFound) chat.append(el('div', 'chat-empty', 'Transcript file not found for this session.'))
  else if (!messages.length) chat.append(el('div', 'chat-empty', 'No messages yet.'))
  else {
    inner.append(...messages.map(renderMessage))
    chat.append(inner)
  }
  return chat
}

function section(title, ...children) {
  const box = el('div', 'section')
  box.append(el('h3', undefined, title), ...children)
  return box
}

function renderChanges(c) {
  const wrap = el('div', 'changes')
  const inner = el('div', 'changes-inner')
  wrap.append(inner)
  const entry = state.changes.get(c.id)
  if (!entry?.data) {
    inner.append(el('div', 'chat-empty', 'Loading changes…'))
    return wrap
  }
  const { git, files, tickets, links } = entry.data

  if (git?.available) {
    const line = el('div', 'git-line')
    const branch = el('span', 'branch')
    branch.append(icon('git-branch', { size: 13 }), text(git.branch ?? 'detached'))
    line.append(branch)
    if (git.ahead || git.behind) line.append(el('span', 'delta', `${git.ahead} ahead, ${git.behind} behind ${git.upstream ?? 'upstream'}`))
    line.append(el('span', 'delta', git.dirtyCount ? `${git.dirtyCount} uncommitted file${git.dirtyCount > 1 ? 's' : ''}` : 'working tree clean'))
    if (git.diffstat) line.append(el('span', 'delta', git.diffstat))
    const parts = [line]
    if (git.lastCommit) {
      const commit = el('div', 'commit')
      commit.append(el('code', undefined, git.lastCommit.hash), text(` ${git.lastCommit.subject} · ${git.lastCommit.when}`))
      parts.push(commit)
    }
    for (const file of git.files) {
      const row = el('div', 'file-row')
      const kind = file.code === '?' || file.code === '??' ? 'untracked' : file.code
      row.append(el('span', `code ${kind}`, file.code), el('code', undefined, file.path))
      parts.push(row)
    }
    inner.append(section('Git working tree', ...parts))
  } else {
    inner.append(section('Git working tree', el('div', 'muted', git?.reason ?? 'Not available')))
  }

  const touched = files.length
    ? files.map((f) => {
        const row = el('div', 'file-row')
        row.append(el('code', undefined, f.rel), el('span', 'meta', `${f.tools.join('/')} ×${f.count} · ${relative(Date.parse(f.lastAt))}`))
        return row
      })
    : [el('div', 'muted', 'No file edits recorded in this session.')]
  inner.append(section(`Files Claude edited (${files.length})`, ...touched))

  const refs = el('div', 'chips')
  for (const t of tickets) {
    const chip = t.url ? el('a', 'link-chip', `${t.key} ×${t.count}`) : el('span', 'link-chip', `${t.key} ×${t.count}`)
    if (t.url) { chip.href = t.url; chip.target = '_blank'; chip.rel = 'noopener' }
    refs.append(chip)
  }
  for (const l of links) {
    const chip = el('a', 'link-chip', `MR !${l.url.split('/').pop()}`)
    chip.href = l.url
    chip.target = '_blank'
    chip.rel = 'noopener'
    chip.title = l.url
    refs.append(chip)
  }
  if (!tickets.length && !links.length) refs.append(el('span', 'muted', 'No ticket keys or merge request links mentioned.'))
  inner.append(section('Tickets and merge requests', refs))
  return wrap
}

async function loadChanges(id) {
  const entry = state.changes.get(id) ?? { data: null, at: 0, loading: false }
  state.changes.set(id, entry)
  if (entry.loading) return
  entry.loading = true
  try {
    entry.data = await getJson(`/api/changes?id=${encodeURIComponent(id)}`)
    entry.at = Date.now()
  } catch {}
  entry.loading = false
  renderFocus()
}

function pollChanges() {
  for (const c of state.cards) {
    if (uiOf(c.id).pane !== 'changes') continue
    const entry = state.changes.get(c.id)
    if (!entry || Date.now() - entry.at > 10_000) loadChanges(c.id)
  }
}

function renderCard(c) {
  const ui = uiOf(c.id)
  const card = el('article', `card${c.active ? ' active' : ''}${state.expanded === c.id ? ' expanded' : ''}${state.flashId === c.id && Date.now() < state.flashUntil ? ' flash' : ''}`)
  card.dataset.id = c.id
  card.style.setProperty('--project', projectColor(c.project))
  const level = contextLevel(c.usage?.context ?? 0)
  if (level) card.classList.add(`ctx-${level}`)

  const head = el('div', 'card-head')
  const row = el('div', 'head-row')
  const titleBox = el('div', 'head-title')
  const meta = el('div', 'meta-line')
  meta.append(projectChip(c), el('span', 'path', home(c.cwd)))
  for (const t of [c.model?.replace(/^claude-/, ''), c.effort && `${c.effort} effort`, c.permissionMode, `${c.completedTurns} ${c.completedTurns === 1 ? 'turn' : 'turns'}`]) {
    if (t) meta.append(el('span', 'dotted', t))
  }
  titleBox.append(el('div', 'title', c.title), meta)
  const live = el('span', 'live')
  live.append(el('span', 'dot'), text(c.active ? 'Working' : `Idle · ${relative(c.touchedAt)}`))
  const expand = el('button', 'icon-only')
  const isExpanded = state.expanded === c.id
  expand.append(icon(isExpanded ? 'minimize' : 'maximize', { size: 16 }))
  expand.title = isExpanded ? 'Shrink (Esc)' : 'Enlarge this card'
  expand.onclick = () => setExpanded(isExpanded ? null : c.id)
  const actions = el('div', 'head-actions')
  actions.append(live, openLink(c.id), expand)
  row.append(starButton(c.id), titleBox, actions)
  head.append(row)
  for (const part of [renderAttention(c), renderNowDoing(c)]) if (part) head.append(part)
  renderUsage(c, head)
  if (c.detail) head.append(el('div', 'summary-line', c.detail))

  const switcher = el('div', 'seg pane-switch')
  for (const [pane, label] of [['chat', 'Chat'], ['changes', 'Changes']]) {
    const b = el('button', undefined, label)
    if (pane === 'changes' && c.details?.filesEdited) b.append(el('span', 'n', String(c.details.filesEdited)))
    b.setAttribute('aria-pressed', String(ui.pane === pane))
    b.onclick = () => { ui.pane = pane; renderFocus(); if (pane === 'changes') loadChanges(c.id) }
    switcher.append(b)
  }
  head.append(switcher)

  card.append(head, ui.pane === 'changes' ? renderChanges(c) : renderChat(c), renderComposer(c))
  return card
}

function renderFocus() {
  const grid = $('cards')
  grid.className = `cards cols-${state.cols}`
  const saved = new Map()
  grid.querySelectorAll('.card').forEach((card) => {
    const chat = card.querySelector('.chat')
    const changes = card.querySelector('.changes')
    saved.set(card.dataset.id, {
      top: chat?.scrollTop ?? 0,
      changesTop: changes?.scrollTop ?? 0,
      stick: card.dataset.stick !== 'false',
      open: [...card.querySelectorAll('.toolbox')].map((d) => d.open),
    })
  })
  const active = document.activeElement
  const keep = active?.dataset?.keep
  const caret = keep && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null
  const nodes = state.cards.map(renderCard)
  grid.replaceChildren(...nodes)
  nodes.forEach((card) => {
    const prev = saved.get(card.dataset.id)
    card.dataset.stick = String(prev ? prev.stick : true)
    const chat = card.querySelector('.chat')
    if (chat) {
      if (prev) card.querySelectorAll('.toolbox').forEach((d, i) => { d.open = Boolean(prev.open[i]) })
      const place = () => { chat.scrollTop = card.dataset.stick === 'true' ? chat.scrollHeight : prev.top }
      place()
      requestAnimationFrame(place)
      chat.addEventListener('scroll', () => {
        card.dataset.stick = String(chat.scrollHeight - chat.clientHeight - chat.scrollTop < 40)
      })
    }
    const changes = card.querySelector('.changes')
    if (changes && prev) changes.scrollTop = prev.changesTop
  })
  if (keep) {
    const field = grid.querySelector(`[data-keep="${keep}"]`)
    if (field && !field.disabled) {
      field.focus()
      if (caret && field.setSelectionRange && field.type !== 'datetime-local') field.setSelectionRange(...caret)
    }
  }
  if (state.expanded && !state.cards.some((c) => c.id === state.expanded) && state.cards.length) state.expanded = null
  document.body.classList.toggle('modal-open', Boolean(state.expanded))
  $('backdrop').hidden = !state.expanded
  $('focus-empty').hidden = state.cards.length > 0
  const badge = $('focus-count')
  badge.hidden = state.focusIds.length === 0
  badge.textContent = String(state.focusIds.length)
  document.querySelectorAll('#layout button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cols === state.cols)))
}

function goToCard(id) {
  if (state.expanded && state.expanded !== id) {
    state.expanded = null
    history.replaceState({}, '', '/focus')
  }
  state.flashId = id
  state.flashUntil = Date.now() + 2200
  if (state.tab !== 'focus') navigate('/focus')
  else renderFocus()
  const reveal = (attempt = 0) => {
    const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)
    if (!card) return attempt < 20 ? setTimeout(() => reveal(attempt + 1), 150) : undefined
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  requestAnimationFrame(() => reveal())
  setTimeout(() => {
    state.flashId = null
    document.querySelectorAll('.card.flash').forEach((node) => node.classList.remove('flash'))
  }, 2300)
}

function setExpanded(id) {
  if (id) {
    history.pushState({ card: id }, '', `/focus?card=${encodeURIComponent(id)}`)
  } else if (history.state?.card) {
    history.back()
    return
  } else {
    history.replaceState({}, '', '/focus')
  }
  state.expanded = id
  renderFocus()
}

function openBroadcast() {
  const targets = $('broadcast-targets')
  targets.replaceChildren()
  for (const c of state.cards) {
    const label = el('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = true
    box.value = c.id
    label.append(box, projectChip(c), el('span', undefined, c.title))
    targets.append(label)
  }
  const snips = $('broadcast-snippets')
  snips.replaceChildren()
  for (const snippet of state.snippets) {
    const b = el('button', undefined, snippet.label)
    b.onclick = () => { const t = $('broadcast-text'); t.value = t.value ? `${t.value}\n${snippet.text}` : snippet.text }
    snips.append(b)
  }
  $('broadcast-status').textContent = state.cards.length ? '' : 'Star some sessions first.'
  $('broadcast').showModal()
}

async function sendBroadcast() {
  const ids = [...$('broadcast-targets').querySelectorAll('input:checked')].map((box) => box.value)
  const prompt = $('broadcast-text').value.trim()
  if (!ids.length || !prompt) {
    $('broadcast-status').textContent = 'Pick at least one session and type a prompt.'
    return
  }
  const { ok, data } = await postJson('/api/broadcast', { ids, prompt })
  if (!ok) {
    $('broadcast-status').textContent = data.error ?? 'Could not send'
    return
  }
  $('broadcast').close()
  $('broadcast-text').value = ''
  toast({ id: 'broadcast', title: 'Queued', kind: 'finished', message: `${data.queued.length} session${data.queued.length === 1 ? '' : 's'} queued${data.skipped.length ? `, ${data.skipped.length} skipped` : ''}.` })
  await resync()
}

function highlight(parent, value, tokens) {
  const pattern = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  value.split(pattern).forEach((part, index) => {
    if (!part) return
    if (index % 2 === 1) parent.append(el('mark', undefined, part))
    else parent.append(text(part))
  })
}

function renderSearch(data) {
  const box = $('search-results')
  box.replaceChildren()
  const { indexed } = data
  $('search-status').textContent = data.tokens.length
    ? `${data.totalHits} message${data.totalHits === 1 ? '' : 's'} in ${data.sessions.length} session${data.sessions.length === 1 ? '' : 's'}${indexed.running ? ` · still indexing (${indexed.done}/${indexed.total})` : ` · ${indexed.total} sessions indexed`}`
    : indexed.running ? `Indexing ${indexed.done}/${indexed.total} sessions…` : `${indexed.total} sessions indexed`
  for (const s of data.sessions) {
    const card = el('div', 'result')
    const head = el('div', 'result-head')
    head.append(starButton(s.id), el('div', 'title', s.title), projectChip(s), el('span', 'path', `${s.count} match${s.count === 1 ? '' : 'es'}`), openLink(s.id))
    card.append(head)
    for (const hit of s.hits) {
      const row = el('div', 'hit')
      const snippet = el('div', 'snippet')
      highlight(snippet, hit.snippet, data.tokens)
      row.append(el('div', 'who', `${hit.role === 'user' ? 'You' : 'Claude'} · ${new Date(hit.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}`), snippet)
      card.append(row)
    }
    box.append(card)
  }
  if (data.tokens.length && !data.sessions.length) box.append(el('div', 'empty', 'No conversation contains all of those words.'))
}

async function runSearch() {
  const q = $('search-q').value.trim()
  history.replaceState(history.state, '', q ? `/search?q=${encodeURIComponent(q)}` : '/search')
  const runId = ++state.search.runId
  clearTimeout(state.search.timer)
  try {
    const data = await getJson(`/api/search?q=${encodeURIComponent(q.length >= 2 ? q : '')}`)
    if (runId !== state.search.runId || state.tab !== 'search') return
    renderSearch(data)
    if (data.indexed.running) state.search.timer = setTimeout(runSearch, 2500)
  } catch {}
}

const metricValue = (bucket, metric) => (metric === 'output' ? bucket.output : metric === 'fresh' ? bucket.input + bucket.cacheWrite : bucket.cacheRead)

function renderUsagePage() {
  const data = state.usage.data
  if (!data) return
  const { metric } = state.usage
  const dayTotals = data.days.map((day) => data.projects.reduce((sum, p) => sum + metricValue(data.series[p]?.[day] ?? { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 }, metric), 0))
  const projectTotals = data.projects.map((p) => ({ p, total: data.days.reduce((sum, day) => sum + metricValue(data.series[p]?.[day] ?? { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 }, metric), 0) })).sort((a, b) => b.total - a.total)
  const total = dayTotals.reduce((a, b) => a + b, 0)
  const busiestIndex = dayTotals.indexOf(Math.max(...dayTotals, 0))
  const responses = data.sessions.reduce((sum, s) => sum + s.responses, 0)

  const cards = $('usage-cards')
  cards.replaceChildren()
  for (const [value, label] of [[compact(total), 'tokens in range'], [String(dayTotals.filter(Boolean).length), `active days of ${data.days.length}`], [dayTotals[busiestIndex] ? `${data.days[busiestIndex].slice(5)} · ${compact(dayTotals[busiestIndex])}` : '—', 'busiest day'], [compact(responses), 'responses (top sessions)']]) {
    const card = el('div', 'stat-card')
    card.append(el('b', undefined, value), el('span', undefined, label))
    cards.append(card)
  }

  const W = 1000
  const H = 280
  const pad = { left: 52, right: 8, top: 12, bottom: 26 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const max = Math.max(...dayTotals, 1)
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('role', 'img')
  const add = (name, attrs, content) => {
    const node = document.createElementNS(svgNs, name)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    if (content) node.textContent = content
    svg.append(node)
    return node
  }
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + plotH - (plotH * i) / 4
    add('line', { x1: pad.left, x2: W - pad.right, y1: y, y2: y, class: 'grid' })
    add('text', { x: pad.left - 8, y: y + 4, 'text-anchor': 'end' }, compact(Math.round((max * i) / 4)))
  }
  const slot = plotW / data.days.length
  const barW = Math.max(2, slot * 0.7)
  data.days.forEach((day, index) => {
    let y = pad.top + plotH
    const x = pad.left + slot * index + (slot - barW) / 2
    for (const { p } of projectTotals) {
      const value = metricValue(data.series[p]?.[day] ?? { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 }, metric)
      if (!value) continue
      const h = (value / max) * plotH
      y -= h
      const rect = add('rect', { x, y, width: barW, height: h, rx: 2, fill: projectColor(p) })
      const title = document.createElementNS(svgNs, 'title')
      title.textContent = `${day} · ${p}: ${value.toLocaleString()} tokens`
      rect.append(title)
    }
    if (index % Math.ceil(data.days.length / 10) === 0 || index === data.days.length - 1) add('text', { x: x + barW / 2, y: H - 8, 'text-anchor': 'middle' }, day.slice(5))
  })
  $('usage-chart').replaceChildren(svg)

  const legend = $('usage-legend')
  legend.replaceChildren()
  for (const { p, total: t } of projectTotals) {
    if (!t) continue
    const item = el('span')
    const swatch = el('i')
    swatch.style.background = projectColor(p)
    item.append(swatch, text(`${p} · ${compact(t)}`))
    legend.append(item)
  }

  const rows = $('usage-rows')
  rows.replaceChildren()
  for (const s of data.sessions) {
    const tr = document.createElement('tr')
    tr.append(
      cell(el('div', 'row-title', s.title)),
      cell(projectChip(s)),
      cell(el('span', 'num', compact(s.output))),
      cell(el('span', 'num', compact(s.input))),
      cell(el('span', 'num', compact(s.cacheRead))),
      cell(el('span', 'num', compact(s.cacheWrite))),
      cell(el('span', 'num', String(s.responses))),
      cell(openLink(s.id))
    )
    rows.append(tr)
  }
  document.querySelectorAll('#usage-metric button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.metric === state.usage.metric)))
  document.querySelectorAll('#usage-days button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === state.usage.days)))
}

async function loadUsage() {
  try {
    state.usage.data = await getJson(`/api/usage?days=${state.usage.days}`)
    state.usage.at = Date.now()
    renderUsagePage()
  } catch {}
}

const pathTab = () => ROUTES[location.pathname.replace(/(.)\/+$/, '$1')] ?? 'all'

function writeFilters() {
  if (state.tab !== 'all') return
  const params = new URLSearchParams()
  if ($('q').value.trim()) params.set('q', $('q').value.trim())
  if (state.status) params.set('status', state.status)
  if ($('archived').checked) params.set('archived', '1')
  const query = params.toString()
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}`)
}

function readFilters() {
  const params = new URLSearchParams(location.search)
  $('q').value = params.get('q') ?? ''
  state.status = params.get('status')
  $('archived').checked = params.get('archived') === '1'
}

function navigate(path) {
  if (location.pathname + location.search !== path) history.pushState({}, '', path)
  applyRoute()
}

function applyRoute() {
  const tab = pathTab()
  if (tab === 'all') readFilters()
  state.tab = tab
  state.expanded = tab === 'focus' ? new URLSearchParams(location.search).get('card') : null
  for (const name of Object.values(ROUTES)) {
    $(`tab-${name}`).setAttribute('aria-selected', String(name === tab))
    $(`view-${name}`).hidden = name !== tab
  }
  const onAll = tab === 'all'
  $('q').hidden = !onAll
  $('archived').parentElement.hidden = !onAll
  state.unseen = 0
  updateTitle()
  renderSummary()
  renderRows()
  renderFocus()
  if (tab === 'search') {
    $('search-q').value = new URLSearchParams(location.search).get('q') ?? ''
    runSearch()
    $('search-q').focus()
  }
  if (tab === 'usage') loadUsage()
  refresh()
}

async function refresh() {
  try {
    const [sessions, focus] = await Promise.all([getJson('/api/sessions'), getJson('/api/focus')])
    const { events, next } = diffAlerts(state.alertSnap, focus.cards)
    const hadBaseline = state.alertSnap !== null
    state.alertSnap = next
    if (hadBaseline && events.length) {
      recordHistory(events)
      if (state.alertsOn) notify(events)
    }
    const signature = JSON.stringify([sessions, focus, Math.floor(Date.now() / 30000)])
    if (signature !== state.signature) {
      state.signature = signature
      state.sessions = sessions
      state.focusIds = focus.ids
      state.cards = focus.cards
      renderSummary()
      renderRows()
      renderFocus()
    }
    pollChanges()
    if (state.tab === 'usage' && Date.now() - state.usage.at > 30_000) loadUsage()
  } catch {}
}

function schedule() {
  clearInterval(state.timer)
  const ms = Number($('interval').value)
  if (ms) state.timer = setInterval(refresh, ms)
}

async function loadSnippets() {
  try {
    state.snippets = (await getJson('/api/snippets')).items
  } catch {}
}

$('tab-all').onclick = (event) => { event.preventDefault(); navigate('/') }
$('tab-focus').onclick = (event) => { event.preventDefault(); navigate('/focus') }
$('tab-search').onclick = (event) => { event.preventDefault(); navigate('/search') }
$('tab-usage').onclick = (event) => { event.preventDefault(); navigate('/usage') }
window.onpopstate = applyRoute
$('q').oninput = () => { renderRows(); writeFilters() }
$('archived').onchange = () => { renderSummary(); renderRows(); writeFilters() }
$('interval').onchange = schedule
$('alerts').onclick = toggleAlerts
$('history').onclick = (event) => { event.stopPropagation(); setHistoryOpen(!state.historyOpen) }
$('notif-panel').onclick = (event) => event.stopPropagation()
document.addEventListener('click', () => setHistoryOpen(false))
window.addEventListener('storage', (event) => {
  if (event.key !== 'board.history') return
  state.history = readHistory()
  renderHistoryBadge()
  if (state.historyOpen) renderHistoryPanel()
})
$('search-q').oninput = () => { clearTimeout(state.search.timer); state.search.timer = setTimeout(runSearch, 250) }
$('broadcast-open').onclick = openBroadcast
$('broadcast-cancel').onclick = () => $('broadcast').close()
$('broadcast-send').onclick = sendBroadcast
document.querySelectorAll('#layout button').forEach((b) => {
  b.onclick = () => {
    state.cols = b.dataset.cols
    remember('board.cols', state.cols)
    renderFocus()
  }
})
document.querySelectorAll('#usage-metric button').forEach((b) => {
  b.onclick = () => { state.usage.metric = b.dataset.metric; remember('board.usageMetric', state.usage.metric); renderUsagePage() }
})
document.querySelectorAll('#usage-days button').forEach((b) => {
  b.onclick = () => { state.usage.days = Number(b.dataset.days); remember('board.usageDays', String(state.usage.days)); loadUsage() }
})
$('backdrop').onclick = () => setExpanded(null)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.historyOpen) { setHistoryOpen(false); return }
  if (event.key !== 'Escape' || $('broadcast').open || !state.expanded) return
  const ui = uiOf(state.expanded)
  if (ui.popover) { ui.popover = null; renderFocus() } else setExpanded(null)
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { state.unseen = 0; updateTitle() }
})
setInterval(() => {
  document.querySelectorAll('[data-since]').forEach((node) => { node.textContent = duration(Date.now() - Number(node.dataset.since)) })
}, 1000)

if (location.hash === '#focus') history.replaceState({}, '', '/focus')
$('history').append(icon('bell', { size: 18 }))
state.history = readHistory()
renderHistoryBadge()
renderAlertsButton()
$('broadcast-open').replaceChildren(icon('megaphone', { size: 16 }), text('Broadcast'))
$('brand-mark').replaceChildren(icon('asterisk', { size: 22, strokeWidth: 2.4 }))
loadSnippets()
applyRoute()
schedule()
