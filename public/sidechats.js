export const mainSessions = (sessions) => sessions.filter((s) => !s.sideChatOf)

export function sideChatGroups(items, parentId = null) {
  const mine = parentId ? items.filter((r) => r.parentId === parentId) : items
  const newest = (a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
  return {
    open: mine.filter((r) => !r.closed).sort(newest),
    closed: mine.filter((r) => r.closed).sort(newest),
  }
}

export function sideChatCount(sessions, id) {
  return sessions.find((s) => s.id === id)?.sideChats ?? 0
}

export function ownReplies(chat, sentAt) {
  return chat.some((m) => m.role === 'user' && Date.parse(m.at) >= sentAt - 2000)
}
