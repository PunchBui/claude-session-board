export const REPEATS = new Set(['none', 'daily', 'weekdays'])

export function nextAfter(at, repeat, nowMs = Date.now()) {
  if (repeat !== 'daily' && repeat !== 'weekdays') return null
  const date = new Date(at)
  do {
    date.setDate(date.getDate() + 1)
    while (repeat === 'weekdays' && (date.getDay() === 0 || date.getDay() === 6)) date.setDate(date.getDate() + 1)
  } while (date.getTime() <= nowMs)
  return date.getTime()
}
