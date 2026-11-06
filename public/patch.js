export function listOps(prev, next) {
  const ops = next.map((html, i) => {
    if (i >= prev.length) return 'append'
    return prev[i] === html ? 'keep' : 'replace'
  })
  return { ops, remove: Math.max(0, prev.length - next.length) }
}

export function phaseLabel(live) {
  if (!live || live.phase === 'idle') return null
  if (live.phase === 'tool') return `Running ${live.current?.name ?? 'tool'}`
  return live.phase === 'thinking' ? 'Thinking…' : 'Writing a reply…'
}
