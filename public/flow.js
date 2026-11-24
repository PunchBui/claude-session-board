export const DAY_MS = 86_400_000
export const SLOW_WAIT_MS = 5 * DAY_MS

export const STEPS = [
  { id: 'created', label: 'Created' },
  { id: 'sprint', label: 'In sprint' },
  { id: 'progress', label: 'In progress' },
  { id: 'mr', label: 'MR created' },
  { id: 'review', label: 'Review / merge' },
  { id: 'approved', label: 'MR approved' },
  { id: 'merged', label: 'MR merged' },
  { id: 'deployed', label: 'MR deployed' },
  { id: 'experiment', label: 'Experiment started' },
  { id: 'done', label: 'Done' },
]
export const STEP_LABEL = Object.fromEntries(STEPS.map((step) => [step.id, step.label]))

export const PHASES = [
  { id: 'plan', label: 'Plan', steps: ['sprint', 'progress'], hint: 'Created → In progress' },
  { id: 'build', label: 'Build', steps: ['mr'], hint: 'In progress → MR created' },
  { id: 'review', label: 'Review', steps: ['review', 'approved', 'merged'], hint: 'MR created → MR merged' },
  { id: 'ship', label: 'Ship', steps: ['deployed', 'experiment', 'done'], hint: 'MR merged → Done' },
]
export const phaseOf = (stepId) => PHASES.find((phase) => phase.steps.includes(stepId)) ?? PHASES[0]

export const SOURCE_LABEL = { jira: 'Jira', gitlab: 'GitLab', deploy: 'Deploy check', board: 'Board', manual: 'Typed in', skill: 'Skill' }

const WAITING = {
  sprint: 'Backlog',
  progress: 'Not started',
  mr: 'Building',
  review: 'MR open',
  approved: 'Waiting on review',
  merged: 'Waiting to merge',
  deployed: 'Waiting to deploy',
  experiment: 'Waiting for experiment',
  done: 'Waiting to close',
}
const DEPLOY_WAITING = { waiting: ['Deploy waiting', 'warn'], deploying: ['Deploying', 'info'], failed: ['Deploy failed', 'bad'], checking: ['Checking deploy', 'info'] }

export function workingMs(a, b) {
  let ms = 0
  let cursor = new Date(a)
  const end = new Date(b)
  while (cursor < end) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
    const stop = next < end ? next : end
    const weekday = cursor.getDay()
    if (weekday !== 0 && weekday !== 6) ms += stop - cursor
    cursor = stop
  }
  return ms
}

export const spanMs = (a, b, work = false) => (b <= a ? 0 : work ? workingMs(a, b) : b - a)

export function fmtSpan(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return days >= 10 || !rest ? `${days}d` : `${days}d ${rest}h`
}

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const index = (sorted.length - 1) * p
  const lo = Math.floor(index)
  const hi = Math.ceil(index)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo)
}

const weightOf = (step, value) => {
  if (step === 'created') return 1000
  if (step === 'done') return 100
  if (value.source === 'manual' || value.source === 'skill') return 5
  if (value.inferred) return 1
  if (value.source === 'gitlab' || value.source === 'deploy') return 3
  return 2
}

export function outOfOrder(steps) {
  const timed = STEPS.map((step) => ({ id: step.id, value: steps?.[step.id] })).filter((item) => Number.isFinite(item.value?.at))
  const best = timed.map((item) => ({ count: 1, weight: weightOf(item.id, item.value), prev: -1 }))
  for (let i = 0; i < timed.length; i++) {
    for (let j = 0; j < i; j++) {
      if (timed[j].value.at > timed[i].value.at) continue
      const count = best[j].count + 1
      const weight = best[j].weight + weightOf(timed[i].id, timed[i].value)
      if (weight > best[i].weight || (weight === best[i].weight && count > best[i].count)) best[i] = { count, weight, prev: j }
    }
  }
  let end = -1
  best.forEach((item, i) => {
    if (end < 0 || item.weight > best[end].weight || (item.weight === best[end].weight && item.count > best[end].count)) end = i
  })
  const keep = new Set()
  for (let i = end; i >= 0; i = best[i].prev) keep.add(timed[i].id)
  return new Set(timed.filter((item) => !keep.has(item.id)).map((item) => item.id))
}

export function deriveTicket(ticket, { now = Date.now(), work = false } = {}) {
  const steps = ticket.steps ?? {}
  const ooo = outOfOrder(steps)
  const usable = STEPS.filter((step) => !steps[step.id]?.na && !ooo.has(step.id))
  const reached = usable.filter((step) => Number.isFinite(steps[step.id]?.at))
  const at = (id) => steps[id]?.at ?? null
  const gaps = []
  for (let i = 1; i < reached.length; i++) {
    const from = reached[i - 1]
    const to = reached[i]
    gaps.push({ from: from.id, to: to.id, a: at(from.id), b: at(to.id), ms: spanMs(at(from.id), at(to.id), work), phase: phaseOf(to.id).id })
  }
  const done = Number.isFinite(at('done')) && !ooo.has('done')
  const last = reached.at(-1) ?? null
  const next = last ? usable[usable.indexOf(last) + 1] ?? null : usable[0] ?? null
  const open = !done && last && next ? { from: last.id, to: next.id, a: at(last.id), b: now, ms: spanMs(at(last.id), now, work), phase: phaseOf(next.id).id, open: true } : null
  let state
  if (done) state = { label: 'Done', sub: '', tone: 'ok' }
  else if (!next) state = { label: ticket.status || 'Open', sub: '', tone: 'info' }
  else {
    const running = next.id === 'done' && last?.id === 'experiment'
    const deploy = next.id === 'deployed' ? DEPLOY_WAITING[ticket.deployState?.state] : null
    const label = running ? 'Experiment running' : deploy?.[0] ?? WAITING[next.id]
    const slow = !running && (open?.ms ?? 0) > SLOW_WAIT_MS
    state = { label, sub: open ? fmtSpan(open.ms) : '', tone: deploy?.[1] === 'bad' ? 'bad' : slow || deploy?.[1] === 'warn' ? 'warn' : running ? 'ok' : 'info' }
  }
  const created = at('created')
  const lead = Number.isFinite(created) ? spanMs(created, done ? at('done') : now, work) : null
  const flags = []
  if (state.tone === 'warn' && open) flags.push(`${state.label} for ${state.sub}`)
  for (const id of ooo) flags.push(`${STEP_LABEL[id]} is out of order`)
  if (ticket.carried) flags.push(`Carried over ${ticket.carried} sprint${ticket.carried === 1 ? '' : 's'}`)
  return { ...ticket, ooo, usable, reached, gaps, open, done, last, next, state, lead, flags }
}

