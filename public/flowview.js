import { STEPS, STEP_LABEL, PHASES, phaseOf, SOURCE_LABEL, deriveTicket, gapRows, kpiValues, inRange, matchesFilter, isMyWorkingTicket, fmtSpan, isWorking, DAY_MS } from './flow.js'
import { mapGraph, induced, foldLeaves, lineage, columns, hiddenNeighbours, flowRows, shape, kindName, KIND_ORDER, SESSION_LINK_LABEL } from './flowmap.js'
import { attachTip, hideTip } from './tip.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const RANGES = [30, 90, 180]
const STATUSES = [['working', 'My working'], ['active', 'In flight'], ['done', 'Done'], ['all', 'All']]
const VIEWS = [['overview', 'Overview'], ['map', 'Map'], ['how', 'How it works']]
const MILESTONE_STEPS = STEPS.filter((step) => step.id !== 'created')
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const TOKEN_HELP = 'https://id.atlassian.com/manage-profile/security/api-tokens'
const STORE_KEY = 'board.flow'

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'style') node.style.cssText = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (key === 'value') node.value = value
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  return node
}

function s(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) if (value != null) node.setAttribute(key, value)
  for (const kid of kids.flat(Infinity)) if (kid != null) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  return node
}

const day = (ms) => {
  const d = new Date(ms)
  return `${MON[d.getMonth()]} ${d.getDate()}`
}
const stamp = (ms) => {
  const d = new Date(ms)
  return `${day(ms)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const ago = (ms) => {
  if (!ms) return 'never'
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1440)}d ago`
}
const localInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const mrShort = (ref) => (ref ? `!${String(ref).split('!').pop()}` : '')
const phaseVar = (id) => `var(--fl-${id})`
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const tone = (state) => ({ merged: 'ok', opened: 'info', closed: 'dim' }[state] ?? 'dim')

