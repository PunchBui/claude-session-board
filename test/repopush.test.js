import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitMessage, createRepoPusher } from '../lib/repopush.js'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

function makeRepos() {
  const root = mkdtempSync(join(tmpdir(), 'repopush-'))
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const other = join(root, 'other')
  execFileSync('git', ['init', '--bare', '-b', 'main', origin])
  for (const dir of [work, other]) {
    execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'ignore' })
    git(dir, 'config', 'user.name', 'Test')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'checkout', '-q', '-B', 'main')
  }
  writeFileSync(join(work, 'a.txt'), 'one\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'first')
  git(work, 'push', '-q', '-u', 'origin', 'main')
  git(other, 'pull', '-q', 'origin', 'main')
  return { root, origin, work, other }
}

test('the message names up to three files and counts the rest', () => {
  const file = (path) => ({ code: 'M', path })
  assert.equal(commitMessage([file('lib/git.js')]), 'Update git.js')
  assert.equal(commitMessage([file('a/x.js'), file('b/x.js'), file('y.css')]), 'Update x.js, y.css')
  assert.equal(commitMessage([file('a.js'), file('b.js'), file('c.js'), file('d.js'), file('e.js')]), 'Update a.js, b.js and 3 more files')
  assert.equal(commitMessage([file('old.js -> new.js')]), 'Update new.js')
  assert.equal(commitMessage([]), 'Update')
})

test('uncommitted files are committed and pushed to origin', async () => {
  const { root, origin, work } = makeRepos()
  try {
    writeFileSync(join(work, 'a.txt'), 'two\n')
    writeFileSync(join(work, 'b.txt'), 'new\n')
    const result = await createRepoPusher({ cwd: work })()
    assert.deepEqual(result, { ok: true, committed: 'Update a.txt, b.txt' })
    assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'Update a.txt, b.txt')
    assert.equal(git(work, 'status', '--porcelain'), '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('commits that are already made are pushed without a new commit', async () => {
  const { root, origin, work } = makeRepos()
  try {
    writeFileSync(join(work, 'a.txt'), 'two\n')
    git(work, 'commit', '-q', '-am', 'my own message')
    const result = await createRepoPusher({ cwd: work })()
    assert.deepEqual(result, { ok: true, committed: null })
    assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'my own message')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('it refuses to push while origin has commits that are not pulled, and leaves the files alone', async () => {
  const { root, origin, work, other } = makeRepos()
  try {
    writeFileSync(join(other, 'c.txt'), 'remote\n')
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'remote change')
    git(other, 'push', '-q', 'origin', 'main')
    writeFileSync(join(work, 'a.txt'), 'local\n')
    const result = await createRepoPusher({ cwd: work })()
    assert.equal(result.ok, false)
    assert.equal(result.status, 409)
    assert.match(result.error, /Pull first/)
    assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'remote change')
    assert.match(git(work, 'status', '--porcelain'), /a\.txt/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a second push while one is running is turned away', async () => {
  const { root, work } = makeRepos()
  try {
    writeFileSync(join(work, 'a.txt'), 'two\n')
    const push = createRepoPusher({ cwd: work })
    const [first, second] = await Promise.all([push(), push()])
    assert.equal(first.ok, true)
    assert.equal(second.status, 409)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a folder without git reports an error instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nogit-'))
  try {
    const result = await createRepoPusher({ cwd: dir })()
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
