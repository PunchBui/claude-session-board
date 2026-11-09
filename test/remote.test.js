import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRemoteConfig, sessionValue, sessionCookie, cookieOf, isAuthed, safeEqual, createLoginLimiter, LOGIN_PAGE } from '../lib/remote.js'

const TOKEN = 'a'.repeat(32)
const fileWith = async (value) => {
  const file = join(await mkdtemp(join(tmpdir(), 'remote-')), 'remote.json')
  if (value !== undefined) await writeFile(file, JSON.stringify(value))
  return file
}

test('no config file means remote access is off', async () => {
  assert.deepEqual(await readRemoteConfig({ file: await fileWith(), env: {} }), { hosts: [], token: null })
})

test('hosts and token are read from the file, normalised', async () => {
  const file = await fileWith({ hosts: ['Mac.Tail1234.ts.net.'], token: TOKEN })
  assert.deepEqual(await readRemoteConfig({ file, env: {} }), { hosts: ['mac.tail1234.ts.net'], token: TOKEN })
})

test('environment variables override the file', async () => {
  const file = await fileWith({ hosts: ['a.ts.net'], token: TOKEN })
  const config = await readRemoteConfig({ file, env: { REMOTE_HOSTS: 'b.ts.net, c.ts.net', BOARD_TOKEN: 'b'.repeat(30) } })
  assert.deepEqual(config, { hosts: ['b.ts.net', 'c.ts.net'], token: 'b'.repeat(30) })
})

test('remote hosts without a strong token refuse to start', async () => {
  await assert.rejects(readRemoteConfig({ file: await fileWith({ hosts: ['a.ts.net'], token: 'short' }), env: {} }), /token/)
  await assert.rejects(readRemoteConfig({ file: await fileWith({ hosts: ['a.ts.net'] }), env: {} }), /token/)
})

test('a malformed host is rejected', async () => {
  await assert.rejects(readRemoteConfig({ file: await fileWith({ hosts: ['evil.com/x'], token: TOKEN }), env: {} }), /Invalid remote host/)
})

test('the login cookie authenticates, anything else does not', () => {
  const header = `theme=dark; board_auth=${sessionValue(TOKEN)}`
  assert.equal(isAuthed(header, TOKEN), true)
  assert.equal(isAuthed(`board_auth=${sessionValue('c'.repeat(32))}`, TOKEN), false)
  assert.equal(isAuthed(`board_auth=${TOKEN}`, TOKEN), false)
  assert.equal(isAuthed('', TOKEN), false)
  assert.equal(isAuthed(undefined, TOKEN), false)
  assert.equal(isAuthed(header, ''), false)
})

test('the session cookie is HttpOnly, Secure and SameSite=Strict, and never holds the raw token', () => {
  const cookie = sessionCookie(TOKEN)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /Secure/)
  assert.match(cookie, /SameSite=Strict/)
  assert.ok(!cookie.includes(TOKEN))
})

test('cookieOf finds a named cookie and ignores lookalikes', () => {
  assert.equal(cookieOf('x_board_auth=1; board_auth=2'), '2')
  assert.equal(cookieOf('a=1'), null)
})

test('safeEqual compares values of different length without throwing', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abcd'), false)
})

test('the limiter blocks after repeated failures and recovers after the window', () => {
  let clock = 0
  const limiter = createLoginLimiter({ max: 3, windowMs: 1000, now: () => clock })
  for (let i = 0; i < 3; i++) { assert.equal(limiter.blocked(), false); limiter.fail() }
  assert.equal(limiter.blocked(), true)
  clock = 1001
  assert.equal(limiter.blocked(), false)
  limiter.fail()
  limiter.reset()
  assert.equal(limiter.blocked(), false)
})

test('one client being blocked does not block another', () => {
  const limiter = createLoginLimiter({ max: 2 })
  limiter.fail('1.1.1.1'); limiter.fail('1.1.1.1')
  assert.equal(limiter.blocked('1.1.1.1'), true)
  assert.equal(limiter.blocked('2.2.2.2'), false)
  limiter.reset('1.1.1.1')
  assert.equal(limiter.blocked('1.1.1.1'), false)
})

test('the limiter forgets old keys beyond its cap', () => {
  const limiter = createLoginLimiter({ max: 1, maxKeys: 2 })
  limiter.fail('a'); limiter.fail('b'); limiter.fail('c')
  assert.equal(limiter.blocked('a'), false)
  assert.equal(limiter.blocked('c'), true)
})

test('the login page posts to /api/login', () => {
  assert.match(LOGIN_PAGE, /\/api\/login/)
})
