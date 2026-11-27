import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepoPuller } from '../lib/repopull.js'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

function makeRepos() {
  const root = mkdtempSync(join(tmpdir(), 'repopull-'))
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
  return { root, work, other }
}

function pushFromOther(other, file, text) {
  writeFileSync(join(other, file), text)
  git(other, 'add', '-A')
  git(other, 'commit', '-q', '-m', `change ${file}`)
  git(other, 'push', '-q', 'origin', 'main')
}

test('commits on origin are fetched and pulled into the checkout', async () => {
  const { root, work, other } = makeRepos()
  try {
    pushFromOther(other, 'b.txt', 'remote\n')
    pushFromOther(other, 'c.txt', 'remote\n')
    const result = await createRepoPuller({ cwd: work })()
    assert.deepEqual(result, { ok: true, pulled: 2 })
    assert.equal(readFileSync(join(work, 'c.txt'), 'utf8'), 'remote\n')
    assert.equal(git(work, 'rev-list', '--count', 'HEAD..origin/main'), '0')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('nothing is pulled when the checkout is already up to date', async () => {
  const { root, work } = makeRepos()
  try {
    assert.deepEqual(await createRepoPuller({ cwd: work })(), { ok: true, pulled: 0 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('uncommitted changes in other files survive a pull', async () => {
  const { root, work, other } = makeRepos()
  try {
    pushFromOther(other, 'b.txt', 'remote\n')
    writeFileSync(join(work, 'a.txt'), 'local edit\n')
    const result = await createRepoPuller({ cwd: work })()
    assert.deepEqual(result, { ok: true, pulled: 1 })
    assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'local edit\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a diverged branch is refused instead of merged, and the local commit is kept', async () => {
  const { root, work, other } = makeRepos()
  try {
    pushFromOther(other, 'b.txt', 'remote\n')
    writeFileSync(join(work, 'a.txt'), 'local\n')
    git(work, 'commit', '-q', '-am', 'local commit')
    const before = git(work, 'rev-parse', 'HEAD')
    const result = await createRepoPuller({ cwd: work })()
    assert.equal(result.ok, false)
    assert.equal(result.status, 409)
    assert.match(result.error, /git pull failed/)
    assert.equal(git(work, 'rev-parse', 'HEAD'), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a second pull while one is running is turned away', async () => {
  const { root, work, other } = makeRepos()
  try {
    pushFromOther(other, 'b.txt', 'remote\n')
    const pull = createRepoPuller({ cwd: work })
    const [first, second] = await Promise.all([pull(), pull()])
    assert.equal(first.ok, true)
    assert.equal(second.status, 409)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a folder without git reports an error instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nogit-'))
  try {
    const result = await createRepoPuller({ cwd: dir })()
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
