import { warmthOf } from './warmth.js'
import { ago } from './loops.js'

export const FILTERS = {
  all: () => true,
  merged: (mr) => Boolean(mr.mergedAt),
  authored: (mr) => mr.role === 'authored',
  reviewing: (mr) => mr.role === 'reviewing',
  action: (mr) => mr.actionable,
  focus: (mr) => mr.focused,
}

const MEANING = {
  hot: 'Something happened on this MR within the last hour.',
  warm: 'Something happened on this MR within the last day.',
  cooling: 'No activity for over a day. It may be getting forgotten.',
  cold: 'No activity for over a week. Nudge it, merge it or close it.',
}

export const mrTemperature = (mr, now = Date.now()) => warmthOf({ lastPromptAt: mr.updatedAt }, now)

export function mergeMrs(data) {
  const own = new Set(data.authored.map((mr) => mr.url))
  return [
    ...data.authored.map((mr) => ({ ...mr, role: 'authored' })),
    ...data.reviewing.filter((mr) => !own.has(mr.url)).map((mr) => ({ ...mr, role: 'reviewing' })),
    ...(data.merged ?? []),
  ]
}

export function orderMrs(list) {
  return [...list].sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)) || b.updatedAt - a.updatedAt)
}

export function visibleMrs(all, { filter = 'all', temp = null, now = Date.now() } = {}) {
  const match = FILTERS[filter] ?? FILTERS.all
  return orderMrs(all.filter((mr) => match(mr) && (!temp || mrTemperature(mr, now).group === temp)))
}

export function tempCounts(all, now = Date.now()) {
  const counts = { warm: 0, cool: 0 }
  for (const mr of all) counts[mrTemperature(mr, now).group] += 1
  return counts
}

export function mrWarmthTip(mr, warmth, now = Date.now()) {
  return {
    heading: warmth.label,
    text: MEANING[warmth.tier],
    rows: [['Last activity', ago(mr.updatedAt, now)], ['Warm', 'Hot under 1h, Warm under 1 day'], ['Cool', 'Cooling under 7 days, Cold after']],
  }
}
