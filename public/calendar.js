// Run times of a routine inside [from, to): the next run (`at`) and every repeat after it.
// Mirrors nextAfter in lib/schedule.js, but walks forward from `at` without a "now" cutoff.
const LIMIT = 400

export function runsBetween(routine, from, to) {
  if (!routine.enabled) return []
  const out = []
  const date = new Date(routine.at)
  for (let i = 0; i < LIMIT && date.getTime() < to; i++) {
    if (date.getTime() >= from) out.push(date.getTime())
    if (routine.repeat === 'none') break
    date.setDate(date.getDate() + (routine.repeat === 'weekly' ? 7 : 1))
    while (routine.repeat === 'weekdays' && (date.getDay() === 0 || date.getDay() === 6)) date.setDate(date.getDate() + 1)
  }
  return out
}

// Six-week grid (Sunday first) covering the month of `anchor`.
export function monthGrid(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay())
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}

// The Sunday-first week containing `anchor`, or just that day.
export function weekGrid(anchor) {
  return Array.from({ length: 7 }, (_, i) => new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay() + i))
}
export const dayGrid = (anchor) => [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())]

// Move the anchor one page: a month, a week or a day.
export function shiftAnchor(anchor, view, by) {
  if (view === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + by, 1)
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + by * (view === 'week' ? 7 : 1))
}

export const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

// day key -> [{ routine, at }] sorted by time, for every routine across the grid.
export function eventsByDay(routines, grid) {
  const from = grid[0].getTime()
  const last = grid[grid.length - 1]
  const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime()
  const map = new Map()
  for (const routine of routines) {
    for (const at of runsBetween(routine, from, to)) {
      const key = dayKey(new Date(at))
      if (!map.has(key)) map.set(key, [])
      map.get(key).push({ routine, at })
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.at - b.at)
  return map
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
export const EFFORT_NAMES = { xhigh: 'Extra high' }
export const modelLabel = (m) => (m ? cap(m) : 'Default')
export const effortLabel = (e) => (e ? EFFORT_NAMES[e] ?? cap(e) : 'Default')
