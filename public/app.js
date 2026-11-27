import { CONTEXT_CAUTION, CONTEXT_DANGER, contextLevel, diffAlerts } from './alerts.js'
import { icon } from './icons.js'
import { splitFences, parseBlocks } from './richtext.js'
import { newSessionIds } from './autofocus.js'
import { listOps, phaseLabel } from './patch.js'
import { warmthOf, warmthTip } from './warmth.js'
import { quickReplies } from './quickreply.js'
import { workingCount, mrsHref, pickedMrs, viewShowing, mergeMrs, visibleMrs, tempCounts, mrTemperature, mrWarmthTip, fixOffered, startOutcome, folderName, babysitView, babysitOffered, babysitFocusId, babysitStoppable, replyPlanOffered, withMrReference, deployOffered, deployView, deployFocusId, refreshStatus, mrsPollMs } from './mrs.js'
import { diffLoops, withoutTickFinishes, untilLabel, spanLabel as shortSpan, loopTip, statusTip, byLatestEnded, diffBackground } from './loops.js'
import { SCOPE_FILTERS, SKILL_SORTS, dailyUses, dayKeys, scopeLabel, skillCounts, skillTemperature, skillTip, summarize, usesInRange, visibleSkills } from './skills.js'
import { attachTip, hideTip } from './tip.js'
import { DraftStore } from './drafts.js'
import { splitAttachments, visibleText, DEFAULT_ATTACH_TEXT } from './attachments.js'
import { PATH_PATTERN, BARE_DOC_PATTERN, isBareDoc, isPath, isImagePath, isHtmlPath, isPdfPath, isRelativeHtml, stripLocation, fileUrl } from './filepaths.js'
import { groupCards, groupOf, cardTitle, visibleGroups, COLLAPSIBLE, pickSelected, neighbour, shortAge, sortCards, sortKey, SORTS, moveWithin } from './sidebar.js'
import { initMobile, isMobile } from './mobile.js'
import { initLinkMenu } from './linkmenu.js'
import { monthGrid, weekGrid, dayGrid, shiftAnchor, eventsByDay, dayKey, modelLabel, effortLabel } from './calendar.js'
import { addEvents, markAllRead, markRead, markSessionRead, unreadCount } from './history.js'
import { mainSessions, sideChatGroups, sideChatCount, ownReplies } from './sidechats.js'
import { createTimeline } from './timelineview.js'
import { coalesce } from './coalesce.js'
import { createFlowView } from './flowview.js'
import { renderWidget, installWidgetHost } from './widgets.js'
import { freshCommand, sideCommand } from './slash.js'
import { latestOnly, forcedRerun, polledPane, broadcastState, defaultTicked, differs, navigationMode, BROADCAST_LIMIT } from './guards.js'

const ROUTES = { '/': 'all', '/focus': 'focus', '/loops': 'focus', '/background': 'focus', '/mrs': 'mrs', '/flow': 'flow', '/search': 'search', '/usage': 'usage', '/skills': 'skills', '/schedule': 'schedule' }
const PAGE_TITLES = { all: 'Sessions', focus: 'Focus', mrs: 'Merge requests', flow: 'Lifecycle', search: 'Search', usage: 'Usage', skills: 'Skills', schedule: 'Schedule' }
const ALERT_ICONS = { finished: 'check-circle', question: 'help-circle', approval: 'pause-circle', blocked: 'octagon-x', failed: 'x-circle', paused: 'pause-circle', loopdone: 'repeat', stalled: 'triangle-alert', bgdone: 'check-circle', bgfailed: 'x-circle' }
const $ = (id) => document.getElementById(id)

const state = {
  resume: new Map(),
  tab: 'all',
  sessions: [],
  focusIds: [],
  cards: [],
  status: null,
  temp: null,
  focusSort: 'manual',
  kept: {},
  signature: '',
  timer: null,
  selected: null,
  wanted: null,
  loaded: false,
  draft: false,
  history: [],
  commands: new Map(),
  pending: new Map(),
  historyOpen: false,
  historyNew: new Set(),
  drafts: new DraftStore((() => { try { return localStorage } catch { return null } })()),
  notes: new Map(),
  asks: new Map(),
  ui: new Map(),
  changes: new Map(),
  agents: new Map(),
  snippets: [],
  alertsOn: false,
  alertSnap: null,
  loopSnap: null,
  backgroundSnap: null,
  knownIds: null,
  unseen: 0,
  attachments: new Map(),
  search: { timer: null, runId: 0 },
  usage: { days: 30, metric: 'output', data: null, at: 0 },
  skills: { data: null, scope: 'all', temp: null, days: 30, sort: 'uses', query: '', at: 0, open: new Set(), details: new Map() },
  schedule: { data: null, at: 0, built: false },
  loops: { data: null, at: 0 },
  timeline: { at: 0 },
  background: { data: null, at: 0, output: new Map(), loading: new Set() },
  sideChats: { data: null, at: 0, cards: new Map(), fetched: new Map(), loading: new Set(), open: new Set(), starting: new Set(), drafts: new Map(), notes: new Map(), pending: new Map(), closedOpen: false },
  panel: { open: false, tab: 'background', scope: 'session', closed: new Set(), opened: new Set(), finishedOpen: false, endedOpen: false },
  mrs: { data: null, filter: 'all', temp: null, at: 0, loading: false, manual: false, picked: [], scrolled: false },
  flow: { at: 0, timer: null },
}

try {
  state.selected = localStorage.getItem('board.selected')
  state.focusSort = sortKey(localStorage.getItem('board.focusSort'))
  state.collapsed = new Set(JSON.parse(localStorage.getItem('board.collapsedGroups') || '[]'))
  state.kept = JSON.parse(localStorage.getItem('board.kept') || '{}')
  state.alertsOn = localStorage.getItem('board.alerts') === '1'
  state.usage.days = Number(localStorage.getItem('board.usageDays')) || 30
  Object.assign(state.panel, JSON.parse(localStorage.getItem('board.panel') || '{}'))
  // On a phone the panel covers the whole chat, so it never comes back open after a reload.
  if (isMobile()) state.panel.open = false
  state.usage.metric = localStorage.getItem('board.usageMetric') || 'output'
  state.skills.days = [7, 30, 90].includes(Number(localStorage.getItem('board.skillsDays'))) ? Number(localStorage.getItem('board.skillsDays')) : 30
  state.skills.sort = SKILL_SORTS.includes(localStorage.getItem('board.skillsSort')) ? localStorage.getItem('board.skillsSort') : 'uses'
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
const timeline = createTimeline($('timeline'), { projectColor, openSession: (id) => openInFocus(id), openSchedule: editSchedule })
const flowView = createFlowView($('flow-root'), { openSession: (id) => openInFocus(id), postJson: (path, body) => postJson(path, body), reload: () => loadFlow() })
new ResizeObserver(([entry]) => {
  const height = entry.target.offsetHeight
  document.documentElement.style.setProperty('--tl-h', height ? `${height + 12}px` : '0px')
}).observe($('timeline'))
setInterval(() => timeline.tick(), 1000)

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
  const chip = el('span', 'chip')
  chip.append(el('span', 'chip-name', s.project ?? 'unknown'))
  chip.title = s.project ?? 'unknown'
  chip.style.setProperty('--project', projectColor(s.project))
  return chip
}
const copyResume = (command) => {
  const button = el('button', 'btn', 'Copy resume')
  button.title = `Board-only session: the desktop app cannot open it. Copies: ${command}`
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(command)
      button.textContent = 'Copied'
    } catch {
      button.textContent = 'Copy failed'
    }
    setTimeout(() => { button.textContent = 'Copy resume' }, 1500)
  }
  return button
}
const openLink = (id, primary) => {
  const resume = state.resume.get(id)
  if (resume) return copyResume(resume)
  const a = el('a', `btn${primary ? ' primary' : ''}`, 'Open')
  a.append(icon('arrow-up-right', { size: 14 }))
  a.href = `claude://code/continue?session=${encodeURIComponent(id)}`
  a.title = 'Open in Claude desktop'
  return a
}
const statusBadge = (status, session) => {
  const span = el('span', `status ${status}`)
  span.append(el('span', 'dot'), text(status.replace(/_/g, ' ')))
  return session ? attachTip(span, () => statusTip(status, session.detail, session.lastActivityAt)) : span
}
const loopBadge = (loop) => {
  if (!loop) return null
  const span = el('span', `loop-badge ${loop.state}`)
  span.append(icon('repeat', { size: 13 }))
  if (loop.state === 'looping') span.append(text(loop.nextAt ? `Looping · next ${untilLabel(loop.nextAt)}` : `Looping · ${loop.every ? `every ${loop.every}m` : 'waiting'}`))
  else if (loop.state === 'stalled') span.append(text('Loop stalled'))
  else span.append(text(`Loop finished · ${relative(loop.endedAt)}`))
  return attachTip(span, () => loopTip(loop))
}
const uiOf = (id) => {
  if (!state.ui.has(id)) state.ui.set(id, { pane: 'chat', popover: null, at: '', repeat: 'none', snippetLabel: '' })
  return state.ui.get(id)
}

const bytesLabel = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`)

function attachmentsOf(id) {
  return state.attachments.get(id) ?? []
}

function withAttachments(id, prompt) {
  const files = attachmentsOf(id)
  if (!files.length) return prompt
  const lines = files.map((file) => `- ${file.path}`).join('\n')
  return `${prompt || DEFAULT_ATTACH_TEXT}\n\nAttached files:\n${lines}`
}

// Drop files anywhere on a card (chat, header or prompt box) to attach them. One set of
// document-level listeners, so cards that are re-rendered or patched in place keep working,
// and a file dropped elsewhere is ignored instead of making the browser open it.
const dropOverlay = el('div', 'drop-overlay', 'Drop to attach')
document.body.append(dropOverlay)
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files')
function dropTarget(event) {
  const card = event.target instanceof Element ? event.target.closest('article.card') : null
  if (!card) return null
  const key = card.classList.contains('new-chat') ? NEW_KEY : card.dataset.id
  return key ? { card, key } : null
}
function showDrop(card) {
  const box = card.getBoundingClientRect()
  Object.assign(dropOverlay.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` })
  dropOverlay.classList.add('on')
}
const hideDrop = () => dropOverlay.classList.remove('on')
document.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  const target = dropTarget(event)
  event.dataTransfer.dropEffect = target ? 'copy' : 'none'
  if (target) showDrop(target.card)
  else hideDrop()
})
document.addEventListener('dragleave', (event) => { if (!event.relatedTarget) hideDrop() })
document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  hideDrop()
  const target = dropTarget(event)
  if (target && event.dataTransfer.files.length) attachFiles(target.key, event.dataTransfer.files)
})
window.addEventListener('dragend', hideDrop)
window.addEventListener('blur', hideDrop)

async function attachFiles(id, files) {
  const list = [...files]
  const note = (message) => (id === NEW_KEY ? setDraftNote(message, message?.startsWith('Uploading') ? 'running' : 'error') : setNote(id, message))
  if (!list.length) return
  note(`Uploading ${list.length} file${list.length === 1 ? '' : 's'}…`)
  renderFocus()
  const added = []
  let failure = null
  for (const file of list) {
    const type = file.type || 'application/octet-stream'
    try {
      const res = signedOut(await fetch(`/api/upload?name=${encodeURIComponent(file.name || 'pasted')}`, { method: 'POST', headers: { 'content-type': type }, body: file }))
      const data = await res.json().catch(() => ({}))
      if (!res.ok) failure ??= data.error ?? `Could not upload ${file.name}`
      else added.push({ ...data, preview: data.image ? URL.createObjectURL(file) : null })
    } catch {
      failure ??= `Could not upload ${file.name}`
    }
  }
  if (added.length) state.attachments.set(id, [...attachmentsOf(id), ...added])
  note(failure ? (added.length ? `${failure}. ${added.length} of ${list.length} attached.` : failure) : null)
  renderFocus()
}

function removeAttachment(id, path) {
  const removed = attachmentsOf(id).find((file) => file.path === path)
  if (removed?.preview) URL.revokeObjectURL(removed.preview)
  const rest = attachmentsOf(id).filter((file) => file.path !== path)
  if (rest.length) state.attachments.set(id, rest)
  else state.attachments.delete(id)
  renderFocus()
}

function renderAttachments(c) {
  const files = attachmentsOf(c.id)
  if (!files.length) return null
  const row = el('div', 'attachments')
  for (const file of files) {
    const chip = el('div', 'attachment')
    if (file.preview) {
      const thumb = document.createElement('img')
      thumb.src = file.preview
      thumb.alt = file.name
      chip.append(thumb)
    } else chip.append(icon('paperclip', { size: 14 }))
    const remove = el('button')
    remove.append(icon('x', { size: 14 }))
    remove.title = 'Remove attachment'
    remove.onclick = () => removeAttachment(c.id, file.path)
    chip.append(el('span', 'n', file.name), el('span', 'size', bytesLabel(file.size)), remove)
    row.append(chip)
  }
  return row
}

// Over a tunnel the board answers 401 once the login cookie is gone; reloading shows the sign-in page.
const signedOut = (res) => { if (res.status === 401) location.reload(); return res }

