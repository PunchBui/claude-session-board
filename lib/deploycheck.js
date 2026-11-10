export const DEPLOY_STATES = ['checking', 'live', 'deploying', 'waiting', 'failed', 'unknown']

export const MAX_DEPLOY = 200
export const MAX_NOTE = 300

export const isDeployState = (value) => DEPLOY_STATES.includes(value)

export function recordDeploy(store, url, { state, note, sessionId }, now) {
  const previous = store[url]
  const entry = {
    state,
    note: typeof note === 'string' ? note.trim().slice(0, MAX_NOTE) : '',
    sessionId: sessionId ?? previous?.sessionId ?? null,
    at: now,
  }
  const entries = Object.entries({ ...store, [url]: entry }).sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, MAX_DEPLOY))
}

export function withDeploy(data, store) {
  const mark = (mrs) => mrs.map((mr) => (store[mr.url] && mr.mergedAt ? { ...mr, deploy: store[mr.url] } : mr))
  return { ...data, merged: mark(data.merged ?? []) }
}