export function inRange(derived, days, now = Date.now()) {
  return !derived.done || derived.steps.done.at >= now - days * DAY_MS
}

export function gapRows(derived) {
  return STEPS.slice(1).map((step) => {
    const gaps = derived.flatMap((ticket) => ticket.gaps.filter((gap) => gap.to === step.id).map((gap) => ({ ...gap, key: ticket.key })))
    const values = gaps.map((gap) => gap.ms)
    const slowest = gaps.reduce((max, gap) => (!max || gap.ms > max.ms ? gap : max), null)
    return {
      step: step.id,
      label: step.label,
      n: values.length,
      median: percentile(values, 0.5),
      p75: percentile(values, 0.75),
      slowest: slowest ? { key: slowest.key, ms: slowest.ms } : null,
      froms: [...new Set(gaps.map((gap) => STEP_LABEL[gap.from]))],
    }
  })
}

export const KPIS = [
  { id: 'lead', label: 'Lead time', hint: 'Created → Done', from: 'created', to: 'done' },
  { id: 'cycle', label: 'Cycle time', hint: 'In progress → Done', from: 'progress', to: 'done' },
  { id: 'review', label: 'Review wait', hint: 'MR created → approved', from: 'mr', to: 'approved' },
  { id: 'deploy', label: 'Merge to deploy', hint: 'MR merged → deployed', from: 'merged', to: 'deployed' },
]

export function kpiValues(derived, work = false) {
  return KPIS.map((kpi) => {
    const spans = derived
      .filter((ticket) => !ticket.ooo.has(kpi.from) && !ticket.ooo.has(kpi.to))
      .map((ticket) => {
        const a = ticket.steps[kpi.from]?.at
        const b = ticket.steps[kpi.to]?.at
        return Number.isFinite(a) && Number.isFinite(b) ? { key: ticket.key, ms: spanMs(a, b, work) } : null
      })
      .filter(Boolean)
    const slowest = spans.reduce((max, span) => (!max || span.ms > max.ms ? span : max), null)
    return { ...kpi, n: spans.length, median: percentile(spans.map((span) => span.ms), 0.5), slowest }
  })
}

export const isMyWorkingTicket = (derived) => Boolean(derived.mine) && !derived.done && derived.reached.some((step) => step.id !== 'created' && step.id !== 'sprint')

export const lastTouched = (derived) => Math.max(derived.updatedAt ?? 0, ...derived.reached.map((step) => derived.steps[step.id]?.at ?? 0))

export function matchesFilter(derived, { epic = 'all', status = 'all', query = '', since = 0 } = {}) {
  if (epic !== 'all' && String(derived.epic) !== epic) return false
  if (status === 'working' && (!isMyWorkingTicket(derived) || lastTouched(derived) < since)) return false
  if (status === 'active' && derived.done) return false
  if (status === 'done' && !derived.done) return false
  const q = query.trim().toLowerCase()
  return !q || `${derived.key} ${derived.title}`.toLowerCase().includes(q)
}

export const WORKING_MS = 5 * 60_000

const latest = (...values) => Math.max(0, ...values.filter(Number.isFinite))

export function mapActivity({ tickets = [], sessions = [], mrs = [], looseSessions = [], looseMrs = [] }) {
  const at = new Map()
  const sessionAt = new Map(sessions.map((item) => [item.id, latest(item.lastActivityAt)]))
  const mrAt = new Map(mrs.map((item) => [item.url, latest(item.updatedAt, item.mergedAt, item.createdAt)]))
  for (const [id, value] of sessionAt) at.set(`s:${id}`, value)
  for (const [url, value] of mrAt) at.set(`m:${url}`, value)
  for (const item of looseSessions) at.set(`s:${item.id}`, latest(item.lastActivityAt))
  for (const item of looseMrs) at.set(`m:${item.url}`, latest(item.createdAt, item.mergedAt))
  const epics = new Map()
  for (const ticket of tickets) {
    const value = latest(
      ticket.updatedAt,
      ...(ticket.sessions ?? []).map((id) => sessionAt.get(id)),
      ...(ticket.mrs ?? []).map((url) => mrAt.get(url)),
    )
    at.set(`t:${ticket.key}`, value)
    const epic = `e:${ticket.epic ?? 'none'}`
    epics.set(epic, Math.max(epics.get(epic) ?? 0, value))
  }
  for (const [id, value] of epics) at.set(id, value)
  return at
}

export const isWorking = (lastActivityAt, now = Date.now()) => Number.isFinite(lastActivityAt) && now - lastActivityAt < WORKING_MS