async function postJson(path, body) {
  try {
    const res = signedOut(await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    return { ok: res.ok, data: await res.json().catch(() => ({})) }
  } catch {
    return { ok: false, data: { error: 'Could not reach the board. It may be restarting.' } }
  }
}
const shouldQueue = (result) => !result.ok && result.data.queueable === true
async function getJson(path) {
  const res = signedOut(await fetch(path, { cache: 'no-store' }))
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return res.json()
}
const refresh = coalesce(refreshBoard)
const resync = async () => { state.signature = ''; await refresh() }

function setNote(id, message) {
  if (message) state.notes.set(id, message)
  else state.notes.delete(id)
}

function toast(event) {
  document.querySelectorAll('.toast').forEach((old) => { if (old.dataset.session === event.id) old.remove() })
  const box = el('div', `toast ${event.kind}`)
  box.dataset.session = event.id
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

function clearNotifications(id) {
  document.querySelectorAll('#toasts .toast').forEach((t) => { if (t.dataset.session === id) t.remove() })
  if (!state.history.some((entry) => entry.id === id && !entry.read)) return
  state.historyNew = new Set([...state.historyNew].filter((uid) => state.history.find((entry) => entry.uid === uid)?.id !== id))
  writeHistory(markSessionRead(state.history, id))
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
      const n = new Notification(event.title, { body: event.message, tag: event.id, renotify: true })
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

const failToast = (id, title, result) => toast({ id, title, kind: 'failed', message: result.data?.error ?? title })

async function setFocus(id, focused) {
  const result = await postJson('/api/focus', { id, focused })
  if (!result.ok) {
    failToast('focus-update', focused ? 'Could not add to Focus' : 'Could not remove from Focus', result)
    return false
  }
  state.focusIds = result.data.ids
  await resync()
  return true
}

function closeMenus() { document.querySelectorAll('.kebab-menu').forEach((m) => m.remove()) }
document.addEventListener('click', (event) => { if (!event.target.closest?.('.kebab-wrap')) closeMenus() })
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenus() })

// Three-dot menu on a Focus sidebar item: currently just "Unfocus session".
function kebabMenu(id) {
  const wrap = el('div', 'kebab-wrap')
  const b = el('button', 'icon-only kebab-btn')
  b.append(icon('more', { size: 18 }))
  b.title = 'More'
  b.setAttribute('aria-label', 'Session menu')
  b.setAttribute('aria-haspopup', 'menu')
  b.onclick = (event) => {
    event.stopPropagation()
    const open = wrap.querySelector('.kebab-menu')
    closeMenus()
    if (open) return
    const menu = el('div', 'kebab-menu')
    menu.setAttribute('role', 'menu')
    const item = el('button', undefined, 'Unfocus session')
    item.setAttribute('role', 'menuitem')
    item.onclick = () => { closeMenus(); setFocus(id, false) }
    menu.append(item)
    wrap.append(menu)
    const box = b.getBoundingClientRect()
    menu.style.top = `${Math.min(box.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`
    menu.style.left = `${Math.max(8, box.right - menu.offsetWidth)}px`
  }
  wrap.onkeydown = (event) => event.stopPropagation()
  wrap.append(b)
  return wrap
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

const temperatureOf = (s) => warmthOf(s, Date.now(), state.kept[s.id] ?? 0)

function keepWarm(id) {
  state.kept[id] = Date.now()
  remember('board.kept', JSON.stringify(state.kept))
  renderRows()
  renderFocus()
}

function meterBadge(t, tip) {
  const box = el('span', `temp ${t.tier}`)
  const meter = el('span', 'meter')
  for (let i = 1; i <= 4; i++) meter.append(el('i', i <= t.bars ? 'f' : undefined))
  box.append(meter, text(t.label))
  return attachTip(box, tip)
}

// Just the bars, for tight spots like the sidebar; the label and details are in the tooltip.
function tempMeter(t, session) {
  const box = el('span', `temp compact ${t.tier}`)
  const meter = el('span', 'meter')
  for (let i = 1; i <= 4; i++) meter.append(el('i', i <= t.bars ? 'f' : undefined))
  box.append(meter)
  box.setAttribute('aria-label', t.label)
  return attachTip(box, () => warmthTip(session, t, state.kept[session.id] ?? 0))
}

function tempBadge(t, session) {
  return meterBadge(t, () => warmthTip(session, t, state.kept[session.id] ?? 0))
}

function visible() {
  const q = $('q').value.trim().toLowerCase()
  return mainSessions(state.sessions).filter((s) =>
    ($('archived').checked || !s.archived) &&
    (!state.status || s.status === state.status) &&
    (!state.temp || temperatureOf(s).group === state.temp) &&
    (!q || `${s.title} ${s.cwd} ${s.project}`.toLowerCase().includes(q)))
}

function renderMrsBadge() {
  const data = state.mrs.data
  const count = data ? [...data.authored, ...data.reviewing].filter((mr) => mr.focused).length : 0
  const badge = $('mrs-count')
  badge.hidden = count === 0
  badge.textContent = String(count)
}

function renderSummary() {
  const pool = mainSessions(state.sessions).filter((s) => $('archived').checked || !s.archived)
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
  const temps = pool.reduce((acc, s) => ({ ...acc, [temperatureOf(s).group]: (acc[temperatureOf(s).group] ?? 0) + 1 }), {})
  box.append(el('span', 'pill-gap'))
  for (const group of ['warm', 'cool']) {
    const b = el('button', 'pill', `${group[0].toUpperCase()}${group.slice(1)} ${temps[group] ?? 0}`)
    b.setAttribute('aria-pressed', String(state.temp === group))
    b.onclick = () => { state.temp = state.temp === group ? null : group; renderSummary(); renderRows(); writeFilters() }
    box.append(b)
  }
}

function statusCell(s) {
  const box = el('div', 'status-cell')
  box.append(statusBadge(s.status, s))
  const badge = loopBadge(s.loop)
  if (badge) box.append(badge)
  return box
}

function renderRows() {
  hideTip()
  const rows = visible().map((s) => ({ s, t: temperatureOf(s) })).sort((a, b) => b.t.at - a.t.at)
  const body = $('rows')
  body.replaceChildren()
  $('empty').hidden = rows.length > 0
  let group = null
  for (const { s, t } of rows) {
    if (t.group !== group) {
      group = t.group
      const head = document.createElement('tr')
      head.className = 'temp-group'
      const label = group === 'warm' ? 'Warm' : `Cool · ${rows.filter((r) => r.t.group === 'cool').length} sessions, consider archiving the cold ones`
      const td = el('td', undefined, label)
      td.colSpan = 9
      head.append(td)
      body.append(head)
    }
    const tr = document.createElement('tr')
    if (t.group === 'cool') tr.className = 'cool'
    const title = el('div')
    const heading = el('div', 'row-title', s.title)
    if (state.drafts.has(s.id)) {
      const draft = el('span', 'draft-chip', 'Draft')
      draft.title = state.drafts.get(s.id).trim().slice(0, 200)
      heading.append(draft)
    }
    if (s.sideChats) {
      const chip = el('span', 'side-chip')
      chip.append(icon('message-circle', { size: 12 }), text(` ${s.sideChats} side ${s.sideChats === 1 ? 'chat' : 'chats'}`))
      chip.title = 'Open the session on Focus and use the Side chats panel to read them'
      heading.append(chip)
    }
    title.append(heading)
    if (s.detail) title.append(el('div', 'row-sub', s.detail))
    const project = el('div')
    project.append(projectChip(s), el('div', 'path', home(s.cwd)))
    tr.append(
      cell(starButton(s.id)),
      cell(title),
      cell(project),
      cell(statusCell(s)),
      cell(tempBadge(t, s)),
      cell(el('span', 'num', s.model ?? '—')),
      cell(el('span', 'num', String(s.completedTurns))),
      cell(el('span', 'num', relative(t.at))),
      cell(openLink(s.id))
    )
    body.append(tr)
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/
const LINK_PATTERN = new RegExp(`(${[/`[^`\n]+`/, /\*\*[^*\n]+\*\*/, /\[[^\]\n]+\]\(\S+?\)/, URL_PATTERN, PATH_PATTERN, BARE_DOC_PATTERN].map((re) => re.source).join('|')})`, 'g')
const PLAIN_PATTERN = new RegExp(`(${[URL_PATTERN, PATH_PATTERN, BARE_DOC_PATTERN].map((re) => re.source).join('|')})`, 'g')
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

async function revealFile(path, base) {
  const result = await postJson('/api/reveal', { path, base })
  if (!result.ok) toast({ id: 'reveal-file', title: 'Could not open in Finder', kind: 'failed', message: result.data?.error ?? 'Could not open the file.' })
}

function openLightbox(path) {
  if (!isMobile()) return openImagePane(path)
  const box = el('dialog', 'lightbox')
  const bar = el('div', 'lightbox-bar')
  const reveal = el('button', 'btn', 'Reveal in Finder')
  reveal.type = 'button'
  reveal.onclick = () => revealFile(path)
  const close = el('button', 'icon-btn')
  close.type = 'button'
  close.title = 'Close (Esc)'
  close.append(icon('x', { size: 16 }))
  close.onclick = () => box.close()
  bar.append(el('span', 'lightbox-name', path), reveal, close)
  const img = document.createElement('img')
  img.src = fileUrl(path)
  img.alt = path.split('/').pop()
  box.append(bar, img)
  box.onclick = (event) => {
    if (event.target === box || event.target === img) box.close()
  }
  box.onclose = () => box.remove()
  document.body.append(box)
  box.showModal()
}

let chatBase = ''

const HTML_LAYOUT_WIDTH = 1200

const PREVIEW_MIN = 360
let closePreviewPane = null

// Desktop: like the Claude desktop app's preview, a file opens in a pane docked beside the chat. The content gets
// the pane's own width and reflows as the divider is dragged. Phones keep the full-screen viewers.
function openPreviewPane(path, src, content, { reload = null, extra = [] } = {}) {
  closePreviewPane?.()
  const pane = el('aside', 'preview-pane')
  const bar = el('div', 'preview-bar')
  const button = (shape, title) => {
    const b = el('button', 'icon-btn')
    b.type = 'button'
    b.title = title
    b.append(icon(shape, { size: 16 }))
    return b
  }
  const name = el('span', 'preview-name', path.split('/').pop())
  name.title = path
  const tab = el('a', 'icon-btn')
  tab.href = src
  tab.target = '_blank'
  tab.rel = 'noopener'
  tab.title = 'Open in a new tab'
  tab.append(icon('arrow-up-right', { size: 16 }))
  const close = button('x', 'Close preview')
  if (reload) {
    const again = button('repeat', 'Reload')
    again.onclick = reload
    bar.append(again)
  }
  bar.append(name, ...extra, tab, close)

  const setWidth = (px) => {
    const max = Math.max(PREVIEW_MIN, window.innerWidth - 420)
    const w = Math.round(Math.min(max, Math.max(PREVIEW_MIN, px)))
    document.body.style.setProperty('--preview-w', `${w}px`)
    return w
  }
  setWidth(Number(localStorage.getItem('board.previewW')) || window.innerWidth * 0.45)
  const grip = el('div', 'preview-grip')
  grip.title = 'Drag to resize'
  grip.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    grip.setPointerCapture(event.pointerId)
    pane.classList.add('resizing')
    const move = (e) => remember('board.previewW', setWidth(window.innerWidth - e.clientX))
    const stop = () => {
      pane.classList.remove('resizing')
      grip.removeEventListener('pointermove', move)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop, { once: true })
    grip.addEventListener('pointercancel', stop, { once: true })
  })
  const onResize = () => setWidth(parseFloat(document.body.style.getPropertyValue('--preview-w')))
  window.addEventListener('resize', onResize)

  closePreviewPane = () => {
    window.removeEventListener('resize', onResize)
    document.body.classList.remove('preview-open')
    pane.remove()
    closePreviewPane = null
  }
  close.onclick = () => closePreviewPane()
  pane.append(grip, bar, content)
  document.body.append(pane)
  document.body.classList.add('preview-open')
}

function openHtmlViewer(path, base = '') {
  if (isMobile()) return openHtmlCanvas(path, base)
  const src = fileUrl(path, base)
  const frame = document.createElement('iframe')
  frame.title = path.split('/').pop()
  frame.setAttribute('sandbox', 'allow-scripts allow-popups')
  frame.src = src
  openPreviewPane(path, src, frame, { reload: () => { frame.src = src } })
}

function openImagePane(path) {
  const src = fileUrl(path)
  const holder = el('div', 'preview-image')
  const img = document.createElement('img')
  img.src = src
  img.alt = path.split('/').pop()
  holder.append(img)
  const reveal = el('button', 'btn', 'Reveal in Finder')
  reveal.type = 'button'
  reveal.onclick = () => revealFile(path)
  openPreviewPane(path, src, holder, { extra: [reveal] })
}

function openPdfPane(path) {
  const src = fileUrl(path)
  const frame = document.createElement('iframe')
  frame.title = path.split('/').pop()
  frame.src = src
  const save = el('a', 'btn', 'Download')
  save.href = `${src}&download=1`
  save.download = frame.title
  openPreviewPane(path, src, frame, { reload: () => { frame.src = src }, extra: [save] })
}

// Excalidraw-style canvas: the page keeps one fixed desktop layout; the board pans and zooms it with transforms.
function openHtmlCanvas(path, base = '') {
  const box = el('dialog', 'lightbox html-viewer')
  const bar = el('div', 'lightbox-bar')
  const tab = el('a', 'btn', 'New tab')
  tab.href = fileUrl(path, base)
  tab.target = '_blank'
  tab.rel = 'noopener'
  const close = el('button', 'icon-btn')
  close.type = 'button'
  close.title = 'Close (Esc)'
  close.append(icon('x', { size: 16 }))
  close.onclick = () => box.close()
  const frame = document.createElement('iframe')
  frame.src = `${fileUrl(path, base)}&viewer=1`
  frame.setAttribute('sandbox', 'allow-scripts allow-popups')
  frame.style.width = `${HTML_LAYOUT_WIDTH}px`
  frame.style.height = '2000px'
  const holder = el('div', 'html-holder')
  holder.append(frame)

  let s = 0.3, x = 0, y = 0, pageH = 2000
  let fitted = true
  const label = el('button', 'btn zoom-label')
  label.type = 'button'
  label.title = 'Fit to width'
  const render = () => {
    frame.style.transform = `translate(${x}px, ${y}px) scale(${s})`
    label.textContent = `${Math.round(s * 100)}%`
  }
  const clampPan = () => {
    const w = holder.clientWidth, h = holder.clientHeight
    const cw = HTML_LAYOUT_WIDTH * s, ch = pageH * s
    x = cw <= w ? (w - cw) / 2 : Math.min(0, Math.max(w - cw, x))
    y = ch <= h ? 0 : Math.min(0, Math.max(h - ch, y))
  }
  const zoomAt = (factor, cx, cy) => {
    const next = Math.min(6, Math.max(0.1, s * factor))
    const k = next / s
    x = cx - (cx - x) * k
    y = cy - (cy - y) * k
    s = next
    fitted = false
    clampPan()
    render()
  }
  const fit = () => {
    s = Math.min(1, holder.clientWidth / HTML_LAYOUT_WIDTH)
    x = 0
    y = 0
    fitted = true
    clampPan()
    render()
  }
  const center = () => [holder.clientWidth / 2, holder.clientHeight / 2]
  label.onclick = fit
  const out = el('button', 'btn', '−')
  out.type = 'button'
  out.onclick = () => zoomAt(1 / 1.3, ...center())
  const inn = el('button', 'btn', '+')
  inn.type = 'button'
  inn.onclick = () => zoomAt(1.3, ...center())

  // pointer gestures: one finger pans, two fingers pinch around their midpoint, double-tap toggles fit / 2.5x fit
  const pointers = new Map()
  let last = null
  let lastTap = 0
  const local = (event) => {
    const r = holder.getBoundingClientRect()
    return [event.clientX - r.left, event.clientY - r.top]
  }
  const pinchState = () => {
    const [a, b] = [...pointers.values()]
    return { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1 }
  }
  holder.addEventListener('pointerdown', (event) => {
    holder.setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, local(event))
    last = pointers.size === 2 ? pinchState() : null
    if (pointers.size === 1) {
      const now = Date.now()
      if (now - lastTap < 300) {
        const [cx, cy] = local(event)
        if (fitted) zoomAt(2.5, cx, cy)
        else fit()
        lastTap = 0
      } else lastTap = now
    }
  })
  holder.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return
    const before = pointers.get(event.pointerId)
    const now = local(event)
    pointers.set(event.pointerId, now)
    if (pointers.size === 1) {
      x += now[0] - before[0]
      y += now[1] - before[1]
      fitted = false
      clampPan()
      render()
    } else if (pointers.size === 2 && last) {
      const cur = pinchState()
      x += cur.cx - last.cx
      y += cur.cy - last.cy
      zoomAt(cur.d / last.d, cur.cx, cur.cy)
      last = cur
    }
  })
  const lift = (event) => {
    pointers.delete(event.pointerId)
    last = pointers.size === 2 ? pinchState() : null
  }
  holder.addEventListener('pointerup', lift)
  holder.addEventListener('pointercancel', lift)
  holder.addEventListener('wheel', (event) => {
    event.preventDefault()
    const [cx, cy] = local(event)
    if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.01), cx, cy)
    else { x -= event.deltaX; y -= event.deltaY; fitted = false; clampPan(); render() }
  }, { passive: false })

  const onMessage = (event) => {
    const size = event.source === frame.contentWindow ? event.data?.htmlViewerSize : null
    if (!size || !(size.h > 0)) return
    pageH = Math.min(size.h, 60000)
    frame.style.height = `${pageH}px`
    clampPan()
    render()
  }
  window.addEventListener('message', onMessage)
  bar.append(el('span', 'lightbox-name', path.split('/').pop()), out, label, inn, tab, close)
  box.append(bar, holder)
  box.onclose = () => {
    window.removeEventListener('message', onMessage)
    box.remove()
  }
  document.body.append(box)
  box.showModal()
  fit()
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

// A PDF opened by navigating away strands a bookmarked (no URL bar) phone web app with no way back,
// so it opens in a full-screen dialog with its own Close button. The file is fetched here first so
// the wait shows real progress instead of a black page, then handed to the browser's PDF viewer.
function openPdfViewer(path) {
  if (!isMobile()) return openPdfPane(path)
  const box = el('dialog', 'lightbox html-viewer pdf-viewer')
  const bar = el('div', 'lightbox-bar')
  const save = el('a', 'btn', 'Download')
  save.hidden = true
  const close = el('button', 'icon-btn')
  close.type = 'button'
  close.title = 'Close (Esc)'
  close.append(icon('x', { size: 16 }))
  close.onclick = () => box.close()
  const name = path.split('/').pop()
  const holder = el('div', 'pdf-holder')
  const loading = el('div', 'pdf-loading')
  const label = el('div', 'pdf-label', 'Loading PDF…')
  const track = el('div', 'pdf-track')
  const fill = el('div', 'pdf-fill')
  track.append(fill)
  const spin = el('span', 'spinner')
  loading.append(spin, label, track)
  holder.append(loading)
  bar.append(el('span', 'lightbox-name', name), save, close)
  box.append(bar, holder)

  const controller = new AbortController()
  let objectUrl = null
  box.onclose = () => {
    controller.abort()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    box.remove()
  }
  const fail = (message) => {
    spin.remove()
    track.remove()
    label.textContent = message
    const retry = el('button', 'btn', 'Try again')
    retry.type = 'button'
    retry.onclick = () => { box.close(); openPdfViewer(path) }
    loading.append(retry)
  }
  const load = async () => {
    const res = await fetch(fileUrl(path), { signal: controller.signal })
    if (!res.ok) return fail('Could not load this PDF.')
    const total = Number(res.headers.get('content-length')) || 0
    const chunks = []
    let got = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      got += value.length
      label.textContent = total ? `Loading PDF… ${mb(got)} of ${mb(total)}` : `Loading PDF… ${mb(got)}`
      if (total) fill.style.width = `${Math.min(100, (got / total) * 100)}%`
    }
    objectUrl = URL.createObjectURL(new Blob(chunks, { type: 'application/pdf' }))
    save.href = objectUrl
    save.download = name
    save.hidden = false
    const frame = document.createElement('iframe')
    frame.title = name
    frame.src = objectUrl
    frame.onload = () => loading.remove()
    holder.append(frame)
    // Safari can skip the load event for PDFs; never leave the spinner up over a ready document.
    setTimeout(() => loading.remove(), 1500)
  }
  load().catch((error) => { if (error?.name !== 'AbortError') fail('Could not load this PDF. Check the connection.') })
  document.body.append(box)
  box.showModal()
}

function fileNode(path, label, { preview = true } = {}) {
  const target = stripLocation(path)
  const image = isImagePath(target)
  const html = isHtmlPath(target)
  const pdf = isPdfPath(target)
  const base = chatBase
  const wrap = el('span', 'filelink')
  const a = el('a', 'chat-link')
  a.href = image || html || pdf ? fileUrl(target, base) : '#'
  a.dataset.copy = target
  a.title = html ? 'Open page' : pdf ? 'Open PDF' : 'Reveal in Finder'
  a.onclick = (event) => {
    event.preventDefault()
    if (pdf) openPdfViewer(target)
    else if (html) openHtmlViewer(target, base)
    else revealFile(target, base)
  }
  if (typeof label === 'string') a.append(text(label))
  else a.append(label)
  wrap.append(a)
  if (pdf) {
    const save = el('a', 'chat-link pdf-save', ' ⬇ Download')
    save.href = `${fileUrl(target)}&download=1`
    save.download = target.split('/').pop()
    save.title = 'Download PDF'
    wrap.append(save)
  }
  if (image && preview) {
    const frame = el('span', 'filepreview')
    const open = el('a')
    open.href = fileUrl(target)
    open.dataset.copy = target
    open.title = 'Open full size'
    open.onclick = (event) => {
      event.preventDefault()
      openLightbox(target)
    }
    const img = document.createElement('img')
    img.src = fileUrl(target)
    img.alt = target.split('/').pop()
    img.loading = 'lazy'
    img.onerror = () => frame.remove()
    open.append(img)
    frame.append(open)
    wrap.append(frame)
  }
  return wrap
}

function inline(parent, value) {
  value.split(LINK_PATTERN).forEach((part) => {
    if (!part) return
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      const inner = part.slice(1, -1)
      const code = el('code', undefined, inner)
      const href = /^https?:\/\/\S+$/.test(inner) ? safeUrl(inner) : null
      parent.append(href ? linkNode(href, code) : isPath(inner) || isBareDoc(inner) || (chatBase && isRelativeHtml(inner)) ? fileNode(inner, code) : code)
    } else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      const strong = el('strong')
      inline(strong, part.slice(2, -2))
      parent.append(strong)
    } else if (part.startsWith('[') && /\]\(\S+\)$/.test(part)) {
      const split = part.lastIndexOf('](')
      const label = part.slice(1, split)
      const target = part.slice(split + 2, -1)
      const href = safeUrl(target)
      parent.append(href ? linkNode(href, label) : isPath(target) || isBareDoc(target) || (chatBase && isRelativeHtml(target)) ? fileNode(target, label) : text(part))
    } else if (/^https?:\/\//.test(part)) {
      const [url, tail] = splitTrailing(part)
      const href = safeUrl(url)
      if (href) parent.append(linkNode(href, url), text(tail))
      else parent.append(text(part))
    } else if (isBareDoc(part)) {
      parent.append(fileNode(part, part))
    } else if (isPath(splitTrailing(part)[0])) {
      const [path, tail] = splitTrailing(part)
      parent.append(fileNode(path, path), text(tail))
    } else {
      parent.append(text(part))
    }
  })
}

function linkifyPlain(parent, value) {
  value.split(PLAIN_PATTERN).forEach((part) => {
    if (!part) return
    if (/^https?:\/\//.test(part)) {
      const [url, tail] = splitTrailing(part)
      const href = safeUrl(url)
      if (href) parent.append(linkNode(href, url), text(tail))
      else parent.append(text(part))
    } else if (isBareDoc(part)) {
      parent.append(fileNode(part, part, { preview: false }))
    } else if (isPath(splitTrailing(part)[0])) {
      const [path, tail] = splitTrailing(part)
      parent.append(fileNode(path, path, { preview: false }), text(tail))
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

function renderBlock(block) {
  if (block.type === 'heading') {
    const h = el('div', `md-h md-h${Math.min(block.level, 4)}`)
    inline(h, block.text)
    return h
  }
  if (block.type === 'rule') return el('hr', 'md-rule')
  if (block.type === 'quote') {
    const q = el('blockquote', 'md-quote')
    inline(q, block.text)
    return q
  }
  if (block.type === 'list') {
    const list = document.createElement(block.ordered ? 'ol' : 'ul')
    list.className = 'md-list'
    for (const item of block.items) {
      const li = document.createElement('li')
      if (item.depth) li.style.marginLeft = `${item.depth * 20}px`
      inline(li, item.text)
      list.append(li)
    }
    return list
  }
  if (block.type === 'table') {
    const scroll = el('div', 'md-table-wrap')
    const table = el('table', 'md-table')
    const head = document.createElement('tr')
    block.header.forEach((cell, i) => {
      const th = document.createElement('th')
      if (block.aligns[i]) th.style.textAlign = block.aligns[i]
      inline(th, cell)
      head.append(th)
    })
    const thead = document.createElement('thead')
    thead.append(head)
    const tbody = document.createElement('tbody')
    for (const row of block.rows) {
      const tr = document.createElement('tr')
      row.forEach((cell, i) => {
        const td = document.createElement('td')
        if (block.aligns[i]) td.style.textAlign = block.aligns[i]
        inline(td, cell)
        tr.append(td)
      })
      tbody.append(tr)
    }
    table.append(thead, tbody)
    scroll.append(table)
    return scroll
  }
  const para = el('div', 'para')
  inline(para, block.text)
  return para
}

function richText(parent, value) {
  for (const part of splitFences(value)) {
    if (part.type === 'code') {
      parent.append(codeBlock(part))
    } else {
      for (const block of parseBlocks(part.text)) parent.append(renderBlock(block))
    }
  }
}

const normalizeText = (value) => String(value).replace(/\n{3,}/g, '\n\n').trim()
const PENDING_TTL_MS = 45_000

function isDelivered(entry, messages) {
  return messages.some((m) => m.role === 'user' && Date.parse(m.at) >= entry.at - 2000)
}

function addPending(id, text) {
  const list = state.pending.get(id) ?? []
  list.push({ text: normalizeText(text), at: Date.now() })
  state.pending.set(id, list)
}

function dropPending(id, text) {
  const list = (state.pending.get(id) ?? []).filter((entry) => entry.text !== normalizeText(text))
  if (list.length) state.pending.set(id, list)
  else state.pending.delete(id)
}

function prunePending() {
  let changed = false
  for (const [id, list] of [...state.pending]) {
    const card = state.cards.find((c) => c.id === id)
    const messages = card?.details?.chat ?? []
    const keep = list.filter((entry) => {
      const expired = Date.now() - entry.at > PENDING_TTL_MS
      const failed = ['failed', 'stalled'].includes(card?.run?.state) && card.run.startedAt >= entry.at - 5000
      return !expired && !failed && !isDelivered(entry, messages)
    })
    if (keep.length !== list.length) changed = true
    if (keep.length) state.pending.set(id, keep)
    else state.pending.delete(id)
  }
  return changed
}

let burstTimer = null

function burstRefresh() {
  clearInterval(burstTimer)
  let ticks = 0
  burstTimer = setInterval(() => {
    ticks += 1
    refresh()
    if (ticks >= 25 || state.pending.size === 0) clearInterval(burstTimer)
  }, 600)
}

function sendWidgetPrompt(frame, prompt) {
  if (frame.closest('.agent-log, .sc-log')) return false
  const id = frame.closest('.card')?.dataset.id
  if (!id) return false
  const box = document.createElement('textarea')
  box.value = prompt
  submitPrompt(id, box)
  return true
}

function renderMessage(m) {
  if (m.role === 'widget') return renderWidget(m)
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
  const wrap = el('div', `msg ${m.role}${m.pending ? ' pending' : ''}`)
  const body = el('div', 'body')
  richText(body, m.text)
  if (m.pending) {
    const status = el('time', 'sending')
    status.append(el('span', 'spinner'), text('Sending…'))
    wrap.append(body, status)
  } else {
    wrap.append(body, el('time', undefined, clock(m.at)))
  }
  return wrap
}

function autosize(box) {
  box.style.height = 'auto'
  box.style.height = `${Math.min(box.scrollHeight, 180)}px`
}

async function submitPrompt(id, box) {
  const typed = box.value.trim()
  const fresh = freshCommand(typed)
  if (fresh !== null) return startFreshChat(id, box, fresh)
  const side = sideCommand(typed)
  if (side !== null) return startSideFromComposer(id, box, side)
  const files = attachmentsOf(id)
  if (!typed && !files.length) return
  const prompt = withAttachments(id, typed)
  clearNotifications(id)
  const card = state.cards.find((c) => c.id === id)
  const busy = card?.run?.state === 'running' || card?.active || Boolean(card?.live?.attention) || card?.queue?.items.length > 0
  box.value = ''
  state.drafts.delete(id)
  state.attachments.delete(id)
  autosize(box)
  if (!busy) {
    addPending(id, prompt)
    const view = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)
    if (view) view.dataset.stick = 'true'
    renderFocus()
  }
  setNote(id, 'Sending…')
  let result = await postJson(busy ? '/api/queue' : '/api/prompt', { id, prompt })
  if (!busy && shouldQueue(result)) {
    dropPending(id, prompt)
    result = await postJson('/api/queue', { id, prompt })
  }
  if (result.ok) {
    setNote(id, null)
  } else {
    dropPending(id, prompt)
    state.drafts.set(id, typed)
    if (files.length) state.attachments.set(id, files)
    setNote(id, result.data.error ?? 'Could not send')
  }
  state.signature = ''
  await refresh()
  if (state.pending.size) burstRefresh()
}

async function createSchedule(c, box) {
  const ui = uiOf(c.id)
  const typed = box.value.trim()
  const at = new Date(ui.at).getTime()
  if (!typed && !attachmentsOf(c.id).length) return setNote(c.id, 'Type the prompt to schedule first.') || renderFocus()
  const prompt = withAttachments(c.id, typed)
  if (!Number.isFinite(at)) return setNote(c.id, 'Pick a date and time.') || renderFocus()
  const { ok, data } = await postJson('/api/schedule', { id: c.id, prompt, at, repeat: ui.repeat })
  if (ok) {
    state.drafts.delete(c.id)
    state.attachments.delete(c.id)
    ui.popover = null
    setNote(c.id, null)
  } else {
    setNote(c.id, data.error ?? 'Could not schedule')
  }
  await resync()
}

async function loadCommands(id, query = `id=${encodeURIComponent(id)}`) {
  const known = state.commands.get(id)
  if (known && (known.loading || Date.now() - known.at < 60_000)) return
  state.commands.set(id, { items: known?.items ?? null, loading: true, at: Date.now() })
  let items = known?.items ?? []
  try {
    items = (await getJson(`/api/commands?${query}`)).items ?? []
  } catch {}
  state.commands.set(id, { items, loading: false, at: Date.now() })
  if (id.startsWith('folder:')) syncScheduleSlash()
  else resyncSlash(id)
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
    const force = el('button', 'btn', 'Send now')
    force.title = c.run?.state === 'running' ? 'Interrupt the running prompt and send this message now' : 'Send this message now, even if the session looks busy in the desktop app'
    force.onclick = async () => {
      const result = await postJson('/api/queue/force', { id: c.id, qid: item.qid })
      if (!result.ok) toast({ id: 'force-send', title: 'Could not send now', kind: 'finished', message: result.data?.error ?? 'Could not send' })
      resync()
    }
    const { text: body, files } = splitAttachments(item.prompt)
    const content = el('div', 't')
    const shown = visibleText(body)
    if (shown) content.append(el('div', 'qtext', shown))
    if (files.length) {
      const strip = el('div', 'qfiles')
      for (const file of files) {
        const chip = el('div', 'qfile')
        chip.title = file.path
        if (file.image) {
          const thumb = document.createElement('img')
          thumb.src = `/api/upload?path=${encodeURIComponent(file.path)}`
          thumb.alt = file.name
          thumb.loading = 'lazy'
          thumb.onerror = () => thumb.replaceWith(icon('paperclip', { size: 14 }))
          chip.append(thumb)
        } else chip.append(icon('paperclip', { size: 14 }))
        chip.append(el('span', 'n', file.name))
        strip.append(chip)
      }
      content.append(strip)
    }
    row.append(el('span', 'n', String(index + 1)), content, force, remove)
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
    const run = el('button')
    run.append(icon('play', { size: 14 }))
    run.title = item.repeat === 'none' ? 'Run now' : 'Run now (the schedule stays)'
    run.setAttribute('aria-label', 'Run now')
    run.onclick = async () => {
      run.disabled = true
      const { ok, data } = await postJson('/api/schedule/run', { sid: item.sid })
      if (!ok) {
        run.disabled = false
        run.title = data.error ?? 'Could not run it now'
        return
      }
      resync()
    }
    row.append(icon('clock', { size: 15 }), el('span', 'when', `${dateTime(item.at)}${repeat}`), el('span', 't', item.prompt), run, remove)
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

// Header for a composer popover, with its own Close button: a phone has no Esc key.
function popoverHead(c, title) {
  const head = el('div', 'pop-head')
  const close = el('button', 'icon-only pop-close')
  close.type = 'button'
  close.title = 'Close'
  close.setAttribute('aria-label', 'Close')
  close.append(icon('x', { size: 16 }))
  close.onclick = () => closePopover(c.id)
  head.append(el('h4', undefined, title), close)
  return head
}

function closePopover(id) {
  const ui = uiOf(id)
  if (!ui.popover) return
  ui.popover = null
  renderFocus()
}

function renderSnippetPopover(c, box) {
  const ui = uiOf(c.id)
  const pop = el('div', 'popover')
  pop.append(popoverHead(c, 'Prompt shortcuts'))
  const list = el('div', 'snip-list')
  for (const snippet of state.snippets) {
    const row = el('div', 'snip')
    const remove = el('button')
    remove.append(icon('trash', { size: 14 }))
    remove.title = 'Delete shortcut'
    remove.setAttribute('aria-label', `Delete shortcut ${snippet.label}`)
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
  pop.append(popoverHead(c, 'Send the text in the box later'))
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
  const busy = running || c.active || Boolean(c.live?.attention) || c.queue?.items.length > 0
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
  box.onpaste = (event) => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (!files.length) return
    event.preventDefault()
    attachFiles(c.id, files)
  }
  composer.append(box)

  const tools = el('div', 'tools')
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.multiple = true
  picker.hidden = true
  picker.onchange = () => { attachFiles(c.id, picker.files); picker.value = '' }
  const attach = el('button', 'tool')
  attach.append(icon('paperclip', { size: 18 }))
  attach.title = 'Attach files or images (you can also paste or drop them)'
  attach.onclick = () => picker.click()
  tools.append(attach, picker)
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
    note.textContent = c.run.stopRequested
      ? 'Stopping the board run…'
      : c.run.pending?.length
        ? 'Waiting for your answer above. The run continues as soon as you reply.'
        : `Board run in progress (${c.run.mode}) · started ${relative(c.run.startedAt)}.${c.source === 'board' ? '' : ' Do not type in the desktop app until it finishes or you press Stop.'}`
    note.classList.add('running')
  } else if (c.run?.state === 'done' && c.run.handoff?.ready) {
    note.textContent = 'Handoff written. A new chat should be open in the desktop app: press Enter there to start it. '
    const again = el('a', undefined, 'Open it again')
    again.href = handoffLinkFor(c)
    note.append(again)
  } else if (c.run?.state === 'failed' || c.run?.state === 'stalled') {
    note.textContent = `Last prompt ${c.run.state === 'stalled' ? 'stalled' : 'failed'}: ${c.run.error} `
    note.classList.add('error')
    if (c.run.prompt) {
      const retry = el('a', undefined, 'Retry')
      retry.href = '#'
      retry.onclick = async (event) => {
        event.preventDefault()
        const result = await postJson('/api/prompt', { id: c.id, prompt: c.run.prompt })
        setNote(c.id, result.ok ? null : (result.data.error ?? 'Could not send'))
        await resync()
      }
      note.append(retry)
    }
  } else if (c.run?.state === 'stopped') {
    note.textContent = 'Last prompt was stopped.'
  } else if (c.active && c.source !== 'board') {
    note.textContent = 'Busy in the desktop app. New prompts are queued until it is idle.'
  }

  for (const part of [renderAsks(c), renderSchedules(c), renderQueue(c)]) if (part) dock.append(part)
  if (ui.popover === 'snippets') dock.append(renderSnippetPopover(c, box))
  if (ui.popover === 'schedule') dock.append(renderSchedulePopover(c, box))
  const attachments = renderAttachments(c)
  if (attachments) dock.append(attachments)
  const replies = quickReplies(c)
  if (replies.length) {
    const chips = el('div', 'quick-replies')
    for (const reply of replies) {
      const chip = el('button', 'quick-reply', reply.label)
      chip.title = `Send "${reply.prompt}"`
      chip.onclick = () => {
        chips.querySelectorAll('button').forEach((b) => { b.disabled = true })
        const sender = document.createElement('textarea')
        sender.value = reply.prompt
        submitPrompt(c.id, sender)
      }
      chips.append(chip)
    }
    dock.append(chips)
  }
  dock.append(composer, note)
  syncSlash(c.id, dock, box)
  requestAnimationFrame(() => autosize(box))
  return dock
}

// A running board session can stop and ask: an MCP server (e.g. Supabase before a migration) wants a yes/no,
// which a one-shot `claude -p` run could only cancel. The answer goes back to the waiting run.
function renderAsks(c) {
  const asks = c.run?.state === 'running' ? c.run.pending ?? [] : []
  if (!asks.length) return null
  const wrap = el('div', 'asks')
  for (const ask of asks) {
    if (ask.kind === 'question') {
      wrap.append(renderQuestionAsk(c, ask))
      continue
    }
    const key = `${c.id}:${ask.id}`
    const values = state.asks.get(key) ?? {}
    state.asks.set(key, values)
    const card = el('form', 'ask')
    card.append(el('div', 'ask-server', `${ask.server || 'A tool'} asks${ask.title ? ` · ${ask.title}` : ''}`), el('div', 'ask-message', ask.message))
    if (ask.url) {
      const link = el('a', undefined, ask.url)
      link.href = ask.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      card.append(link)
    }
    const inputs = []
    for (const field of ask.fields) {
      const row = el('label', 'ask-field')
      row.append(el('span', undefined, `${field.title}${field.required ? ' *' : ''}`))
      let input
      if (field.type === 'boolean') {
        input = el('input')
        input.type = 'checkbox'
        input.checked = values[field.name] ?? field.default === true
        values[field.name] ??= input.checked
        input.onchange = () => { values[field.name] = input.checked }
      } else if (field.type === 'choice' || field.type === 'multi') {
        input = el('select')
        input.multiple = field.type === 'multi'
        for (const option of field.options ?? []) {
          const node = el('option', undefined, option.label)
          node.value = option.value
          node.selected = [].concat(values[field.name] ?? field.default ?? []).includes(option.value)
          input.append(node)
        }
        input.onchange = () => { values[field.name] = field.type === 'multi' ? [...input.selectedOptions].map((o) => o.value) : input.value }
        if (field.type === 'choice' && values[field.name] === undefined) values[field.name] = input.value
      } else {
        input = el('input')
        input.type = field.type === 'string' ? 'text' : 'number'
        input.value = values[field.name] ?? field.default ?? ''
        input.oninput = () => { values[field.name] = input.value }
      }
      if (field.description) row.title = field.description
      row.append(input)
      inputs.push(input)
      card.append(row)
    }
    const status = el('span', 'ask-status')
    const buttons = []
    const answer = async (action) => {
      for (const b of buttons) b.disabled = true
      const result = await postJson('/api/prompt/answer', { id: c.id, requestId: ask.id, action, content: values })
      if (result.ok) state.asks.delete(key)
      else {
        status.textContent = result.data.error ?? 'Could not send the answer'
        for (const b of buttons) b.disabled = false
      }
      if (result.ok || result.data.error?.includes('no longer')) await resync()
    }
    const bar = el('div', 'ask-bar')
    for (const [action, label, cls] of ask.mode === 'url' ? [['accept', 'Done', 'primary'], ['cancel', 'Cancel', '']] : [['accept', 'Approve', 'primary'], ['decline', 'Decline', '']]) {
      const button = el('button', `btn ${cls}`.trim(), label)
      button.type = 'button'
      button.onclick = () => answer(action)
      buttons.push(button)
      bar.append(button)
    }
    bar.append(status)
    card.append(bar)
    card.onsubmit = (event) => event.preventDefault()
    wrap.append(card)
  }
  return wrap
}

function renderQuestionAsk(c, ask) {
  const key = `${c.id}:${ask.id}`
  const entry = state.asks.get(key) ?? { answers: {}, error: '' }
  state.asks.set(key, entry)
  const values = entry.answers
  const card = el('form', 'ask question-ask')
  const status = el('span', 'ask-status', entry.error)
  const buttons = []
  const send = async (action) => {
    for (const b of buttons) b.disabled = true
    entry.error = ''
    status.textContent = ''
    const answers = Object.fromEntries(ask.questions.map((q) => {
      const value = values[q.question] ?? { picked: [], other: '' }
      return [q.question, [...value.picked, value.other.trim()].filter(Boolean)]
    }))
    const result = await postJson('/api/prompt/answer', { id: c.id, requestId: ask.id, action, answers })
    if (result.ok) state.asks.delete(key)
    else {
      entry.error = result.data.error ?? 'Could not send the answer'
      status.textContent = entry.error
      for (const b of buttons) b.disabled = false
    }
    if (result.ok || result.data.error?.includes('no longer')) await resync()
  }
  card.append(el('div', 'ask-server', ask.questions.length > 1 ? `Claude has ${ask.questions.length} questions for you` : 'Claude has a question for you'))
  for (const q of ask.questions) {
    const value = values[q.question] ??= { picked: [], other: '' }
    const block = el('fieldset', 'question')
    const head = el('legend', 'question-head')
    if (q.header) head.append(el('span', 'question-chip', q.header))
    head.append(el('span', 'question-text', q.question))
    block.append(head)
    if (q.multiSelect) block.append(el('div', 'question-hint', 'Pick any that apply'))
    const rows = []
    const other = el('input', 'question-other')
    const sync = () => {
      for (const { row, label } of rows) {
        const on = value.picked.includes(label)
        row.classList.toggle('on', on)
        row.setAttribute('aria-checked', String(on))
      }
    }
    q.options.forEach((option, index) => {
      const row = el('button', `question-option${q.multiSelect ? ' multi' : ''}`)
      row.type = 'button'
      row.setAttribute('role', q.multiSelect ? 'checkbox' : 'radio')
      const mark = el('span', 'question-mark', q.multiSelect ? '' : String(index + 1))
      const body = el('span', 'question-body')
      body.append(el('b', undefined, option.label))
      if (option.description) body.append(el('span', 'question-desc', option.description))
      row.append(mark, body)
      row.onclick = () => {
        if (q.multiSelect) value.picked = value.picked.includes(option.label) ? value.picked.filter((label) => label !== option.label) : [...value.picked, option.label]
        else {
          value.picked = [option.label]
          value.other = ''
          other.value = ''
        }
        sync()
      }
      rows.push({ row, label: option.label })
      block.append(row)
    })
    other.type = 'text'
    other.placeholder = q.multiSelect ? 'Something else (optional)' : 'Other: type your own answer'
    other.value = value.other
    other.oninput = () => {
      value.other = other.value
      if (!q.multiSelect && other.value.trim()) {
        value.picked = []
        sync()
      }
    }
    other.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        send('accept')
      }
    }
    block.append(other)
    sync()
    card.append(block)
  }
  const bar = el('div', 'ask-bar')
  for (const [action, label, cls] of [['accept', 'Submit answers', 'primary'], ['decline', 'Skip', '']]) {
    const button = el('button', `btn ${cls}`.trim(), ask.questions.length === 1 && action === 'accept' ? 'Submit' : label)
    button.type = 'button'
    button.onclick = () => send(action)
    buttons.push(button)
    bar.append(button)
  }
  bar.append(status)
  card.append(bar)
  card.onsubmit = (event) => event.preventDefault()
  return card
}

function handoffLinkFor(c) {
  const params = new URLSearchParams({ folder: c.cwd ?? '', q: `Read the handoff document at ${c.run.handoff.file} and continue the work it describes.` })
  if (!c.cwd) params.delete('folder')
  return `claude://code/new?${params}`
}

function handoffButton(c) {
  const writing = c.run?.state === 'running' && c.run.handoff
  const board = c.source === 'board'
  const button = el('button', 'btn primary handoff', writing ? 'Writing handoff…' : (board ? 'Move to desktop' : 'Hand off'))
  button.title = board ? 'Run /handoff in this board session, then open a new chat in the desktop app with the document' : 'Run /handoff in this session, then open a new chat with the document'
  button.disabled = Boolean(writing || c.run?.state === 'running' || c.active)
  button.onclick = async () => {
    button.disabled = true
    setNote(c.id, 'Starting handoff…')
    const result = await postJson('/api/handoff', { id: c.id })
    setNote(c.id, result.ok ? null : (result.data.error ?? 'Could not start the handoff'))
    state.signature = ''
    await refresh()
  }
  return button
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
    if (level === 'danger') row.prepend(handoffButton(c))
    row.prepend(el('span', `context-alert ${level}`, `Over ${compact(limit)} · ${verb}`))
  }
  if (c.source === 'board' && level !== 'danger') row.prepend(handoffButton(c))
  head.append(row)
}

