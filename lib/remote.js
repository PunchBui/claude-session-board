import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'

// Remote access. The server still listens on 127.0.0.1 only; a tunnel such as
// `tailscale serve` forwards a private HTTPS hostname to it. Requests whose Host
// header is one of the configured remote hosts must carry a login cookie, because
// the board can run prompts on this machine. localhost needs no login.

export const COOKIE = 'board_auth'
export const MIN_TOKEN_LENGTH = 24
export const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365

const HOST_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/

const cleanHosts = (value) => {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',')
  return [...new Set(list.map((host) => String(host).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))]
}

// Config comes from data/remote.json ({ hosts, token }); REMOTE_HOSTS and BOARD_TOKEN override it.
export async function readRemoteConfig({ file, env = process.env }) {
  let stored = {}
  try {
    stored = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${error.message}`)
  }
  const hosts = cleanHosts(env.REMOTE_HOSTS ?? stored.hosts)
  const token = String(env.BOARD_TOKEN ?? stored.token ?? '')
  const bad = hosts.find((host) => !HOST_NAME.test(host))
  if (bad) throw new Error(`Invalid remote host "${bad}"`)
  if (hosts.length === 0) return { hosts: [], token: null }
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`Remote access needs a token of at least ${MIN_TOKEN_LENGTH} characters (run scripts/enable-remote.sh).`)
  return { hosts, token }
}

// Stateless session value: the cookie is an HMAC of the token, so changing the token logs everyone out.
export const sessionValue = (token) => createHmac('sha256', token).update('claude-session-board/session/v1').digest('hex')

const digest = (value) => createHash('sha256').update(String(value)).digest()
export const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b))

export function cookieOf(header, name = COOKIE) {
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

export function isAuthed(cookieHeader, token) {
  const sent = cookieOf(cookieHeader)
  return Boolean(token) && sent !== null && safeEqual(sent, sessionValue(token))
}

export const sessionCookie = (token) =>
  `${COOKIE}=${sessionValue(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`

// Failed logins are counted per client key (the real address a tunnel reports, e.g. CF-Connecting-IP),
// so a stranger who guesses wrong cannot lock you out. Keys are capped so the map cannot grow forever.
export function createLoginLimiter({ max = 8, windowMs = 10 * 60_000, maxKeys = 1000, now = Date.now } = {}) {
  const failures = new Map()
  const recent = (key) => {
    const list = (failures.get(key) ?? []).filter((at) => now() - at < windowMs)
    if (list.length) failures.set(key, list)
    else failures.delete(key)
    return list
  }
  return {
    blocked: (key = '') => recent(key).length >= max,
    fail: (key = '') => {
      const list = recent(key)
      list.push(now())
      failures.set(key, list)
      if (failures.size > maxKeys) failures.delete(failures.keys().next().value)
    },
    reset: (key = '') => failures.delete(key),
  }
}

// Served with status 401 so the service worker never caches it as the app shell.
export const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#262624">
<title>Sign in · Claude Session Board</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#262624;color:#ece9e1;font:16px/1.4 system-ui,sans-serif}
form{width:min(22rem,calc(100vw - 2rem));display:grid;gap:.75rem}
h1{font-size:1.1rem;margin:0}
input,button{font:inherit;padding:.7rem .8rem;border-radius:.5rem;border:1px solid #4a4944;background:#1f1e1d;color:inherit}
button{background:#d97757;border-color:#d97757;color:#1f1e1d;font-weight:600}
#msg{min-height:1.2em;color:#f0a090;margin:0;font-size:.9rem}
</style></head><body>
<form id="f"><h1>Claude Session Board</h1>
<input id="t" type="password" autocomplete="current-password" placeholder="Access token" required autofocus>
<button>Sign in</button><p id="msg" role="alert"></p></form>
<script>
document.getElementById('f').addEventListener('submit', async (event) => {
  event.preventDefault()
  const msg = document.getElementById('msg')
  msg.textContent = ''
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: document.getElementById('t').value }) })
    if (res.ok) return location.reload()
    msg.textContent = res.status === 429 ? 'Too many attempts. Try again later.' : 'Wrong token.'
  } catch { msg.textContent = 'Could not reach the board.' }
})
</script></body></html>`
