export const REPEATS = new Set(['none', 'daily', 'weekdays', 'weekly'])

export function nextAfter(at, repeat, nowMs = Date.now()) {
  if (repeat !== 'daily' && repeat !== 'weekdays' && repeat !== 'weekly') return null
  const date = new Date(at)
  do {
    date.setDate(date.getDate() + (repeat === 'weekly' ? 7 : 1))
    while (repeat === 'weekdays' && (date.getDay() === 0 || date.getDay() === 6)) date.setDate(date.getDate() + 1)
  } while (date.getTime() <= nowMs)
  return date.getTime()
}

export async function fireDue(items, { now, enqueue }) {
  const fired = []
  for (const item of items) {
    if (item.at <= now && (await enqueue(item.id, item.prompt))) fired.push(item)
  }
  return fired
}

export function advanceFired(items, fired, now) {
  const done = new Set(fired)
  return items.flatMap((item) => {
    if (!done.has(item)) return [item]
    const next = nextAfter(item.at, item.repeat, now)
    return next ? [{ ...item, at: next }] : []
  })
}