function renderAttention(c) {
  const a = c.live?.attention
  if (!a || a.board) return null
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

function renderWorking(c) {
  const live = c.live
  const label = phaseLabel(live)
  const background = runningBackground(c)
  if (!label && !live?.subagents?.length && !background.length) return null
  const row = el('div', 'working')
  if (label) {
    const line = el('div', 'working-line')
    line.append(el('span', 'pulse'), el('span', 'shimmer', label))
    if (live.phase === 'tool') line.append(sinceSpan(live.current.since))
    row.append(line)
    if (live.phase === 'tool' && live.current.text) row.append(el('div', 'what', live.current.text))
  }
  for (const sub of live.subagents) {
    const line = el('div', 'working-line sub')
    line.append(icon('corner-down-right', { size: 14 }), el('b', undefined, sub.name), el('span', 'what', sub.text), sinceSpan(sub.since))
    row.append(line)
  }
  if (background.length) {
    if (!label) {
      const line = el('div', 'working-line')
      line.append(el('span', 'pulse'), el('span', undefined, `${background.length} background ${background.length === 1 ? 'command' : 'commands'} running`))
      row.append(line)
    }
    for (const task of background.slice(0, BACKGROUND_LINES)) {
      const line = el('div', 'working-line sub')
      line.append(icon('terminal', { size: 14 }), el('b', undefined, task.kind === 'monitor' ? 'Monitor' : 'Background'), el('span', 'what', task.label), sinceSpan(new Date(task.startedAt).toISOString()))
      row.append(line)
    }
    if (background.length > BACKGROUND_LINES) row.append(el('div', 'working-line sub bg-more', `+${background.length - BACKGROUND_LINES} more`))
  }
  return row
}

const BACKGROUND_LINES = 3

const runningBackground = (c) => (c.backgroundTasks?.tasks ?? []).filter((task) => task.status === 'running')

function renderChat(c) {
  chatBase = c.cwd ?? ''
  const wrap = el('div', 'chat-wrap')
  const chat = el('div', 'chat')
  const inner = el('div', 'chat-inner')
  const messages = c.details?.chat ?? []
  const waiting = (state.pending.get(c.id) ?? []).filter((entry) => !isDelivered(entry, messages))
  const working = renderWorking(c)
  if (!c.transcriptFound && !waiting.length && !working) chat.append(el('div', 'chat-empty', 'Transcript file not found for this session.'))
  else if (!messages.length && !waiting.length && !working) chat.append(el('div', 'chat-empty', 'No messages yet.'))
  else {
    inner.append(...messages.map(renderMessage), ...waiting.map((entry) => renderMessage({ role: 'user', text: entry.text, pending: true })))
    if (working) inner.append(working)
    chat.append(inner)
  }
  const jump = el('button', 'jump')
  jump.type = 'button'
  jump.title = 'Scroll to latest'
  jump.setAttribute('aria-label', 'Scroll to latest message')
  jump.append(icon('arrow-down', { size: 18, strokeWidth: 2.4 }))
  jump.onclick = () => {
    chat.closest('.card').dataset.stick = 'true'
    chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' })
  }
  wrap.append(chat, jump)
  return wrap
}

const JUMP_THRESHOLD = 120

function syncJump(card) {
  const chat = card.querySelector('.chat')
  const jump = card.querySelector('.jump')
  if (!chat || !jump) return
  jump.classList.toggle('show', chat.scrollHeight - chat.clientHeight - chat.scrollTop > JUMP_THRESHOLD)
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
    inner.append(entry?.failed ? retryNotice('Could not load the changes.', () => loadChanges(c.id)) : el('div', 'chat-empty', 'Loading changes…'))
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

function retryNotice(message, retry) {
  const box = el('div', 'chat-empty')
  const button = el('button', 'btn', 'Retry')
  button.type = 'button'
  button.onclick = retry
  box.append(text(`${message} `), button)
  return box
}

async function loadChanges(id) {
  const entry = state.changes.get(id) ?? { data: null, at: 0, loading: false, failed: false }
  state.changes.set(id, entry)
  if (entry.loading) return
  entry.loading = true
  let redraw = false
  try {
    const data = await getJson(`/api/changes?id=${encodeURIComponent(id)}`)
    redraw = entry.failed || differs(entry.data, data)
    entry.data = data
    entry.failed = false
  } catch {
    redraw = !entry.failed && !entry.data
    entry.failed = !entry.data
  }
  entry.at = Date.now()
  entry.loading = false
  if (redraw) renderFocus()
}

const activePane = () => polledPane({ tab: state.tab, draft: state.draft, selectedId: selectedCard()?.id ?? null, paneOf: (id) => uiOf(id).pane })

function pollChanges() {
  if (activePane() !== 'changes') return
  const id = selectedCard().id
  const entry = state.changes.get(id)
  if (!entry || Date.now() - entry.at > 10_000) loadChanges(id)
}

const AGENT_STATUS = { running: 'Running', done: 'Done', stopped: 'Stopped' }

function agentMeta(item) {
  const parts = []
  const end = item.status === 'running' ? Date.now() : item.updatedAt
  if (item.startedAt && end) parts.push(duration(end - item.startedAt))
  if (item.toolCount) parts.push(`${item.toolCount} tool call${item.toolCount > 1 ? 's' : ''}`)
  if (item.usage?.output) parts.push(`${compact(item.usage.output)} output tokens`)
  if (item.usage?.model) parts.push(item.usage.model.replace(/^claude-/, ''))
  return parts.join(' · ')
}

function renderAgentRow(c, entry, item) {
  const open = entry.open === item.id
  const row = el('div', `agent-row ${item.status}${open ? ' open' : ''}`)
  row.dataset.agent = item.id
  const head = el('button', 'agent-head')
  head.type = 'button'
  head.setAttribute('aria-expanded', String(open))
  head.append(el('span', `dot ${item.status === 'running' ? 'work' : item.status === 'done' ? 'done' : 'idle'}`))
  const body = el('div', 'agent-body')
  const top = el('div', 'agent-top')
  top.append(el('b', undefined, item.type), el('span', 'agent-desc', item.description || 'No description'), el('span', 'agent-state', AGENT_STATUS[item.status] ?? item.status))
  body.append(top)
  const meta = [agentMeta(item), item.branch].filter(Boolean).join(' · ')
  if (meta) body.append(el('div', 'agent-meta', meta))
  head.append(body, icon(open ? 'chevron-up' : 'chevron-down', { size: 16 }))
  head.onclick = () => {
    entry.open = open ? null : item.id
    renderFocus()
    if (!open) loadAgentChat(c.id, item.id)
  }
  row.append(head)
  if (open) {
    const log = el('div', 'agent-log')
    const chat = entry.chats.get(item.id)
    if (!chat) log.append(el('div', 'muted', 'Loading transcript…'))
    else if (!chat.items.length) log.append(el('div', 'muted', 'No messages recorded.'))
    else log.append(...chat.items.map(renderMessage))
    row.append(log)
  }
  return row
}

function renderAgents(c) {
  const wrap = el('div', 'changes agents')
  const inner = el('div', 'changes-inner')
  wrap.append(inner)
  const entry = state.agents.get(c.id)
  if (!entry?.items) inner.append(entry?.failed ? retryNotice('Could not load the subagents.', () => loadAgents(c.id)) : el('div', 'chat-empty', 'Loading subagents…'))
  else if (!entry.items.length) inner.append(el('div', 'chat-empty', 'This session has not started any subagents.'))
  else inner.append(...entry.items.map((item) => renderAgentRow(c, entry, item)))
  return wrap
}

function agentsEntry(id) {
  if (!state.agents.has(id)) state.agents.set(id, { items: null, at: 0, open: null, chats: new Map(), loading: false, failed: false })
  return state.agents.get(id)
}

async function fetchAgentChat(entry, id, agent) {
  try {
    const { chat } = await getJson(`/api/subagents?id=${encodeURIComponent(id)}&agent=${encodeURIComponent(agent)}`)
    if (JSON.stringify(entry.chats.get(agent)?.items) === JSON.stringify(chat)) return false
    entry.chats.set(agent, { items: chat })
    return true
  } catch {
    return false
  }
}

async function loadAgents(id) {
  const entry = agentsEntry(id)
  if (entry.loading) return
  entry.loading = true
  let redraw = false
  try {
    const { items } = await getJson(`/api/subagents?id=${encodeURIComponent(id)}`)
    redraw = entry.failed || differs(entry.items, items)
    entry.items = items
    entry.failed = false
  } catch {
    redraw = !entry.failed && !entry.items
    entry.failed = !entry.items
  }
  entry.at = Date.now()
  if (entry.open && (await fetchAgentChat(entry, id, entry.open))) redraw = true
  entry.loading = false
  if (redraw) renderFocus()
}

async function loadAgentChat(id, agent) {
  const entry = agentsEntry(id)
  if ((await fetchAgentChat(entry, id, agent)) && entry.open === agent) renderFocus()
}

function pollAgents() {
  if (activePane() !== 'agents') return
  const id = selectedCard().id
  const entry = agentsEntry(id)
  const live = entry.items?.some((item) => item.status === 'running')
  if (Date.now() - entry.at > (live ? 3000 : 15_000)) loadAgents(id)
}

function mrLinks(c) {
  if (!c.mrUrls?.length) return null
  const box = el('div', 'mr-links')
  for (const url of c.mrUrls) {
    const [, repo, iid] = url.match(/\/([^/]+)\/-\/merge_requests\/(\d+)$/) ?? []
    const a = el('a', 'mr-chip', repo ? `${repo} !${iid}` : url)
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.title = `Open ${url} in GitLab`
    a.append(icon('arrow-up-right', { size: 12 }))
    box.append(a)
  }
  const all = el('a', 'mr-chip mr-all', 'Merge requests')
  const href = mrsHref(c.mrUrls)
  all.href = href
  all.title = 'Open the Merge requests page with this session\'s merge requests highlighted'
  all.onclick = (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return
    event.preventDefault()
    navigate(href, { back: true })
  }
  box.append(all)
  return box
}

function renderCard(c) {
  const ui = uiOf(c.id)
  const heat = temperatureOf(c)
  const card = el('article', `card temp-${heat.tier}${heat.group === 'cool' ? ' cool' : ''}${c.active ? ' active' : ''}`)
  card.dataset.id = c.id
  card.style.setProperty('--project', projectColor(c.project))
  const level = contextLevel(c.usage?.context ?? 0)
  if (level) card.classList.add(`ctx-${level}`)

  const head = el('div', 'card-head')
  const row = el('div', 'head-row')
  const titleBox = el('div', 'head-title')
  const meta = el('div', 'meta-line')
  meta.append(projectChip(c), el('span', 'path', home(c.cwd)))
  const turns = c.source === 'board' ? null : `${c.completedTurns} ${c.completedTurns === 1 ? 'turn' : 'turns'}`
  const tags = [c.source === 'board' && 'board only', turns]
  for (const t of tags) {
    if (t) meta.append(el('span', 'dotted', t))
  }
  meta.append(settingSelect(c, 'model'), settingSelect(c, 'effort'), settingSelect(c, 'permissionMode'))
  titleBox.append(el('div', 'title', c.title), meta)
  const mrs = mrLinks(c)
  if (mrs) titleBox.append(mrs)
  const live = el('span', 'live')
  live.append(el('span', 'dot'), text(c.active ? 'Working' : `Idle · ${relative(c.touchedAt)}`))
  const switcher = el('div', 'seg pane-switch')
  const panes = [['chat', 'Chat'], ['changes', 'Changes']]
  if (c.subagents?.total || ui.pane === 'agents') panes.push(['agents', 'Agents'])
  for (const [pane, label] of panes) {
    const b = el('button', undefined, label)
    if (pane === 'changes' && c.details?.filesEdited) b.append(el('span', 'n', String(c.details.filesEdited)))
    if (pane === 'agents' && c.subagents?.total) b.append(el('span', 'n', c.subagents.running ? `${c.subagents.running}/${c.subagents.total}` : String(c.subagents.total)))
    b.setAttribute('aria-pressed', String(ui.pane === pane))
    b.onclick = () => { ui.pane = pane; if (isMobile()) ui.more = false; renderFocus(); if (pane === 'changes') loadChanges(c.id); if (pane === 'agents') loadAgents(c.id) }
    switcher.append(b)
  }
  const step = el('div', 'stepper')
  for (const [dir, glyph, title] of [[-1, 'chevron-up', 'Previous session (↑)'], [1, 'chevron-down', 'Next session (↓)']]) {
    const b = el('button', 'icon-only')
    b.append(icon(glyph, { size: 16 }))
    b.title = title
    b.onclick = () => stepSelected(dir)
    step.append(b)
  }
  const actions = el('div', 'head-actions')
  const phone = isMobile()
  actions.append(...[phone && starButton(c.id), tempBadge(heat, c), loopBadge(c.loop), live, switcher, sideChatButton(c), tasksButton(c), lifecycleButton(c), step, openLink(c.id)].filter(Boolean))
  if (phone) {
    // Phone: the star, the actions (Chat/Changes included) and the token row all fold behind
    // the ⋯ in the header (renderMobileHeader), so the chat gets the screen.
    card.classList.toggle('more-open', Boolean(ui.more))
    if (ui.more) {
      row.append(actions)
      head.append(row)
    }
  } else {
    row.append(starButton(c.id), titleBox, actions)
    head.append(row)
  }
  for (const part of [renderAttention(c), ui.pane === 'chat' ? null : renderNowDoing(c)]) if (part) head.append(part)
  if (!phone || ui.more) renderUsage(c, head)
  if (heat.group === 'cool') head.append(coolNudge(c))

  const dock = renderComposer(c)
  card.append(head, ui.pane === 'changes' ? renderChanges(c) : ui.pane === 'agents' ? renderAgents(c) : renderChat(c), dock)
  return card
}

function orderedCards() {
  return sortCards(state.cards, state.focusSort, { promptAt: (c) => temperatureOf(c).at })
}

function coolNudge(c) {
  const box = el('div', 'cool-nudge')
  box.append(el('span', undefined, 'Still need this in Focus?'))
  const keep = el('button', undefined, 'Keep')
  keep.onclick = () => keepWarm(c.id)
  const drop = el('button', undefined, 'Unfocus')
  drop.onclick = () => setFocus(c.id, false)
  const actions = el('span', 'nudge-actions')
  actions.append(keep, drop)
  box.append(actions)
  return box
}

const views = new Map()

function snap(node) {
  const clone = node.cloneNode(true)
  clone.querySelectorAll('[data-since]').forEach((n) => { n.textContent = '' })
  return clone.outerHTML
}

function snapshotOf(card) {
  const inner = card.querySelector('.chat-inner')
  return { parts: [...card.children].map(snap), msgs: inner ? [...inner.children].map(snap) : [] }
}

function patchChat(view, oldWrap, newWrap, next) {
  const oldInner = oldWrap.querySelector('.chat-inner')
  const newInner = newWrap.querySelector('.chat-inner')
  if (!oldInner || !newInner) {
    oldWrap.replaceWith(newWrap)
    return
  }
  const { ops, remove } = listOps(view.msgs, next.msgs)
  const oldKids = [...oldInner.children]
  const newKids = [...newInner.children]
  ops.forEach((op, i) => {
    if (op === 'keep') return
    const node = newKids[i]
    if (op === 'append') {
      node.classList.add('fresh')
      oldInner.append(node)
      return
    }
    const was = oldKids[i]
    const box = was.querySelector('details')
    const now = node.querySelector('details')
    if (box?.open && now) now.open = true
    if (was.classList.contains('working')) node.classList.add('fresh')
    was.replaceWith(node)
  })
  for (let k = 0; k < remove; k += 1) oldInner.lastElementChild.remove()
}

function scrollers(node) {
  const found = [[null, node]]
  for (const log of node.querySelectorAll('.agent-log')) found.push([log.closest('.agent-row')?.dataset.agent ?? null, log])
  return found
}

function saveScroll(node) {
  return scrollers(node).map(([key, target]) => ({
    key,
    top: target.scrollTop,
    stick: target.scrollHeight - target.clientHeight - target.scrollTop < 40
  }))
}

function restoreScroll(node, saved) {
  for (const [key, target] of scrollers(node)) {
    const was = saved.find((s) => s.key === key)
    if (!was) continue
    target.scrollTop = was.stick && key ? target.scrollHeight : was.top
  }
}

function replacePane(was, node) {
  const saved = saveScroll(was)
  was.replaceWith(node)
  restoreScroll(node, saved)
}

function patchCard(view, built) {
  const next = snapshotOf(built)
  const card = view.node
  card.className = built.className
  const oldKids = [...card.children]
  const newKids = [...built.children]
  const held = new Set()
  newKids.forEach((node, i) => {
    const was = oldKids[i]
    if (!was) return card.append(node)
    if (was.className !== node.className) return was.replaceWith(node)
    if (view.parts[i] === next.parts[i]) return
    if (was.contains(document.activeElement) && document.activeElement.matches('select')) return void held.add(i)
    if (node.classList.contains('chat-wrap')) patchChat(view, was, node, next)
    else if (node.classList.contains('changes')) replacePane(was, node)
    else was.replaceWith(node)
  })
  view.parts = next.parts.map((part, i) => (held.has(i) ? view.parts[i] : part))
  view.msgs = next.msgs
}

function bindChat(card) {
  const chat = card.querySelector('.chat')
  if (!chat || chat.dataset.bound) return
  chat.dataset.bound = '1'
  chat.addEventListener('scroll', () => {
    card.dataset.stick = String(chat.scrollHeight - chat.clientHeight - chat.scrollTop < 40)
    syncJump(card)
  })
}

function sideGroups() {
  return groupCards(orderedCards(), $('side-q').value)
}

function shownGroups(groups, selectedId) {
  return visibleGroups(groups, state.collapsed, selectedId, Boolean($('side-q').value.trim()))
}

function toggleGroup(key) {
  if (state.collapsed.has(key)) state.collapsed.delete(key)
  else state.collapsed.add(key)
  remember('board.collapsedGroups', JSON.stringify([...state.collapsed]))
  renderFocus()
}

function selectedCard(groups = sideGroups()) {
  return pickSelected(groups, state.selected)
}

function selectCard(id) {
  // The sidebar is on every page: picking a session from another page opens it on Focus.
  if (state.tab !== 'focus') return void goToCard(id)
  if (state.selected === id && !state.draft) return
  state.draft = false
  state.selected = id
  remember('board.selected', id)
  if (state.tab === 'focus') history.replaceState({}, '', `/focus?card=${encodeURIComponent(id)}`)
  clearNotifications(id)
  renderFocus()
}

function stepSelected(step) {
  const groups = sideGroups()
  const current = selectedCard(groups)
  const next = current && neighbour(shownGroups(groups, current.id), current.id, step)
  if (next) selectCard(next)
}

function sideStar(id) {
  const b = starButton(id)
  const toggle = b.onclick
  b.classList.add('side-star')
  b.onclick = (event) => { event.stopPropagation(); toggle() }
  b.onkeydown = (event) => event.stopPropagation()
  return b
}

function babysitNote(entry) {
  const view = babysitView(entry)
  return view.note ? `${view.label} · ${view.note}` : view.label
}

function sideItem(c, selected) {
  const item = el('div', `item${selected ? ' sel' : ''}`)
  item.dataset.id = c.id
  item.tabIndex = 0
  item.setAttribute('role', 'option')
  item.setAttribute('aria-selected', String(selected))
  item.title = c.detail ? `${c.title}\n${c.detail}` : c.title
  const attention = c.live?.attention
  const working = c.active || c.run?.state === 'running'
  const top = el('div', 'item-top')
  top.append(el('span', `dot ${attention ? 'ask' : working ? 'work' : c.status === 'completed' ? 'done' : 'idle'}`), el('span', 'item-title', cardTitle(c)), tempMeter(temperatureOf(c), c), el('span', 'item-time', working ? 'now' : shortAge(c.touchedAt)), sideStar(c.id), kebabMenu(c.id))
  const sub = el('div', 'item-sub')
  let note = c.detail ?? ''
  let mono = false
  if (attention) note = attention.kind === 'question' ? (attention.text?.split('\n')[0] || 'Waiting for your answer') : `${attention.tool} may need approval`
  else if (working && c.live?.phase === 'tool') { note = `${c.live.current.name}${c.live.current.text ? ` · ${c.live.current.text}` : ''}`; mono = true }
  else if (working) note = phaseLabel(c.live) ?? 'Working'
  else if (c.babysit) note = babysitNote(c.babysit)
  sub.append(projectChip(c), el('span', `note${mono ? ' mono' : ''}`, note))
  const level = contextLevel(c.usage?.context ?? 0)
  if (level) sub.append(el('span', `tag ctx ${level}`, compact(c.usage.context)))
  const queued = c.queue?.items.length ?? 0
  if (queued) sub.append(el('span', 'tag q', `+${queued}`))
  const sides = sideChatCount(state.sessions, c.id)
  if (sides) {
    const tag = el('span', 'tag sidechat')
    tag.append(icon('message-circle', { size: 11 }), text(` ${sides}`))
    tag.title = `${sides} side ${sides === 1 ? 'chat' : 'chats'}`
    sub.append(tag)
  }
  const sched = c.schedules ?? []
  if (sched.length) {
    const tag = el('span', 'tag sched')
    tag.append(icon('clock', { size: 11 }), document.createTextNode(sched.length > 1 ? ` ${sched.length}` : ` ${clock(new Date(sched[0].at).toISOString())}`))
    tag.title = sched.map((x) => `${dateTime(x.at)}${x.repeat === 'none' ? '' : ` · ${x.repeat}`}: ${x.prompt}`).join('\n')
    sub.append(tag)
  }
  item.append(top, sub)
  if (working && c.usage) {
    const bar = el('div', 'item-bar')
    const fill = el('i', level ? 'warn' : undefined)
    fill.style.width = `${Math.min(100, Math.round((c.usage.context / CONTEXT_DANGER) * 100))}%`
    bar.append(fill)
    item.append(bar)
  }
  item.dataset.group = groupOf(c)
  item.draggable = true
  item.ondragstart = (event) => {
    state.dragId = c.id
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-board-session', c.id)
    requestAnimationFrame(() => item.classList.add('dragging'))
  }
  item.ondragend = endSideDrag
  item.ondragover = (event) => {
    if (!state.dragId || !sameSideGroup(state.dragId, c.id)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const box = item.getBoundingClientRect()
    showSideDrop(item, event.clientY > box.top + box.height / 2)
  }
  item.ondrop = (event) => {
    if (!state.dragId || !sameSideGroup(state.dragId, c.id)) return
    event.preventDefault()
    const box = item.getBoundingClientRect()
    dropSessionOn(c.id, event.clientY > box.top + box.height / 2)
  }
  item.onclick = () => selectCard(c.id)
  item.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectCard(c.id) } }
  return item
}

// Drag a sidebar session to reorder it. The new order is saved as the Manual order, so it
// also takes over from any other sort. Sessions only move inside their own group.
const sideItemOf = (id) => document.querySelector(`#side-list .item[data-id="${CSS.escape(id)}"]`)
const sameSideGroup = (a, b) => sideItemOf(a)?.dataset.group === sideItemOf(b)?.dataset.group

function showSideDrop(item, after) {
  clearSideDrop()
  item.classList.add(after ? 'drop-after' : 'drop-before')
}
const clearSideDrop = () => document.querySelectorAll('#side-list .drop-before, #side-list .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'))