export function createFlowView(root, { openSession, postJson, reload }) {
  const ui = { range: 30, epic: 'all', status: 'working', work: false, query: '', view: 'overview', open: null, focus: null, trail: [], folds: new Set(), setup: false, adding: false, linking: null, collapsed: [], busy: false, message: null }
  try { const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); Object.assign(ui, saved, saved.v >= 2 ? {} : { status: 'working' }, { open: null, focus: null, trail: [], folds: new Set(), setup: false, adding: false, linking: null, busy: false, message: null }) } catch {}
  let data = null
  let derived = []
  let graph = null
  let resizeTimer = null

  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 2, range: ui.range, epic: ui.epic, status: ui.status, work: ui.work, view: ui.view, collapsed: ui.collapsed }))
    } catch {}
  }
  const set = (patch) => {
    Object.assign(ui, patch)
    save()
    render()
  }

  const detail = h('aside', { class: 'fl-detail', 'aria-label': 'Ticket detail' })
  document.body.append(detail)
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && ui.open && !root.hidden) closeDetail() })
  addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => { if (!root.closest('[hidden]') && data) render() }, 150)
  })

  const tickets = () => data?.tickets ?? []
  const epicOf = (key) => data?.epics.find((epic) => epic.key === key) ?? null
  const mrOf = (url) => data?.mrs.find((mr) => mr.url === url) ?? null
  const sessionOf = (id) => data?.sessions.find((item) => item.id === id) ?? null
  const channelOf = (id) => data?.channels?.find((channel) => channel.id === id) ?? { id, name: null }
  const channelLabel = (channel) => (channel?.name ? `#${channel.name}` : /^D/.test(channel?.id ?? '') ? 'Direct message' : channel?.id ? `Channel ${channel.id}` : 'Slack')

  function slackThreads() {
    if (ui.status === 'done' || !(ui.epic === 'all' || ui.epic.startsWith('slack:'))) return []
    const since = Date.now() - ui.range * DAY_MS
    const q = ui.query.trim().toLowerCase()
    return (data.threads ?? []).filter((thread) => Math.max(thread.lastActivityAt ?? 0, thread.at ?? 0) >= since
      && (ui.epic === 'all' || ui.epic === `slack:${thread.channel}`)
      && (!q || `${thread.title ?? ''} ${thread.author ?? ''} ${channelLabel(channelOf(thread.channel))}`.toLowerCase().includes(q)))
  }

  function shown() {
    const now = Date.now()
    derived = tickets().map((ticket) => deriveTicket(ticket, { now, work: ui.work }))
    return derived.filter((ticket) => inRange(ticket, ui.range, now) && matchesFilter(ticket, { epic: ui.epic, status: ui.status, query: ui.query, since: now - ui.range * DAY_MS }))
  }

  function statsFor(list) {
    if (ui.status !== 'working') return list
    const now = Date.now()
    return derived.filter((ticket) => ticket.mine && inRange(ticket, ui.range, now) && matchesFilter(ticket, { epic: ui.epic, query: ui.query }))
  }

  function seg(items, current, onPick, label) {
    return h('div', { class: 'seg', role: 'group', 'aria-label': label }, items.map(([value, text]) => h('button', { type: 'button', 'aria-pressed': String(String(current) === String(value)), onclick: () => onPick(value) }, text)))
  }

  function head() {
    const syncing = data?.refreshing || ui.busy
    const parts = []
    if (syncing) parts.push('Syncing…')
    else if (data?.fetchedAt) parts.push(`Synced ${ago(data.fetchedAt)}`)
    if (data?.jira) parts.push(`Jira: ${data.jira.email}`)
    if (!data?.gitlab) parts.push('GitLab off (set GITLAB_HOST)')
    return h('div', { class: 'page-head' },
      h('h2', {}, 'Lifecycle'),
      h('div', { class: 'head-controls' },
        h('span', { class: 'fl-sync' }, h('span', { class: `fl-dot${syncing ? ' busy' : data?.error ? ' bad' : ''}` }), parts.join(' · ')),
        data?.configured ? h('button', { class: 'btn', type: 'button', onclick: () => set({ setup: !ui.setup }) }, 'Jira settings') : null,
        h('button', { class: 'btn', type: 'button', disabled: syncing || null, onclick: syncNow }, 'Sync now')))
  }

  async function syncNow() {
    ui.busy = true
    render()
    const result = await postJson('/api/flow/sync', {})
    ui.busy = false
    if (result.ok) update(result.data)
    else render()
  }

  function errors() {
    const out = []
    if (data?.error) out.push(h('div', { class: 'fl-callout bad' }, `Jira sync failed: ${data.error}`))
    if (data?.gitlabError) out.push(h('div', { class: 'fl-callout' }, `GitLab: ${data.gitlabError}`))
    return out
  }

  function setupCard() {
    const jira = data?.jira
    const form = h('form', { class: 'fl-setup', autocomplete: 'off' })
    const field = (label, input, hint) => h('label', { class: 'fl-field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null)
    const baseUrl = h('input', { class: 'field', name: 'baseUrl', placeholder: 'https://your-site.atlassian.net', value: jira?.baseUrl ?? '', required: true })
    const email = h('input', { class: 'field', name: 'email', type: 'email', placeholder: 'you@example.com', value: jira?.email ?? '', required: true })
    const token = h('input', { class: 'field', name: 'token', type: 'password', placeholder: jira ? 'Leave empty to keep the saved token' : 'Jira API token', required: !jira })
    const jql = h('textarea', { class: 'field', name: 'jql', rows: 2, placeholder: 'assignee = currentUser() AND (statusCategory != Done OR resolved >= -180d) ORDER BY updated DESC' })
    jql.value = jira && jira.jql && !jira.jql.startsWith('assignee = currentUser() AND (statusCategory != Done OR resolved >= -180d)') ? jira.jql : ''
    const review = h('input', { class: 'field', name: 'reviewStatus', placeholder: 'review|merge' })
    const note = h('div', { class: 'fl-form-note', role: 'status' }, ui.message ?? '')
    form.append(
      h('h3', {}, jira ? 'Jira settings' : 'Connect Jira'),
      h('p', { class: 'fl-sub' }, 'The page reads your tickets, their status and sprint history, and the merge requests GitLab linked to them. The token is kept in data/jira.json on this Mac, readable only by you. Jira Cloud only.'),
      field('Jira site', baseUrl),
      field('Email', email),
      field('API token', token, h('span', {}, 'Create one at ', h('a', { href: TOKEN_HELP, target: '_blank', rel: 'noopener' }, 'id.atlassian.com'), '.')),
      field('Tickets to show (JQL, optional)', jql, 'Empty uses your open tickets and the ones resolved in the last 180 days.'),
      field('Review status pattern (optional)', review, 'A regular expression for the Jira status that means review or merge.'),
      note,
      h('div', { class: 'fl-actions' },
        h('button', { class: 'btn primary', type: 'submit' }, jira ? 'Save' : 'Connect'),
        jira ? h('button', { class: 'btn', type: 'button', onclick: () => set({ setup: false, message: null }) }, 'Cancel') : null,
        jira && !jira.fromEnv ? h('button', { class: 'btn danger', type: 'button', onclick: disconnect }, 'Disconnect') : null),
      jira?.fromEnv ? h('p', { class: 'fl-sub' }, 'JIRA_API_TOKEN is set in the environment, so it wins over what you save here.') : null,
    )
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      note.textContent = 'Checking with Jira…'
      const result = await postJson('/api/flow/jira', { baseUrl: baseUrl.value, email: email.value, token: token.value, jql: jql.value, reviewStatus: review.value })
      if (!result.ok) {
        note.textContent = result.data.error ?? 'Could not save.'
        return
      }
      ui.setup = false
      ui.message = null
      await reload()
    })
    return h('div', { class: 'fl-card' }, form)
  }

  async function disconnect() {
    await postJson('/api/flow/jira', { disconnect: true })
    ui.setup = false
    await reload()
  }

  function filters(list) {
    const epics = data.epics.filter((epic) => tickets().some((ticket) => ticket.epic === epic.key))
    const epicSelect = h('select', { class: 'field', 'aria-label': 'Epic', onchange: (event) => set({ epic: event.target.value }) },
      h('option', { value: 'all' }, 'All epics'),
      epics.map((epic) => h('option', { value: epic.key }, `${epic.key} · ${epic.title}`)),
      tickets().some((ticket) => !ticket.epic) ? h('option', { value: 'null' }, 'No epic') : null,
      (data.channels ?? []).length ? h('optgroup', { label: 'Slack channels' }, data.channels.map((channel) => h('option', { value: `slack:${channel.id}` }, `Slack · ${channelLabel(channel)}`))) : null)
    epicSelect.value = ui.epic
    const query = h('input', { class: 'field', type: 'search', placeholder: 'Filter by key or title', value: ui.query, 'aria-label': 'Filter tickets' })
    query.addEventListener('input', () => {
      ui.query = query.value
      const caret = query.selectionStart
      render()
      const again = root.querySelector('.fl-filters input[type=search]')
      again?.focus()
      again?.setSelectionRange(caret, caret)
    })
    const mrCount = new Set(list.flatMap((ticket) => ticket.mrs)).size
    const sessionCount = new Set(list.flatMap((ticket) => ticket.sessions)).size
    return h('div', { class: 'fl-filters' },
      seg(RANGES.map((days) => [days, `${days} days`]), ui.range, (value) => set({ range: Number(value) }), 'Range'),
      epicSelect,
      ui.epic === 'all' ? null : h('button', { class: 'fl-pill', type: 'button', title: 'Show every epic', onclick: () => set({ epic: 'all' }) }, ui.epic === 'null' ? 'No epic' : ui.epic.startsWith('slack:') ? `Slack: ${channelLabel(channelOf(ui.epic.slice(6)))}` : `Epic: ${ui.epic}${epicOf(ui.epic) ? ` · ${epicOf(ui.epic).title}` : ''}`, h('span', { class: 'fl-pill-x', 'aria-hidden': 'true' }, '×')),
      seg(STATUSES, ui.status, (value) => set({ status: value }), 'Status'),
      h('label', { class: 'fl-check' }, h('input', { type: 'checkbox', checked: ui.work || null, onchange: (event) => set({ work: event.target.checked }) }), 'Working days only'),
      query,
      h('span', { class: 'fl-counts' }, `${plural(list.length, 'ticket')} · ${plural(mrCount, 'MR')} · ${plural(sessionCount, 'session')}`))
  }

  function views() {
    return h('nav', { class: 'fl-views' }, VIEWS.map(([value, text]) => h('button', { type: 'button', 'aria-pressed': String(ui.view === value), onclick: () => set({ view: value }) }, text)))
  }

  function kpis(list) {
    return h('div', { class: 'fl-kpis' }, kpiValues(list, ui.work).map((kpi) => h('div', { class: 'fl-kpi' },
      h('div', { class: 'fl-kpi-l' }, `${kpi.label} · ${kpi.hint}`),
      h('div', { class: 'fl-kpi-v' }, kpi.median == null ? '—' : fmtSpan(kpi.median)),
      h('div', { class: 'fl-kpi-s' }, `median of ${plural(kpi.n, 'ticket')}`, kpi.slowest ? [' · slowest ', h('b', {}, kpi.slowest.key), ` ${fmtSpan(kpi.slowest.ms)}`] : null))))
  }

  function gapChart(list) {
    const host = h('div', { class: 'fl-gapchart' })
    const card = h('div', { class: 'fl-card' },
      h('h3', {}, 'Where the time goes'),
      h('p', { class: 'fl-sub' }, 'Median time to reach each step from the step before it. The thin line runs to the 75th percentile, and the slowest step is highlighted. Steps a ticket skipped or did not need fall through to the step before.', ui.status === 'working' ? ` With My working, the numbers above and this chart use all your tickets in the last ${ui.range} days, done ones included, so there is history to measure.` : ''),
      host)
    requestAnimationFrame(() => drawGapChart(host, gapRows(list)))
    return card
  }

  function drawGapChart(host, rows) {
    const width = host.clientWidth || 800
    const left = 170
    const right = 130
    const rowH = 30
    const top = 6
    const height = top + rows.length * rowH + 24
    const max = Math.max(DAY_MS, ...rows.map((row) => row.p75 ?? 0))
    const stepDays = Math.max(1, Math.ceil(max / DAY_MS / 8))
    const x = (ms) => left + (ms / max) * (width - left - right)
    const worst = rows.reduce((best, row) => (row.median != null && (!best || row.median > best.median) ? row : best), null)
    const svg = s('svg', { width, height, role: 'img', 'aria-label': 'Median time to reach each step' })
    for (let d = 0; d * DAY_MS <= max; d += stepDays) {
      svg.append(s('line', { x1: x(d * DAY_MS), x2: x(d * DAY_MS), y1: top - 2, y2: height - 20, class: 'fl-grid' }))
      svg.append(s('text', { x: x(d * DAY_MS), y: height - 6, 'text-anchor': 'middle', class: 'fl-axis' }, d ? `${d}d` : '0'))
    }
    rows.forEach((row, i) => {
      const cy = top + i * rowH + rowH / 2
      const group = s('g', { class: 'fl-gap-row' })
      group.append(s('rect', { x: 0, y: cy - rowH / 2, width, height: rowH, fill: 'transparent' }))
      group.append(s('text', { x: 0, y: cy + 4, class: 'fl-label' }, `→ ${row.label}`))
      if (row.median != null) {
        const x0 = x(0)
        const x1 = Math.max(x0 + 3, x(row.median))
        const r = Math.min(4, x1 - x0)
        const half = 7
        group.append(s('path', { class: `fl-gbar${row === worst ? ' worst' : ''}`, d: `M${x0},${cy - half} H${x1 - r} Q${x1},${cy - half} ${x1},${cy - half + r} V${cy + half - r} Q${x1},${cy + half} ${x1 - r},${cy + half} H${x0} Z` }))
        const xp = x(row.p75)
        if (xp > x1 + 1) {
          group.append(s('line', { x1: x1 + 1, x2: xp, y1: cy, y2: cy, class: 'fl-whisker' }))
          group.append(s('line', { x1: xp, x2: xp, y1: cy - 5, y2: cy + 5, class: 'fl-whisker' }))
        }
        const label = s('text', { x: Math.max(x1, xp) + 8, y: cy + 4, class: 'fl-value' }, fmtSpan(row.median), s('tspan', { class: 'fl-n', dx: 6 }, `n ${row.n}`))
        group.append(label)
      } else group.append(s('text', { x: x(0) + 4, y: cy + 4, class: 'fl-axis' }, 'no ticket has both steps yet'))
      attachTip(group, () => (row.median == null
        ? { heading: 'No data', text: `→ ${row.label}`, rows: [] }
        : { heading: `${fmtSpan(row.median)} median`, text: `→ ${row.label}, from ${row.froms.join(' or ')}`, rows: [['75th percentile', fmtSpan(row.p75)], ['Tickets', String(row.n)], ['Slowest', `${row.slowest.key}, ${fmtSpan(row.slowest.ms)}`]] }))
      svg.append(group)
    })
    host.replaceChildren(svg)
  }

  function legend() {
    return h('div', { class: 'fl-legend' },
      PHASES.map((phase) => h('span', {}, h('i', { style: `background:${phaseVar(phase.id)}` }), h('b', {}, phase.label), ` ${phase.hint}`)),
      h('span', {}, h('i', { class: 'hatch' }), 'Still waiting'),
      h('span', {}, h('i', { class: 'today' }), 'Today'))
  }

  function scaleFor(list, width) {
    const earliest = Math.min(...list.map((ticket) => ticket.steps.created?.at ?? Date.now()))
    const start = new Date(Math.max(earliest, Date.now() - ui.range * DAY_MS))
    start.setHours(0, 0, 0, 0)
    const end = Date.now() + DAY_MS * 0.6
    return { start: start.getTime(), end, x: (ms) => ((ms - start.getTime()) / (end - start.getTime())) * width }
  }

  function drawAxis(host, list) {
    const width = host.clientWidth
    if (!width || !list.length) return
    const { start, end, x } = scaleFor(list, width)
    const svg = s('svg', { width, height: 16 })
    const every = (width / ((end - start) / DAY_MS)) * 7 < 60 ? (width / ((end - start) / DAY_MS)) * 14 < 60 ? 28 : 14 : 7
    const tick = new Date(start)
    while (tick.getDay() !== 1) tick.setDate(tick.getDate() + 1)
    for (; tick.getTime() < end; tick.setDate(tick.getDate() + every)) {
      const tx = x(tick.getTime())
      if (tx < width - 60) svg.append(s('text', { x: tx, y: 11, 'text-anchor': tx < 24 ? 'start' : 'middle', class: 'fl-axis' }, day(tick.getTime())))
    }
    svg.append(s('text', { x: x(Date.now()), y: 11, 'text-anchor': 'end', class: 'fl-axis today' }, 'Today'))
    host.replaceChildren(svg)
  }

  function journey(ticket, list, width) {
    const { x } = scaleFor(list, width)
    const height = 22
    const svg = s('svg', { width, height, class: 'fl-journey' })
    svg.append(s('line', { x1: x(Date.now()), x2: x(Date.now()), y1: 0, y2: height, class: 'fl-today' }))
    for (const gap of [...ticket.gaps, ...(ticket.open ? [ticket.open] : [])]) {
      if (x(gap.b) < 2) continue
      const x0 = Math.max(0, x(gap.a))
      const x1 = Math.max(x0 + 2, x(gap.b) - (gap.open ? 0 : 2))
      const shape = gap.open
        ? s('rect', { x: x0, y: 6, width: x1 - x0, height: 10, rx: 2, fill: `url(#fl-hatch-${gap.phase})`, stroke: phaseVar(gap.phase), 'stroke-width': 1 })
        : s('rect', { x: x0, y: 6, width: x1 - x0, height: 10, rx: 2, fill: phaseVar(gap.phase), class: 'fl-seg' })
      const hit = s('rect', { x: x0, y: 0, width: Math.max(8, x1 - x0), height, fill: 'transparent' })
      attachTip(hit, () => ({
        heading: gap.open ? `${fmtSpan(gap.ms)} so far` : fmtSpan(gap.ms),
        text: `${STEP_LABEL[gap.from]} → ${STEP_LABEL[gap.to]}${gap.open ? ' (not reached yet)' : ''}`,
        rows: [['From', stamp(gap.a)], ['To', gap.open ? 'now' : stamp(gap.b)], ['Phase', phaseOf(gap.to).label]],
      }))
      svg.append(shape, hit)
    }
    if (ticket.steps.created?.at && x(ticket.steps.created.at) >= 0) svg.append(s('circle', { cx: x(ticket.steps.created.at), cy: 11, r: 2.5, class: 'fl-start' }))
    return svg
  }

  function ticketList(list) {
    const axisHost = h('span', { class: 'fl-axis-host' })
    const body = h('div', {})
    const card = h('div', { class: 'fl-card' },
      h('h3', {}, 'Tickets by epic'),
      h('p', { class: 'fl-sub' }, 'Each bar is one ticket on a shared calendar covering the chosen range, split into its phases. Click a ticket for its full timeline, sessions and merge requests.'),
      legend(),
      h('div', { class: 'fl-tk-head' }, h('span', {}, 'Ticket'), h('span', {}, 'Now'), axisHost, h('span', { class: 'num' }, 'Lead / age'), h('span', {}, 'Links')),
      body)
    requestAnimationFrame(() => {
      drawAxis(axisHost, list)
      body.replaceChildren(...ticketRows(list, axisHost.clientWidth))
    })
    return card
  }

  function ticketRows(list, width) {
    if (!list.length) return [h('p', { class: 'fl-sub' }, !data.tickets.length ? 'No tickets yet.' : ui.status === 'working' ? 'None of your tickets is in progress. In flight or All shows the rest.' : 'No tickets match these filters.')]
    const groups = new Map()
    for (const ticket of list) {
      const key = ticket.epic ?? 'null'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(ticket)
    }
    const order = [...groups.keys()].sort((a, b) => (a === 'null') - (b === 'null') || groups.get(b).filter((t) => !t.done).length - groups.get(a).filter((t) => !t.done).length || a.localeCompare(b))
    const out = []
    for (const key of order) {
      const rows = groups.get(key).sort((a, b) => (a.steps.created?.at ?? 0) - (b.steps.created?.at ?? 0))
      const epic = key === 'null' ? null : epicOf(key)
      const all = derived.filter((ticket) => String(ticket.epic) === key)
      const doneN = all.filter((ticket) => ticket.done).length
      const collapsed = ui.collapsed.includes(key)
      out.push(h('div', { class: 'fl-epic-row', onclick: () => set({ collapsed: collapsed ? ui.collapsed.filter((k) => k !== key) : [...ui.collapsed, key] }) },
        h('span', { class: `fl-caret${collapsed ? ' shut' : ''}` }, '▾'),
        epic ? [h('span', { class: 'fl-key' }, epic.key), h('span', { class: 'fl-epic-t' }, epic.title)] : h('span', { class: 'fl-epic-t' }, 'No epic'),
        epic ? [h('span', { class: 'fl-meter' }, h('span', { style: `width:${all.length ? (doneN / all.length) * 100 : 0}%` })), h('span', { class: 'fl-sub0' }, `${doneN} of ${all.length} done`)] : h('span', { class: 'fl-sub0' }, plural(all.length, 'ticket')),
        epic?.url ? h('a', { class: 'fl-ext', href: epic.url, target: '_blank', rel: 'noopener', onclick: (event) => event.stopPropagation() }, 'Jira ↗') : null))
      if (collapsed) continue
      for (const ticket of rows) {
        out.push(h('div', { class: `fl-tk-row${ui.open === ticket.key ? ' sel' : ''}`, role: 'button', tabindex: 0, onclick: () => openDetail(ticket.key), onkeydown: (event) => { if (event.key === 'Enter') openDetail(ticket.key) } },
          h('div', { class: 'fl-tk-main' },
            h('div', { class: 'fl-tk-title' }, h('span', { class: 'fl-key' }, ticket.key), ticket.title),
            h('div', { class: 'fl-tk-flags' }, ticket.flags.length ? ticket.flags.join(' · ') : [ticket.type, `Jira: ${ticket.status}`, !ticket.mine && ticket.assignee ? ticket.assignee : null].filter(Boolean).join(' · '))),
          h('div', { class: 'fl-now' }, h('span', { class: `fl-state ${ticket.state.tone}` }, ticket.state.label), ticket.done ? null : h('span', { class: 'fl-state-sub' }, ticket.state.sub)),
          h('div', {}, width ? journey(ticket, list, width) : null),
          h('div', { class: 'num' }, fmtSpan(ticket.lead)),
          h('div', { class: 'fl-links' }, h('span', { class: 'fl-chip' }, h('b', {}, ticket.mrs.length), ' MR'), h('span', { class: 'fl-chip' }, h('b', {}, ticket.sessions.length), ' sess'))))
      }
    }
    return out
  }

  function openDetail(key) {
    ui.open = key
    ui.adding = false
    renderDetail()
    root.querySelectorAll('.fl-tk-row').forEach((row) => row.classList.toggle('sel', row.querySelector('.fl-key')?.textContent === key))
  }

  function closeDetail() {
    ui.open = null
    detail.classList.remove('open')
    root.querySelectorAll('.fl-tk-row.sel').forEach((row) => row.classList.remove('sel'))
  }

  function stepRows(ticket) {
    const byTo = Object.fromEntries(ticket.gaps.map((gap) => [gap.to, gap]))
    if (ticket.open) byTo[ticket.open.to] = ticket.open
    const max = Math.max(DAY_MS, ...ticket.gaps.map((gap) => gap.ms), ticket.open?.ms ?? 0)
    const out = []
    STEPS.forEach((step, index) => {
      const gap = byTo[step.id]
      if (gap) {
        const width = Math.max(2, (gap.ms / max) * 200)
        const fill = gap.open ? `background:repeating-linear-gradient(135deg, ${phaseVar(gap.phase)} 0 2px, transparent 2px 5px);border:1px solid ${phaseVar(gap.phase)}` : `background:${phaseVar(gap.phase)}`
        out.push(h('div', { class: 'fl-gapline' }, h('span', { class: 'fl-rail' }),
          h('span', { class: 'fl-g' }, h('span', { class: 'fl-gb', style: `width:${width}px;${fill}` }), h('b', {}, fmtSpan(gap.ms)), gap.open ? ' so far' : '', gap.from !== STEPS[index - 1]?.id ? ` from ${STEP_LABEL[gap.from]}` : '')))
      }
      const value = ticket.steps[step.id]
      let cls = 'future'
      let when = ''
      let badge = null
      let note = value?.note ?? null
      if (value?.na) {
        cls = 'na'
        when = 'n/a'
      } else if (ticket.ooo.has(step.id)) {
        cls = 'ooo'
        when = stamp(value.at)
        badge = h('span', { class: 'fl-src ooo' }, 'Out of order')
        note = [note?.replace(/[.\s]*$/, '.'), 'Left out of the gaps because it is later than the steps after it.'].filter(Boolean).join(' ')
      } else if (Number.isFinite(value?.at)) {
        cls = 'done'
        when = stamp(value.at)
        badge = h('span', { class: `fl-src${value.inferred ? ' inf' : ''}` }, value.inferred ? 'Inferred' : SOURCE_LABEL[value.source] ?? value.source)
      } else if (ticket.next?.id === step.id) {
        cls = 'pending'
        when = 'next'
        if (step.id === 'deployed' && ticket.deployState) note = `Deploy check: ${ticket.deployState.state}${ticket.deployState.note ? `, ${ticket.deployState.note}` : ''}`
      }
      const typed = value && (value.source === 'manual' || value.source === 'skill') && step.id !== 'created'
      out.push(h('div', { class: `fl-step ${cls}` }, h('span', { class: 'fl-sdot' }),
        h('div', {}, h('div', {}, h('span', { class: 'fl-slabel' }, step.label), badge, typed ? h('button', { class: 'fl-clear', type: 'button', title: 'Remove this typed-in value', onclick: () => clearMilestone(ticket.key, step.id) }, '×') : null), note ? h('div', { class: 'fl-snote' }, note) : null),
        h('div', { class: 'fl-when' }, when)))
    })
    return out
  }

  async function clearMilestone(key, step) {
    await postJson('/api/flow/milestone', { ticket: key, step, clear: true })
    await reload()
  }

  function addForm(ticket) {
    if (!ui.adding) return h('button', { class: 'btn small', type: 'button', onclick: () => { ui.adding = true; renderDetail() } }, '+ Add a missing time')
    const step = h('select', { class: 'field' }, MILESTONE_STEPS.map((item) => h('option', { value: item.id }, item.label)))
    step.value = ticket.next?.id && ticket.next.id !== 'created' ? ticket.next.id : 'experiment'
    const when = h('input', { class: 'field', type: 'datetime-local', value: localInput(Date.now()) })
    const note = h('input', { class: 'field', placeholder: 'Note (optional)' })
    const na = h('input', { type: 'checkbox' })
    const status = h('span', { class: 'fl-form-note' })
    const form = h('form', { class: 'fl-add' },
      step, when, note,
      h('label', { class: 'fl-check' }, na, 'Not applicable'),
      h('div', { class: 'fl-actions' }, h('button', { class: 'btn primary small', type: 'submit' }, 'Save'), h('button', { class: 'btn small', type: 'button', onclick: () => { ui.adding = false; renderDetail() } }, 'Cancel'), status))
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const body = na.checked ? { ticket: ticket.key, step: step.value, na: true, note: note.value } : { ticket: ticket.key, step: step.value, at: new Date(when.value).getTime(), note: note.value }
      const result = await postJson('/api/flow/milestone', body)
      if (!result.ok) {
        status.textContent = result.data.error ?? 'Could not save.'
        return
      }
      ui.adding = false
      await reload()
    })
    return form
  }

  function renderDetail() {
    const ticket = derived.find((item) => item.key === ui.open)
    if (!ticket) {
      closeDetail()
      return
    }
    hideTip()
    const epic = ticket.epic ? epicOf(ticket.epic) : null
    const mrs = ticket.mrs.map(mrOf).filter(Boolean)
    const sessions = ticket.sessions.map(sessionOf).filter(Boolean)
    const cell = (label, value, exact = true) => h('div', {}, label, h('b', {}, value ? `${stamp(value)}${exact ? '' : '*'}` : '—'))
    detail.replaceChildren(
      h('button', { class: 'fl-x', type: 'button', 'aria-label': 'Close', onclick: closeDetail }, '×'),
      h('div', { class: 'fl-crumb' }, epic ? ['Epic ', epic.url ? h('a', { href: epic.url, target: '_blank', rel: 'noopener' }, epic.key) : epic.key, ` · ${epic.title}`] : 'No epic'),
      h('div', { class: 'fl-d-title' }, `${ticket.key} · ${ticket.title}`),
      h('div', { class: 'fl-d-chips' },
        h('span', { class: `fl-state ${ticket.state.tone}` }, ticket.done ? 'Done' : [ticket.state.label, ticket.state.sub ? ` · ${ticket.state.sub}` : '']),
        h('span', { class: 'fl-chip' }, ticket.type || 'Ticket'),
        h('span', { class: 'fl-chip' }, `Jira: ${ticket.status}`),
        h('span', { class: 'fl-chip' }, `${ticket.done ? 'Lead' : 'Age'} ${fmtSpan(ticket.lead)}`),
        ticket.url ? h('a', { class: 'btn small', href: ticket.url, target: '_blank', rel: 'noopener' }, 'Open in Jira ↗') : null,
        h('button', { class: 'btn small', type: 'button', onclick: () => { closeDetail(); set({ view: 'map', focus: `t:${ticket.key}`, trail: [] }) } }, 'Show in Map')),
      ...ticket.flags.map((flag) => h('div', { class: 'fl-callout' }, flag)),
      h('div', { class: 'fl-d-sec' }, h('h4', {}, 'Lifecycle'), stepRows(ticket), h('div', { class: 'fl-add-wrap' }, addForm(ticket))),
      h('div', { class: 'fl-d-sec' }, h('h4', {}, `Sessions (${sessions.length})`),
        sessions.length
          ? sessions.map((item) => h('div', { class: 'fl-sess' }, h('span', { class: `fl-sd ${item.status ?? ''}` }),
            h('div', { class: 'fl-sess-main' }, h('div', { class: 'fl-sess-t' }, item.title), h('div', { class: 'fl-sess-m' }, [item.project, ago(item.lastActivityAt), item.tickets.find((link) => link.key === ticket.key)?.why].filter(Boolean).join(' · '))),
            h('button', { class: 'btn small', type: 'button', onclick: () => openSession(item.id) }, 'Open')))
          : h('p', { class: 'fl-sub' }, 'No session has worked on this ticket yet. A session counts when its git branch has the key, it worked on one of the MRs, or it mentions the key.')),
      h('div', { class: 'fl-d-sec' }, h('h4', {}, `Merge requests (${mrs.length})`),
        mrs.length
          ? mrs.map((mr) => h('div', { class: 'fl-mr' },
            h('div', { class: 'fl-mr-top' }, h('a', { class: 'fl-ref', href: mr.url, target: '_blank', rel: 'noopener' }, mr.ref), h('span', { class: `fl-state ${tone(mr.state)}` }, mr.draft ? 'Draft' : mr.state === 'opened' ? 'Open' : mr.state === 'merged' ? 'Merged' : mr.state === 'closed' ? 'Closed' : 'Unknown')),
            mr.title ? h('div', { class: 'fl-mr-t' }, mr.title) : null,
            h('div', { class: 'fl-mini' }, cell('Created', mr.createdAt), cell('Approved', mr.approvedAt), cell('Merged', mr.mergedAt), cell('Deployed', mr.deploy?.state === 'live' ? mr.deploy.at : null, mr.deploy?.exact)),
            mr.deploy && mr.deploy.state !== 'live' ? h('div', { class: 'fl-via' }, `Deploy check: ${mr.deploy.state}${mr.deploy.note ? `, ${mr.deploy.note}` : ''}`) : null,
            mr.deploy?.state === 'live' && !mr.deploy.exact ? h('div', { class: 'fl-via' }, '* time of the deploy check') : null,
            h('div', { class: 'fl-via' }, `Linked by: ${mr.tickets.find((link) => link.key === ticket.key)?.why.join(' · ') ?? '—'}`)))
          : h('p', { class: 'fl-sub' }, 'No merge request yet. One shows up when Jira links it, or its branch or title has the ticket key.')),
    )
    detail.classList.add('open')
  }

  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1)
  const mrState = (mr) => (mr?.draft ? 'Draft' : mr?.state === 'opened' ? 'Open' : mr?.state === 'merged' ? (mr.deploy?.state === 'live' ? 'Deployed' : 'Merged') : mr?.state === 'closed' ? 'Closed' : 'Unknown')

  const INBOUND = { task: 'Started from', fork: 'Forked from', handoff: 'Picked up the handoff of', message: 'Messaged by' }
  const OUTBOUND = { task: 'Started sessions', fork: 'Forked into', handoff: 'Handed off to', message: 'Messaged' }
  function nodeText(g, node) {
    const ref = node.ref
    if (node.kind === 'epic') {
      const epic = ref ? epicOf(ref) : null
      const count = (g.children.get(node.id) ?? []).length
      return { key: epic?.key ?? ref, title: epic?.title ?? ref, meta: plural(count, 'ticket'), short: epic?.key ?? ref, open: epic?.url ? ['Open in Jira', () => window.open(epic.url, '_blank', 'noopener')] : null }
    }
    if (node.kind === 'channel') {
      const channel = channelOf(ref)
      const count = (g.children.get(node.id) ?? []).length
      return { key: 'Slack', title: channelLabel(channel), meta: plural(count, 'thread'), short: channelLabel(channel), open: channel.url ? ['Open in Slack', () => window.open(channel.url, '_blank', 'noopener')] : null }
    }
    if (node.kind === 'ticket') return { key: ref.key, title: ref.title, meta: ref.done ? `Done in ${fmtSpan(ref.lead)}` : `${ref.state.label} · ${ref.state.sub}`, short: ref.key, open: ['Ticket details', () => openDetail(ref.key)] }
    if (node.kind === 'thread') {
      const title = ref.title || `Thread from ${stamp(ref.at)}`
      return { key: `Slack · ${channelLabel(channelOf(ref.channel))}`, title, meta: [ref.author, `posted ${day(ref.at)}`].filter(Boolean).join(' · '), short: title, open: ref.url ? ['Open in Slack', () => window.open(ref.url, '_blank', 'noopener')] : null }
    }
    if (node.kind === 'session') {
      const edge = g.edges.find((item) => item.to === node.id && INBOUND[item.kind])
      const from = edge ? g.nodes.get(edge.from)?.ref?.title : null
      const why = edge ? `${INBOUND[edge.kind]} ${from ?? 'another session'}` : ref.tickets?.[0]?.why ?? ref.threads?.[0]?.why
      return { key: null, title: ref.title, meta: [ref.project, why].filter(Boolean).join(' · '), short: ref.title, open: ['Open session', () => openSession(ref.id)] }
    }
    return { key: ref.ref, title: ref.title || mrShort(ref.ref), meta: node.loose ? (ref.state === 'opened' ? 'Open' : ref.state) : mrState(ref), short: mrShort(ref.ref), open: ['Open in GitLab', () => window.open(ref.url, '_blank', 'noopener')] }
  }

  const MAX_LIST = 8
  const listOf = (items) => (items.length > MAX_LIST ? [...items.slice(0, MAX_LIST), `and ${items.length - MAX_LIST} more`] : items).join('\n')
  const when = (ms) => (ms ? `${stamp(ms)} (${ago(ms)})` : null)
  const nameOf = (g, id) => {
    const node = g.nodes.get(id)
    if (!node) return null
    const text = nodeText(g, node)
    return node.kind === 'session' ? text.title : text.key && text.key !== text.title && !String(text.key).startsWith('Slack') ? `${text.key} ${text.title}` : text.title
  }

  function detailOf(g, node, shown = null) {
    const ref = node.ref
    const text = nodeText(g, node)
    const rows = []
    const add = (label, value) => { if (value != null && value !== '' && !(Array.isArray(value) && !value.length)) rows.push([label, Array.isArray(value) ? listOf(value) : String(value)]) }
    const ups = g.edges.filter((edge) => edge.to === node.id)
    const downs = g.edges.filter((edge) => edge.from === node.id)
    let heading = text.title
    let line = capital(kindName(node.kind, 1))
    if (node.kind === 'epic') {
      const epic = epicOf(ref)
      line = `Epic ${ref}`
      add('Jira status', epic?.status)
      add('Tickets here', downs.map((edge) => g.nodes.get(edge.to)?.ref?.key).filter(Boolean))
    } else if (node.kind === 'channel') {
      line = 'Slack channel'
      add('Channel id', ref)
      add('Threads', downs.length)
    } else if (node.kind === 'ticket') {
      line = [ref.key, ref.type].filter(Boolean).join(' · ')
      add('Jira status', ref.status)
      add('Now', ref.done ? `Done in ${fmtSpan(ref.lead)}` : [ref.state.label, ref.state.sub].filter(Boolean).join(' · '))
      add('Assignee', ref.assignee)
      add('Epic', ref.epic ? [ref.epic, epicOf(ref.epic)?.title].filter(Boolean).join(' · ') : 'None')
      add('Created', when(ref.steps?.created?.at))
      add('Steps reached', (ref.reached ?? []).map((step) => STEP_LABEL[step.id] ?? step.id).join(', '))
      add('Flags', ref.flags)
      add('Sessions', (ref.sessions ?? []).length)
      add('MRs', (ref.mrs ?? []).map((url) => mrOf(url)?.ref ?? url))
    } else if (node.kind === 'thread') {
      heading = ref.title || `Thread from ${stamp(ref.at)}`
      line = `Slack thread in ${channelLabel(channelOf(ref.channel))}`
      add('Started by', ref.author)
      add('Posted', when(ref.at))
      add('Sessions', (ref.sessions ?? []).length)
    } else if (node.kind === 'session') {
      line = ['Session', ref.project, node.loose ? 'no ticket' : null].filter(Boolean).join(' · ')
      add('Status', isWorking(node.at) ? 'Working now' : ref.status)
      add('Started', when(ref.createdAt))
      add('Linked to tickets by', (ref.tickets ?? []).map((link) => `${link.key}: ${link.why}`))
      add('Slack', (ref.threads ?? []).map((link) => link.why))
      for (const edge of ups.filter((item) => INBOUND[item.kind])) add(INBOUND[edge.kind], nameOf(g, edge.from))
      for (const kind of Object.keys(OUTBOUND)) add(OUTBOUND[kind], downs.filter((edge) => edge.kind === kind).map((edge) => nameOf(g, edge.to)))
      add('MRs', (ref.mrs ?? []).map((url) => mrOf(url)?.ref ?? url))
    } else if (node.kind === 'mr') {
      line = ref.ref
      add('State', node.loose ? ref.state : mrState(ref))
      add('Author', ref.author)
      add('Created', when(ref.createdAt))
      add('Approved', when(ref.approvedAt))
      add('Merged', when(ref.mergedAt))
      add('Deployed', ref.deploy ? (ref.deploy.state === 'live' ? `${when(ref.deploy.at)}${ref.deploy.exact ? '' : ' (time of the check)'}` : `${ref.deploy.state}${ref.deploy.note ? `, ${ref.deploy.note}` : ''}`) : null)
      add('Tickets', (ref.tickets ?? []).map((link) => `${link.key}: ${link.why.join(', ')}`))
      add('Worked on by', ups.filter((edge) => g.nodes.get(edge.from)?.kind === 'session').map((edge) => nameOf(g, edge.from)))
    }
    add('Last activity', when(node.at))
    if (shown) add('Not on this path', [...(g.parents.get(node.id) ?? []), ...(g.children.get(node.id) ?? [])].filter((id) => !shown.has(id)).map((id) => nameOf(g, id)))
    return { heading, text: line, rows, wide: true }
  }

  function timeBadge(node, live = node.kind === 'session') {
    if (!node.at) return null
    const working = live && isWorking(node.at)
    const tip = node.kind === 'session' && node.ref.createdAt ? `Started ${stamp(node.ref.createdAt)} · Last activity ${stamp(node.at)}` : `Last activity ${stamp(node.at)}`
    return h('span', { class: `fl-ntime${working ? ' live' : ''}`, title: tip }, working ? 'Working now' : ago(node.at))
  }

  const focusOn = (id) => {
    if (id === ui.focus) return
    set({ trail: ui.focus ? [...ui.trail, ui.focus].slice(-20) : [], focus: id, linking: null })
  }
  const keyed = (fn) => (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fn() } }

  function linkBox(kind, id) {
    if (ui.linking !== `${kind}:${id}`) return h('button', { class: 'btn small', type: 'button', onclick: (event) => { event.stopPropagation(); set({ linking: `${kind}:${id}` }) } }, 'Link…')
    const select = h('select', { class: 'field', onclick: (event) => event.stopPropagation() }, data.tickets.map((ticket) => h('option', { value: ticket.key }, `${ticket.key} · ${ticket.title}`)))
    return h('div', { class: 'fl-linkbox', onclick: (event) => event.stopPropagation(), onkeydown: (event) => event.stopPropagation() }, select,
      h('button', { class: 'btn primary small', type: 'button', onclick: async () => { await postJson('/api/flow/link', { kind, id, ticket: select.value }); ui.linking = null; await reload() } }, 'Link'),
      h('button', { class: 'btn small', type: 'button', onclick: () => set({ linking: null }) }, 'Cancel'))
  }
  const looseLink = (node) => (!node.loose ? null : node.kind === 'session' ? linkBox('session', node.ref.id) : node.kind === 'mr' ? linkBox('mr', node.ref.url) : null)

  function mapCard(g, node, hidden, shown) {
    const text = nodeText(g, node)
    const time = timeBadge(node)
    const focused = node.id === ui.focus
    const go = () => focusOn(node.id)
    const open = text.open ? h('button', { class: 'fl-open', type: 'button', title: text.open[0], 'aria-label': text.open[0], onclick: (event) => { event.stopPropagation(); text.open[1]() } }, '↗') : null
    const more = hidden ? h('span', { class: 'fl-more', title: `${plural(hidden, 'linked item')} not on this path. Click the card to follow from here.` }, `+${hidden} more`) : null
    const card = h('div', { class: `fl-node k-${node.kind}${focused ? ' focus' : ''}${node.loose ? ' loose' : ''}${time?.classList.contains('live') ? ' working' : ''}`, 'data-id': node.id, role: 'button', tabindex: 0, onmouseenter: () => highlight(node.id), onmouseleave: () => highlight(null), onclick: go, onkeydown: keyed(go) },
      h('div', { class: 'fl-nhead' }, h('span', { class: `fl-kind k-${node.kind}` }, capital(kindName(node.kind, 1))), text.key && text.key !== 'Slack' ? h('span', { class: 'fl-nk' }, text.key) : null, open),
      h('div', { class: 'fl-nrow' }, h('div', { class: 'fl-nt' }, text.title), time),
      text.meta || more ? h('div', { class: 'fl-nrow' }, h('div', { class: 'fl-nm' }, text.meta), more) : null,
      focused ? looseLink(node) : null)
    return attachTip(card, () => detailOf(g, node, shown))
  }

  function focusView(g, wide = false) {
    const ids = lineage(g, ui.focus)
    const hidden = hiddenNeighbours(g, ids)
    const folded = foldLeaves(induced(g, ids), columns(g, ids), { keep: new Set([ui.focus]), open: new Set([...ui.folds].filter((key) => key.startsWith(`${ui.focus}|`)).map((key) => key.slice(ui.focus.length + 1))) })
    const cols = folded.cols
    const links = folded.edges
    graph = { links, parents: folded.parents, children: folded.children }
    const foldKey = (stack) => `${ui.focus}|${stack.id}`
    const toggleFold = (stack) => {
      ui.folds.has(foldKey(stack)) ? ui.folds.delete(foldKey(stack)) : ui.folds.add(foldKey(stack))
      ui.mapScroll = null
      render()
    }
    const foldCard = (stack) => {
      const members = stack.ids.map((id) => g.nodes.get(id))
      const newest = members.reduce((a, b) => (b.at > a.at ? b : a))
      const counts = new Map()
      if (stack.kind === 'mr') for (const node of members) counts.set(mrState(node.ref), (counts.get(mrState(node.ref)) ?? 0) + 1)
      const meta = stack.kind === 'mr' ? [...counts].sort((a, b) => b[1] - a[1]).map(([state, n]) => `${state} ${n}`).join(' · ') : `Latest: ${nodeText(g, newest).title}`
      const go = () => toggleFold(stack)
      const card = h('div', { class: `fl-node fl-fold k-${stack.kind}`, 'data-id': stack.id, role: 'button', tabindex: 0, onmouseenter: () => highlight(stack.id), onmouseleave: () => highlight(null), onclick: go, onkeydown: keyed(go) },
        h('div', { class: 'fl-nhead' }, h('span', { class: `fl-kind k-${stack.kind}` }, capital(kindName(stack.kind, members.length))), h('span', { class: 'fl-more fl-fold-open' }, 'Show all')),
        h('div', { class: 'fl-nrow' }, h('div', { class: 'fl-nt' }, `${members.length} ${kindName(stack.kind, members.length)} with nothing after them`), timeBadge({ ...newest, at: newest.at }, stack.kind === 'session')),
        h('div', { class: 'fl-nm' }, meta))
      return attachTip(card, () => ({ heading: `${members.length} ${kindName(stack.kind, members.length)} with nothing after them`, text: 'Show all lays them out one by one.', rows: [...members].sort((a, b) => b.at - a.at).slice(0, 12).map((member) => [ago(member.at), nameOf(g, member.id)]).concat(members.length > 12 ? [['', `and ${members.length - 12} more`]] : []), wide: true }))
    }
    const opened = (col) => [...folded.stacks.values()].filter((stack) => stack.open && stack.ids.some((id) => col.includes(id)))
    const colTitle = (col) => {
      const counts = new Map()
      for (const id of col) {
        const stack = folded.stacks.get(id)
        const kind = stack?.kind ?? g.nodes.get(id).kind
        counts.set(kind, (counts.get(kind) ?? 0) + (stack ? stack.ids.length : 1))
      }
      return KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => capital(kindName(kind, counts.get(kind)))).join(' · ')
    }
    const focusNode = g.nodes.get(ui.focus)
    const back = ui.trail.filter((id) => g.nodes.has(id)).at(-1)
    const kinds = new Set(links.map((edge) => edge.kind))
    const bar = h('div', { class: 'fl-focusbar' },
      h('button', { class: 'btn small', type: 'button', onclick: () => set({ focus: null, trail: [], linking: null }) }, '← All flows'),
      back ? h('button', { class: 'btn small', type: 'button', title: nodeText(g, g.nodes.get(back)).title, onclick: () => set({ focus: back, trail: ui.trail.slice(0, ui.trail.lastIndexOf(back)), linking: null }) }, `Back to ${nodeText(g, g.nodes.get(back)).short}`) : null,
      h('span', { class: 'fl-focus-name' }, `Following ${kindName(focusNode.kind, 1)} `, h('b', {}, nodeText(g, focusNode).short)),
      wide ? h('span', { class: 'fl-wide', title: 'The range, epic, status and text filters would hide it, so this view ignores them' }, 'Filters off for this one') : null,
      h('span', { class: 'fl-legend' }, Object.keys(SESSION_LINK_LABEL).filter((kind) => kinds.has(kind)).map((kind) => h('span', { class: 'fl-leg' }, s('svg', { width: 26, height: 8 }, s('path', { class: `fl-link k-${kind}`, d: 'M1,4 L25,4' })), `${capital(SESSION_LINK_LABEL[kind])}`))))
    const svg = s('svg', { class: 'fl-map-svg' })
    const flow = h('div', { class: 'fl-flowmap', style: `grid-template-columns: repeat(${cols.length}, 236px)` },
      cols.map((col) => h('div', { class: 'fl-fcol' }, h('h4', {}, colTitle(col)),
        h('div', { class: 'fl-fcol-body' },
          opened(col).map((stack) => h('button', { class: 'btn small fl-fold-btn', type: 'button', onclick: () => toggleFold(stack) }, `Fold the ${stack.ids.length} ${kindName(stack.kind, stack.ids.length)} with nothing after them`)),
          col.map((id) => (folded.stacks.has(id) ? foldCard(folded.stacks.get(id)) : mapCard(g, g.nodes.get(id), hidden.get(id), ids)))))))
    const wrap = h('div', { class: 'fl-map-wrap' }, svg, flow)
    const scroller = h('div', { class: 'fl-map-scroll' }, wrap)
    const at = ui.mapScroll?.focus === ui.focus ? ui.mapScroll : null
    scroller.addEventListener('scroll', () => { ui.mapScroll = { focus: ui.focus, top: scroller.scrollTop, left: scroller.scrollLeft } })
    requestAnimationFrame(() => {
      drawLinks(wrap, svg)
      if (at) {
        scroller.scrollTop = at.top
        scroller.scrollLeft = at.left
      } else {
        const card = wrap.querySelector(`[data-id="${CSS.escape(ui.focus)}"]`)
        if (card) {
          scroller.scrollLeft = Math.max(0, card.offsetLeft - (scroller.clientWidth - card.offsetWidth) / 2)
          scroller.scrollTop = Math.max(0, card.offsetTop - (scroller.clientHeight - card.offsetHeight) / 2)
        }
      }
    })
    return [bar, scroller]
  }

  function flowList(g) {
    graph = null
    const rows = flowRows(g)
    if (!rows.length) return [h('p', { class: 'fl-sub' }, ui.status === 'working' ? 'None of your tickets is in progress. In flight or All shows the rest.' : 'No tickets match these filters.')]
    const stepLabel = (step) => (step.ids.length === 1 ? nodeText(g, g.nodes.get(step.ids[0])).short : step.kinds.map(([kind, n]) => `${n} ${kindName(kind, n)}`).join(', '))
    const lone = rows.filter((row) => row.loose && row.ids.size === 1)
    const loneRow = (row) => {
      const node = g.nodes.get(row.anchor)
      const text = nodeText(g, node)
      return attachTip(h('div', { class: 'fl-lone', 'data-id': node.id },
        h('span', { class: `fl-kind k-${node.kind}` }, capital(kindName(node.kind, 1))),
        text.key ? h('span', { class: 'fl-nk' }, text.key) : null,
        h('span', { class: 'fl-flow-t' }, text.title),
        timeBadge(node),
        text.open ? h('button', { class: 'fl-open', type: 'button', title: text.open[0], 'aria-label': text.open[0], onclick: () => text.open[1]() }, '↗') : null,
        looseLink(node)), () => detailOf(g, node))
    }
    const list = h('div', { class: 'fl-flows' }, rows.filter((row) => !lone.includes(row)).map((row) => {
      const anchor = g.nodes.get(row.anchor)
      const text = nodeText(g, anchor)
      const live = [...row.ids].some((id) => g.nodes.get(id).kind === 'session' && isWorking(g.nodes.get(id).at))
      const steps = shape(g, row.ids)
      const go = () => focusOn(row.anchor)
      return attachTip(h('div', { class: `fl-flow${row.loose ? ' loose' : ''}${live ? ' working' : ''}`, role: 'button', tabindex: 0, onclick: go, onkeydown: keyed(go) },
        h('div', { class: 'fl-flow-top' }, h('span', { class: `fl-kind k-${anchor.kind}` }, capital(kindName(anchor.kind, 1))), text.key && text.key !== 'Slack' ? h('span', { class: 'fl-nk' }, text.key) : null, h('span', { class: 'fl-flow-t' }, text.title), timeBadge({ ...anchor, at: row.at }, live)),
        h('div', { class: 'fl-flow-shape' }, steps.map((step, i) => [i ? h('span', { class: 'fl-arrow', 'aria-hidden': 'true' }, '→') : null, h('span', { class: `fl-chip k-${step.kinds.length === 1 ? step.kinds[0][0] : 'mixed'}` }, stepLabel(step))]),
          h('span', { class: 'fl-flow-tags' },
            row.groups.map((id) => h('button', { class: 'fl-tag', type: 'button', title: `Follow everything under ${nodeText(g, g.nodes.get(id)).title}`, onclick: (event) => { event.stopPropagation(); focusOn(id) } }, `${capital(kindName(g.nodes.get(id).kind, 1))} ${nodeText(g, g.nodes.get(id)).short}`)),
            anchor.loose ? looseLink(anchor) : null))), () => detailOf(g, anchor))
    }), lone.length ? [h('div', { class: 'fl-map-sep' }, 'Recent sessions and your MRs with no ticket'), h('div', { class: 'fl-lones' }, lone.map(loneRow))] : null)
    const scroller = h('div', { class: 'fl-map-scroll' }, list)
    const at = ui.mapScroll?.focus === null ? ui.mapScroll : null
    scroller.addEventListener('scroll', () => { ui.mapScroll = { focus: null, top: scroller.scrollTop, left: 0 } })
    if (at) requestAnimationFrame(() => { scroller.scrollTop = at.top })
    return [scroller]
  }

  function mapView(list) {
    const graphOf = (tickets, threads) => mapGraph({ tickets, threads, sessions: data.sessions, sessionLinks: data.sessionLinks ?? [], mrs: data.mrs, looseSessions: data.loose.sessions, looseMrs: data.loose.mrs })
    let g = graphOf(list, slackThreads())
    let wide = false
    if (ui.focus && !g.nodes.has(ui.focus)) {
      const all = graphOf(derived, data.threads ?? [])
      if (all.nodes.has(ui.focus)) [g, wide] = [all, true]
    }
    const focused = ui.focus && g.nodes.has(ui.focus)
    if (ui.focus && !focused && /^[sm]:/.test(ui.focus)) return unmapped(ui.focus)
    return h('div', { class: 'fl-card' },
      h('h3', {}, focused ? 'How this piece of work flowed' : 'Flows'),
      h('p', { class: 'fl-sub' }, focused
        ? 'What led here is to the left, what came from it to the right, in the order it happened. Sessions that started, forked, handed off to or messaged another session chain on to it. Click any card to follow the flow from there, or ↗ to open it. +N more means linked items that are not on this path.'
        : 'One row per piece of work, latest first: the ticket or Slack thread it started from, then each step that came out of it. Click a row to follow it, or an epic or channel tag to see everything under it. Dashed rows have no ticket, and Link… attaches one by hand.'),
      ...(focused ? focusView(g, wide) : flowList(g)))
  }

  function unmapped(focus) {
    const session = focus.startsWith('s:')
    const id = focus.slice(2)
    return h('div', { class: 'fl-card' },
      h('h3', {}, session ? 'This session is not on the map yet' : 'This merge request is not on the map yet'),
      h('p', { class: 'fl-sub' }, session
        ? 'It has no ticket, Slack thread or linked session, and it is not one of the recent sessions with no ticket. A session joins the map when its git branch has a ticket key, it works on a ticket\'s MR, it mentions a key at least twice, it reads a Slack thread, or another session started, forked, handed off to or messaged it.'
        : 'No ticket, Slack thread or session leads to it, and it is not one of your ten newest open MRs with no ticket. An MR joins the map when Jira links it, its branch or title has a ticket key, or a session on the map worked on it.'),
      h('div', { class: 'fl-focusbar' },
        h('button', { class: 'btn small', type: 'button', onclick: () => set({ focus: null, trail: [], linking: null }) }, '← All flows'),
        session ? h('button', { class: 'btn small', type: 'button', onclick: () => openSession(id) }, 'Back to the session') : h('a', { class: 'btn small', href: id, target: '_blank', rel: 'noopener' }, 'Open in GitLab ↗'),
        linkBox(session ? 'session' : 'mr', id)))
  }

  function show(id) {
    hideTip()
    closeDetail()
    Object.assign(ui, { view: 'map', focus: id, trail: [], linking: null, mapScroll: null })
    save()
    if (data) render()
  }

  function drawLinks(wrap, svg) {
    if (!graph || !wrap.isConnected) return
    const box = wrap.getBoundingClientRect()
    svg.setAttribute('width', box.width)
    svg.setAttribute('height', box.height)
    const rect = (id) => wrap.querySelector(`[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect()
    svg.replaceChildren(...graph.links.flatMap(({ from, to, kind }) => {
      const ra = rect(from)
      const rb = rect(to)
      if (!ra || !rb) return []
      const x1 = ra.right - box.left
      const y1 = ra.top + ra.height / 2 - box.top
      const x2 = rb.left - box.left
      const y2 = rb.top + rb.height / 2 - box.top
      const dx = Math.max(24, (x2 - x1) / 2)
      const path = s('path', { class: `fl-link k-${kind}`, 'data-a': from, 'data-b': to, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` })
      const label = SESSION_LINK_LABEL[kind]
      return label ? [path, s('text', { class: `fl-link-label k-${kind}`, 'data-a': from, 'data-b': to, x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 5, 'text-anchor': 'middle' }, label)] : [path]
    }))
  }

  function highlight(id) {
    const wrap = root.querySelector('.fl-map-wrap')
    if (!wrap || !graph) return
    if (!id) {
      wrap.querySelectorAll('.fl-node').forEach((node) => node.classList.remove('dim', 'hl'))
      wrap.querySelectorAll('.fl-link, .fl-link-label').forEach((link) => link.classList.remove('dim', 'hl'))
      return
    }
    const lit = new Set([id])
    const walk = (map) => {
      const stack = [id]
      while (stack.length) for (const next of map.get(stack.pop()) ?? []) if (!lit.has(next)) { lit.add(next); stack.push(next) }
    }
    walk(graph.parents)
    walk(graph.children)
    wrap.querySelectorAll('.fl-node').forEach((node) => {
      node.classList.toggle('dim', !lit.has(node.dataset.id))
      node.classList.toggle('hl', node.dataset.id === id)
    })
    wrap.querySelectorAll('.fl-link, .fl-link-label').forEach((link) => {
      const on = lit.has(link.dataset.a) && lit.has(link.dataset.b)
      link.classList.toggle('hl', on)
      link.classList.toggle('dim', !on)
    })
  }

  function howView() {
    const row = (...cells) => h('tr', {}, cells.map((cell) => h('td', {}, cell)))
    return h('div', { class: 'fl-how' },
      h('div', { class: 'fl-card' },
        h('h3', {}, 'How each step gets its time'),
        h('p', { class: 'fl-sub' }, 'When a ticket has several MRs, MR created uses the first one, and approved, merged and deployed wait for the last one. Inferred times are marked on the ticket. A step that is later than the steps after it is flagged out of order and left out of the gaps.'),
        h('table', { class: 'fl-table' },
          h('tr', {}, h('th', {}, 'Step'), h('th', {}, 'Rule'), h('th', {}, 'If it is missing')),
          row('Created', 'Jira created time', 'Never missing'),
          row('In sprint', 'First time the Sprint field was set, or the sprint start if that was later', 'Skipped'),
          row('In progress', 'First move into an In Progress status that is not a review status', 'First session on the ticket (inferred)'),
          row('MR created', 'Earliest created time of the linked MRs', 'n/a when a done ticket had no MR'),
          row('Review / merge', 'First move into a status matching the review pattern (default review|merge)', 'First "Ready for review" label, the MR leaving draft, or an MR opened ready (inferred)'),
          row('MR approved', 'Last approval on the linked MRs', 'Not reached yet'),
          row('MR merged', 'Merge time of the last linked MR', 'Not reached yet'),
          row('MR deployed', 'deployedAt from /csb-check-deploy', 'Time of the check (inferred), or its state, such as Deploy waiting'),
          row('Experiment started', 'POST /api/flow/milestone from a skill, or typed in on the ticket', 'n/a'),
          row('Done', 'Last move into a Done status', 'Not reached yet'))),
      h('div', { class: 'fl-card' },
        h('h3', {}, 'How things get linked'),
        h('table', { class: 'fl-table' },
          h('tr', {}, h('th', {}, 'Link'), h('th', {}, 'Found by')),
          row('Epic → ticket', 'The Jira parent'),
          row('Ticket → MR', 'MR links GitLab wrote on the ticket, then the key in the MR branch, then the first key in the MR title'),
          row('Ticket → session', 'The key in the session\'s git branch, then the session working on one of the ticket\'s MRs, then the key mentioned at least twice (top three keys only)'),
          row('Session → session', 'Claude desktop\'s record that a session was started as a task from, or forked from, another one; a handoff document one session wrote and the next one was told to read; or messages one session sent to another. A ticket line to a session that is already reached through another session is left out, so the chain shows.'),
          row('Slack thread → session', 'A Slack link you pasted into a prompt, or a thread the session read with the Slack tools. The thread title is its first message; channel names come from Slack text the sessions saw. MRs those sessions worked on follow the thread.'),
          row('Anything else', 'Link… on the Map, saved in data/flow-links.json')),
        h('h3', { style: 'margin-top:16px' }, 'Reporting a time from a skill'),
        h('pre', { class: 'fl-pre' }, `curl -s -X POST http://localhost:4747/api/flow/milestone \\
  -H 'content-type: application/json' -H 'origin: http://localhost:4747' \\
  -d '{"ticket":"ABC-123","step":"experiment","at":"2026-05-04T09:00:00Z","note":"Run 42 started","source":"skill"}'`)))
  }

  function hatchDefs() {
    return s('svg', { width: 0, height: 0, class: 'fl-defs', 'aria-hidden': 'true' }, s('defs', {}, PHASES.map((phase) => s('pattern', { id: `fl-hatch-${phase.id}`, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, s('rect', { width: 2, height: 5, fill: phaseVar(phase.id) })))))
  }

  function render() {
    hideTip()
    if (!data) {
      root.replaceChildren(h('div', { class: 'page-head' }, h('h2', {}, 'Lifecycle')), h('p', { class: 'fl-sub' }, 'Loading…'))
      return
    }
    if (!data.configured || ui.setup) {
      root.replaceChildren(head(), ...errors(), setupCard())
      if (!data.configured) detail.classList.remove('open')
      return
    }
    const list = shown()
    const body = []
    if (ui.view === 'overview') body.push(kpis(statsFor(list)), gapChart(statsFor(list)), ticketList(list))
    if (ui.view === 'map') body.push(mapView(list))
    if (ui.view === 'how') body.push(howView())
    const empty = !data.tickets.length && !data.refreshing ? h('div', { class: 'fl-callout' }, 'Jira returned no tickets for your JQL. Check it in Jira settings.') : null
    root.replaceChildren(...[hatchDefs(), head(), ...errors(), empty, filters(list), views(), ...body].filter(Boolean))
    if (ui.open && !ui.adding) renderDetail()
  }

  function update(next) {
    data = next
    const typing = document.activeElement?.closest?.('.fl-setup, .fl-linkbox, .fl-add')
    if (typing && root.contains(typing)) return
    if (typing && detail.contains(typing)) return
    render()
  }

  function leave() {
    closeDetail()
    hideTip()
  }

  render()
  return { update, render, leave, show, busy: () => ui.busy || Boolean(data?.refreshing) }
}
