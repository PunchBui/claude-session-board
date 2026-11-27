export function newSessionIds(known, sessions, focusIds) {
  const next = new Set([...(known ?? []), ...sessions.map((s) => s.id)])
  if (!known) return { fresh: [], next }
  const fresh = sessions
    .filter((s) => !known.has(s.id) && !s.archived && !s.sideChatOf && !s.unfocused && !focusIds.includes(s.id))
    .map((s) => s.id)
  return { fresh, next }
}
