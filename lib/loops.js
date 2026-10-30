const CRON_EXPIRY_MS = 7 * 24 * 60 * 60_000
const ENDED_VISIBLE_MS = 24 * 60 * 60_000
const WAKE_SETTLE_MS = 60_000
const STALL_FLOOR_MS = 5 * 60_000
const EVERY_MINUTES = /^\*\/(\d{1,2}) \* \* \* \*$/
const JOB_ID = /job (\S+) \(/
const LISTED_ID = /^(\S+) — /gm
const MAX_PROMPT_CHARS = 4000
const MAX_FIRES = 300
const CHAIN_GAP_MS = 30 * 60_000

export function newLoopState() {
  return { jobs: new Map(), calls: new Map(), wakeup: null, chain: null, endedAt: null, history: [] }
}

const millis = (at) => {
  const value = Date.parse(at)
  return Number.isNaN(value) ? Date.now() : value
}

const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim()

function everyMinutes(cron) {
  const match = EVERY_MINUTES.exec(String(cron ?? '').trim())
  return match ? Number(match[1]) : null
}

function close(record, at, reason) {
  if (record && !record.endedAt) {
    record.endedAt = at
    record.endReason = reason
  }
}

function recordFire(record, at) {
  record.lastFiredAt = at
  record.fires.push(at)
  if (record.fires.length > MAX_FIRES) record.fires.shift()
}

function openChain(loops, prompt, at) {
  const chain = { id: `wakeup-${at}`, kind: 'wakeup', cron: null, every: null, recurring: true, prompt, createdAt: at, lastFiredAt: null, fires: [], endedAt: null, endReason: null }
  loops.chain = chain
  loops.history.push(chain)
  return chain
}

function reconcile(loops, listed, at) {
  for (const job of [...loops.jobs.values()]) {
    if (job.createdAt >= at || listed.has(job.id)) continue
    loops.jobs.delete(job.id)
    close(job, at, 'removed')
  }
  if (loops.jobs.size === 0 && !loops.wakeup && loops.history.some((record) => record.endReason === 'removed' && record.endedAt === at)) loops.endedAt = at
}

export function noteLoopToolUse(loops, block, at) {
  const input = block.input ?? {}
  const when = millis(at)
  if (block.name === 'CronCreate') {
    loops.calls.set(block.id, { kind: 'cron', cron: input.cron, every: everyMinutes(input.cron), recurring: input.recurring !== false, prompt: String(input.prompt ?? '').slice(0, MAX_PROMPT_CHARS), createdAt: when })
  } else if (block.name === 'CronList') {
    loops.calls.set(block.id, { kind: 'list', at: when })
  } else if (block.name === 'CronDelete') {
    const job = loops.jobs.get(input.id)
    if (!job) return
    loops.jobs.delete(input.id)
    close(job, when, 'deleted')
    if (loops.jobs.size === 0 && !loops.wakeup) loops.endedAt = when
  } else if (block.name === 'ScheduleWakeup') {
    if (input.stop) {
      if (loops.wakeup || loops.jobs.size) loops.endedAt = when
      close(loops.chain, when, 'stopped')
      loops.wakeup = null
      return
    }
    const chain = loops.chain
    const continuing = chain && !chain.endedAt && (!loops.wakeup?.firedAt || when - loops.wakeup.firedAt < CHAIN_GAP_MS)
    if (chain && !continuing) close(chain, loops.wakeup?.firedAt ?? chain.createdAt, 'finished')
    const prompt = String(input.prompt ?? '').slice(0, MAX_PROMPT_CHARS)
    if (!continuing) openChain(loops, prompt, when)
    loops.wakeup = { setAt: when, dueAt: when + Number(input.delaySeconds ?? 0) * 1000, prompt, firedAt: null }
    loops.endedAt = null
  }
}

export function noteLoopToolResult(loops, toolUseId, content) {
  const call = loops.calls.get(toolUseId)
  if (!call) return
  loops.calls.delete(toolUseId)
  const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '')
  if (call.kind === 'list') return reconcile(loops, new Set([...text.matchAll(LISTED_ID)].map((match) => match[1])), call.at)
  const id = JOB_ID.exec(text)?.[1]
  if (!id) return
  const job = { id, ...call, lastFiredAt: null, fires: [], endedAt: null, endReason: null }
  loops.jobs.set(id, job)
  loops.history.push(job)
  loops.endedAt = null
}

