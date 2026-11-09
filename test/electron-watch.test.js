import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { classify, createBatcher } = createRequire(import.meta.url)('../electron/watch.cjs')
const repo = '/r'

test('files the browser loads trigger a page reload', () => {
  for (const file of ['public/app.js', 'public/app.css', 'public/index.html', 'public/icons.js', 'public/manifest.webmanifest', 'public/sub/x.svg']) assert.equal(classify(repo, `${repo}/${file}`), 'page', file)
})

test('server code triggers a restart', () => {
  for (const file of ['server.js', 'lib/runs.js', 'lib/sub/x.js']) assert.equal(classify(repo, `${repo}/${file}`), 'server', file)
})

test('tests, data, docs, editor temp files and outside paths are ignored', () => {
  for (const file of ['test/runs.test.js', 'lib/runs.test.js', 'data/focus.json', 'README.md', 'public/.app.js.swp', 'public/app.js~', 'public/.DS_Store', 'lib/.#runs.js', 'electron/main.js', 'package.json']) assert.equal(classify(repo, `${repo}/${file}`), null, file)
  assert.equal(classify(repo, '/elsewhere/public/app.js'), null)
  assert.equal(classify(repo, repo), null)
})

test('the batcher fires once per burst and lets a server change win', () => {
  const timers = []
  const fired = []
  const batch = createBatcher((kind) => fired.push(kind), { setTimer: (fn, ms) => timers.push({ fn, ms }) - 1, clearTimer: (id) => { if (timers[id]) timers[id].fn = null } })
  batch('page')
  batch('page')
  batch('server')
  batch('page')
  batch(null)
  for (const t of timers) t.fn?.()
  assert.deepEqual(fired, ['server'])
  assert.equal(timers.at(-1).ms, 500)
})

test('a lone page change waits the short delay', () => {
  const timers = []
  const fired = []
  const batch = createBatcher((kind) => fired.push(kind), { setTimer: (fn, ms) => timers.push({ fn, ms }) - 1, clearTimer: () => {} })
  batch('page')
  assert.equal(timers[0].ms, 150)
  timers[0].fn()
  assert.deepEqual(fired, ['page'])
})