function endSideDrag() {
  const dirty = state.dragDirty
  state.dragId = null
  state.dragDirty = false
  clearSideDrop()
  document.querySelectorAll('#side-list .dragging').forEach((n) => n.classList.remove('dragging'))
  if (dirty) renderFocus()
}

async function dropSessionOn(targetId, after) {
  const id = state.dragId
  const shown = orderedCards().map((c) => c.id)
  const next = moveWithin(shown, id, targetId, after, sameSideGroup)
  endSideDrag()
  if (next === shown || next.join() === shown.join()) return
  state.focusSort = 'manual'
  remember('board.focusSort', 'manual')
  const byId = new Map(state.cards.map((c) => [c.id, c]))
  state.cards = next.map((x) => byId.get(x)).filter(Boolean)
  state.focusIds = next
  renderFocus()
  const result = await postJson('/api/focus/order', { ids: next })
  if (!result.ok) setNote(id, result.data?.error ?? 'Could not save the new order')
  state.signature = ''
  await refresh()
}

// Phone drawer: every session that is not starred, so the drawer lists all of them.
// Tapping one stars it (it becomes a Focus card) and opens it.
function renderOthers(list) {
  const q = $('side-q').value.trim().toLowerCase()
  const starred = new Set(state.focusIds)
  const rest = mainSessions(state.sessions)
    .filter((s) => !starred.has(s.id) && ($('archived').checked || !s.archived) && (!q || `${s.title} ${s.project} ${s.cwd}`.toLowerCase().includes(q)))
    .sort((a, b) => (b.touchedAt ?? b.lastActivityAt ?? 0) - (a.touchedAt ?? a.lastActivityAt ?? 0))
  if (!rest.length) {
    if (!list.children.length) list.append(el('div', 'side-empty', q ? 'No session matches.' : 'No sessions yet.'))
    return
  }
  const head = el('div', 'grp', 'Other sessions')
  head.append(el('span', 'n', String(rest.length)))
  list.append(head)
  for (const s of rest.slice(0, 60)) {
    const item = el('div', 'item other-item')
    item.tabIndex = 0
    item.setAttribute('role', 'option')
    const top = el('div', 'item-top')
    top.append(el('span', `dot ${s.active ? 'work' : s.status === 'completed' ? 'done' : 'idle'}`), el('span', 'item-title', s.title), el('span', 'item-time', s.active ? 'now' : shortAge(s.touchedAt ?? s.lastActivityAt)))
    const sub = el('div', 'item-sub')
    sub.append(projectChip(s))
    item.append(top, sub)
    const open = async () => { await setFocus(s.id, true); goToCard(s.id) }
    item.onclick = open
    item.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } }
    list.append(item)
  }
  if (rest.length > 60) list.append(el('div', 'side-empty', `${rest.length - 60} more: use the filter or All sessions`))
}

function renderMobileHeader(current) {
  const box = $('m-title')
  const back = isMobile() ? history.state?.back : null
  $('m-back').hidden = !back
  $('menu-btn').hidden = Boolean(back)
  if (back) {
    const label = back.startsWith('/focus') ? 'Back to the chat' : `Back to ${PAGE_TITLES[ROUTES[back.split('?')[0]]] ?? 'the previous page'}`
    $('m-back').title = label
    $('m-back').setAttribute('aria-label', label)
  }
  const more = $('m-more')
  more.hidden = !(isMobile() && state.tab === 'focus' && !state.draft && current)
  if (!more.hidden) {
    // The session's ⋯ lives in the header on phones; a dot on it keeps the context warning visible.
    const level = contextLevel(current.usage?.context ?? 0)
    more.dataset.id = current.id
    more.dataset.ctx = level ?? ''
    more.title = level ? 'Session actions · context is getting full' : 'Session actions'
    more.setAttribute('aria-expanded', String(Boolean(uiOf(current.id).more)))
  }
  if (!isMobile()) return box.replaceChildren()
  const onFocus = state.tab === 'focus'
  const title = el('div', 'm-title-main', onFocus ? (state.draft ? 'New chat' : current?.title ?? 'Focus') : PAGE_TITLES[state.tab])
  box.replaceChildren(title)
  if (onFocus && !state.draft && current) {
    const attention = current.live?.attention
    const working = current.active || current.run?.state === 'running'
    const sub = el('div', 'm-title-sub')
    sub.append(el('span', `dot ${attention ? 'ask' : working ? 'work' : 'idle'}`), el('span', undefined, `${attention ? 'Needs you' : working ? 'Working' : 'Idle'}${current.project ? ` · ${current.project}` : ''}`))
    box.append(sub)
  }
}

function groupSummaryNode({ running, idle, nextAt }) {
  const box = el('span', 'sum')
  if (running) box.append(el('span', 'spinner'), el('span', undefined, `${running} running`))
  if (idle) box.append(el('span', undefined, `${running ? '· ' : ''}${idle} idle`))
  if (nextAt) box.append(el('span', 'next', `next ${clock(new Date(nextAt).toISOString())}`))
  box.title = [running ? `${running} running` : null, idle ? `${idle} idle` : null, nextAt ? `Next scheduled check ${dateTime(nextAt)}` : 'No check scheduled'].filter(Boolean).join(' · ')
  return box
}

let sideMarkup = ''
let sideSelectedId = null

function renderSide(groups, selected) {
  const list = $('side-list')
  const next = el('div')
  for (const g of groups) {
    const collapsible = COLLAPSIBLE.has(g.key) && !$('side-q').value.trim()
    const head = el('div', `grp${g.key === 'need' ? ' need' : ''}${collapsible ? ' fold' : ''}`)
    if (collapsible) {
      head.tabIndex = 0
      head.setAttribute('role', 'button')
      head.setAttribute('aria-expanded', String(!g.collapsed))
      head.append(icon(g.collapsed ? 'chevron-right' : 'chevron-down', { size: 12 }))
      head.onclick = () => toggleGroup(g.key)
      head.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleGroup(g.key) } }
    }
    head.append(el('span', undefined, g.label), el('span', 'n', String(g.total ?? g.cards.length)))
    if (g.summary) head.append(groupSummaryNode(g.summary))
    next.append(head)
    for (const c of g.cards) next.append(sideItem(c, c.id === selected?.id))
  }
  if (!groups.length && !isMobile()) next.append(el('div', 'side-empty', $('side-q').value.trim() ? 'No focused session matches.' : ''))
  if (isMobile()) renderOthers(next)
  const markup = next.innerHTML
  const selectedId = selected?.id ?? null
  if (markup === sideMarkup) {
    sideSelectedId = selectedId
    return
  }
  sideMarkup = markup
  const scroll = list.scrollTop
  const focusedId = list.contains(document.activeElement) ? document.activeElement.closest('.item')?.dataset.id : null
  list.replaceChildren(...next.childNodes)
  list.scrollTop = scroll
  if (selectedId !== sideSelectedId) list.querySelector('.item.sel')?.scrollIntoView({ block: 'nearest' })
  sideSelectedId = selectedId
  if (focusedId) list.querySelector(`.item[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true })
}

function renderFocus() {
  if (state.dragId) { state.dragDirty = true; return }
  hideTip()
  const stage = $('cards')
  const active = document.activeElement
  const keep = active?.dataset?.keep
  const caret = keep && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null
  const pageTop = window.scrollY
  const pageLeft = window.scrollX
  if (state.wanted && state.loaded) {
    const asked = state.wanted
    state.wanted = null
    if (!state.focusIds.includes(asked) && state.sessions.some((s) => s.id === asked)) openInFocus(asked)
  }
  const groups = sideGroups()
  const current = selectedCard(groups)
  // A selection that never showed up (stale id from an earlier visit) is replaced by the card we fell
  // back to, so the chat stops following whichever row is on top. A selection that was showing and then
  // vanished (one poll missed it) is kept, so it comes back when the card does.
  if (current && !state.draft && !$('side-q').value.trim()) {
    if (state.selected === current.id) state.selectedSeen = current.id
    else if (state.selectedSeen !== state.selected) {
      state.selected = current.id
      state.selectedSeen = current.id
      remember('board.selected', current.id)
      if (state.tab === 'focus' && new URLSearchParams(location.search).get('card') && new URLSearchParams(location.search).get('card') !== current.id) history.replaceState(history.state, '', `/focus?card=${encodeURIComponent(current.id)}`)
    }
  }
  const wanted = current && !state.draft ? [current] : []
  const ids = wanted.map((c) => c.id)
  for (const [id, view] of views) {
    if (ids.includes(id)) continue
    view.node.remove()
    views.delete(id)
  }
  const created = new Set()
  for (const c of wanted) {
    const built = renderCard(c)
    const view = views.get(c.id)
    if (view?.node.isConnected) patchCard(view, built)
    else {
      views.set(c.id, { node: built, ...snapshotOf(built) })
      built.dataset.stick = 'true'
      created.add(c.id)
      stage.append(built)
    }
  }
  for (const id of ids) {
    const card = views.get(id).node
    bindChat(card)
    const chat = card.querySelector('.chat')
    if (!chat) continue
    const place = () => { if (card.dataset.stick === 'true') chat.scrollTop = chat.scrollHeight }
    place()
    syncJump(card)
    if (created.has(id)) requestAnimationFrame(() => { place(); syncJump(card) })
  }
  if (keep) {
    const field = stage.querySelector(`[data-keep="${keep}"]`)
    if (field && !field.disabled) {
      field.focus({ preventScroll: true })
      if (caret && field.setSelectionRange && field.type !== 'datetime-local') field.setSelectionRange(...caret)
    }
  }
  if (state.draft) {
    if (!draft) buildDraft()
    if (!draft.node.isConnected) stage.append(draft.node)
    if (draft.rootsKey !== [...folderRoots().keys()].join('|')) fillFolders()
    syncDraftAttachments()
  } else draft?.node.remove()
  if (window.scrollY !== pageTop || window.scrollX !== pageLeft) window.scrollTo(pageLeft, pageTop)
  renderSide(shownGroups(groups, current?.id), state.draft || state.tab !== 'focus' ? null : current)
  const none = state.loaded && state.cards.length === 0 && !state.draft
  stage.hidden = none
  $('focus-empty').hidden = !none
  $('new-chat').setAttribute('aria-pressed', String(state.draft))
  const badge = $('focus-count')
  badge.hidden = none
  badge.textContent = String(state.cards.length)
  renderSortMenu()
  renderMobileHeader(state.draft ? null : current)
  renderTaskPanel(state.draft ? null : current)
}

function goToCard(id) {
  state.draft = false
  state.selected = id
  remember('board.selected', id)
  clearNotifications(id)
  if (state.tab !== 'focus') navigate(`/focus?card=${encodeURIComponent(id)}`)
  else {
    history.replaceState({}, '', `/focus?card=${encodeURIComponent(id)}`)
    renderFocus()
  }
}

let draft = null
const NEW_KEY = 'new-chat'

function folderRoots() {
  const roots = new Map()
  for (const s of state.sessions) {
    const root = s.projectRoot ?? s.cwd
    if (root && !roots.has(root)) roots.set(root, s.project ?? root.split('/').pop())
  }
  return roots
}

function fillFolders() {
  const roots = folderRoots()
  draft.rootsKey = [...roots.keys()].join('|')
  const { select } = draft
  const previous = select.value
  const extra = [...select.options].map((o) => o.value).filter((v) => v && !roots.has(v))
  select.replaceChildren(
    ...[...roots].map(([root, name]) => new Option(`${name} — ${home(root)}`, root)),
    ...extra.map((path) => new Option(`${path.split('/').filter(Boolean).pop() ?? path} — ${home(path)}`, path)),
    new Option('Other folder…', ''),
  )
  const known = [...select.options].some((o) => o.value === previous && previous !== '')
  select.value = known ? previous : ([...roots.keys()][0] ?? '')
  state.lastFolder = select.value || null
  syncDraftFolder()
}

const draftFolder = () => draft.select.value

// Settings a board session can start with, as `claude` flags. '' leaves the CLI / board default.
const NEW_OPTIONS = [
  ['model', 'Model', [['', 'Default'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]],
  ['effort', 'Effort', [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]],
  ['chrome', 'Chrome', [['', 'Off'], ['on', 'On (Claude in Chrome)']]],
  ['permissionMode', 'Permissions', [['', 'Board default'], ['manual', 'Ask (denies in headless)'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan mode'], ['auto', 'Auto'], ['dontAsk', "Don't ask"], ['bypassPermissions', 'Bypass permissions']]],
]

function setDraftNote(message, kind) {
  draft.note.textContent = message ?? ''
  draft.note.className = `run-note${kind ? ` ${kind}` : ''}`
}

function syncDraftFolder() {
  const folder = draftFolder()
  draft.sub.textContent = folder ? home(folder) : 'Choose a folder to work in'
  showNewDefaults(folder)
}

// The first option of each select says what "default" really is for the chosen folder: the
// model and effort `claude` would use from its settings files, and the board's permission mode.
const defaultsByFolder = new Map()
let defaultsFor = null
async function defaultsOf(folder) {
  const key = folder || ''
  if (!defaultsByFolder.has(key)) {
    const found = await getJson(`/api/new-defaults?folder=${encodeURIComponent(key)}`).catch(() => null)
    if (!found) return null
    defaultsByFolder.set(key, found)
  }
  return defaultsByFolder.get(key)
}

async function showNewDefaults(folder) {
  defaultsFor = folder
  if (!(await defaultsOf(folder))) return
  if (defaultsFor !== folder || !draft) return
  const found = defaultsByFolder.get(folder || '')
  for (const [name, label, choices] of NEW_OPTIONS) {
    if (name === 'chrome') continue
    const first = draft.optSelects[name].options[0]
    const value = found[name]
    const shown = value ? (choices.find(([v]) => v === value)?.[1] ?? value) : null
    const base = name === 'permissionMode' ? 'Board default' : 'Default'
    first.textContent = shown ? `${base} (${shown})` : `${base} (account setting)`
  }
}

const SETTING_LABELS = { model: 'Model', effort: 'Effort', permissionMode: 'Mode' }

function settingSelect(c, name) {
  const choices = NEW_OPTIONS.find(([key]) => key === name)[2]
  const select = el('select', 'dotted setting-select')
  const current = c[name]
  const shown = (value) => choices.find(([v]) => v === value)?.[1] ?? String(value).replace(/^claude-/, '')
  const stored = c.override?.[name] ?? ''
  const inherited = !stored && current ? shown(current) : null
  for (const [value, label] of choices) {
    const option = el('option', null, value === '' ? `${SETTING_LABELS[name]}: ${inherited ?? 'default'}` : `${SETTING_LABELS[name]}: ${label}`)
    option.value = value
    select.append(option)
  }
  if (stored && !choices.some(([v]) => v === stored)) {
    const option = el('option', null, `${SETTING_LABELS[name]}: ${stored}`)
    option.value = stored
    select.append(option)
  }
  select.value = stored
  select.title = `Applies from this session's next prompt. Choose the first entry to go back to the default.`
  select.addEventListener('change', async () => {
    select.disabled = true
    const result = await postJson('/api/session/settings', { id: c.id, [name]: select.value })
    select.disabled = false
    if (!result.ok) select.value = stored
    else resync()
  })
  return select
}

function buildDraft() {
  const node = el('article', 'card new-chat')
  const head = el('div', 'card-head')
  const row = el('div', 'head-row')
  const titleBox = el('div', 'head-title')
  titleBox.append(el('div', 'title', 'New chat'))
  const close = el('button', 'icon-only')
  close.append(icon('x', { size: 16 }))
  close.title = 'Cancel (Esc)'
  close.onclick = closeNewChat
  const actions = el('div', 'head-actions')
  actions.append(close)
  row.append(titleBox, actions)
  head.append(row)

  const wrap = el('div', 'chat-wrap')
  const chat = el('div', 'chat')
  const hello = el('div', 'chat-empty new-hello')
  const sub = el('div', 'hello-sub')
  hello.append(el('div', 'hello-title', 'What should Claude work on?'), sub)
  chat.append(hello)
  wrap.append(chat)

  const dock = el('div', 'dock')
  const pick = el('div', 'new-pick')
  const select = el('select', 'field')
  select.setAttribute('aria-label', 'Project folder')
  pick.append(el('span', 'new-label', 'Project'), select)

  const opts = el('div', 'new-opts')
  const optSelects = {}
  const saved = (() => { try { return JSON.parse(localStorage.getItem('board.newOpts') || '{}') } catch { return {} } })()
  for (const [key, label, choices] of NEW_OPTIONS) {
    const field = el('label', 'new-opt')
    const sel = el('select', 'field')
    sel.setAttribute('aria-label', label)
    sel.replaceChildren(...choices.map(([value, name]) => new Option(name, value)))
    sel.value = choices.some(([value]) => value === saved[key]) ? saved[key] : ''
    sel.onchange = () => {
      const now = Object.fromEntries(Object.entries(optSelects).map(([k, s]) => [k, s.value]))
      try { localStorage.setItem('board.newOpts', JSON.stringify(now)) } catch {}
    }
    optSelects[key] = sel
    field.append(el('span', 'new-label', label), sel)
    opts.append(field)
  }
  opts.title = 'Used by Start here. Open in Claude opens the desktop app, which has its own model and effort pickers.'

  const composer = el('div', 'composer')
  const box = document.createElement('textarea')
  box.rows = 1
  box.placeholder = 'Describe the first task · Enter to start'
  composer.append(box)
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.multiple = true
  picker.hidden = true
  picker.onchange = () => { attachFiles(NEW_KEY, picker.files); picker.value = '' }
  const attach = el('button', 'tool')
  attach.append(icon('paperclip', { size: 18 }))
  attach.title = 'Attach files or images (you can also paste or drop them)'
  attach.onclick = () => picker.click()
  const tools = el('div', 'tools')
  tools.append(attach, picker)
  composer.append(tools)
  const open = el('button', 'send stop-side')
  open.append(icon('arrow-up-right', { size: 18 }))
  open.title = 'Open in Claude: opens the desktop app on this folder with the prompt filled in. You press send there.'
  open.setAttribute('aria-label', 'Open in Claude')
  const here = el('button', 'send')
  here.append(icon('arrow-up', { size: 18, strokeWidth: 2.5 }))
  here.title = 'Start here: run the prompt now on the board only (Enter)'
  here.setAttribute('aria-label', 'Start here')
  composer.append(open, here)
  const note = el('div', 'run-note')
  const hint = el('div', 'new-hint', '↑ (Enter) starts it here and runs on the board only, with the permission mode shown on its card. ↗ opens the desktop app on this folder with the prompt filled in: you press send there.')
  const attachments = el('div', 'attachments-slot')
  dock.append(pick, opts, attachments, composer, hint, note)

  node.append(head, wrap, dock)
  draft = { node, select, optSelects, text: box, note, sub, here, open, attachments, shown: '' }
  select.onchange = chooseFolder
  here.onclick = startHere
  open.onclick = startNewChat
  box.oninput = () => autosize(box)
  box.onpaste = (event) => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (!files.length) return
    event.preventDefault()
    attachFiles(NEW_KEY, files)
  }
  box.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); startHere() }
  }
  return draft
}

function syncDraftAttachments() {
  const files = attachmentsOf(NEW_KEY)
  const key = files.map((f) => f.path).join('|')
  if (draft.shown === key) return
  draft.shown = key
  const row = renderAttachments({ id: NEW_KEY })
  draft.attachments.replaceChildren(...(row ? [row] : []))
}

function clearDraftAttachments() {
  for (const file of attachmentsOf(NEW_KEY)) if (file.preview) URL.revokeObjectURL(file.preview)
  state.attachments.delete(NEW_KEY)
  syncDraftAttachments()
}


function startSideFromComposer(id, box, question) {
  const card = state.cards.find((c) => c.id === id)
  if (!card) return
  box.value = ''
  state.drafts.delete(id)
  autosize(box)
  if (!(state.panel.open && state.panel.tab === 'sidechats')) openPanelTab('sidechats')
  if (question) return startSideChat(card, question)
  requestAnimationFrame(() => document.querySelector(`textarea[data-keep="sc:new:${CSS.escape(id)}"]`)?.focus())
}

function startFreshChat(id, box, firstPrompt) {
  const card = state.cards.find((c) => c.id === id)
  box.value = ''
  state.drafts.delete(id)
  autosize(box)
  openNewChat()
  if (!draft) return
  if (card?.cwd) {
    addPickedFolder(card.cwd)
    state.lastFolder = card.cwd
    syncDraftFolder()
  }
  for (const key of ['model', 'effort', 'permissionMode']) {
    const select = draft.optSelects[key]
    const value = card?.[key]
    if (value && [...select.options].some((option) => option.value === value)) select.value = value
  }
  draft.text.value = firstPrompt.trim()
  autosize(draft.text)
  draft.text.focus()
  setDraftNote(`A fresh session in ${card?.cwd ? home(card.cwd) : 'a folder you choose'}. Write its first prompt.`)
}

function openNewChat() {
  if (state.tab !== 'focus') return void navigate('/focus?new=1')
  state.draft = true
  history.replaceState({}, '', '/focus?new=1')
  renderFocus()
  draft.text.focus()
}

function closeNewChat() {
  if (!state.draft) return
  state.draft = false
  const current = selectedCard()
  history.replaceState({}, '', current ? `/focus?card=${encodeURIComponent(current.id)}` : '/focus')
  renderFocus()
}

function addPickedFolder(path) {
  const { select } = draft
  const existing = [...select.options].find((o) => o.value === path)
  if (existing) return void (select.value = path)
  const option = new Option(`${path.split('/').filter(Boolean).pop() ?? path} — ${home(path)}`, path)
  select.insertBefore(option, select.querySelector('option[value=""]'))
  select.value = path
}

async function chooseFolder() {
  const { select } = draft
  if (select.value !== '') {
    state.lastFolder = select.value
    syncDraftFolder()
    return
  }
  setDraftNote('Choose a folder in the Finder window…')
  select.disabled = true
  const { ok, data } = await postJson('/api/pick-folder', {}).catch(() => ({ ok: false, data: {} }))
  const result = ok ? data : { error: true }
  select.disabled = false
  setDraftNote('')
  if (result.path) {
    addPickedFolder(result.path)
    state.lastFolder = result.path
  } else {
    select.value = state.lastFolder ?? ''
    if (result.unsupported || result.error) setDraftNote('The folder picker is not available here. Open a session in that folder once and it will appear in this list.', 'error')
  }
  syncDraftFolder()
  select.focus()
}

async function startHere() {
  const folder = draftFolder()
  const typed = draft.text.value.trim()
  if (!folder.startsWith('/')) return void setDraftNote('Choose a project folder first.', 'error')
  if (!typed && !attachmentsOf(NEW_KEY).length) return void setDraftNote('Write the first prompt: Start here runs it right away.', 'error')
  const prompt = withAttachments(NEW_KEY, typed)
  draft.here.disabled = true
  setDraftNote('Starting…', 'running')
  const chosen = Object.fromEntries(Object.entries(draft.optSelects).map(([key, sel]) => [key, sel.value]))
  const result = await postJson('/api/new-session', { folder, prompt, ...chosen }).catch(() => ({ ok: false, data: {} }))
  draft.here.disabled = false
  if (!result.ok) return void setDraftNote(result.data?.error ?? 'Could not start the session.', 'error')
  setDraftNote('')
  draft.text.value = ''
  autosize(draft.text)
  clearDraftAttachments()
  state.draft = false
  const focused = await postJson('/api/focus', { id: result.data.id, focused: true }).catch(() => null)
  if (focused?.ok) state.focusIds = focused.data.ids
  state.selected = result.data.id
  state.selectedSeen = state.selected
  remember('board.selected', state.selected)
  history.replaceState({}, '', `/focus?card=${encodeURIComponent(state.selected)}`)
  state.signature = ''
  await refresh()
}

function startNewChat() {
  const folder = draftFolder()
  const prompt = withAttachments(NEW_KEY, draft.text.value.trim()).trim()
  const params = new URLSearchParams()
  if (folder) params.set('folder', folder)
  if (prompt) params.set('q', prompt)
  const link = el('a')
  link.href = `claude://code/new${params.size ? `?${params}` : ''}`
  link.click()
  draft.text.value = ''
  autosize(draft.text)
  clearDraftAttachments()
  closeNewChat()
  toast({ id: 'new-chat', title: 'Opening Claude', kind: 'finished', message: 'The new session joins Focus once the app records it.' })
}

function syncBroadcast() {
  const ticked = $('broadcast-targets').querySelectorAll('input:checked').length
  const view = broadcastState(state.cards.length, ticked)
  $('broadcast-status').textContent = state.cards.length ? view.note : 'Star some sessions first.'
  $('broadcast-send').disabled = !view.canSend
}

