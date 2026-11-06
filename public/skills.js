import { warmthOf } from './warmth.js'
import { ago } from './loops.js'

export const SCOPE_FILTERS = {
  all: () => true,
  global: (skill) => skill.scope === 'global',
  project: (skill) => skill.scope === 'project',
}

export const RANGES = [7, 30, 90]

const UNUSED = { tier: 'unused', label: 'Unused', group: 'unused', bars: 0, at: 0 }

const MEANING = {
  hot: 'Used within the last hour.',
  warm: 'Used within the last day.',
  cooling: 'Not used for over a day.',
  cold: 'Not used for over a week. Check it still earns its place.',
  unused: 'Never used in any indexed session.',
}

export const skillTemperature = (skill, now = Date.now()) => (skill.lastUsedAt ? warmthOf({ lastPromptAt: skill.lastUsedAt }, now) : UNUSED)

export function dayKeys(count, now = Date.now()) {
  const pad = (n) => String(n).padStart(2, '0')
  const today = new Date(now)
  const keys = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    keys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  }
  return keys
}

export const dailyUses = (skill, count, now = Date.now()) => dayKeys(count, now).map((day) => skill.days?.[day] ?? 0)

export const usesInRange = (skill, count, now = Date.now()) => dailyUses(skill, count, now).reduce((sum, n) => sum + n, 0)

const matches = (skill, query) => {
  if (!query) return true
  const needle = query.toLowerCase()
  return [skill.name, skill.description, skill.project ?? ''].some((field) => field.toLowerCase().includes(needle))
}

export function orderSkills(list, count, now = Date.now()) {
  return list
    .map((skill) => ({ skill, used: usesInRange(skill, count, now) }))
    .sort((a, b) => b.used - a.used || (b.skill.lastUsedAt ?? 0) - (a.skill.lastUsedAt ?? 0) || a.skill.name.localeCompare(b.skill.name))
    .map(({ skill }) => skill)
}

export function visibleSkills(all, { scope = 'all', temp = null, query = '', days = 30, now = Date.now() } = {}) {
  const inScope = SCOPE_FILTERS[scope] ?? SCOPE_FILTERS.all
  return orderSkills(
    all.filter((skill) => inScope(skill) && matches(skill, query.trim()) && (!temp || skillTemperature(skill, now).group === temp)),
    days,
    now
  )
}

export function skillCounts(all, now = Date.now()) {
  const counts = { warm: 0, cool: 0, unused: 0 }
  for (const skill of all) counts[skillTemperature(skill, now).group] += 1
  return counts
}

export function summarize(all, days, now = Date.now()) {
  const installed = all.filter((skill) => skill.scope !== 'missing')
  const ranked = orderSkills(all, days, now)
  const top = ranked[0] && usesInRange(ranked[0], days, now) ? ranked[0] : null
  return {
    installed: installed.length,
    usedInRange: all.filter((skill) => usesInRange(skill, days, now) > 0).length,
    neverUsed: installed.filter((skill) => !skill.lastUsedAt).length,
    top: top ? { name: top.name, uses: usesInRange(top, days, now) } : null,
  }
}

export function skillTip(skill, warmth, now = Date.now()) {
  const rows = []
  if (skill.lastUsedAt) rows.push(['Last used', ago(skill.lastUsedAt, now)])
  if (skill.firstUsedAt) rows.push(['First used', ago(skill.firstUsedAt, now)])
  rows.push(['Warm', 'Hot under 1h, Warm under 1 day'], ['Cool', 'Cooling under 7 days, Cold after'])
  return { heading: warmth.label, text: MEANING[warmth.tier], rows }
}

export const SCOPE_LABELS = { global: 'Global', project: 'Project', missing: 'Not on disk' }

export function scopeLabel(skill) {
  if (skill.scope === 'project') return skill.project ?? 'Project'
  if (skill.scope === 'missing') return SCOPE_LABELS.missing
  return skill.source === 'plugin' ? 'Plugin' : SCOPE_LABELS.global
}
