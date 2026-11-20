export const DEPLOY_STATES = ['checking', 'live', 'deploying', 'waiting', 'failed', 'unknown']

export const MAX_DEPLOY = 200
export const MAX_NOTE = 300

const ACTIVE = new Set(['checking', 'deploying', 'waiting'])

export const isDeployState = (value) => DEPLOY_STATES.includes(value)
export const isDeployActive = (state) => ACTIVE.has(state)

export function deployTime(value, now) {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) && ms <= now + 60_000 ? ms : null
}

export function recordDeploy(store, url, { state, note, sessionId, deployedAt }, now) {
  const previous = store[url]
  const exact = state === 'live' ? deployTime(deployedAt, now) ?? (previous?.state === 'live' ? previous.deployedAt ?? null : null) : null
  const entry = {
    state,
    note: typeof note === 'string' ? note.trim().slice(0, MAX_NOTE) : '',
    sessionId: sessionId ?? previous?.sessionId ?? null,
    at: now,
    ...(exact ? { deployedAt: exact } : {}),
  }
  const entries = Object.entries({ ...store, [url]: entry }).sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, MAX_DEPLOY))
}

export function withDeploy(data, store) {
  const mark = (mrs) => mrs.map((mr) => (store[mr.url] && mr.mergedAt ? { ...mr, deploy: store[mr.url] } : mr))
  return { ...data, merged: mark(data.merged ?? []) }
}
