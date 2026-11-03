import { ago } from './loops.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const TIERS = [
  { tier: 'hot', label: 'Hot', group: 'warm', bars: 4, maxAgeMs: HOUR },
  { tier: 'warm', label: 'Warm', group: 'warm', bars: 3, maxAgeMs: DAY },
  { tier: 'cooling', label: 'Cooling', group: 'cool', bars: 2, maxAgeMs: 7 * DAY },
  { tier: 'cold', label: 'Cold', group: 'cool', bars: 1, maxAgeMs: Infinity },
]

export function warmthOf(session, now = Date.now(), keptAt = 0) {
  const prompted = Math.max(session.lastPromptAt ?? session.lastActivityAt ?? 0, keptAt)
  const age = Math.max(0, now - prompted)
  return { ...TIERS.find((t) => age < t.maxAgeMs), at: prompted }
}

export function byWarmth(a, b) {
  return b.at - a.at
}

const MEANING = {
  hot: 'You prompted this within the last hour.',
  warm: 'You prompted this within the last day.',
  cooling: 'No prompt from you for over a day. It may be getting forgotten.',
  cold: 'No prompt from you for over a week. Consider archiving it.',
}

export function warmthTip(session, warmth, keptAt = 0, now = Date.now()) {
  const rows = []
  const prompted = session.lastPromptAt ?? session.lastActivityAt
  if (prompted) rows.push([session.lastPromptAt ? 'Last prompt' : 'Last activity', ago(prompted, now)])
  if (keptAt && keptAt >= (prompted ?? 0)) rows.push(['Kept warm', ago(keptAt, now)])
  rows.push(['Warm', 'Hot under 1h, Warm under 1 day'], ['Cool', 'Cooling under 7 days, Cold after'])
  return { heading: warmth.label, text: MEANING[warmth.tier], rows }
}
