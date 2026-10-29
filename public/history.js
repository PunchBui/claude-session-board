export const HISTORY_LIMIT = 100
const DUPLICATE_WINDOW_MS = 10_000

export function addEvents(history, events, now = Date.now()) {
  const next = [...history]
  for (const event of events) {
    const duplicate = next.some((entry) => entry.id === event.id && entry.kind === event.kind && entry.message === event.message && now - entry.at < DUPLICATE_WINDOW_MS)
    if (duplicate) continue
    next.unshift({ uid: globalThis.crypto.randomUUID(), id: event.id, title: event.title, kind: event.kind, message: event.message, at: now, read: false })
  }
  return next.slice(0, HISTORY_LIMIT)
}

export const markAllRead = (history) => history.map((entry) => (entry.read ? entry : { ...entry, read: true }))
export const unreadCount = (history) => history.reduce((count, entry) => count + (entry.read ? 0 : 1), 0)
export const markRead = (history, uid) => history.map((entry) => (entry.uid === uid && !entry.read ? { ...entry, read: true } : entry))
export const markSessionRead = (history, id) => history.map((entry) => (entry.id === id && !entry.read ? { ...entry, read: true } : entry))