function openBroadcast() {
  const targets = $('broadcast-targets')
  targets.replaceChildren()
  const defaults = new Set(defaultTicked(state.cards.map((c) => c.id)))
  for (const c of state.cards) {
    const label = el('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = defaults.has(c.id)
    box.value = c.id
    box.onchange = syncBroadcast
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
  syncBroadcast()
  $('broadcast').showModal()
}

async function sendBroadcast() {
  const ids = [...$('broadcast-targets').querySelectorAll('input:checked')].map((box) => box.value)
  const prompt = $('broadcast-text').value.trim()
  if (ids.length > BROADCAST_LIMIT) return syncBroadcast()
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
  data.queued.forEach(clearNotifications)
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

function renderProjectOptions(projects, selected) {
  const select = $('search-project')
  const names = selected && !projects.includes(selected) ? [selected, ...projects] : projects
  const key = names.join('\n')
  if (select.dataset.key !== key) {
    select.dataset.key = key
    select.replaceChildren(new Option('All projects', ''), ...names.map((name) => new Option(name, name)))
  }
  select.value = selected
}

function renderSearch(data) {
  const box = $('search-results')
  box.replaceChildren()
  renderProjectOptions(data.projects, data.project)
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
  if (state.tab !== 'search') return
  const q = $('search-q').value.trim()
  const project = $('search-project').value
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (project) params.set('project', project)
  history.replaceState(history.state, '', params.size ? `/search?${params}` : '/search')
  const runId = ++state.search.runId
  clearTimeout(state.search.timer)
  try {
    const data = await getJson(`/api/search?q=${encodeURIComponent(q.length >= 2 ? q : '')}&project=${encodeURIComponent(project)}`)
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

const END_SHORT = { deleted: 'Deleted', fired: 'Ran once', stopped: 'Stopped', finished: 'Finished', expired: 'Expired', removed: 'Removed' }
const END_REASONS = { deleted: 'Deleted by Claude', fired: 'Ran once', stopped: 'Stopped', finished: 'Finished', expired: 'Expired after 7 days', removed: 'Dropped by the session' }

function scheduleLabel(r) {
  if (r.kind === 'wakeup') return 'Self-paced'
  if (!r.recurring) return `Once · ${r.cron}`
  return r.every ? `Every ${r.every} min` : r.cron
}

function loopStatus(r) {
  const span = el('span', `loop-badge ${r.status}`)
  span.append(icon('repeat', { size: 13 }))
  if (r.status === 'looping') span.append(text(r.nextAt ? `Looping · next ${untilLabel(r.nextAt)}` : 'Looping'))
  else if (r.status === 'stalled') span.append(text('Stalled'))
  else span.append(text(END_SHORT[r.endReason] ?? 'Ended'))
  return attachTip(span, () => loopTip(r))
}

function loopDetail(r) {
  const box = el('div', 'loop-detail')
  box.append(el('div', 'loop-prompt', r.prompt || '(no prompt recorded)'))
  const facts = el('div', 'loop-facts')
  for (const [label, value] of [
    ['Schedule', r.cron ?? scheduleLabel(r)],
    ['Started', new Date(r.createdAt).toLocaleString()],
    ['Ended', r.endedAt ? `${new Date(r.endedAt).toLocaleString()} · ${END_REASONS[r.endReason] ?? r.endReason}` : '—'],
  ]) facts.append(el('span', undefined, `${label}: ${value}`))
  box.append(facts)
  const runs = el('div', 'loop-runs')
  if (!r.fires.length) runs.append(el('span', 'dim', 'No runs recorded yet.'))
  for (const at of [...r.fires].reverse()) runs.append(el('span', 'run-chip', new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (new Date(at).toDateString() === new Date().toDateString() ? '' : ` · ${new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`)))
  if (r.fireCount > r.fires.length) runs.append(el('span', 'dim', `+${r.fireCount - r.fires.length} earlier`))
  box.append(runs)
  return box
}

const CI_LABELS = { success: 'Passed', failed: 'Failed', running: 'Running', pending: 'Pending', created: 'Queued', canceled: 'Canceled', skipped: 'Skipped', manual: 'Manual' }

function mrCi(mr) {
  const span = el('span', `mr-ci ${mr.pipeline ?? 'none'}`)
  if (mr.pipeline === 'running') span.append(el('span', 'spinner'), text(' '))
  span.append(text(CI_LABELS[mr.pipeline] ?? '—'))
  if (mr.pipeline === 'failed' && fixOffered(mr)) span.append(text(' '), mrFixControl(mr, 'ci'))
  return span
}

const FIX_SENT_KEY = 'board.mrFixSent'

const MR_FIXES = {
  ci: {
    key: (mr) => mr.pipelineId ?? mr.updatedAt,
    prompt: (mr) => `The CI pipeline failed on ${mr.url}. Work on branch ${mr.source}: if this folder is on another branch, do not switch it, use a git worktree for ${mr.source} instead. Look at the failed jobs, find the cause, fix it, and push.`,
    title: (mr) => `Start a new session in ${folderName(mr)} to fix the pipeline`,
  },
  conflicts: {
    key: (mr) => mr.updatedAt,
    prompt: (mr) => `${mr.url} has merge conflicts with ${mr.target}. Work on branch ${mr.source}: if this folder is on another branch, do not switch it, use a git worktree for ${mr.source} instead. Merge ${mr.target} into ${mr.source}, resolve the conflicts, run the tests, and push.`,
    title: (mr) => `Start a new session in ${folderName(mr)} to resolve the conflicts`,
  },
  threads: {
    key: (mr) => `${mr.unresolved}:${mr.updatedAt}`,
    prompt: (mr) => `${mr.url} has ${mr.unresolved} unresolved review thread${mr.unresolved === 1 ? '' : 's'}. Work on branch ${mr.source}: if this folder is on another branch, do not switch it, use a git worktree for ${mr.source} instead. Read each unresolved thread with glab, make the requested change or reply where no change is needed, run the tests, push, and resolve each thread you have addressed.`,
    title: (mr) => `Start a new session in ${folderName(mr)} to address the unresolved threads`,
  },
}

function readFixSent() {
  try { return JSON.parse(localStorage.getItem(FIX_SENT_KEY) || '{}') } catch { return {} }
}

const fixSlot = (mr, kind) => (kind === 'ci' ? mr.url : `${mr.url}#${kind}`)
const fixSent = (mr, kind) => readFixSent()[fixSlot(mr, kind)] === MR_FIXES[kind].key(mr)

function markFixSent(mr, kind) {
  try { localStorage.setItem(FIX_SENT_KEY, JSON.stringify({ ...readFixSent(), [fixSlot(mr, kind)]: MR_FIXES[kind].key(mr) })) } catch {}
}

function showFixOutcome(button, outcome) {
  button.textContent = outcome.label
  button.title = outcome.title
  button.disabled = outcome.disabled
}

const startMrSession = (mr, prompt, extra = {}) => postJson('/api/new-session', { folder: mr.folder, prompt, ...extra })

async function sendMrFix(mr, kind, button) {
  if (button.disabled) return
  button.disabled = true
  button.textContent = 'Starting…'
  const result = await startMrSession(mr, MR_FIXES[kind].prompt(mr))
  const outcome = startOutcome(result)
  showFixOutcome(button, outcome)
  if (outcome.record) markFixSent(mr, kind)
}

function mrFixButton(mr, kind) {
  const b = el('button', 'btn mr-fix', 'Fix')
  b.title = MR_FIXES[kind].title(mr)
  b.onclick = (event) => { event.stopPropagation(); sendMrFix(mr, kind, b) }
  return b
}

function mrThreads(mr) {
  const box = el('span', 'mr-threads')
  box.append(el('span', mr.unresolved ? 'mr-ci failed' : 'dim', String(mr.unresolved ?? 0)))
  if (mr.role === 'authored' && mr.unresolved && fixOffered(mr)) box.append(mrFixControl(mr, 'threads'))
  return box
}

function mrFixControl(mr, kind) {
  return fixSent(mr, kind) ? el('span', 'dim mr-fix-sent', 'Fix sent') : mrFixButton(mr, kind)
}

function mrTempBadge(mr) {
  const t = mrTemperature(mr)
  const box = el('span', `temp ${t.tier}`)
  const meter = el('span', 'meter')
  for (let i = 1; i <= 4; i++) meter.append(el('i', i <= t.bars ? 'f' : undefined))
  box.append(meter, text(t.label))
  return attachTip(box, () => mrWarmthTip(mr, t))
}

async function setMrFocus(mr, focused) {
  const { ok } = await postJson('/api/mrs/focus', { url: mr.url, focused })
  if (!ok) return
  const mark = (list) => list.map((item) => (item.url === mr.url ? { ...item, focused } : item))
  state.mrs.data = { ...state.mrs.data, authored: mark(state.mrs.data.authored), reviewing: mark(state.mrs.data.reviewing), merged: mark(state.mrs.data.merged ?? []) }
  renderMrsBadge()
  renderMrsPage()
}

function mrStarButton(mr) {
  const b = el('button', 'star')
  b.append(icon('star', { size: 18, fill: Boolean(mr.focused) }))
  b.setAttribute('aria-pressed', String(Boolean(mr.focused)))
  b.title = mr.focused ? 'Remove from Focus' : 'Add to Focus'
  b.onclick = () => setMrFocus(mr, !mr.focused)
  return b
}

const MR_LABEL_ACTIONS = { approved: 'Ready to merge', 'no-reviewer': 'Ready for review' }
const MR_LABEL_PRESENT = { 'Ready to merge': /^ready to (merge|deploy)$/i, 'Ready for review': /^ready (to|for) review$/i }

async function addMrLabel(mr, label, button) {
  button.disabled = true
  button.textContent = 'Adding…'
  const { ok, data } = await postJson('/api/mrs/label', { url: mr.url, label })
  if (!ok) {
    button.disabled = false
    button.textContent = `Add ${label}`
    button.title = data.error ?? 'Could not add the label'
    return
  }
  if (data.mr) {
    const { labels, readyLabel, verdict, actionable } = data.mr
    const patch = (list) => list.map((item) => (item.url === mr.url ? { ...item, labels, readyLabel, verdict, actionable } : item))
    const authored = patch(state.mrs.data.authored)
    const reviewing = patch(state.mrs.data.reviewing)
    const needAction = [...authored, ...reviewing].filter((item) => item.actionable).length
    state.mrs.data = { ...state.mrs.data, authored, reviewing, actionable: needAction }
    renderMrsBadge()
    updateMrRow(mr.url)
  } else {
    loadMrs(true)
  }
}

async function setMrAutoMerge(mr, button) {
  button.disabled = true
  button.textContent = 'Setting…'
  const { ok, data } = await postJson('/api/mrs/auto-merge', { url: mr.url })
  if (!ok) {
    button.disabled = false
    button.textContent = 'Auto-merge'
    button.title = data.error ?? 'Could not set auto-merge'
    return
  }
  if (data.mr) {
    const { autoMerge, autoMergeAvailable, verdict, actionable } = data.mr
    const authored = state.mrs.data.authored.map((item) => (item.url === mr.url ? { ...item, autoMerge, autoMergeAvailable, verdict, actionable } : item))
    const needAction = [...authored, ...state.mrs.data.reviewing].filter((item) => item.actionable).length
    state.mrs.data = { ...state.mrs.data, authored, actionable: needAction }
    renderMrsBadge()
    updateMrRow(mr.url)
  } else {
    loadMrs(true)
  }
}

async function closeMrRequest(mr, button) {
  if (!window.confirm(`Close this merge request?\n\n${mr.title}`)) return
  button.disabled = true
  button.textContent = 'Closing…'
  const { ok, data } = await postJson('/api/mrs/close', { url: mr.url })
  if (!ok) {
    button.disabled = false
    button.textContent = 'Close'
    button.title = data.error ?? 'Could not close the merge request'
    return
  }
  const authored = state.mrs.data.authored.filter((item) => item.url !== mr.url)
  const needAction = [...authored, ...state.mrs.data.reviewing].filter((item) => item.actionable).length
  state.mrs.data = { ...state.mrs.data, authored, actionable: needAction }
  renderMrsBadge()
  renderMrsPage()
}

function setMrBabysit(url, babysit) {
  const patch = (list) => list.map((item) => (item.url === url ? { ...item, babysit } : item))
  const data = state.mrs.data
  state.mrs.data = { ...data, authored: patch(data.authored), merged: patch(data.merged ?? []) }
  updateMrRow(url)
}

async function startBabysit(mr, button) {
  if (button.disabled) return
  button.disabled = true
  button.textContent = 'Starting…'
  const result = await startMrSession(mr, `/csb-babysit ${mr.url}`)
  showFixOutcome(button, startOutcome(result))
  if (!result.ok) return
  const saved = await postJson('/api/mrs/babysit', { url: mr.url, state: 'starting', sessionId: result.data.id })
  if (saved.ok) setMrBabysit(mr.url, saved.data.babysit)
}

async function stopBabysit(mr, button) {
  if (button.disabled) return
  button.disabled = true
  button.textContent = 'Stopping…'
  const { ok, data } = await postJson('/api/mrs/babysit/stop', { url: mr.url })
  if (ok) return setMrBabysit(mr.url, data.babysit)
  button.disabled = false
  button.textContent = 'Stop'
  button.title = data.error ?? 'Could not stop the babysit'
}

async function approveReplies(mr, button) {
  if (button.disabled) return
  button.disabled = true
  button.textContent = 'Sending…'
  const { ok, data } = await postJson('/api/mrs/babysit/approve', { url: mr.url })
  if (ok) return setMrBabysit(mr.url, data.babysit)
  button.disabled = false
  button.textContent = 'Approve and post'
  button.title = data.error ?? 'Could not send the approval'
}

function mrBabysit(mr) {
  const box = el('div', 'mr-babysit')
  const view = mr.mergedAt ? null : babysitView(mr.babysit)
  const sessionId = babysitFocusId(mr)
  if (view || sessionId) {
    const status = el('div', 'mr-babysit-status')
    if (view?.active) {
      const spinner = el('span', 'spinner')
      spinner.title = 'Babysit is running'
      status.append(spinner)
    }
    if (view) {
      const chip = el('span', `mr-badge ${view.tone}`, view.label)
      if (view.note) chip.title = view.note
      status.append(chip)
    }
    if (sessionId) status.append(focusButton(sessionId, 'Go to the babysit session in Focus'))
    box.append(status)
  }
  if (view?.note) {
    const note = el('div', 'dim mr-babysit-note', view.note)
    note.title = view.note
    box.append(note)
  }
  if (replyPlanOffered(mr)) {
    const approve = el('button', 'btn mr-babysit-start', 'Approve and post')
    approve.title = 'Tell the babysit session to post the replies and push the changes exactly as its plan says. Open the session first to edit a reply.'
    approve.onclick = () => approveReplies(mr, approve)
    box.append(approve)
  }
  if (babysitStoppable(mr)) {
    const stop = el('button', 'btn mr-babysit-stop', 'Stop')
    stop.title = 'Stop this babysit: cancel its running check and its scheduled checks'
    stop.onclick = () => stopBabysit(mr, stop)
    box.append(stop)
  }
  if (babysitOffered(mr)) {
    const button = el('button', 'btn mr-babysit-start', mr.babysit ? 'Babysit again' : 'Babysit')
    button.title = `Start a new session in ${folderName(mr)} to watch the pipeline, fix failures, mark the MR ready for review and ready to merge, and tell you when it needs you`
    button.onclick = () => startBabysit(mr, button)
    box.append(button)
  }
  return box.childNodes.length ? box : el('span', 'dim', '—')
}

function setMrDeploy(url, deploy) {
  const data = state.mrs.data
  state.mrs.data = { ...data, merged: (data.merged ?? []).map((item) => (item.url === url ? { ...item, deploy } : item)) }
  updateMrRow(url)
}

async function startDeployCheck(mr, button) {
  if (button.disabled) return
  button.disabled = true
  button.textContent = 'Starting…'
  const result = await startMrSession(mr, `/csb-check-deploy ${mr.url}`, { focus: false })
  showFixOutcome(button, startOutcome(result))
  if (!result.ok) return
  const saved = await postJson('/api/mrs/deploy', { url: mr.url, state: 'checking', sessionId: result.data.id })
  if (saved.ok) setMrDeploy(mr.url, saved.data.deploy)
}

function mrDeploy(mr) {
  const box = el('div', 'mr-deploy')
  const view = deployView(mr.deploy)
  const sessionId = deployFocusId(mr)
  if (view) {
    const status = el('div', 'mr-babysit-status')
    if (view.active) {
      const spinner = el('span', 'spinner')
      spinner.title = 'Deploy check is running'
      status.append(spinner)
    }
    const chip = el('span', `mr-badge ${view.tone}`, view.label)
    chip.title = `${view.note ? `${view.note}\n` : ''}Checked ${dateTime(view.checkedAt)}`
    status.append(chip)
    if (sessionId) status.append(focusButton(sessionId, 'Go to the deploy check session in Focus'))
    box.append(status)
    if (view.note) {
      const note = el('div', 'dim mr-babysit-note', view.note)
      note.title = view.note
      box.append(note)
    }
  }
  if (deployOffered(mr)) {
    const button = el('button', 'btn mr-fix', mr.deploy ? 'Check again' : 'Check deploy')
    button.title = `Start a new session in ${folderName(mr)} to ${mr.deploy ? 'check the deployment again' : 'check the deployment of this merged MR'}`
    button.onclick = () => startDeployCheck(mr, button)
    box.append(button)
  }
  return box.childNodes.length ? box : null
}

function mrVerdict(mr) {
  const box = el('span', 'mr-verdict')
  box.append(el('span', `mr-badge ${mr.verdict.tone}`, mr.verdict.code === 'waiting' ? `${mr.verdict.label} (${shortSpan(Date.now() - mr.updatedAt)} ago)` : mr.verdict.label))
  const action = mr.role === 'authored' ? MR_LABEL_ACTIONS[mr.verdict.code] : null
  if (action && !mr.labels?.some((label) => MR_LABEL_PRESENT[action].test(label))) {
    const button = el('button', 'btn mr-add-ready', `Add ${action}`)
    button.onclick = () => addMrLabel(mr, action, button)
    box.append(button)
  }
  if (mr.role === 'authored' && !mr.mergedAt && mr.autoMergeAvailable) {
    const auto = el('button', 'btn mr-auto-merge', 'Auto-merge')
    auto.title = 'Merge this merge request automatically once its pipeline succeeds'
    auto.onclick = () => setMrAutoMerge(mr, auto)
    box.append(auto)
  }
  if (mr.role === 'authored' && !mr.mergedAt) {
    const close = el('button', 'btn mr-close', 'Close')
    close.title = 'Close this merge request on GitLab without merging it'
    close.onclick = () => closeMrRequest(mr, close)
    box.append(close)
  }
  if (mr.role === 'authored' && mr.mergedAt) {
    const deploy = mrDeploy(mr)
    if (deploy) box.append(deploy)
  }
  if (mr.role === 'authored' && mr.conflicts && mr.verdict.code !== 'merged') {
    if (mr.verdict.code !== 'conflicts') box.append(el('span', 'mr-badge bad', 'Has conflicts'))
    if (fixOffered(mr)) box.append(mrFixControl(mr, 'conflicts'))
  }
  return box
}

const pingedLabel = (at) => `Pinged (${shortSpan(Date.now() - at)} ago)`

async function pingMrReviewer(mr, reviewer, button) {
  const before = button.textContent
  button.disabled = true
  button.textContent = 'Pinging…'
  const { ok, data } = await postJson('/api/mrs/ping', { url: mr.url, reviewer })
  if (ok) {
    mr.pinged = { ...mr.pinged, [reviewer]: data.pingedAt }
    const mark = (list) => list.map((item) => (item.url === mr.url ? { ...item, pinged: mr.pinged } : item))
    state.mrs.data = { ...state.mrs.data, authored: mark(state.mrs.data.authored), reviewing: mark(state.mrs.data.reviewing), merged: mark(state.mrs.data.merged ?? []) }
    button.textContent = pingedLabel(data.pingedAt)
    button.pingError = null
    button.disabled = false
    return
  }
  button.disabled = false
  button.textContent = before
  button.pingError = data.error ?? 'Could not send the Slack message'
}

function pingTip(mr, name, button) {
  const who = mr.reviewerNames?.[name] ?? name
  const at = mr.pinged?.[name]
  if (button.pingError) return { heading: 'Ping failed', text: button.pingError, rows: [] }
  if (button.classList.contains('due')) return { heading: `Ping ${who} again`, text: at ? 'No approval since the last ping. A day has passed.' : 'No ping and no approval since this was ready for review. A day has passed.', rows: at ? [['Last ping', `${shortSpan(Date.now() - at)} ago`]] : [] }
  if (!at) return { heading: 'Ping on Slack', text: `Sends ${who} a Slack message asking them to review this merge request.`, rows: [] }
  return {
    heading: `Pinged ${who}`,
    text: 'A Slack review request was already sent. Clicking again sends another message straight away.',
    rows: [['Sent', new Date(at).toLocaleString()], ['Ago', `${shortSpan(Date.now() - at)}`]],
  }
}

async function pingMrChannel(mr, button) {
  const before = button.textContent
  button.disabled = true
  button.textContent = 'Sending…'
  const { ok, data } = await postJson('/api/mrs/ping-channel', { url: mr.url })
  button.disabled = false
  if (!ok) {
    button.textContent = before
    button.pingError = data.error ?? 'Could not send the Slack message'
    return
  }
  mr.channelPinged = data.pingedAt
  const mark = (list) => list.map((item) => (item.url === mr.url ? { ...item, channelPinged: data.pingedAt } : item))
  state.mrs.data = { ...state.mrs.data, authored: mark(state.mrs.data.authored), reviewing: mark(state.mrs.data.reviewing), merged: mark(state.mrs.data.merged ?? []) }
  button.textContent = pingedLabel(data.pingedAt)
  button.pingError = null
}

function channelTip(mr, button) {
  const channel = `#${state.mrs.data.reviewChannel}`
  if (button.pingError) return { heading: 'Ask failed', text: button.pingError, rows: [] }
  if (!mr.channelPinged) return { heading: `Ask ${channel}`, text: `Posts a Slack message in ${channel} asking the team to review this merge request.`, rows: [] }
  return {
    heading: `Asked ${channel}`,
    text: 'A review request was already posted in the channel. Clicking again posts another message straight away.',
    rows: [['Sent', new Date(mr.channelPinged).toLocaleString()], ['Ago', shortSpan(Date.now() - mr.channelPinged)]],
  }
}

function mrChannelAsk(mr) {
  const button = el('button', mr.pingDue?.team ? 'btn mr-ping mr-ask-team due' : 'btn mr-ping mr-ask-team', mr.channelPinged ? pingedLabel(mr.channelPinged) : 'Ask team')
  button.onclick = () => pingMrChannel(mr, button)
  return attachTip(button, () => channelTip(mr, button))
}

function mrReviewers(mr) {
  const box = el('span', 'mr-reviewers')
  const askTeam = mr.role === 'authored' && !mr.mergedAt && state.mrs.data?.reviewChannel
  if (!mr.reviewers.length) {
    if (!askTeam) return el('span', 'dim', 'None')
    box.append(el('span', 'dim', 'None'), mrChannelAsk(mr))
    return box
  }
  const dueButtons = []
  for (const name of mr.reviewers) {
    const approved = mr.approvedBy.includes(name)
    const item = el('span', 'mr-reviewer-item')
    item.append(el('span', approved ? 'mr-reviewer approved' : 'mr-reviewer', approved ? `${name} ✓` : name))
    if (mr.role === 'authored' && !approved) {
      const pingedAt = mr.pinged?.[name]
      const due = mr.pingDue?.reviewers?.includes(name)
      const button = el('button', due ? 'btn mr-ping due' : 'btn mr-ping', pingedAt ? pingedLabel(pingedAt) : 'Ping')
      button.onclick = () => pingMrReviewer(mr, name, button)
      if (due) dueButtons.push([name, button])
      item.append(attachTip(button, () => pingTip(mr, name, button)))
    }
    box.append(item)
  }
  if (dueButtons.length > 1) {
    const all = el('button', 'btn mr-ping-all', `Ping ${dueButtons.length} due`)
    all.onclick = async () => {
      all.disabled = true
      for (const [name, button] of dueButtons) await pingMrReviewer(mr, name, button)
      all.remove()
    }
    box.append(all)
  }
  if (askTeam) box.append(mrChannelAsk(mr))
  return box
}

const mrSessionsOpen = new Set()

async function openInFocus(id) {
  if (!state.focusIds.includes(id)) await setFocus(id, true)
  goToCard(id)
}

function focusButton(id, title) {
  const link = el('a', 'mr-go')
  link.append(icon('arrow-up-right', { size: 14 }))
  link.href = `/focus?card=${encodeURIComponent(id)}`
  link.title = title
  link.setAttribute('aria-label', title)
  link.onclick = (event) => { event.preventDefault(); openInFocus(id) }
  return link
}

function mrHasWorking() {
  const data = state.mrs.data
  if (!data) return false
  return [...data.authored, ...data.reviewing, ...(data.merged ?? [])].some((mr) => mr.sessions?.some((session) => session.working))
}

function mrSession(mr) {
  if (!mr.sessions.length) return el('span', 'dim', '—')
  const list = el('div', 'mr-session')
  for (const session of mr.sessions) {
    const item = el('div', 'mr-session-item')
    const name = el('span', 'mr-session-title', session.title.startsWith('/csb-babysit') ? 'Babysit' : session.title)
    name.title = session.title
    item.append(name)
    if (session.working) {
      const dot = el('span', 'mr-working')
      dot.title = 'Working now'
      dot.setAttribute('role', 'img')
      dot.setAttribute('aria-label', 'Working now')
      item.append(dot)
    }
    item.append(focusButton(session.sessionId, 'Open as a Focus item'))
    list.append(item)
  }
  if (mr.sessions.length === 1) return list
  const details = document.createElement('details')
  details.className = 'mr-sessions'
  details.open = mrSessionsOpen.has(mr.url)
  details.ontoggle = () => (details.open ? mrSessionsOpen.add(mr.url) : mrSessionsOpen.delete(mr.url))
  const summary = el('summary', 'dim', `${mr.sessions.length} sessions`)
  const working = workingCount(mr)
  if (working) {
    const dot = el('span', 'mr-working')
    dot.setAttribute('role', 'img')
    dot.setAttribute('aria-label', `${working} working now`)
    summary.title = `${working} working now`
    summary.append(dot, el('span', 'mr-working-count', `${working} working`))
  }
  details.append(summary, list)
  return details
}

function startChatAboutMr(mr) {
  openNewChat()
  if (!draft) return
  if (mr.folder) {
    addPickedFolder(mr.folder)
    state.lastFolder = mr.folder
    syncDraftFolder()
  }
  draft.text.value = withMrReference(draft.text.value, mr)
  autosize(draft.text)
  draft.text.focus()
  setDraftNote(`Prefilled with !${mr.url.match(/\/merge_requests\/(\d+)/)?.[1] ?? ''} as a reference. Add what Claude should do.`)
}

function mrSessionCell(mr) {
  const box = el('div', 'mr-session-cell')
  box.append(mrSession(mr))
  const button = el('button', 'btn mr-new-chat')
  button.append(icon('plus', { size: 12 }), text(' New chat'))
  button.title = 'Open a new chat with this merge request prefilled as a reference'
  button.onclick = () => startChatAboutMr(mr)
  box.append(button)
  return box
}

function buildMrRow(mr) {
  const tr = document.createElement('tr')
  tr.dataset.url = mr.url
  if (mrTemperature(mr).group === 'cool') tr.className = 'cool'
  if (state.mrs.picked.includes(mr.url)) tr.classList.add('picked')
  const title = el('div', 'mr-title')
  const link = el('a', 'row-title mr-link', mr.title)
  link.href = mr.url
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  const repo = el('div', 'mr-project')
  repo.append(projectChip({ project: mr.project.split('/').pop() }), mapButton(`m:${mr.url}`, 'Show this merge request on the Lifecycle map', 'icon-only mr-map', 13), el('span', 'dim mr-ref', `${mr.ref} · ${mr.source} → ${mr.target}`))
  const iid = mr.url.match(/\/merge_requests\/(\d+)/)?.[1]
  if (iid) title.append(el('span', 'mr-iid', `!${iid}`), text(' '))
  title.append(link, repo)
  tr.append(
    cell(mrStarButton(mr)),
    cell(title),
    cell(el('span', 'dim', mr.role === 'authored' ? 'Mine' : `Review · ${mr.author}`)),
    cell(mrVerdict(mr)),
    cell(mr.role === 'authored' ? mrBabysit(mr) : el('span', 'dim', '—')),
    cell(mrCi(mr)),
    cell(mrReviewers(mr)),
    cell(mrThreads(mr)),
    cell(mrTempBadge(mr)),
    cell(el('span', 'num', relative(mr.updatedAt))),
    cell(mrSessionCell(mr))
  )
  return tr
}

const clockSeconds = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function paintMrsStatus() {
  const { data, statusBase, loading, at } = state.mrs
  if (!data || !statusBase) return
  const line = refreshStatus({ fetchedAt: data.fetchedAt, at, loading, autoOff: Number($('interval').value) === 0, working: mrHasWorking() }, Date.now(), clockSeconds)
  $('mrs-status').textContent = `${statusBase} · ${line}`
}

setInterval(() => { if (state.tab === 'mrs') paintMrsStatus() }, 1000)

function renderMrsSummary(all, rows) {
  const data = state.mrs.data
  const { filter, temp } = state.mrs
  const open = all.filter((mr) => !mr.mergedAt)
  const counts = tempCounts(open)
  const focused = open.filter((mr) => mr.focused).length
  const waiting = data.reviewing.filter((mr) => mr.verdict.code === 'needs-review').length
  state.mrs.statusBase = `${data.host} · ${data.authored.length} yours · ${data.reviewing.length} to review (${waiting} waiting on you) · ${data.actionable} need action · ${focused} focused`
  paintMrsStatus()
  $('mrs-error').hidden = !data.error
  $('mrs-error').textContent = data.error ? `Could not refresh from ${data.host}: ${data.error}` : ''
  $('mrs-empty').hidden = all.length > 0 || Boolean(data.error)
  $('mrs-nomatch').hidden = rows.length > 0 || all.length === 0
  document.querySelectorAll('#mrs-filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)))
  document.querySelectorAll('#mrs-temp button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.temp === temp))
    b.textContent = `${b.dataset.temp === 'warm' ? 'Warm' : 'Cool'} ${counts[b.dataset.temp]}`
  })
  document.querySelector('#mrs-filter [data-filter="focus"]').textContent = `Focus ${focused}`
  document.querySelector('#mrs-filter [data-filter="merged"]').textContent = `Merged ${(data.merged ?? []).length}`
}

function renderMrsPage() {
  const data = state.mrs.data
  if (!data) return
  const all = mergeMrs(data)
  const rows = visibleMrs(all, state.mrs)
  renderMrsSummary(all, rows)
  $('mrs-rows').replaceChildren(...rows.map(buildMrRow))
  scrollToPicked()
}

function scrollToPicked() {
  if (state.mrs.scrolled || !state.mrs.picked.length) return
  const row = $('mrs-rows').querySelector('tr.picked')
  if (!row) return
  state.mrs.scrolled = true
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function pickMrs(picked) {
  state.mrs.picked = picked
  state.mrs.scrolled = false
  const data = state.mrs.data
  if (!data || !picked.length) return
  const { filter, temp } = viewShowing(mergeMrs(data), picked, state.mrs)
  Object.assign(state.mrs, { filter, temp })
}

function updateMrRow(url) {
  const data = state.mrs.data
  const current = [...$('mrs-rows').children].find((tr) => tr.dataset.url === url)
  if (!data || !current) return renderMrsPage()
  const all = mergeMrs(data)
  const rows = visibleMrs(all, state.mrs)
  const mr = rows.find((item) => item.url === url)
  const shown = [...$('mrs-rows').children].map((tr) => tr.dataset.url)
  if (!mr || rows.length !== shown.length || rows.some((item, index) => item.url !== shown[index])) return renderMrsPage()
  current.replaceWith(buildMrRow(mr))
  renderMrsSummary(all, rows)
}

function renderMrsChannel() {
  const data = state.mrs.data
  const button = $('mrs-channel')
  button.hidden = !data
  if (!data) return
  button.textContent = data.reviewChannel ? `Review channel: #${data.reviewChannel}` : 'Set review channel'
  button.disabled = Boolean(data.reviewChannelLocked)
  button.title = data.reviewChannelLocked
    ? 'Set by the REVIEW_SLACK_CHANNEL environment variable'
    : 'The Slack channel the Ask team button posts review requests in'
}

async function editReviewChannel() {
  const data = state.mrs.data
  const answer = window.prompt('Slack channel to ask for reviews in (name only, for example team-reviews). Leave empty to turn Ask team off.', data.reviewChannel ?? '')
  if (answer === null) return
  const { ok, data: result } = await postJson('/api/mrs/review-channel', { channel: answer })
  if (!ok) {
    window.alert(result.error ?? 'Could not save the channel')
    return
  }
  await loadMrs(true)
}

function renderMrsLoading() {
  const { loading, data, manual } = state.mrs
  const first = loading && !data
  $('view-mrs').setAttribute('aria-busy', String(loading))
  $('view-mrs').classList.toggle('refreshing', loading && Boolean(data) && manual)
  $('mrs-loading').hidden = !first
  $('mrs-sheet').hidden = !data
  const button = $('mrs-refresh')
  button.disabled = loading
  button.replaceChildren(...(loading ? [el('span', 'spinner'), text('Refreshing')] : [text('Refresh')]))
  if (first) $('mrs-status').textContent = ''
}

async function fetchMrs(force) {
  state.mrs.loading = true
  state.mrs.manual = force
  renderMrsLoading()
  try {
    state.mrs.data = await getJson(`/api/mrs${force ? '?force=1' : ''}`)
    if (!state.mrs.scrolled) pickMrs(state.mrs.picked)
    renderMrsBadge()
    renderMrsChannel()
    renderMrsPage()
  } catch {
    if (!state.mrs.data) {
      $('mrs-error').textContent = 'Could not reach the board server. It will retry shortly.'
      $('mrs-error').hidden = false
    }
  } finally {
    state.mrs.loading = false
    state.mrs.at = state.mrs.data?.refreshing ? Date.now() - (mrsPollMs(mrHasWorking()) - 5_000) : Date.now()
    renderMrsLoading()
  }
}

const loadMrs = forcedRerun(fetchMrs)

const REPEAT_LABELS = { none: 'Once', daily: 'Every day', weekdays: 'Weekdays', weekly: 'Every week' }
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const sched = { fields: {}, note: null, history: new Set(), view: 'list', month: new Date() }
const CAL_VIEWS = new Set(['month', 'week', 'day'])

// Same project picker as New chat: known projects, then "Other folder…" opens the Finder picker.
function fillScheduleFolders() {
  const select = sched.fields.folder
  if (!select) return
  const roots = folderRoots()
  const key = [...roots.keys()].join('|')
  if (sched.rootsKey === key) return
  sched.rootsKey = key
  const previous = select.value
  const extra = [...select.options].map((o) => o.value).filter((v) => v && !roots.has(v))
  select.replaceChildren(
    ...[...roots].map(([root, name]) => new Option(`${name} — ${home(root)}`, root)),
    ...extra.map((path) => new Option(`${path.split('/').filter(Boolean).pop() ?? path} — ${home(path)}`, path)),
    new Option('Other folder…', ''),
  )
  const known = [...select.options].some((o) => o.value === previous && previous !== '')
  select.value = known ? previous : ([...roots.keys()][0] ?? '')
  sched.lastFolder = select.value || null
}

async function chooseScheduleFolder() {
  const select = sched.fields.folder
  if (select.value !== '') return void (sched.lastFolder = select.value)
  setSchedNote('Choose a folder in the Finder window…')
  select.disabled = true
  const { ok, data } = await postJson('/api/pick-folder', {})
  select.disabled = false
  setSchedNote('')
  if (ok && data.path) {
    if (![...select.options].some((o) => o.value === data.path)) select.insertBefore(new Option(`${data.path.split('/').filter(Boolean).pop() ?? data.path} — ${home(data.path)}`, data.path), select.querySelector('option[value=""]'))
    select.value = data.path
    sched.lastFolder = data.path
  } else {
    select.value = sched.lastFolder ?? ''
    if (!ok || data.unsupported) setSchedNote('The folder picker is not available here. Open a session in that folder once and it will appear in this list.', true)
  }
}

function buildScheduleForm() {
  const form = $('schedule-form')
  const f = sched.fields
  const labelled = (cls, label, node) => {
    const wrap = el('label', cls)
    wrap.append(el('span', 'new-label', label), node)
    return wrap
  }
  const select = (choices) => {
    const node = el('select', 'field')
    node.replaceChildren(...choices.map(([value, name]) => new Option(name, value)))
    return node
  }

  f.name = el('input', 'field sched-name')
  f.name.type = 'text'
  f.name.placeholder = 'Name (optional, defaults to the prompt)'
  f.name.setAttribute('aria-label', 'Name')

  f.folder = el('select', 'field')
  f.folder.setAttribute('aria-label', 'Project folder')
  f.folder.onchange = chooseScheduleFolder
  const pick = labelled('sched-pick', 'Project', f.folder)

  f.repeat = select(Object.entries(REPEAT_LABELS))
  f.repeat.value = 'daily'
  f.repeat.setAttribute('aria-label', 'Repeat')
  f.repeat.onchange = syncScheduleWhen
  f.at = el('input', 'field')
  f.at.type = 'time'
  f.at.value = '09:00'
  f.at.setAttribute('aria-label', 'Time')
  f.atLabel = labelled('sched-opt', 'Time', f.at)
  const when = el('div', 'sched-opts')
  f.day = select(DAY_NAMES.map((name, index) => [String(index), name]))
  f.day.value = String((new Date().getDay() + 1) % 7)
  f.day.setAttribute('aria-label', 'Day of the week')
  f.dayLabel = labelled('sched-opt', 'On', f.day)
  f.dayLabel.hidden = true
  when.append(labelled('sched-opt', 'Repeat', f.repeat), f.dayLabel, f.atLabel)

  const opts = el('div', 'sched-opts')
  for (const [name, label, choices] of NEW_OPTIONS) {
    f[name] = select(choices)
    f[name].setAttribute('aria-label', label)
    opts.append(labelled('sched-opt', label, f[name]))
  }

  const composer = el('div', 'composer')
  f.prompt = document.createElement('textarea')
  f.prompt.rows = 2
  f.prompt.placeholder = 'The prompt to run in a new session each time'
  const go = el('button', 'send')
  go.type = 'submit'
  go.append(icon('arrow-up', { size: 18, strokeWidth: 2.5 }))
  go.title = 'Add schedule'
  go.setAttribute('aria-label', 'Add schedule')
  const cancel = el('button', 'btn', 'Cancel')
  cancel.type = 'button'
  cancel.hidden = true
  cancel.onclick = () => endEdit()
  f.go = go
  f.cancel = cancel
  composer.append(f.prompt, go)
  const composerBox = el('div', 'sched-composer')
  composerBox.append(composer)
  sched.composerBox = composerBox
  sched.note = el('div', 'sched-note')
  const foot = el('div', 'sched-foot')
  foot.append(sched.note, cancel)

  form.append(f.name, pick, when, opts, composerBox, foot)
  form.onsubmit = (event) => { event.preventDefault(); saveSchedule() }
  f.prompt.oninput = () => { sched.slashIndex = 0; sched.slashDismissed = null; syncScheduleSlash() }
  f.prompt.onfocus = () => { if (f.prompt.value.startsWith('/')) syncScheduleSlash() }
  f.prompt.onblur = () => sched.menu?.remove()
  f.folder.addEventListener('change', () => { sched.menu?.remove(); syncScheduleSlash() })
  f.prompt.onkeydown = (event) => {
    const options = sched.slashItems ?? []
    if (options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        sched.slashIndex = (sched.slashIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        return void syncScheduleSlash()
      }
      const chosen = options[sched.slashIndex]
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing && f.prompt.value !== `/${chosen.name}`)) {
        event.preventDefault()
        return void acceptScheduleSlash(chosen)
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        sched.slashDismissed = f.prompt.value
        return void syncScheduleSlash()
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); saveSchedule() }
  }
  state.schedule.built = true
}

// Slash-command suggestions for the prompt, from the commands and skills of the chosen project.
function scheduleCommandKey() {
  const folder = sched.fields.folder?.value
  return folder ? `folder:${folder}` : null
}

function syncScheduleSlash() {
  sched.menu?.remove()
  sched.menu = null
  const f = sched.fields
  const key = scheduleCommandKey()
  sched.slashItems = []
  if (!key || !f.prompt || !f.prompt.value.startsWith('/') || document.activeElement !== f.prompt) return
  if (!state.commands.has(key)) loadCommands(key, `folder=${encodeURIComponent(f.folder.value)}`)
  const matches = sched.slashDismissed === f.prompt.value ? null : slashMatches(key, f.prompt.value)
  if (!matches?.length) return
  sched.slashItems = matches
  sched.slashIndex = Math.min(sched.slashIndex ?? 0, matches.length - 1)
  const menu = el('div', 'popover slash-menu')
  matches.forEach((item, index) => {
    const row = el('div', `slash-item${index === sched.slashIndex ? ' active' : ''}`)
    const main = el('div', 'slash-main')
    main.append(el('span', 'slash-name', `/${item.name}`))
    if (item.hint) main.append(el('span', 'slash-hint', item.hint))
    main.append(el('span', `slash-src ${item.source}`, item.source))
    row.append(main)
    if (item.description) row.append(el('div', 'slash-desc', item.description))
    row.onmousedown = (event) => { event.preventDefault(); acceptScheduleSlash(item) }
    menu.append(row)
  })
  sched.composerBox.append(menu)
  sched.menu = menu
  menu.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
}

function acceptScheduleSlash(item) {
  const box = sched.fields.prompt
  box.value = `/${item.name} `
  box.setSelectionRange(box.value.length, box.value.length)
  sched.slashDismissed = null
  syncScheduleSlash()
}

// Edit mode: the form at the top is loaded with a schedule and saving updates it.
function loadScheduleForm(r) {
  const f = sched.fields
  f.name.value = r.name
  if (![...f.folder.options].some((o) => o.value === r.folder)) f.folder.insertBefore(new Option(`${r.folder.split('/').filter(Boolean).pop() ?? r.folder} — ${home(r.folder)}`, r.folder), f.folder.querySelector('option[value=""]'))
  f.folder.value = r.folder
  sched.lastFolder = r.folder
  f.repeat.value = r.repeat
  syncScheduleWhen()
  const at = new Date(r.at)
  f.day.value = String(at.getDay())
  f.at.value = f.at.type === 'time' ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : toLocalInput(Math.max(r.at, Date.now() + 60_000))
  for (const [name] of NEW_OPTIONS) f[name].value = name === 'chrome' ? (r.chrome ? 'on' : '') : (r[name] ?? '')
  f.prompt.value = r.prompt
  renderSchedulePage()
  f.prompt.focus()
  $('schedule-form').scrollIntoView({ block: 'start', behavior: 'smooth' })
}

function startEdit(r) {
  const f = sched.fields
  sched.editing = r.rid
  loadScheduleForm(r)
  f.go.title = 'Save changes'
  f.go.setAttribute('aria-label', 'Save changes')
  f.cancel.hidden = false
  $('schedule-title').textContent = 'Edit schedule'
  setSchedNote(`Editing “${r.name}”. Saving puts it back on the schedule.`)
}

// Clone: the same settings in the form as a new schedule. Nothing is saved until you press send.
function startClone(r) {
  const f = sched.fields
  sched.editing = null
  loadScheduleForm({ ...r, name: `${r.name} (copy)` })
  f.go.title = 'Add schedule'
  f.go.setAttribute('aria-label', 'Add schedule')
  f.cancel.hidden = false
  $('schedule-title').textContent = 'Clone schedule'
  setSchedNote(`Cloned from “${r.name}”. Change what you need, then press send to add it.`)
}

function endEdit() {
  const f = sched.fields
  sched.editing = null
  f.name.value = ''
  f.prompt.value = ''
  f.go.title = 'Add schedule'
  f.go.setAttribute('aria-label', 'Add schedule')
  f.cancel.hidden = true
  $('schedule-title').textContent = 'Schedule a session'
  setSchedNote('')
  renderSchedulePage()
}

// Once needs a date and time; every day and weekdays only need the time of day.
function syncScheduleWhen() {
  const f = sched.fields
  const repeating = f.repeat.value !== 'none'
  f.dayLabel.hidden = f.repeat.value !== 'weekly'
  const stamp = f.at.value
  const wanted = repeating ? 'time' : 'datetime-local'
  if (f.at.type === wanted) return
  const time = stamp.includes('T') ? stamp.split('T')[1] : stamp
  f.at.type = wanted
  f.at.value = repeating ? time : toLocalInput(nextOccurrence(time))
  f.atLabel.firstChild.textContent = repeating ? 'Time' : 'When'
  f.at.setAttribute('aria-label', repeating ? 'Time' : 'When')
}

// The next moment the clock shows hh:mm, today if it is still ahead.
function nextOccurrence(time, weekday = null) {
  const [h, m] = time.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  if (weekday !== null) d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7))
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + (weekday !== null ? 7 : 1))
  return d.getTime()
}

function setSchedNote(message, isError = false) {
  sched.note.textContent = message
  sched.note.className = `sched-note${isError ? ' error' : ''}`
}

async function saveSchedule() {
  const f = sched.fields
  if (!f.at.value) return setSchedNote('Pick a time.', true)
  const at = f.at.type === 'time' ? nextOccurrence(f.at.value, f.repeat.value === 'weekly' ? Number(f.day.value) : null) : new Date(f.at.value).getTime()
  const body = { name: f.name.value, folder: f.folder.value, prompt: f.prompt.value, at, repeat: f.repeat.value }
  for (const [name] of NEW_OPTIONS) body[name] = f[name].value
  setSchedNote('Saving…')
  const editing = sched.editing
  const { ok, data } = await postJson(editing ? '/api/routines/update' : '/api/routines', editing ? { ...body, rid: editing } : body)
  if (!ok) return setSchedNote(data.error ?? 'Could not save the schedule.', true)
  state.schedule.data = data
  timeline.update({ routines: data.routines })
  if (editing || !f.cancel.hidden) endEdit()
  else { f.name.value = ''; f.prompt.value = '' }
  setSchedNote(editing ? 'Saved.' : 'Added.')
  renderSchedulePage()
}

const scheduleRequest = latestOnly()

async function loadSchedule() {
  if (!state.schedule.built) buildScheduleForm()
  fillScheduleFolders()
  const isLatest = scheduleRequest()
  try {
    const data = await getJson('/api/routines')
    if (!isLatest()) return
    state.schedule.data = data
    state.schedule.at = Date.now()
    timeline.update({ routines: state.schedule.data.routines })
    renderSchedulePage()
  } catch {}
}

async function scheduleAction(path, body) {
  const { ok, data } = await postJson(path, body)
  if (data.routines) {
    state.schedule.data = { routines: data.routines }
    timeline.update({ routines: data.routines })
  }
  setSchedNote(ok ? '' : (data.error ?? 'Something went wrong.'), !ok)
  if (ok && path.endsWith('/run')) { state.signature = ''; refresh() }
  renderSchedulePage()
}

function scheduleHistory(r) {
  const list = el('div', 'rt-history')
  for (const run of r.history) {
    const when = new Date(run.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    if (run.sessionId) {
      const row = el('a', 'rt-run')
      row.href = `/focus?card=${encodeURIComponent(run.sessionId)}`
      row.title = 'Open this run in Focus'
      row.onclick = (event) => { event.preventDefault(); openInFocus(run.sessionId) }
      row.append(el('span', undefined, when), el('span', 'dim', relative(run.at)), icon('arrow-up-right', { size: 12 }))
      list.append(row)
    } else {
      const row = el('div', 'rt-run failed')
      row.append(el('span', undefined, when), el('span', 'err', run.error ?? 'Could not start the session.'))
      list.append(row)
    }
  }
  return list
}

function renderScheduleCalendar(routines) {
  const box = $('schedule-cal')
  box.replaceChildren()
  const view = sched.view
  const anchor = sched.month
  const bar = el('div', 'cal-bar')
  const step = (label, by) => {
    const b = el('button', 'btn', label)
    b.onclick = () => { sched.month = by === 0 ? new Date() : shiftAnchor(anchor, view, by); renderSchedulePage() }
    return b
  }
  const days = view === 'month' ? monthGrid(anchor) : view === 'week' ? weekGrid(anchor) : dayGrid(anchor)
  const title = view === 'month' ? anchor.toLocaleDateString([], { month: 'long', year: 'numeric' })
    : view === 'week' ? `${days[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
    : anchor.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  bar.append(step('‹', -1), el('strong', 'cal-title', title), step('›', 1), step('Today', 0))
  box.append(bar)
  const grid = el('div', `cal-grid ${view}`)
  if (view !== 'day') for (const name of DAY_NAMES) grid.append(el('div', 'cal-dow', name.slice(0, 3)))
  const events = eventsByDay(routines, days)
  const todayKey = dayKey(new Date())
  const max = view === 'month' ? 3 : Infinity
  for (const d of days) {
    const cell = el('div', `cal-day${view === 'month' && d.getMonth() !== anchor.getMonth() ? ' other' : ''}${dayKey(d) === todayKey ? ' today' : ''}`)
    cell.append(el('div', 'cal-num', String(d.getDate())))
    const list = events.get(dayKey(d)) ?? []
    if (!list.length && view !== 'month') cell.append(el('div', 'cal-more', 'Nothing scheduled'))
    for (const { routine, at } of list.slice(0, max)) {
      const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const chip = el('button', 'cal-chip')
      chip.append(el('span', 'cal-time', time), text(` ${routine.name}`), el('span', 'cal-opts', `${modelLabel(routine.model)} · ${effortLabel(routine.effort)}${view === 'day' ? ` · ${home(routine.folder)}` : ''}`))
      chip.title = `${routine.name}\n${time} · ${REPEAT_LABELS[routine.repeat]}\nModel: ${modelLabel(routine.model)} · Effort: ${effortLabel(routine.effort)}\n${home(routine.folder)}`
      chip.onclick = () => startEdit(routine)
      cell.append(chip)
    }
    if (list.length > max) cell.append(el('div', 'cal-more', `+${list.length - max} more`))
    grid.append(cell)
  }
  box.append(grid)
}

function renderSchedulePage() {
  const data = state.schedule.data
  if (!data) return
  const rows = [...data.routines].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.at - b.at)
  const active = rows.filter((r) => r.enabled).length
  $('schedule-status').textContent = rows.length ? `${rows.length} total · ${active} active` : ''
  $('schedule-empty').hidden = rows.length > 0
  document.querySelectorAll('#schedule-view button').forEach((b) => { b.onclick = () => { sched.view = b.dataset.view; renderSchedulePage() }; b.setAttribute('aria-pressed', String(b.dataset.view === sched.view)) })
  const list = $('schedule-rows')
  list.replaceChildren()
  $('schedule-cal').hidden = !CAL_VIEWS.has(sched.view)
  document.querySelector('.sched-page').classList.toggle('wide', CAL_VIEWS.has(sched.view))
  list.hidden = CAL_VIEWS.has(sched.view)
  if (CAL_VIEWS.has(sched.view)) return renderScheduleCalendar(rows)
  for (const r of rows) {
    const item = el('div', `rt-item${r.enabled ? '' : ' off'}${sched.editing === r.rid ? ' editing' : ''}`)
    const main = el('div', 'rt-main')
    const nextText = r.enabled
      ? (r.repeat === 'none' ? new Date(r.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : `${r.repeat === 'weekly' ? `Every ${DAY_NAMES[new Date(r.at).getDay()]}` : REPEAT_LABELS[r.repeat]} at ${new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
      : (r.repeat === 'none' && r.runs ? 'Done' : `Paused · ${REPEAT_LABELS[r.repeat]}`)
    const meta = el('div', 'rt-meta')
    meta.append(el('span', undefined, nextText), el('span', 'path', home(r.folder)))
    if (r.lastSessionId) {
      const link = el('a', undefined, `Last run ${relative(r.lastFiredAt)}`)
      link.href = `/focus?card=${encodeURIComponent(r.lastSessionId)}`
      link.title = 'Open the session from the last run'
      link.onclick = (event) => { event.preventDefault(); openInFocus(r.lastSessionId) }
      meta.append(link)
    }
    meta.append(el('span', 'rt-model', `${modelLabel(r.model)} · ${effortLabel(r.effort)} effort`))
    if (r.runs) meta.append(el('span', undefined, `${r.runs} run${r.runs === 1 ? '' : 's'}`))
    if (r.lastError) meta.append(el('span', 'err', r.lastError))
    main.append(el('div', 'rt-title', r.name), meta)
    if (r.history?.length) {
      const open = sched.history.has(r.rid)
      const toggleHistory = el('button', 'rt-history-toggle', `${open ? 'Hide' : 'Show'} run history (${r.history.length})`)
      toggleHistory.setAttribute('aria-expanded', String(open))
      toggleHistory.onclick = () => { if (open) sched.history.delete(r.rid); else sched.history.add(r.rid); renderSchedulePage() }
      main.append(toggleHistory)
      if (open) main.append(scheduleHistory(r))
    }
    const actions = el('div', 'rt-actions')
    const run = el('button', 'btn', 'Run now')
    run.title = 'Start a session with this prompt right now'
    run.onclick = () => scheduleAction('/api/routines/run', { rid: r.rid })
    const toggle = el('button', 'btn', r.enabled ? 'Pause' : 'Resume')
    toggle.onclick = () => scheduleAction('/api/routines/toggle', { rid: r.rid, enabled: !r.enabled })
    if (!r.enabled && r.repeat === 'none' && r.runs) toggle.disabled = true
    const edit = el('button', 'btn', 'Edit')
    edit.onclick = () => startEdit(r)
    const clone = el('button', 'btn', 'Clone')
    clone.title = 'Copy these settings into a new schedule'
    clone.onclick = () => startClone(r)
    const del = el('button', 'btn', 'Delete')
    del.onclick = () => scheduleAction('/api/routines/remove', { rid: r.rid }).then(() => { if (sched.editing === r.rid) endEdit() })
    actions.append(run, toggle, edit, clone, del)
    item.append(main, actions)
    list.append(item)
  }
}

async function editSchedule(rid) {
  navigate('/schedule', { back: true })
  await loadSchedule()
  const routine = state.schedule.data?.routines?.find((r) => r.rid === rid)
  if (routine) startEdit(routine)
}

async function loadTimeline() {
  state.timeline.at = Date.now()
  try {
    const [routines, loops] = await Promise.all([getJson('/api/routines'), getJson('/api/loops')])
    state.loops.data = loops
    state.loops.at = Date.now()
    timeline.update({ routines: routines.routines, loops: loops.loops })
  } catch {}
}

async function loadLoops() {
  try {
    state.loops.data = await getJson('/api/loops')
    state.loops.at = Date.now()
    timeline.update({ loops: state.loops.data.loops })
    renderTaskPanel()
  } catch {}
}

const BG_LABELS = { running: 'Running', completed: 'Completed', failed: 'Failed', killed: 'Killed', stopped: 'Stopped', expired: 'Expired', unknown: 'Unknown' }

const panelSession = (selected) => (state.panel.scope === 'session' && selected ? selected.id : null)

function savePanel() {
  const { open, tab, scope, finishedOpen, endedOpen } = state.panel
  remember('board.panel', JSON.stringify({ open, tab, scope, finishedOpen, endedOpen }))
}

function togglePanel() {
  state.panel.open = !state.panel.open
  savePanel()
  renderFocus()
  if (state.panel.open) loadTaskData()
}

function tasksButton(c) {
  const count = (c.backgroundTasks?.running ?? 0) + (c.loop && c.loop.state !== 'ended' ? c.loop.count : 0)
  const b = el('button', 'icon-only tasks-btn')
  b.type = 'button'
  b.append(icon('list', { size: 16 }))
  if (count) b.append(el('span', 'tasks-n', String(count)))
  b.title = 'Background tasks and loops'
  b.setAttribute('aria-label', 'Background tasks and loops')
  b.setAttribute('aria-pressed', String(state.panel.open && state.panel.tab !== 'sidechats'))
  b.onclick = () => openPanelTab('background')
  return b
}

function lifecycleButton(c) {
  return mapButton(`s:${c.id}`, 'Show this session on the Lifecycle map', 'icon-only tasks-btn', 16)
}

function mapButton(focus, title, className, size) {
  const b = el('button', className)
  b.type = 'button'
  b.append(icon('workflow', { size }))
  b.title = title
  b.setAttribute('aria-label', title)
  b.onclick = (event) => {
    event.stopPropagation()
    flowView.show(focus)
    navigate('/flow', { back: true })
  }
  return b
}

function openPanelTab(tab) {
  const side = tab === 'sidechats'
  if (state.panel.open && side === (state.panel.tab === 'sidechats')) return togglePanel()
  state.panel.open = true
  if (side || state.panel.tab === 'sidechats') state.panel.tab = tab
  if (side) state.panel.scope = 'session'
  savePanel()
  renderFocus()
  loadTaskData()
}

function sideChatButton(c) {
  const count = sideChatCount(state.sessions, c.id)
  const b = el('button', 'icon-only tasks-btn')
  b.type = 'button'
  b.append(icon('message-circle', { size: 16 }))
  if (count) b.append(el('span', 'tasks-n', String(count)))
  b.title = count ? `Side chats (${count} open)` : 'Side chat: ask a quick question on a copy of this conversation'
  b.setAttribute('aria-label', 'Side chats')
  b.setAttribute('aria-pressed', String(state.panel.open && state.panel.tab === 'sidechats'))
  b.onclick = () => openPanelTab('sidechats')
  return b
}

function flipIn(set, key) {
  if (set.has(key)) set.delete(key)
  else set.add(key)
  renderTaskPanel(state.panelSelected)
}

function panelSection(label, count, { toggle = null, open = true } = {}) {
  const head = el(toggle ? 'button' : 'div', 'tp-section')
  if (toggle) {
    head.type = 'button'
    head.setAttribute('aria-expanded', String(open))
    head.onclick = toggle
    head.append(icon(open ? 'chevron-down' : 'chevron-right', { size: 13 }))
  }
  head.append(el('span', undefined, label), el('span', 'tp-count', String(count)))
  return head
}

function taskDetail(task) {
  const key = taskKey(task)
  const box = el('div', 'tp-detail')
  if (task.command) box.append(el('div', 'tp-cmd', `$ ${task.command}`))
  if (task.summary) box.append(el('div', 'tp-note', task.summary))
  if (task.events.length) {
    const list = el('div', 'tp-events')
    for (const event of [...task.events].reverse()) {
      const row = el('div', 'tp-event')
      row.append(el('span', 'dim', new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), el('span', undefined, event.text))
      list.append(row)
    }
    box.append(list)
  }
  if (task.hasOutput) {
    const out = state.background.output.get(key)
    if (!out && !state.background.loading.has(key)) {
      state.background.loading.add(key)
      fetchBackgroundOutput(task).then(() => { state.background.loading.delete(key); renderTaskPanel(state.panelSelected) })
    }
    const text = out ? (out.available ? `${out.truncated ? '… (showing the last part)\n' : ''}${out.text}` : 'Output is no longer available.') : 'Loading output…'
    box.append(el('pre', 'tp-out', text.trim() ? text : 'No output yet'))
  } else if (!task.events.length) box.append(el('div', 'tp-note', 'No output recorded.'))
  return box
}

function taskRow(task, showSession) {
  const open = taskOpen(task)
  const running = task.status === 'running'
  const row = el('div', `tp-row ${task.status}${open ? ' open' : ''}`)
  const head = el('button', 'tp-row-head')
  head.type = 'button'
  head.setAttribute('aria-expanded', String(open))
  head.onclick = () => flipIn(running ? state.panel.closed : state.panel.opened, taskKey(task))
  const label = (task.description || task.command || '(no description)').replace(/\s+/g, ' ')
  const title = el('span', 'tp-row-title')
  title.append(el('span', 'tp-row-name', label))
  if (showSession) title.append(el('span', 'tp-row-session', task.title))
  head.append(icon(open ? 'chevron-down' : 'chevron-right', { size: 14 }), title)
  if (running) head.append(sinceSpan(new Date(task.startedAt).toISOString()))
  else head.append(el('span', `tp-status ${task.status}`, [BG_LABELS[task.status] ?? task.status, task.kind === 'monitor' ? '' : task.exitCode === null ? '' : `exit ${task.exitCode}`].filter(Boolean).join(' · ')))
  row.append(head)
  if (open) row.append(taskDetail(task))
  return row
}

function loopRow(r, showSession) {
  const key = `${r.sessionId}:${r.id}`
  const open = state.panel.opened.has(key)
  const row = el('div', `tp-row loop ${r.status}${open ? ' open' : ''}`)
  const head = el('button', 'tp-row-head')
  head.type = 'button'
  head.setAttribute('aria-expanded', String(open))
  head.onclick = () => flipIn(state.panel.opened, key)
  const title = el('span', 'tp-row-title')
  title.append(el('span', 'tp-row-name', (r.prompt || '(no prompt)').replace(/\s+/g, ' ')))
  const sub = el('span', 'tp-row-session')
  sub.append(loopStatus(r), text(` ${scheduleLabel(r)} · ${r.fireCount} ${r.fireCount === 1 ? 'run' : 'runs'}${showSession ? ` · ${r.title}` : ''}`))
  title.append(sub)
  head.append(icon(open ? 'chevron-down' : 'chevron-right', { size: 14 }), title)
  row.append(head)
  if (open) row.append(loopDetail(r))
  return row
}

function panelEmpty(message) {
  return el('div', 'tp-empty', message)
}

function backgroundBody(tasks, showSession) {
  const frag = document.createDocumentFragment()
  const running = tasks.filter((task) => task.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  const finished = tasks.filter((task) => task.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  if (!tasks.length) return panelEmpty('No background commands yet. Commands Claude runs in the background, and monitors it arms, show up here.')
  frag.append(panelSection('Running', running.length))
  if (running.length) frag.append(...running.map((task) => taskRow(task, showSession)))
  else frag.append(panelEmpty('Nothing running.'))
  if (finished.length) {
    const open = state.panel.finishedOpen
    frag.append(panelSection('Finished', finished.length, { toggle: () => { state.panel.finishedOpen = !open; savePanel(); renderTaskPanel(state.panelSelected) }, open }))
    if (open) frag.append(...finished.map((task) => taskRow(task, showSession)))
  }
  return frag
}

function loopsBody(loops, showSession) {
  const frag = document.createDocumentFragment()
  const sorted = [...loops].sort(byLatestEnded)
  const active = sorted.filter((r) => r.status !== 'ended')
  const ended = sorted.filter((r) => r.status === 'ended')
  if (!loops.length) return panelEmpty('No loops yet. Sessions that schedule recurring checks with /loop or cron jobs show up here.')
  frag.append(panelSection('Active', active.length))
  if (active.length) frag.append(...active.map((r) => loopRow(r, showSession)))
  else frag.append(panelEmpty('No active loops.'))
  if (ended.length) {
    const open = state.panel.endedOpen
    frag.append(panelSection('Ended', ended.length, { toggle: () => { state.panel.endedOpen = !open; savePanel(); renderTaskPanel(state.panelSelected) }, open }))
    if (open) frag.append(...ended.map((r) => loopRow(r, showSession)))
  }
  return frag
}

const SIDE_PENDING_MS = 120_000

function sideComposer(key, { placeholder, label, onSend, busy = false }) {
  const sc = state.sideChats
  const wrap = el('div', 'sc-compose')
  const box = el('div', 'sc-ask')
  const area = document.createElement('textarea')
  area.rows = 1
  area.placeholder = placeholder
  area.dataset.keep = `sc:${key}`
  area.value = sc.drafts.get(key) ?? ''
  area.disabled = busy
  area.oninput = () => { sc.drafts.set(key, area.value); autosize(area) }
  area.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      onSend(area.value.trim())
    }
  }
  const send = el('button', 'icon-only sc-send')
  send.type = 'button'
  send.title = label
  send.setAttribute('aria-label', label)
  send.disabled = busy
  send.append(icon('arrow-up', { size: 16 }))
  send.onclick = () => onSend(area.value.trim())
  box.append(area, send)
  wrap.append(box)
  const note = sc.notes.get(key)
  if (note) wrap.append(el('div', 'sc-note', note))
  requestAnimationFrame(() => autosize(area))
  return wrap
}

async function startSideChat(c, prompt) {
  const sc = state.sideChats
  const key = `new:${c.id}`
  if (!prompt || sc.starting.has(c.id)) return
  sc.starting.add(c.id)
  sc.notes.set(key, 'Starting a side chat on a copy of this conversation…')
  renderTaskPanel()
  const result = await postJson('/api/side-chats', { id: c.id, prompt })
  sc.starting.delete(c.id)
  if (result.ok) {
    sc.drafts.delete(key)
    sc.notes.delete(key)
    sc.open.add(result.data.id)
    sc.pending.set(result.data.id, { text: prompt, at: Date.now() })
    await loadSideChats()
    await loadSideChat(result.data.id)
    sideBurst()
  } else {
    sc.notes.set(key, result.data.error ?? 'Could not start the side chat')
  }
  renderTaskPanel()
}

async function sendSideReply(r, prompt) {
  const sc = state.sideChats
  const key = `reply:${r.id}`
  if (!prompt) return
  const card = sc.cards.get(r.id)
  const busy = card?.run?.state === 'running' || Boolean(card?.active) || r.running
  sc.drafts.delete(key)
  sc.notes.set(key, busy ? 'Queuing…' : 'Sending…')
  if (!busy) sc.pending.set(r.id, { text: prompt, at: Date.now() })
  renderTaskPanel()
  let result = await postJson(busy ? '/api/queue' : '/api/prompt', { id: r.id, prompt })
  if (!busy && shouldQueue(result)) {
    sc.pending.delete(r.id)
    result = await postJson('/api/queue', { id: r.id, prompt })
  }
  if (result.ok) sc.notes.delete(key)
  else {
    sc.pending.delete(r.id)
    sc.drafts.set(key, prompt)
    sc.notes.set(key, result.data.error ?? 'Could not send')
  }
  await loadSideChat(r.id)
  loadSideChats()
  sideBurst()
}

async function closeSideChat(r, closed) {
  const result = await postJson('/api/side-chats/close', { id: r.id, closed })
  if (!result.ok) state.sideChats.notes.set(`reply:${r.id}`, result.data.error ?? 'Could not update the side chat')
  if (closed) state.sideChats.open.delete(r.id)
  await loadSideChats()
  state.signature = ''
  refresh()
}

function sideChatDetail(r, showParent) {
  const sc = state.sideChats
  const card = sc.cards.get(r.id)
  const box = el('div', 'sc-detail')
  const log = el('div', 'sc-log')
  log.dataset.sc = r.id
  if (!card) log.append(el('div', 'tp-note', 'Loading…'))
  else {
    chatBase = card.cwd ?? ''
    const messages = card.details?.chat ?? []
    const pending = sc.pending.get(r.id)
    const waiting = pending && !ownReplies(messages, pending.at)
    log.append(...messages.map(renderMessage))
    if (waiting) log.append(renderMessage({ role: 'user', text: pending.text, pending: true }))
    const working = renderWorking(card)
    if (working) log.append(working)
    else if (card.run?.state === 'running') {
      const line = el('div', 'working')
      const inner = el('div', 'working-line')
      inner.append(el('span', 'pulse'), el('span', 'shimmer', 'Starting…'))
      line.append(inner)
      log.append(line)
    }
    if (!messages.length && !waiting && !working && card.run?.state !== 'running') log.append(el('div', 'tp-note', 'No messages yet.'))
    if (['failed', 'stalled'].includes(card.run?.state) && card.run.error) log.append(el('div', 'sc-error', card.run.error))
    const queued = card.queue?.items.length ?? 0
    if (queued) log.append(el('div', 'tp-note', `${queued} queued ${queued === 1 ? 'message' : 'messages'}: ${queued === 1 ? 'it runs' : 'they run'} when this reply finishes.`))
  }
  box.append(log)
  if (!r.closed) box.append(sideComposer(`reply:${r.id}`, { placeholder: 'Reply in this side chat…', label: 'Send in this side chat', onSend: (prompt) => sendSideReply(r, prompt) }))
  const actions = el('div', 'sc-actions')
  const toggle = el('button', 'btn', r.closed ? 'Reopen' : 'Close')
  toggle.title = r.closed ? 'Move it back to Open' : 'Move it to Closed. Nothing is deleted.'
  toggle.onclick = () => closeSideChat(r, !r.closed)
  actions.append(toggle)
  if (showParent && r.parentTitle) {
    const go = el('button', 'btn', 'Go to session')
    go.title = r.parentTitle
    go.onclick = () => openInFocus(r.parentId)
    actions.append(go)
  }
  actions.append(openLink(r.id))
  box.append(actions)
  return box
}

function sideChatRow(r, showParent) {
  const sc = state.sideChats
  const open = sc.open.has(r.id)
  const row = el('div', `tp-row sc-row${r.running ? ' running' : ''}${open ? ' open' : ''}`)
  const head = el('button', 'tp-row-head')
  head.type = 'button'
  head.setAttribute('aria-expanded', String(open))
  head.onclick = () => {
    if (open) sc.open.delete(r.id)
    else {
      sc.open.add(r.id)
      loadSideChat(r.id)
    }
    renderTaskPanel()
  }
  const title = el('span', 'tp-row-title')
  title.append(el('span', 'tp-row-name', r.title))
  const sub = [showParent ? r.parentTitle : null, r.source === 'board' ? 'started on the board' : 'from Claude desktop'].filter(Boolean)
  title.append(el('span', 'tp-row-session', sub.join(' · ')))
  head.append(icon(open ? 'chevron-down' : 'chevron-right', { size: 14 }), title)
  if (r.running) {
    const live = el('span', 'sc-live')
    live.append(el('span', 'spinner'), text('Working'))
    head.append(live)
  } else head.append(el('span', 'tp-status', relative(r.lastActivityAt)))
  row.append(head)
  if (open) row.append(sideChatDetail(r, showParent))
  return row
}

function sideChatsBody(selected, sessionId) {
  const sc = state.sideChats
  const frag = document.createDocumentFragment()
  const { open, closed } = sideChatGroups(sc.data?.items ?? [], sessionId)
  if (sessionId && selected) {
    frag.append(sideComposer(`new:${selected.id}`, { placeholder: 'Ask a side question…', label: 'Start a side chat', busy: sc.starting.has(selected.id), onSend: (prompt) => startSideChat(selected, prompt) }))
    frag.append(el('div', 'tp-note sc-hint', 'Runs on a copy of this conversation, so the main chat does not change.'))
  }
  frag.append(panelSection('Open', open.length))
  if (open.length) frag.append(...open.map((r) => sideChatRow(r, !sessionId)))
  else frag.append(panelEmpty(sessionId ? 'No side chats on this session yet.' : 'No open side chats.'))
  if (closed.length) {
    const shown = sc.closedOpen
    frag.append(panelSection('Closed', closed.length, { toggle: () => { sc.closedOpen = !shown; renderTaskPanel() }, open: shown }))
    if (shown) frag.append(...closed.map((r) => sideChatRow(r, !sessionId)))
  }
  return frag
}

async function loadSideChats() {
  try {
    state.sideChats.data = await getJson('/api/side-chats')
    state.sideChats.at = Date.now()
    renderTaskPanel()
  } catch {}
}

async function loadSideChat(id) {
  const sc = state.sideChats
  if (sc.loading.has(id)) return
  sc.loading.add(id)
  let changed = false
  try {
    const card = await getJson(`/api/side-chat?id=${encodeURIComponent(id)}`)
    if (card?.id) {
      changed = JSON.stringify(card) !== JSON.stringify(sc.cards.get(id))
      sc.cards.set(id, card)
      sc.fetched.set(id, Date.now())
      const pending = sc.pending.get(id)
      const failed = ['failed', 'stalled'].includes(card.run?.state) && card.run.startedAt >= (pending?.at ?? 0) - 5000
      if (pending && (ownReplies(card.details?.chat ?? [], pending.at) || failed || Date.now() - pending.at > SIDE_PENDING_MS)) {
        sc.pending.delete(id)
        changed = true
      }
    }
  } catch {}
  sc.loading.delete(id)
  if (changed) renderTaskPanel()
}

const sidePanelShown = () => state.tab === 'focus' && state.panel.open && state.panel.tab === 'sidechats'

function sideChatLive(id) {
  const card = state.sideChats.cards.get(id)
  return state.sideChats.pending.has(id) || card?.run?.state === 'running' || Boolean(card?.active)
}

function pollSideChats() {
  if (!sidePanelShown()) return
  const sc = state.sideChats
  if (Date.now() - sc.at > 4000) loadSideChats()
  for (const id of sc.open) {
    if (Date.now() - (sc.fetched.get(id) ?? 0) > (sideChatLive(id) ? 1000 : 15_000)) loadSideChat(id)
  }
}

let sideBurstTimer = null

function sideBurst() {
  clearInterval(sideBurstTimer)
  let ticks = 0
  sideBurstTimer = setInterval(() => {
    ticks += 1
    const live = [...state.sideChats.open].filter(sideChatLive)
    if (ticks > 150 || !live.length || !sidePanelShown()) return clearInterval(sideBurstTimer)
    live.forEach(loadSideChat)
    if (ticks % 3 === 0) loadSideChats()
  }, 1200)
}

function renderTaskPanel(selected = state.panelSelected) {
  state.panelSelected = selected
  const panel = $('task-panel')
  const open = state.panel.open && state.tab === 'focus'
  panel.hidden = !open
  if (!open) return
  hideTip()
  const keepScroll = panel.querySelector('.tp-body')?.scrollTop ?? 0
  const sessionId = panelSession(selected)
  const mine = (items) => (sessionId ? items.filter((item) => item.sessionId === sessionId) : items)
  const tasks = mine(state.background.data?.tasks ?? [])
  const loops = mine(state.loops.data?.loops ?? [])
  const running = tasks.filter((task) => task.status === 'running').length
  const activeLoops = loops.filter((r) => r.status !== 'ended').length
  const openSides = sideChatGroups(state.sideChats.data?.items ?? [], sessionId).open.length

  const head = el('div', 'tp-head')
  const tabs = el('div', 'tp-tabs')
  for (const [key, label, count] of [['background', 'Background', running], ['loops', 'Loops', activeLoops], ['sidechats', 'Side chats', openSides]]) {
    const b = el('button', undefined, label)
    b.type = 'button'
    if (count) b.append(el('span', 'n', String(count)))
    b.setAttribute('aria-pressed', String(state.panel.tab === key))
    b.onclick = () => { state.panel.tab = key; savePanel(); renderTaskPanel(selected) }
    tabs.append(b)
  }
  const close = el('button', 'icon-only')
  close.type = 'button'
  close.title = 'Close panel'
  close.setAttribute('aria-label', 'Close panel')
  close.append(icon('x', { size: 16 }))
  close.onclick = togglePanel
  head.append(tabs, close)

  const scope = el('div', 'seg tp-scope')
  for (const [key, label] of [['session', 'This session'], ['all', 'All sessions']]) {
    const b = el('button', undefined, label)
    b.type = 'button'
    b.disabled = key === 'session' && !selected
    b.setAttribute('aria-pressed', String(state.panel.scope === key))
    b.onclick = () => { state.panel.scope = key; savePanel(); renderTaskPanel(selected) }
    scope.append(b)
  }

  const body = el('div', 'tp-body')
  const tab = state.panel.tab
  const loaded = tab === 'background' ? state.background.data : tab === 'loops' ? state.loops.data : state.sideChats.data
  if (!loaded) body.append(panelEmpty('Loading…'))
  else body.append(tab === 'background' ? backgroundBody(tasks, !sessionId) : tab === 'loops' ? loopsBody(loops, !sessionId) : sideChatsBody(selected, sessionId))
  const focused = document.activeElement
  const keep = panel.contains(focused) ? focused.dataset?.keep : null
  const caret = keep && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null
  const logs = new Map([...panel.querySelectorAll('.sc-log')].map((log) => [log.dataset.sc, { top: log.scrollTop, stick: log.scrollHeight - log.clientHeight - log.scrollTop < 40 }]))
  panel.replaceChildren(head, scope, body)
  body.scrollTop = keepScroll
  for (const log of panel.querySelectorAll('.sc-log')) {
    const was = logs.get(log.dataset.sc)
    log.scrollTop = !was || was.stick ? log.scrollHeight : was.top
  }
  if (keep) {
    const field = [...panel.querySelectorAll('[data-keep]')].find((node) => node.dataset.keep === keep)
    if (field && !field.disabled) {
      field.focus({ preventScroll: true })
      if (caret) field.setSelectionRange(...caret)
    }
  }
}

const taskKey = (task) => `${task.sessionId}:${task.id}`

const taskOpen = (task) => (task.status === 'running' ? !state.panel.closed.has(taskKey(task)) : state.panel.opened.has(taskKey(task)))

async function fetchBackgroundOutput(task) {
  const key = taskKey(task)
  try {
    state.background.output.set(key, await getJson(`/api/background/output?session=${encodeURIComponent(task.sessionId)}&task=${encodeURIComponent(task.id)}`))
  } catch {
    state.background.output.set(key, { available: false })
  }
}

async function loadBackground() {
  try {
    state.background.data = await getJson('/api/background')
    state.background.at = Date.now()
    const stale = state.background.data.tasks.filter((task) => task.hasOutput && taskOpen(task) && (task.status === 'running' || !state.background.output.has(taskKey(task))))
    await Promise.all(stale.map(fetchBackgroundOutput))
    renderTaskPanel()
  } catch {}
}

function loadTaskData() {
  loadBackground()
  loadLoops()
  loadSideChats()
  state.sideChats.open.forEach(loadSideChat)
}

const usageRequest = latestOnly()

async function loadUsage() {
  const isLatest = usageRequest()
  try {
    const data = await getJson(`/api/usage?days=${state.usage.days}`)
    if (!isLatest()) return
    state.usage.data = data
    state.usage.at = Date.now()
    renderUsagePage()
  } catch {}
}

async function loadFlow() {
  clearTimeout(state.flow.timer)
  try {
    const data = await getJson('/api/flow')
    state.flow.at = Date.now()
    flowView.update(data)
    if (data.refreshing) state.flow.timer = setTimeout(() => { if (state.tab === 'flow') loadFlow() }, 4000)
  } catch {}
}

async function loadSkills() {
  try {
    state.skills.data = await getJson('/api/skills')
    state.skills.at = Date.now()
    renderSkillsPage()
  } catch {}
}

async function fetchSkillDetail(key) {
  state.skills.details.set(key, { loading: true })
  try {
    const response = signedOut(await fetch(`/api/skill?key=${encodeURIComponent(key)}`, { cache: 'no-store' }))
    state.skills.details.set(key, response.ok ? await response.json() : { error: 'Could not read SKILL.md.' })
  } catch {
    state.skills.details.set(key, { error: 'Could not read SKILL.md.' })
  }
  renderSkillsPage()
}

function sparkline(values, { width, height, titles = [] }) {
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('class', 'spark')
  svg.setAttribute('role', 'img')
  const max = Math.max(...values, 1)
  const slot = width / values.length
  values.forEach((value, index) => {
    const h = value ? Math.max(2, (value / max) * height) : 1
    const rect = document.createElementNS(svgNs, 'rect')
    rect.setAttribute('x', String(index * slot + slot * 0.15))
    rect.setAttribute('y', String(height - h))
    rect.setAttribute('width', String(slot * 0.7))
    rect.setAttribute('height', String(h))
    rect.setAttribute('rx', '1')
    if (!value) rect.setAttribute('class', 'zero')
    if (titles[index]) {
      const title = document.createElementNS(svgNs, 'title')
      title.textContent = titles[index]
      rect.append(title)
    }
    svg.append(rect)
  })
  return svg
}

function skillScope(skill) {
  return skill.scope === 'project' ? projectChip(skill) : el('span', `scope-tag ${skill.scope}`, scopeLabel(skill))
}

function skillDetailBox(skill, now) {
  const box = el('div', 'loop-detail')
  const description = [skill.description, skill.hint ? `Argument hint: ${skill.hint}` : ''].filter(Boolean).join('\n\n')
  if (description) box.append(el('div', 'loop-prompt', description))
  const facts = el('div', 'loop-facts')
  const stamp = (ms) => (ms ? new Date(ms).toLocaleString() : 'never')
  for (const [label, value] of [
    ['Scope', skill.scope === 'project' ? `Project · ${skill.project}` : scopeLabel(skill)],
    ['Uses', `${skill.uses} total · ${skill.toolUses} by Claude · ${skill.commandUses} by slash command`],
    ['Sessions', String(skill.sessions)],
    ['First used', stamp(skill.firstUsedAt)],
    ['Last used', stamp(skill.lastUsedAt)],
    ...(skill.updatedAt ? [['Updated', stamp(skill.updatedAt)]] : []),
    ...(skill.path ? [['Path', home(skill.path)]] : []),
  ]) facts.append(el('span', undefined, `${label}: ${value}`))
  box.append(facts)

  const { days } = state.skills
  const keys = dayKeys(days, now)
  const values = dailyUses(skill, days, now)
  const trend = el('div', 'skill-trend')
  trend.append(el('div', 'skill-section-title', `Uses per day, last ${days} days`), sparkline(values, { width: Math.min(720, days * 14), height: 44, titles: keys.map((day, i) => `${day}: ${values[i]} use${values[i] === 1 ? '' : 's'}`) }))
  box.append(trend)

  if (skill.byProject.length) {
    const chips = el('div', 'chips')
    for (const entry of skill.byProject) {
      const chip = projectChip({ project: entry.project })
      chip.append(text(` · ${entry.uses}`))
      chips.append(chip)
    }
    box.append(el('div', 'skill-section-title', 'Used in projects'), chips)
  }

  if (skill.recent.length) {
    const list = el('div', 'skill-sessions')
    for (const item of skill.recent) {
      const row = el('div', 'skill-session')
      row.append(el('span', 'row-title', item.title), projectChip(item), el('span', 'num', `${item.uses}×`), el('span', 'num', relative(item.lastAt)), openLink(item.sessionId))
      list.append(row)
    }
    box.append(el('div', 'skill-section-title', 'Recent sessions'), list)
  }

  if (skill.scope !== 'missing') {
    box.append(el('div', 'skill-section-title', 'SKILL.md'))
    const detail = state.skills.details.get(skill.key)
    if (!detail || detail.loading) box.append(el('span', 'dim', 'Loading…'))
    else if (detail.error) box.append(el('span', 'dim', detail.error))
    else {
      if (detail.files.length) {
        const files = el('div', 'chips')
        for (const file of detail.files) files.append(el('span', 'run-chip', file))
        box.append(files)
      }
      box.append(el('pre', 'skill-body', detail.body || '(empty)'))
      if (detail.truncated) box.append(el('span', 'dim', 'Truncated for display.'))
    }
  }
  return box
}

function renderSkillsPage() {
  hideTip()
  const data = state.skills.data
  if (!data) return
  const { scope, temp, days, sort, query, open } = state.skills
  const now = Date.now()
  const all = data.skills
  const summary = summarize(all, days, now)
  const cards = $('skills-cards')
  cards.replaceChildren()
  for (const [value, label, small] of [
    [String(summary.installed), 'skills installed'],
    [String(summary.usedInRange), `used in the last ${days} days`],
    [String(summary.neverUsed), 'never used'],
    [summary.top ? summary.top.name : '—', summary.top ? `most used · ${summary.top.uses} in ${days} days` : 'most used', true],
  ]) {
    const card = el('div', 'stat-card')
    card.append(el('b', small ? 'small' : undefined, value), el('span', undefined, label))
    cards.append(card)
  }

  const counts = skillCounts(all.filter((skill) => SCOPE_FILTERS[scope](skill)), now)
  const pills = $('skills-temp')
  pills.replaceChildren()
  for (const group of ['warm', 'cool', 'unused']) {
    const b = el('button', 'pill', `${group[0].toUpperCase()}${group.slice(1)} ${counts[group]}`)
    b.setAttribute('aria-pressed', String(temp === group))
    b.onclick = () => { state.skills.temp = temp === group ? null : group; renderSkillsPage() }
    pills.append(b)
  }

  const rows = visibleSkills(all, { scope, temp, query, days, sort, now })
  $('skills-status').textContent = `${rows.length} of ${all.length} skills${data.indexed?.running ? ` · indexing ${data.indexed.done}/${data.indexed.total} sessions` : ''} · uses counted from Skill tool calls and slash commands in the main conversation`
  $('skills-empty').hidden = rows.length > 0
  const body = $('skills-rows')
  body.replaceChildren()
  for (const skill of rows) {
    const t = skillTemperature(skill, now)
    const tr = document.createElement('tr')
    tr.className = 'loop-row'
    const name = el('div')
    name.append(el('div', 'row-title', skill.name))
    if (skill.description) name.append(el('div', 'skill-desc', skill.description))
    const values = dailyUses(skill, days, now)
    tr.append(
      cell(name),
      cell(skillScope(skill)),
      cell(meterBadge(t, () => skillTip(skill, t))),
      cell(el('span', 'num', String(usesInRange(skill, days, now)))),
      cell(el('span', 'num', String(skill.uses))),
      cell(el('span', 'num', String(skill.sessions))),
      cell(el('span', 'num', skill.lastUsedAt ? relative(skill.lastUsedAt) : '—')),
      cell(el('span', 'num', skill.updatedAt ? relative(skill.updatedAt) : '—')),
      cell(sparkline(values, { width: 90, height: 18 }))
    )
    tr.onclick = (event) => {
      if (event.target.closest('a')) return
      if (open.has(skill.key)) open.delete(skill.key)
      else {
        open.add(skill.key)
        if (skill.scope !== 'missing' && !state.skills.details.has(skill.key)) fetchSkillDetail(skill.key)
      }
      renderSkillsPage()
    }
    body.append(tr)
    if (open.has(skill.key)) {
      const detail = document.createElement('tr')
      detail.className = 'loop-detail-row'
      const td = cell(skillDetailBox(skill, now))
      td.colSpan = 9
      detail.append(td)
      body.append(detail)
    }
  }
  document.querySelectorAll('#skills-scope button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === scope)))
  document.querySelectorAll('#skills-days button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days)))
  document.querySelectorAll('#skills-sort button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === sort)))
}

const pathTab = () => ROUTES[location.pathname.replace(/(.)\/+$/, '$1')] ?? 'all'

function writeFilters() {
  if (state.tab !== 'all') return
  const params = new URLSearchParams()
  if ($('q').value.trim()) params.set('q', $('q').value.trim())
  if (state.status) params.set('status', state.status)
  if (state.temp) params.set('temp', state.temp)
  if ($('archived').checked) params.set('archived', '1')
  const query = params.toString()
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}`)
}

function readFilters() {
  const params = new URLSearchParams(location.search)
  $('q').value = params.get('q') ?? ''
  state.status = params.get('status')
  state.temp = ['warm', 'cool'].includes(params.get('temp')) ? params.get('temp') : null
  $('archived').checked = params.get('archived') === '1'
}

// `back`: a page opened from inside another one (the Lifecycle map from a session, say) remembers
// where it came from, so the phone header shows Back: a fullscreen web app has no browser Back button.
function navigate(path, { back = false } = {}) {
  const mode = navigationMode(history.state, location.pathname + location.search === path)
  const entry = back ? { back: location.pathname + location.search } : {}
  if (mode === 'back') return void history.back()
  if (mode === 'push') history.pushState(entry, '', path)
  else if (mode === 'replace') history.replaceState(entry, '', path)
  applyRoute()
}

const LEGACY_PANELS = { '/loops': 'loops', '/background': 'background' }

function applyRoute() {
  const legacy = LEGACY_PANELS[location.pathname.replace(/(.)\/+$/, '$1')]
  if (legacy) {
    state.panel.open = true
    state.panel.tab = legacy
    savePanel()
    history.replaceState({}, '', '/focus')
  }
  const tab = pathTab()
  if (tab === 'all') readFilters()
  state.tab = tab
  const query = new URLSearchParams(location.search)
  state.draft = tab === 'focus' && query.has('new')
  state.wanted = tab === 'focus' ? query.get('card') : null
  if (tab === 'focus') state.selected = query.get('card') ?? state.selected
  for (const name of Object.values(ROUTES)) {
    $(`tab-${name}`).setAttribute('aria-selected', String(name === tab))
    $(`view-${name}`).hidden = name !== tab
  }
  const onAll = tab === 'all'
  $('q').hidden = !onAll
  $('archived').parentElement.hidden = !onAll && !isMobile()
  state.unseen = 0
  updateTitle()
  renderMobileHeader(null)
  renderSummary()
  renderRows()
  renderFocus()
  if (tab !== 'search') {
    clearTimeout(state.search.timer)
    state.search.runId++
  } else {
    const params = new URLSearchParams(location.search)
    $('search-q').value = params.get('q') ?? ''
    renderProjectOptions([], params.get('project') ?? '')
    runSearch()
    $('search-q').focus()
  }
  if (tab === 'usage') loadUsage()
  if (tab === 'skills') loadSkills()
  if (tab === 'flow') loadFlow()
  else flowView.leave()
  if (tab === 'schedule') loadSchedule()
  if (tab === 'focus' && state.panel.open) loadTaskData()
  if (tab === 'mrs') {
    pickMrs(pickedMrs(location.search))
    renderMrsPage()
    loadMrs()
  } else if (state.mrs.picked.length) {
    state.mrs.picked = []
  }
  refresh()
}

function detectEvents(sessions, cards) {
  const hadBaseline = state.alertSnap !== null
  try {
    const alerts = diffAlerts(state.alertSnap, cards)
    const loops = diffLoops(state.loopSnap, sessions)
    const background = diffBackground(state.backgroundSnap, sessions)
    state.alertSnap = alerts.next
    state.loopSnap = loops.next
    state.backgroundSnap = background.next
    return hadBaseline ? [...withoutTickFinishes(alerts.events, loops.events), ...loops.events, ...background.events] : []
  } catch {
    state.alertSnap = null
    state.loopSnap = null
    state.backgroundSnap = null
    return []
  }
}

async function refreshBoard() {
  try {
    const [sessions, firstFocus] = await Promise.all([getJson('/api/sessions'), getJson('/api/focus')])
    let focus = firstFocus
    const { fresh, next: knownIds } = newSessionIds(state.knownIds, sessions, focus.ids)
    state.knownIds = knownIds
    if (fresh.length) {
      for (const id of fresh) await postJson('/api/focus', { id, focused: true })
      focus = await getJson('/api/focus')
    }
    const events = detectEvents(sessions, focus.cards)
    if (events.length) {
      recordHistory(events)
      if (state.alertsOn) notify(events)
    }
    const signature = JSON.stringify([sessions, focus, Math.floor(Date.now() / 30000)])
    if (signature !== state.signature) {
      state.signature = signature
      state.sessions = sessions
      state.resume = new Map(sessions.filter((s) => s.resume).map((s) => [s.id, s.resume]))
      state.focusIds = focus.ids
      state.cards = focus.cards
      timeline.update({ prompts: focus.cards.map((c) => ({ sessionId: c.id, title: c.title, project: c.project, items: c.schedules ?? [] })) })
      state.loaded = true
      renderSummary()
      renderRows()
      renderFocus()
      if (state.tab === 'schedule' && state.schedule.built) fillScheduleFolders()
    }
    if (prunePending()) renderFocus()
    pollChanges()
    pollAgents()
    pollSideChats()
    if (state.tab === 'usage' && Date.now() - state.usage.at > 30_000) loadUsage()
    if (state.tab === 'flow' && Date.now() - state.flow.at > 60_000 && !flowView.busy()) loadFlow()
    if (state.tab === 'skills' && !state.skills.open.size && Date.now() - state.skills.at > 30_000) loadSkills()
    if (state.tab === 'schedule' && Date.now() - state.schedule.at > 5_000) loadSchedule()
    if (Date.now() - state.mrs.at > mrsPollMs(mrHasWorking())) loadMrs()
    if (!isMobile() && Date.now() - state.timeline.at > 15_000) loadTimeline()
    if (state.tab === 'focus' && state.panel.open) {
      if (Date.now() - state.background.at > 4_000) loadBackground()
      if (Date.now() - state.loops.at > 5_000) loadLoops()
    }
  } catch {}
}

const serverStatus = { up: null, info: null, checkedAt: 0, latency: 0, downSince: 0 }

function spanLabel(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function serverTip() {
  const { up, info, checkedAt, latency, downSince } = serverStatus
  const checked = checkedAt ? `${spanLabel(Date.now() - checkedAt)} ago` : 'not yet'
  if (up === false) {
    return {
      heading: 'Server offline',
      text: 'The board server is not responding. Data on this page is stale.',
      rows: [
        ['Offline for', downSince ? spanLabel(Date.now() - downSince) : 'unknown'],
        ['Last check', checked],
        ['Last known pid', info ? String(info.pid) : 'unknown'],
        ['Start it', 'npm start, or ./scripts/install-launch-agent.sh'],
      ],
    }
  }
  if (!info) return { heading: 'Checking server', text: 'Waiting for the first response.', rows: [] }
  return {
    heading: 'Server running',
    text: `Answering on http://localhost:${info.port}.`,
    rows: [
      ['Uptime', spanLabel(Date.now() - info.startedAt)],
      ['Response', `${latency} ms`],
      ['Last check', checked],
      ['Process', `pid ${info.pid}, ${info.memoryMb} MB`],
      ['Node', info.node],
      ['Started by', info.managed ? 'launchd (auto-restarts)' : 'manual'],
    ],
  }
}

async function checkServer() {
  const began = performance.now()
  let info = null
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(2500) })
    if (res.ok) info = await res.json()
  } catch {}
  const up = info !== null
  const live = $('live')
  const was = serverStatus.up
  serverStatus.up = up
  serverStatus.checkedAt = Date.now()
  if (up) {
    serverStatus.info = info
    serverStatus.latency = Math.round(performance.now() - began)
    serverStatus.downSince = 0
  } else if (!serverStatus.downSince) {
    serverStatus.downSince = Date.now()
  }
  live.dataset.state = up ? 'on' : 'off'
  live.querySelector('.live-text').textContent = up ? 'Live' : 'Offline'
  if (up && was === false) refresh()
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
$('tab-skills').onclick = (event) => { event.preventDefault(); navigate('/skills') }
$('tab-schedule').onclick = (event) => { event.preventDefault(); navigate('/schedule') }
$('tab-mrs').onclick = (event) => { event.preventDefault(); navigate('/mrs') }
$('tab-flow').onclick = (event) => { event.preventDefault(); navigate('/flow') }
window.onpopstate = applyRoute
$('q').oninput = () => { renderRows(); writeFilters() }
$('archived').onchange = () => { renderSummary(); renderRows(); writeFilters(); if (isMobile()) renderFocus() }
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
$('search-project').onchange = runSearch
$('search-q').oninput = () => { clearTimeout(state.search.timer); state.search.timer = setTimeout(runSearch, 250) }
$('new-chat').onclick = openNewChat
$('focus-clear').onclick = async () => {
  if (!state.focusIds?.length) return
  if (!confirm(`Remove all ${state.focusIds.length} sessions from Focus? The sessions themselves are kept.`)) return
  const result = await postJson('/api/focus/clear', {})
  if (!result.ok) return failToast('focus-update', 'Could not clean Focus', result)
  state.focusIds = result.data.ids
  await resync()
}
$('broadcast-open').onclick = openBroadcast
$('broadcast-cancel').onclick = () => $('broadcast').close()
$('broadcast-send').onclick = sendBroadcast
function setSortMenu(open) {
  $('side-sort-menu').hidden = !open
  $('side-sort-btn').setAttribute('aria-expanded', String(open))
}
function renderSortMenu() {
  const button = $('side-sort-btn')
  const current = SORTS.find((s) => s.key === state.focusSort) ?? SORTS[0]
  button.replaceChildren(icon('arrow-up-down', { size: 15 }))
  button.title = `Sort: ${current.label}`
  button.setAttribute('aria-label', `Sort focused sessions (now ${current.label})`)
  button.classList.toggle('on', current.key !== 'manual')
  $('side-sort-menu').replaceChildren(...SORTS.map((s) => {
    const item = el('button')
    item.setAttribute('role', 'menuitemradio')
    item.setAttribute('aria-checked', String(s.key === current.key))
    const tick = el('span', 'tick')
    if (s.key === current.key) tick.append(icon('check', { size: 14 }))
    item.append(tick, text(s.label))
    item.onclick = () => { state.focusSort = sortKey(s.key); remember('board.focusSort', state.focusSort); setSortMenu(false); renderFocus() }
    return item
  }))
}
$('side-sort-btn').onclick = (event) => { event.stopPropagation(); setSortMenu($('side-sort-menu').hidden) }
document.addEventListener('click', (event) => { if (!$('side-sort-menu').hidden && !$('side-sort-menu').contains(event.target)) setSortMenu(false) })
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('side-sort-menu').hidden) setSortMenu(false) })
renderSortMenu()
$('side-q').oninput = renderFocus
document.querySelectorAll('#mrs-filter button').forEach((b) => {
  b.onclick = () => { state.mrs.filter = b.dataset.filter; renderMrsPage() }
})
document.querySelectorAll('#mrs-temp button').forEach((b) => {
  b.onclick = () => { state.mrs.temp = state.mrs.temp === b.dataset.temp ? null : b.dataset.temp; renderMrsPage() }
})
$('mrs-refresh').onclick = () => loadMrs(true)
$('mrs-channel').onclick = editReviewChannel
document.querySelectorAll('#usage-metric button').forEach((b) => {
  b.onclick = () => { state.usage.metric = b.dataset.metric; remember('board.usageMetric', state.usage.metric); renderUsagePage() }
})
document.querySelectorAll('#usage-days button').forEach((b) => {
  b.onclick = () => { state.usage.days = Number(b.dataset.days); remember('board.usageDays', String(state.usage.days)); loadUsage() }
})
document.querySelectorAll('#skills-scope button').forEach((b) => {
  b.onclick = () => { state.skills.scope = b.dataset.scope; renderSkillsPage() }
})
document.querySelectorAll('#skills-days button').forEach((b) => {
  b.onclick = () => { state.skills.days = Number(b.dataset.days); remember('board.skillsDays', String(state.skills.days)); renderSkillsPage() }
})
document.querySelectorAll('#skills-sort button').forEach((b) => {
  b.onclick = () => { state.skills.sort = b.dataset.sort; remember('board.skillsSort', state.skills.sort); renderSkillsPage() }
})
$('skills-q').oninput = () => { state.skills.query = $('skills-q').value; renderSkillsPage() }
$('cards').addEventListener('focusin', (event) => {
  const card = event.target.closest?.('.card')
  if (card) clearNotifications(card.dataset.id)
})

