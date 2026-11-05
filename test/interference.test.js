import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanAppended, createDesktopWatcher, guardAgainstDesktop } from '../lib/interference.js'

const line = (over = {}) => JSON.stringify({ type: 'assistant', entrypoint: 'sdk-cli', isSidechain: false, message: {}, ...over }) + '\n'
const desktop = (over = {}) => line({ entrypoint: 'claude-desktop', ...over })
const scan = (text, carry = Buffer.alloc(0)) => scanAppended(carry, Buffer.from(text))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a desktop conversation entry is detected', () => {
  assert.equal(scan(desktop({ type: 'user' })).found, true)
  assert.equal(scan(desktop({ type: 'assistant' })).found, true)
})

test('entries written by the board run are ignored', () => {
  assert.equal(scan(line({ type: 'user' }) + line({ type: 'assistant' })).found, false)
})

test('records that are not conversation entries are ignored even when they carry the desktop entrypoint', () => {
  const records = ['attachment', 'system', 'last-prompt', 'cost-state'].map((type) => desktop({ type })).join('')
  assert.equal(scan(records).found, false)
  assert.equal(scan(JSON.stringify({ type: 'last-prompt' }) + '\n').found, false)
})

test('a sidechain desktop entry is ignored', () => {
  assert.equal(scan(desktop({ isSidechain: true })).found, false)
})

test('malformed lines do not throw and are skipped', () => {
  assert.equal(scan('{not json\n' + desktop()).found, true)
  assert.equal(scan('{not json\n').found, false)
})

test('a line split across two chunks is detected once it completes', () => {
  const whole = desktop({ type: 'user' })
  const cut = Math.floor(whole.length / 2)
  const first = scanAppended(Buffer.alloc(0), Buffer.from(whole.slice(0, cut)))
  assert.equal(first.found, false)
  const second = scanAppended(first.carry, Buffer.from(whole.slice(cut)))
  assert.equal(second.found, true)
  assert.equal(second.carry.length, 0)
})

test('a multibyte character split across chunks survives the carry', () => {
  const bytes = Buffer.from(desktop({ type: 'user', message: { content: 'héllo wörld' } }))
  const cut = bytes.indexOf(0xc3) + 1
  const first = scanAppended(Buffer.alloc(0), bytes.subarray(0, cut))
  assert.equal(scanAppended(first.carry, bytes.subarray(cut)).found, true)
})

test('an incomplete trailing line is held back until its newline arrives', () => {
  const partial = desktop().trimEnd()
  const first = scanAppended(Buffer.alloc(0), Buffer.from(partial))
  assert.equal(first.found, false)
  assert.equal(scanAppended(first.carry, Buffer.from('\n')).found, true)
})

async function inTempDir(body) {
  const dir = await mkdtemp(join(tmpdir(), 'interference-'))
  try {
    await body(join(dir, 'session.jsonl'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the watcher starts at the end of the file so earlier desktop history is not counted', () =>
  inTempDir(async (path) => {
    const history = desktop({ type: 'user' }) + desktop({ type: 'assistant' })
    await writeFile(path, history)
    const watcher = createDesktopWatcher(path)
    assert.equal(watcher.offset(), Buffer.byteLength(history))
    assert.equal(await watcher.poll(), false)
  }))

test('poll reads only appended bytes and reports desktop writes once they land', () =>
  inTempDir(async (path) => {
    await writeFile(path, desktop({ type: 'user' }))
    const watcher = createDesktopWatcher(path)
    await appendFile(path, line({ type: 'assistant' }))
    assert.equal(await watcher.poll(), false)
    await appendFile(path, line({ type: 'user' }))
    assert.equal(await watcher.poll(), false)
    await appendFile(path, desktop({ type: 'user' }))
    assert.equal(await watcher.poll(), true)
    assert.equal(await watcher.poll(), true)
  }))

test('poll handles a desktop line that is written in two pieces', () =>
  inTempDir(async (path) => {
    await writeFile(path, '')
    const watcher = createDesktopWatcher(path)
    const whole = desktop({ type: 'user' })
    await appendFile(path, whole.slice(0, 20))
    assert.equal(await watcher.poll(), false)
    await appendFile(path, whole.slice(20))
    assert.equal(await watcher.poll(), true)
  }))

test('a watcher with no transcript never reports interference', async () => {
  const watcher = createDesktopWatcher(null)
  assert.equal(await watcher.poll(), false)
})

test('a missing file is tolerated and a file created later is read from the start', () =>
  inTempDir(async (path) => {
    const watcher = createDesktopWatcher(path)
    assert.equal(await watcher.poll(), false)
    await writeFile(path, desktop())
    assert.equal(await watcher.poll(), true)
  }))

test('the guard stops the run once and flags it, and the returned cleanup stops the polling', () =>
  inTempDir(async (path) => {
    await writeFile(path, '')
    let stops = 0
    const run = { interfered: false, stop: () => { stops += 1 } }
    const unguard = guardAgainstDesktop(run, path, { intervalMs: 10 })
    await pause(40)
    assert.equal(stops, 0)
    await appendFile(path, desktop())
    await pause(80)
    assert.equal(run.interfered, true)
    assert.equal(stops, 1)
    unguard()
  }))

test('a cleaned-up guard does not stop a run that has already exited', () =>
  inTempDir(async (path) => {
    await writeFile(path, '')
    let stops = 0
    const run = { interfered: false, stop: () => { stops += 1 } }
    const unguard = guardAgainstDesktop(run, path, { intervalMs: 10 })
    unguard()
    await appendFile(path, desktop())
    await pause(60)
    assert.equal(stops, 0)
    assert.equal(run.interfered, false)
  }))
