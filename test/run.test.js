import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { spawnDetached, killGroup, logTail } from '../lib/run.js'

const RUN_MODULE = fileURLToPath(new URL('../lib/run.js', import.meta.url))
const pgidOf = (pid) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const value = check()
    if (value) return value
    await sleep(25)
  }
  throw new Error('timed out')
}

const pidFrom = (file) => Number(logTail(file, 100).trim()) || null

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a run gets its own process group', async (t) => {
  const child = spawnDetached('sleep', ['30'], { cwd: tmpdir(), logFile: join(scratch(t), 'run.log'), input: '' })
  t.after(() => killGroup(child, 'SIGKILL'))
  assert.equal(pgidOf(child.pid), child.pid)
  assert.notEqual(pgidOf(child.pid), pgidOf(process.pid))
})

test('the prompt goes to stdin and stderr goes to the log file', async (t) => {
  const logFile = join(scratch(t), 'nested', 'run.log')
  const child = spawnDetached('sh', ['-c', 'cat >&2; exit 3'], { cwd: tmpdir(), logFile, input: 'hello from the board' })
  const [code] = await once(child, 'close')
  assert.equal(code, 3)
  assert.equal(readFileSync(logFile, 'utf8'), 'hello from the board')
  assert.equal(logTail(logFile, 5), 'board')
})

test('a run gets the environment it is given', async (t) => {
  const logFile = join(scratch(t), 'run.log')
  const child = spawnDetached('sh', ['-c', 'echo "$BOARD_TEST_PATH" >&2'], { cwd: tmpdir(), logFile, input: '', env: { ...process.env, BOARD_TEST_PATH: '/custom/bin' } })
  await once(child, 'close')
  assert.equal(readFileSync(logFile, 'utf8'), '/custom/bin\n')
})

test('each run starts with an empty log', async (t) => {
  const logFile = join(scratch(t), 'run.log')
  await once(spawnDetached('sh', ['-c', 'echo first >&2'], { cwd: tmpdir(), logFile, input: '' }), 'close')
  await once(spawnDetached('sh', ['-c', 'echo second >&2'], { cwd: tmpdir(), logFile, input: '' }), 'close')
  assert.equal(readFileSync(logFile, 'utf8'), 'second\n')
})

test('stopping a run also stops what it started', async (t) => {
  const logFile = join(scratch(t), 'run.log')
  const child = spawnDetached('sh', ['-c', 'sleep 30 & echo $! >&2; wait'], { cwd: tmpdir(), logFile, input: '' })
  const grandchild = await waitFor(() => pidFrom(logFile))
  t.after(() => alive(grandchild) && process.kill(grandchild, 'SIGKILL'))
  killGroup(child)
  await once(child, 'close')
  await waitFor(() => !alive(grandchild))
})

test('a run survives its board being killed the way launchd does it', async (t) => {
  const dir = scratch(t)
  const logFile = join(dir, 'run.log')
  const board = `
    import { spawnDetached } from ${JSON.stringify(RUN_MODULE)}
    spawnDetached('sh', ['-c', 'echo $$ >&2; sleep 30'], { cwd: ${JSON.stringify(dir)}, logFile: ${JSON.stringify(logFile)}, input: '' })
    setInterval(() => {}, 1000)
  `
  const server = spawn(process.execPath, ['--input-type=module', '-e', board], { detached: true, stdio: 'ignore' })
  const run = await waitFor(() => pidFrom(logFile))
  t.after(() => alive(run) && process.kill(-run, 'SIGKILL'))
  process.kill(-server.pid, 'SIGKILL')
  await once(server, 'close')
  await sleep(200)
  assert.ok(alive(run), 'the run died with the board')
})

test('logTail is empty when there is no log', () => {
  assert.equal(logTail(join(tmpdir(), 'board-run-missing', 'nope.log'), 100), '')
})
