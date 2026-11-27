export function latestOnly() {
  let latest = 0
  return () => {
    const mine = ++latest
    return () => mine === latest
  }
}

export function forcedRerun(load) {
  let current = null
  let queued = null
  const run = (force = false) => {
    if (!current) {
      current = load(force).finally(() => { current = null })
      return current
    }
    if (!force) return current
    queued ??= current.catch(() => {}).then(() => {
      queued = null
      return run(true)
    })
    return queued
  }
  return run
}

export const polledPane = ({ tab, draft, selectedId, paneOf }) => (tab === 'focus' && !draft && selectedId ? paneOf(selectedId) : null)

export const BROADCAST_LIMIT = 20

export const defaultTicked = (ids) => ids.slice(0, BROADCAST_LIMIT)

export function broadcastState(total, ticked) {
  const over = ticked > BROADCAST_LIMIT
  const note = over
    ? `Too many selected: untick ${ticked - BROADCAST_LIMIT} (at most ${BROADCAST_LIMIT} sessions per broadcast).`
    : total > BROADCAST_LIMIT
      ? `Only the first ${BROADCAST_LIMIT} of ${total} sessions are ticked (at most ${BROADCAST_LIMIT} per broadcast).`
      : ''
  return { over, note, canSend: ticked > 0 && !over }
}

export function differs(previous, next) {
  return JSON.stringify(previous) !== JSON.stringify(next)
}

export function navigationMode(historyState, samePath) {
  if (!historyState?.drawer) return samePath ? 'none' : 'push'
  return samePath ? 'back' : 'replace'
}