document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog.lightbox')) return
  if (event.key === 'Escape' && state.historyOpen) { setHistoryOpen(false); return }
  if (state.tab !== 'focus' || $('broadcast').open) return
  const typing = event.target.closest?.('input, textarea, select, [contenteditable]')
  if (event.key === 'Escape') {
    if (state.draft) return void closeNewChat()
    const current = selectedCard()
    if (current && uiOf(current.id).popover) { uiOf(current.id).popover = null; renderFocus() }
    return
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); stepSelected(event.key === 'ArrowDown' ? 1 : -1) }
  else if (event.key === '/' && $('side-q').offsetParent) { event.preventDefault(); $('side-q').focus() }
})
// A phone has no Esc: a tap on the chat closes the ⋯ panel, and a tap outside the composer closes
// its popover or slash menu. pointerdown, because iOS does not send document-level clicks for taps on plain text.
document.addEventListener('pointerdown', (event) => {
  const card = event.target.closest?.('.stage .card')
  if (!card) return
  const id = card.dataset.id
  const ui = state.ui.get(id)
  if (!ui) return
  let changed = false
  if (ui.more && !event.target.closest('.card-head')) { ui.more = false; changed = true }
  if (!event.target.closest('.dock')) {
    if (ui.popover) { ui.popover = null; changed = true }
    else if (ui.slashItems?.length) {
      ui.slashDismissed = state.drafts.get(id) ?? ''
      resyncSlash(id)
    }
  }
  if (changed) renderFocus()
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { state.unseen = 0; updateTitle() }
})
setInterval(() => {
  document.querySelectorAll('[data-since]').forEach((node) => { node.textContent = duration(Date.now() - Number(node.dataset.since)) })
}, 1000)

