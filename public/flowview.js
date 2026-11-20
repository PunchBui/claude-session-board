import { STEPS, STEP_LABEL, PHASES, phaseOf, SOURCE_LABEL, deriveTicket, gapRows, kpiValues, inRange, matchesFilter, fmtSpan, DAY_MS } from './flow.js'
import { attachTip, hideTip } from './tip.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const RANGES = [30, 90, 180]
const STATUSES = [['all', 'All'], ['active', 'In flight'], ['done', 'Done']]
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
  const ui = { range: 30, epic: 'all', status: 'all', work: false, query: '', view: 'overview', open: null, hl: null, setup: false, adding: false, linking: null, collapsed: [], busy: false, message: null }
  try { Object.assign(ui, JSON.parse(localStorage.getItem(STORE_KEY) || '{}'), { open: null, hl: null, setup: false, adding: false, linking: null, busy: false, message: null }) } catch {}
  let data = null
  let derived = []
  let graph = null
  let resizeTimer = null

  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ range: ui.range, epic: ui.epic, status: ui.status, work: ui.work, view: ui.view, collapsed: ui.collapsed }))
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

  function shown() {
    const now = Date.now()
    derived = tickets().map((ticket) => deriveTicket(ticket, { now, work: ui.work }))
    return derived.filter((ticket) => inRange(ticket, ui.range, now) && matchesFilter(ticket, { epic: ui.epic, status: ui.status, query: ui.query }))
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
      tickets().some((ticket) => !ticket.epic) ? h('option', { value: 'null' }, 'No epic') : null)
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
      seg(STATUSES, ui.status, (value) => set({ status: value }), 'Status'),
      h('label', { class: 'fl-check' }, h('input', { type: 'checkbox', checked: ui.work || null, onchange: (event) => set({ work: event.target.checked }) }), 'Working days only'),
      query,
      h('span', { class: 'fl-counts' }, `${plural(list.length, 'ticket')} · ${plural(mrCount, 'MR')} · ${plural(sessionCount, 'session')}`))
  }

  function views() {
    return h('nav', { class: 'fl-views' }, VIEWS.map(([value, text]) => h('button', { type: 'button', 'aria-pressed': String(ui.view === value), onclick: () => set({ view: value, hl: null }) }, text)))
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
      h('p', { class: 'fl-sub' }, 'Median time to reach each step from the step before it. The thin line runs to the 75th percentile, and the slowest step is highlighted. Steps a ticket skipped or did not need fall through to the step before.'),
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
    if (!list.length) return [h('p', { class: 'fl-sub' }, data.tickets.length ? 'No tickets match these filters.' : 'No tickets yet.')]
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
            h('div', { class: 'fl-tk-flags' }, ticket.flags.length ? ticket.flags.join(' · ') : `${ticket.type} · Jira: ${ticket.status}`)),
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
        h('button', { class: 'btn small', type: 'button', onclick: () => { closeDetail(); set({ view: 'map', hl: `t:${ticket.key}` }) } }, 'Show in Map')),
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

  function mapView(list) {
    const keys = new Set(list.map((ticket) => ticket.key))
    const epics = []
    for (const ticket of list) if (!epics.includes(ticket.epic ?? null)) epics.push(ticket.epic ?? null)
    epics.sort((a, b) => (a === null) - (b === null) || String(a).localeCompare(String(b)))
    const ordered = [...list].sort((a, b) => epics.indexOf(a.epic ?? null) - epics.indexOf(b.epic ?? null) || (a.steps.created?.at ?? 0) - (b.steps.created?.at ?? 0))
    const ticketIndex = new Map(ordered.map((ticket, i) => [ticket.key, i]))
    const mrUrls = []
    for (const ticket of ordered) for (const url of ticket.mrs) if (!mrUrls.includes(url) && mrOf(url)) mrUrls.push(url)
    const sessions = data.sessions.filter((item) => item.tickets.some((link) => keys.has(link.key)))
    const firstTicket = (item) => Math.min(...item.tickets.filter((link) => keys.has(link.key)).map((link) => ticketIndex.get(link.key)))
    const firstMr = (item) => Math.min(mrUrls.length, ...item.mrs.map((url) => mrUrls.indexOf(url)).filter((i) => i >= 0))
    sessions.sort((a, b) => firstTicket(a) - firstTicket(b) || firstMr(a) - firstMr(b))
    const links = []
    for (const ticket of ordered) links.push([`e:${ticket.epic ?? 'none'}`, `t:${ticket.key}`])
    const viaSession = new Set()
    for (const item of sessions) {
      for (const link of item.tickets) if (keys.has(link.key)) links.push([`t:${link.key}`, `s:${item.id}`])
      for (const url of item.mrs) if (mrUrls.includes(url)) {
        links.push([`s:${item.id}`, `m:${url}`])
        viaSession.add(url)
      }
    }
    for (const ticket of ordered) for (const url of ticket.mrs) if (mrUrls.includes(url) && !viaSession.has(url)) links.push([`t:${ticket.key}`, `m:${url}`])
    const parents = new Map()
    const children = new Map()
    for (const [a, b] of links) {
      if (!children.has(a)) children.set(a, [])
      children.get(a).push(b)
      if (!parents.has(b)) parents.set(b, [])
      parents.get(b).push(a)
    }
    graph = { links, parents, children }

    const node = (id, cls, key, title, meta, onclick) => h('div', { class: `fl-node ${cls}`, 'data-id': id, onmouseenter: () => highlight(id), onmouseleave: () => highlight(ui.hl), onclick },
      key ? h('div', { class: 'fl-nk' }, key) : null, h('div', { class: 'fl-nt' }, title), meta ? h('div', { class: 'fl-nm' }, meta) : null)
    const col = (title, ...kids) => h('div', { class: 'fl-map-col' }, h('h4', {}, title), ...kids)
    const linkBox = (kind, id) => {
      if (ui.linking !== `${kind}:${id}`) return h('button', { class: 'btn small', type: 'button', onclick: (event) => { event.stopPropagation(); set({ linking: `${kind}:${id}` }) } }, 'Link…')
      const select = h('select', { class: 'field', onclick: (event) => event.stopPropagation() }, data.tickets.map((ticket) => h('option', { value: ticket.key }, `${ticket.key} · ${ticket.title}`)))
      return h('div', { class: 'fl-linkbox', onclick: (event) => event.stopPropagation() }, select,
        h('button', { class: 'btn primary small', type: 'button', onclick: async () => { await postJson('/api/flow/link', { kind, id, ticket: select.value }); ui.linking = null; await reload() } }, 'Link'),
        h('button', { class: 'btn small', type: 'button', onclick: () => set({ linking: null }) }, 'Cancel'))
    }
    const looseMrs = data.loose.mrs
    const looseSessions = data.loose.sessions
    const cols = h('div', { class: 'fl-map-cols' },
      col('Epics', epics.map((key) => {
        const epic = key ? epicOf(key) : null
        const count = ordered.filter((ticket) => (ticket.epic ?? null) === key).length
        return node(`e:${key ?? 'none'}`, 'epic', epic?.key ?? null, epic?.title ?? 'No epic', plural(count, 'ticket'), () => key && set({ epic: key }))
      })),
      col('Tickets', ordered.map((ticket) => node(`t:${ticket.key}`, '', ticket.key, ticket.title, ticket.done ? `Done in ${fmtSpan(ticket.lead)}` : `${ticket.state.label} · ${ticket.state.sub}`, () => openDetail(ticket.key)))),
      col('Sessions', sessions.map((item) => node(`s:${item.id}`, '', null, item.title, [item.project, item.tickets.find((link) => keys.has(link.key))?.why].filter(Boolean).join(' · '), () => openSession(item.id))),
        looseSessions.length ? h('div', { class: 'fl-map-sep' }, 'Recent sessions with no ticket') : null,
        looseSessions.map((item) => node(`s:${item.id}`, 'loose', null, item.title, `${item.project ?? ''} · ${ago(item.lastActivityAt)}`, null)).map((el, i) => { el.append(linkBox('session', looseSessions[i].id)); return el })),
      col('Merge requests', mrUrls.map((url) => {
        const mr = mrOf(url)
        return node(`m:${url}`, '', mr.ref, mr.title || mrShort(mr.ref), mr.draft ? 'Draft' : mr.state === 'opened' ? 'Open' : mr.state === 'merged' ? (mr.deploy?.state === 'live' ? 'Deployed' : 'Merged') : mr.state, () => window.open(url, '_blank', 'noopener'))
      }),
      looseMrs.length ? h('div', { class: 'fl-map-sep' }, 'Your MRs with no ticket') : null,
      looseMrs.map((mr) => node(`m:${mr.url}`, 'loose', mr.ref, mr.title, mr.state === 'opened' ? 'Open' : mr.state, null)).map((el, i) => { el.append(linkBox('mr', looseMrs[i].url)); return el })))
    const svg = s('svg', { class: 'fl-map-svg' })
    const wrap = h('div', { class: 'fl-map-wrap' }, svg, cols)
    requestAnimationFrame(() => {
      drawLinks(wrap, svg)
      highlight(ui.hl)
    })
    return h('div', { class: 'fl-card' },
      h('h3', {}, 'Epic → ticket → session → merge request'),
      h('p', { class: 'fl-sub' }, 'Hover anything to light up its chain. Dashed cards have no ticket, and Link… attaches one by hand.'),
      list.length ? wrap : h('p', { class: 'fl-sub' }, 'No tickets match these filters.'))
  }

  function drawLinks(wrap, svg) {
    if (!graph || !wrap.isConnected) return
    const box = wrap.getBoundingClientRect()
    svg.setAttribute('width', box.width)
    svg.setAttribute('height', box.height)
    const rect = (id) => wrap.querySelector(`[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect()
    svg.replaceChildren(...graph.links.map(([a, b]) => {
      const ra = rect(a)
      const rb = rect(b)
      if (!ra || !rb) return null
      const x1 = ra.right - box.left
      const y1 = ra.top + ra.height / 2 - box.top
      const x2 = rb.left - box.left
      const y2 = rb.top + rb.height / 2 - box.top
      const dx = Math.max(24, (x2 - x1) / 2)
      return s('path', { class: 'fl-link', 'data-a': a, 'data-b': b, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` })
    }).filter(Boolean))
  }

  function highlight(id) {
    const wrap = root.querySelector('.fl-map-wrap')
    if (!wrap || !graph) return
    if (!id) {
      wrap.querySelectorAll('.fl-node').forEach((node) => node.classList.remove('dim', 'hl'))
      wrap.querySelectorAll('.fl-link').forEach((link) => link.classList.remove('dim', 'hl'))
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
    wrap.querySelectorAll('.fl-link').forEach((link) => {
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
    if (ui.view === 'overview') body.push(kpis(list), gapChart(list), ticketList(list))
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
  return { update, render, leave, busy: () => ui.busy || Boolean(data?.refreshing) }
}