export function noteLoopFire(loops, text, at) {
  const firedAt = millis(at)
  for (const job of [...loops.jobs.values()]) {
    if (!sameText(job.prompt, text)) continue
    recordFire(job, firedAt)
    if (!job.recurring) {
      loops.jobs.delete(job.id)
      close(job, firedAt, 'fired')
      if (loops.jobs.size === 0 && !loops.wakeup) loops.endedAt = firedAt
    }
  }
  if (loops.wakeup && !loops.wakeup.firedAt && sameText(loops.wakeup.prompt, text)) {
    loops.wakeup.firedAt = firedAt
    if (loops.chain) recordFire(loops.chain, firedAt)
  }
}

export function loopOf(loops, { nowMs, working, idleMs }) {
  const jobs = [...loops.jobs.values()].filter((job) => nowMs - job.createdAt < CRON_EXPIRY_MS)
  const wake = loops.wakeup
  const pendingWake = wake && !wake.firedAt ? wake : null
  const tickRunning = Boolean(wake?.firedAt) && (working || idleMs < WAKE_SETTLE_MS)

  let endedAt = loops.endedAt
  if (wake?.firedAt && !tickRunning && !jobs.length) endedAt = endedAt ?? wake.firedAt

  const dues = jobs
    .filter((job) => job.every)
    .map((job) => ({ dueAt: (job.lastFiredAt ?? job.createdAt) + job.every * 60_000, grace: Math.max(job.every * 2 * 60_000, STALL_FLOOR_MS) }))
  if (pendingWake) dues.push({ dueAt: pendingWake.dueAt, grace: STALL_FLOOR_MS })
  const next = dues.sort((a, b) => a.dueAt - b.dueAt)[0] ?? null

  if (jobs.length || pendingWake || tickRunning) {
    const stalled = Boolean(next) && !working && nowMs > next.dueAt + next.grace
    const every = jobs.map((job) => job.every).filter(Boolean).sort((a, b) => a - b)[0] ?? null
    const lastFiredAt = Math.max(0, ...jobs.map((job) => job.lastFiredAt ?? 0), wake?.firedAt ?? 0) || null
    return {
      state: stalled ? 'stalled' : 'looping',
      nextAt: tickRunning ? null : (next?.dueAt ?? null),
      every,
      count: jobs.length + (pendingWake || tickRunning ? 1 : 0),
      lastFiredAt,
      endedAt: null,
    }
  }
  if (endedAt && nowMs - endedAt < ENDED_VISIBLE_MS) return { state: 'ended', nextAt: null, every: null, count: 0, lastFiredAt: null, endedAt }
  return null
}

const FIRES_SHOWN = 40

export function loopRecords(loops, { nowMs, working, idleMs }) {
  const wake = loops.wakeup
  const settled = Boolean(wake?.firedAt) && !working && idleMs >= WAKE_SETTLE_MS
  return loops.history.map((record) => {
    let endedAt = record.endedAt
    let endReason = record.endReason
    if (!endedAt && record.kind === 'cron' && nowMs - record.createdAt >= CRON_EXPIRY_MS) {
      endedAt = record.createdAt + CRON_EXPIRY_MS
      endReason = 'expired'
    }
    if (!endedAt && record.kind === 'wakeup' && record === loops.chain && settled) {
      endedAt = wake.firedAt
      endReason = 'finished'
    }
    let status = 'ended'
    let nextAt = null
    if (!endedAt) {
      const dueAt = record.kind === 'wakeup'
        ? (wake && !wake.firedAt ? wake.dueAt : null)
        : (record.every ? (record.lastFiredAt ?? record.createdAt) + record.every * 60_000 : null)
      const grace = record.kind === 'wakeup' ? STALL_FLOOR_MS : Math.max((record.every ?? 0) * 2 * 60_000, STALL_FLOOR_MS)
      status = dueAt && !working && nowMs > dueAt + grace ? 'stalled' : 'looping'
      nextAt = dueAt
    }
    return {
      id: record.id,
      kind: record.kind,
      cron: record.cron,
      every: record.every,
      recurring: record.recurring,
      prompt: record.prompt,
      createdAt: record.createdAt,
      status,
      endedAt: endedAt ?? null,
      endReason: endReason ?? null,
      nextAt,
      lastFiredAt: record.lastFiredAt,
      fireCount: record.fires.length,
      fires: record.fires.slice(-FIRES_SHOWN),
    }
  })
}