function resetIn(ms) {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

function limitNode(label, w) {
  const box = el('div', `limit${w.percent >= 90 ? ' high' : w.percent >= 70 ? ' warn' : ''}`)
  const left = w.resetsAt ? Math.max(0, new Date(w.resetsAt) - Date.now()) : 0
  box.title = `${label} limit: ${w.percent}% used${w.resetsAt ? `, resets in ${resetIn(left)} (${dateTime(new Date(w.resetsAt).getTime())})` : ''}`
  const head = el('span')
  head.append(`${label} `, Object.assign(document.createElement('b'), { textContent: `${w.percent}%` }), w.resetsAt ? ` · ${resetIn(left)}` : '')
  const bar = el('div', 'bar')
  const fill = document.createElement('i')
  fill.style.width = `${Math.min(w.percent, 100)}%`
  bar.append(fill)
  box.append(head, bar)
  return box
}

async function refreshLimits() {
  const box = $('limits')
  try {
    const data = await signedOut(await fetch('/api/limits')).json()
    const nodes = data.available ? [['5h', data.fiveHour], ['Week', data.weekly]].filter(([, w]) => w).map(([l, w]) => limitNode(l, w)) : []
    box.replaceChildren(...nodes)
    box.hidden = !nodes.length
  } catch { box.hidden = true }
}

function setupNavBar() {
  const bar = $('nav-bar')
  const back = $('nav-back')
  const forward = $('nav-forward')
  back.replaceChildren(icon('chevron-left', { size: 16 }))
  forward.replaceChildren(icon('chevron-right', { size: 16 }))
  back.onclick = () => history.back()
  forward.onclick = () => history.forward()
  $('side-collapse').replaceChildren(icon('panel-left', { size: 16 }))
  bar.prepend($('side-collapse'))
  const sync = () => {
    if (!window.navigation) return
    back.disabled = !navigation.canGoBack
    forward.disabled = !navigation.canGoForward
  }
  window.navigation?.addEventListener('currententrychange', sync)
  sync()
  bar.hidden = false
}

const REPO_STATES = {
  synced: { icon: 'check-circle', text: 'Up to date with origin' },
  behind: { icon: 'arrow-down', text: 'Origin has updates to pull' },
  ahead: { icon: 'arrow-up', text: 'Local changes to commit and push' },
  diverged: { icon: 'arrow-up-down', text: 'Origin has updates and local has changes to push' },
}

const REPO_CLICK = {
  synced: 'Click to fetch again',
  behind: 'Click to pull',
  ahead: 'Click to commit and push',
  diverged: 'Click to commit, pull and push',
}

function repoStatusTitle(data) {
  const view = REPO_STATES[data.state]
  const counts = [data.behind ? `${data.behind} to pull` : '', data.ahead ? `${data.ahead} to push` : ''].filter(Boolean).join(', ')
  return [
    `${view.text}${counts ? ` (${counts})` : ''}`,
    `${data.branch} → ${data.upstream}`,
    data.dirtyCount ? `${data.dirtyCount} uncommitted file${data.dirtyCount === 1 ? '' : 's'}` : '',
    data.fetched ? '' : 'Could not reach origin, showing the last fetched state',
    REPO_CLICK[data.state],
  ].filter(Boolean).join('\n')
}

function showRepoStatus(button, data) {
  if (!data.available) { button.hidden = true; return }
  button.dataset.state = data.state
  button.title = repoStatusTitle(data)
  button.setAttribute('aria-label', button.title.split('\n')[0])
  button.replaceChildren(icon(REPO_STATES[data.state].icon, { size: 16 }))
  button.hidden = false
}

async function withRepoSpinner(task) {
  const button = $('repo-status')
  if (button.disabled) return
  const wasShown = !button.hidden
  if (wasShown) {
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.replaceChildren(el('span', 'spinner'))
  }
  try {
    await task(button)
  } catch { button.hidden = true } finally {
    button.disabled = false
    button.removeAttribute('aria-busy')
  }
}

const refreshRepoStatus = (force = false) => withRepoSpinner(async (button) => {
  showRepoStatus(button, await signedOut(await fetch(`/api/repo-status${force ? '?force=1' : ''}`)).json())
})

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

const syncRepo = () => withRepoSpinner(async (button) => {
  const result = await postJson('/api/repo/push', { pull: true })
  if (result.ok) {
    const { committed, pulled, pushed } = result.data
    const did = [committed ? `committed “${committed}”` : '', pulled ? `pulled ${plural(pulled, 'commit')}` : '', pushed ? 'pushed' : ''].filter(Boolean).join(', ')
    showRepoStatus(button, result.data.status)
    toast({ id: 'repo-push', title: pushed ? 'Synced with origin' : 'Updated from origin', kind: 'finished', message: `${did.charAt(0).toUpperCase()}${did.slice(1)}.` })
    return
  }
  toast({ id: 'repo-push', title: 'Could not sync', kind: 'failed', message: result.data.error ?? 'Could not sync' })
  showRepoStatus(button, await signedOut(await fetch('/api/repo-status?force=1')).json())
})

const pullRepoFromOrigin = () => withRepoSpinner(async (button) => {
  const result = await postJson('/api/repo/pull', {})
  if (result.ok) {
    showRepoStatus(button, result.data.status)
    toast({ id: 'repo-pull', title: 'Pulled from origin', kind: 'finished', message: `Pulled ${result.data.pulled} new commit${result.data.pulled === 1 ? '' : 's'}. Restart the board to load server changes.` })
    return
  }
  toast({ id: 'repo-pull', title: 'Could not pull', kind: 'failed', message: result.data.error ?? 'Could not pull' })
  showRepoStatus(button, await signedOut(await fetch('/api/repo-status?force=1')).json())
})

const REPO_CLICK_ACTION = { ahead: syncRepo, behind: pullRepoFromOrigin, diverged: syncRepo }
$('repo-status').onclick = () => (REPO_CLICK_ACTION[$('repo-status').dataset.state] ?? (() => refreshRepoStatus(true)))()

const topbar = document.querySelector('.topbar')
if (window.ResizeObserver) new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar)
if (location.hash === '#focus') history.replaceState({}, '', '/focus')
$('history').append(icon('bell', { size: 18 }))
state.history = readHistory()
renderHistoryBadge()
renderAlertsButton()
$('new-chat').replaceChildren(icon('plus', { size: 16 }), el('span', 'lbl', 'New chat'))
$('broadcast-open').replaceChildren(icon('megaphone', { size: 16 }), el('span', 'lbl', 'Broadcast'))
$('focus-clear').replaceChildren(icon('list-x', { size: 16 }), el('span', 'lbl', 'Clean all'))
$('side-collapse').replaceChildren(icon('panel-left', { size: 18 }))
// Page menu: an icon per page, so the collapsed sidebar can show icons alone.
for (const [name, shape] of Object.entries({ all: 'list', focus: 'star', mrs: 'git-pull-request', flow: 'workflow', search: 'search', usage: 'bar-chart', skills: 'zap', schedule: 'calendar' })) {
  const tab = $(`tab-${name}`)
  tab.prepend(icon(shape, { size: 16 }))
  tab.title = tab.querySelector('.tab-label').textContent
}
// Electron shell (hidden title bar): the sidebar head keeps clear of the window buttons and drags the window.
if (/Electron/.test(navigator.userAgent)) {
  document.documentElement.classList.add('electron')
  setupNavBar()
}
$('menu-btn').replaceChildren(icon('menu', { size: 22 }))
$('m-back').append(icon('chevron-left', { size: 22 }))
$('m-back').onclick = () => history.back()
$('m-more').append(icon('more', { size: 18 }))
$('m-more').onclick = () => {
  const id = $('m-more').dataset.id
  if (!id) return
  const ui = uiOf(id)
  ui.more = !ui.more
  renderFocus()
}
$('drawer-close').replaceChildren(icon('x', { size: 20 }))
$('drawer-brand').replaceChildren(icon('asterisk', { size: 20, strokeWidth: 2.4 }), text('Sessions'))
loadSnippets()
initMobile({ onChange: () => { state.signature = ''; applyRoute() } })
installWidgetHost({ sendPrompt: sendWidgetPrompt, mobile: isMobile })
initLinkMenu((ok, target) => toast(ok
  ? { id: 'copy-link', title: target.label === 'Copy path' ? 'Path copied' : 'Link copied', kind: 'finished', message: target.value }
  : { id: 'copy-link', title: 'Could not copy', kind: 'failed', message: 'The browser blocked clipboard access.' }))
// On a phone the app opens on Focus, not the All sessions table.
if (isMobile() && location.pathname === '/' && !location.search) history.replaceState({}, '', '/focus')
applyRoute()
schedule()
attachTip($('live'), serverTip)
checkServer()
setInterval(checkServer, 3000)
refreshLimits()
setInterval(refreshLimits, 60_000)
refreshRepoStatus()
setInterval(refreshRepoStatus, 60_000)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
