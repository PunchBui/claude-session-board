import { createHash } from 'node:crypto'

const FAST_WINDOW_MS = 16 * 60_000
const FAST_STEP_MS = 5000
const SLOW_STEP_MS = 60_000

export function timeBucket(nowMs, mtimeMs) {
  const age = Math.max(0, nowMs - (mtimeMs ?? 0))
  return Math.floor(nowMs / (age < FAST_WINDOW_MS ? FAST_STEP_MS : SLOW_STEP_MS))
}

export function cardVersion(parts) {
  return createHash('sha1').update(JSON.stringify(parts)).digest('base64url').slice(0, 12)
}

export function parseHave(text) {
  const have = new Map()
  for (const pair of String(text ?? '').split(',')) {
    const at = pair.lastIndexOf(':')
    if (at > 0) have.set(pair.slice(0, at), pair.slice(at + 1))
  }
  return have
}

export function createCardCache(limit = 60) {
  const entries = new Map()
  return {
    get(id, version) {
      const found = entries.get(id)
      return found?.version === version ? found.card : null
    },
    set(id, version, card) {
      entries.delete(id)
      entries.set(id, { version, card })
      while (entries.size > limit) entries.delete(entries.keys().next().value)
    },
    drop(id) {
      entries.delete(id)
    },
    size: () => entries.size,
  }
}

export async function focusDelta(ids, { have, versionOf, build, cache }) {
  const cards = []
  const same = []
  await Promise.all(
    ids.map(async (id) => {
      const version = await versionOf(id)
      if (have.get(id) === version) return same.push(id)
      const cached = cache.get(id, version)
      if (cached) return cards.push(cached)
      const card = { ...(await build(id)), version }
      cache.set(id, version, card)
      cards.push(card)
    })
  )
  return { cards: ids.map((id) => cards.find((card) => card.id === id)).filter(Boolean), same }
}
