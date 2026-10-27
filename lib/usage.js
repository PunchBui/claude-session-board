export function aggregateUsage(entries, days, today = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const dayKeys = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    dayKeys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  }
  const inRange = new Set(dayKeys)
  const series = {}
  const sessions = []
  for (const entry of entries) {
    const total = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0, responses: 0 }
    for (const t of entry.byId.values()) {
      if (!inRange.has(t.day)) continue
      const project = (series[entry.project ?? 'unknown'] ??= {})
      const bucket = (project[t.day] ??= { output: 0, input: 0, cacheRead: 0, cacheWrite: 0, responses: 0 })
      for (const key of ['output', 'input', 'cacheRead', 'cacheWrite']) {
        bucket[key] += t[key]
        total[key] += t[key]
      }
      bucket.responses += 1
      total.responses += 1
    }
    if (total.responses) sessions.push({ id: entry.id, title: entry.title, project: entry.project, ...total })
  }
  sessions.sort((a, b) => b.output - a.output)
  return { days: dayKeys, projects: Object.keys(series).sort(), series, sessions: sessions.slice(0, 25) }
}
