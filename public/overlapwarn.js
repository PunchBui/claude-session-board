export function overlapFor(overlaps, id) {
  return overlaps
    .filter((overlap) => overlap.sessions.some((session) => session.id === id))
    .map((overlap) => ({ path: overlap.path, others: overlap.sessions.filter((session) => session.id !== id) }))
}

export const relativeTo = (path, cwd) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

export function commitOnlyPrompt(path, cwd, others) {
  const names = others.map((other) => `"${other.title}"`).join(', ')
  return `Commit only ${relativeTo(path, cwd)}: stage that one file and leave every other change out. Another session (${names}) also edited it. Run git diff on the file first and tell me if it holds changes you did not make; if it does, stop and ask me before committing.`
}
