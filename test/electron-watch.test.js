import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { WATCHED, changedFile, classify, createBatcher } = createRequire(import.meta.url)('../electron/watch.cjs')
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

test('every watched target resolves the names fs.watch reports to the right file', () => {
  const kindOf = (dir, name) => classify(repo, changedFile(repo, dir, name))
  assert.equal(kindOf('.', 'server.js'), 'server')
  assert.equal(kindOf('.', 'package.json'), null)
  assert.equal(kindOf('.', 'README.md'), null)
  assert.equal(kindOf('.', null), null)
  assert.equal(kindOf('lib', 'runs.js'), 'server')
  assert.equal(kindOf('lib', 'sub/x.js'), 'server')
  assert.equal(kindOf('public', 'app.js'), 'page')
  assert.equal(kindOf('public', null), null)
  assert.deepEqual(WATCHED.map(({ dir, recursive }) => [dir, recursive]), [['public', true], ['lib', true], ['.', false]])
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
