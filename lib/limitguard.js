export const WINDOW_HOURS = 5
export const STEP_PERCENT = 20
export const MIN_ALLOWED = 20
export const RESUME_MARGIN = 5
export const MAX_GUARDS = 400
export const CONTINUE_PROMPT = 'The 5-hour usage limit guard paused you. Continue exactly where you left off.'

export function allowedPercent(resetsAt, now = Date.now()) {
  const reset = resetsAt ? new Date(resetsAt).getTime() : NaN
  const hours = Number.isFinite(reset) ? Math.max(0, reset - now) / 3_600_000 : WINDOW_HOURS
  if (hours <= 1) return 100
  return Math.max(MIN_ALLOWED, 100 - STEP_PERCENT * (Math.ceil(hours) - 1))
}

export function guardStatus(limits, now = Date.now()) {
  const window = limits?.available ? limits.fiveHour : null
  if (!window) return { known: false, percent: null, allowed: null, resetsAt: null, over: false, clear: true }
  const allowed = allowedPercent(window.resetsAt, now)
  return {
    known: true,
    percent: window.percent,
    allowed,
    resetsAt: window.resetsAt,
    over: allowed < 100 && window.percent >= allowed,
    clear: allowed >= 100 || window.percent <= allowed - RESUME_MARGIN,
  }
}

export function decideGuard(guard, status, running) {
  if (!guard?.on || !status.known) return null
  if (guard.pausedAt) return status.clear ? 'resume' : null
  return running && status.over ? 'pause' : null
}

export function paused(guard, status, now, wasRunning) {
  return { ...guard, pausedAt: now, resumeWithPrompt: wasRunning, percent: status.percent, allowed: status.allowed, resetsAt: status.resetsAt }
}

export function released(guard) {
  const { pausedAt, resumeWithPrompt, percent, allowed, resetsAt, ...rest } = guard
  return rest
}

export function publicGuard(guard) {
  if (!guard?.on) return null
  return { on: true, pausedAt: guard.pausedAt ?? null, percent: guard.percent ?? null, allowed: guard.allowed ?? null, resetsAt: guard.resetsAt ?? null }
}

export function parseGuardsFile(parsed) {
  const items = parsed?.items && typeof parsed.items === 'object' ? parsed.items : {}
  const out = {}
  for (const [id, value] of Object.entries(items).slice(0, MAX_GUARDS)) {
    if (!/^local_[A-Za-z0-9-]{1,64}$/.test(id) || value?.on !== true) continue
    out[id] = {
      on: true,
      pausedAt: Number.isFinite(value.pausedAt) ? value.pausedAt : null,
      resumeWithPrompt: value.resumeWithPrompt === true,
      percent: Number.isFinite(value.percent) ? value.percent : null,
      allowed: Number.isFinite(value.allowed) ? value.allowed : null,
      resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : null,
    }
  }
  return out
}
