import { execFile } from 'node:child_process'

const URL_USAGE = 'https://api.anthropic.com/api/oauth/usage'
const TTL = 60_000

export function shapeLimits(raw) {
  const pick = (w) => (w && typeof w.utilization === 'number' ? { percent: Math.round(w.utilization), resetsAt: w.resets_at ?? null } : null)
  return { fiveHour: pick(raw?.five_hour), weekly: pick(raw?.seven_day) }
}

export function tokenFromCredentials(text) {
  try { return JSON.parse(text)?.claudeAiOauth?.accessToken || '' } catch { return '' }
}

function keychainToken() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve('')
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (error, stdout) => resolve(error ? '' : tokenFromCredentials(stdout)))
  })
}

export function createLimitsReader({ getToken = keychainToken, fetchImpl = fetch, now = Date.now } = {}) {
  let cache = null
  let at = 0
  return async function readLimits() {
    if (cache && now() - at < TTL) return cache
    const token = await getToken()
    if (!token) return { available: false, reason: 'no Claude Code login found' }
    try {
      const res = await fetchImpl(URL_USAGE, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      cache = { available: true, ...shapeLimits(await res.json()) }
      at = now()
      return cache
    } catch (error) {
      return cache ?? { available: false, reason: String(error.message ?? error) }
    }
  }
}
