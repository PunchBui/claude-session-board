import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic, readJsonQuarantine } from '../lib/atomic.js'

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-atomic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a written store reads back and leaves no temp file behind', async (t) => {
  const dir = scratch(t)
  const file = join(dir, 'queue.json')
  await writeJsonAtomic(file, { items: [1, 2] })
  assert.deepEqual(await readJsonQuarantine(file, null), { items: [1, 2] })
  assert.deepEqual(readdirSync(dir), ['queue.json'])
})

test('writing creates the missing directory', async (t) => {
  const file = join(scratch(t), 'data', 'nested', 'focus.json')
  await writeJsonAtomic(file, { ids: [] })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ids: [] })
})

test('a rewrite replaces the previous content whole', async (t) => {
  const file = join(scratch(t), 'a.json')
  await writeJsonAtomic(file, { long: 'x'.repeat(5000) })
  await writeJsonAtomic(file, { short: 1 })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { short: 1 })
})

test('concurrent writes never leave a torn file and the last call wins', async (t) => {
  const dir = scratch(t)
  const file = join(dir, 'runs.json')
  const writes = Array.from({ length: 60 }, (_, index) => writeJsonAtomic(file, { index, padding: 'y'.repeat(index * 200) }))
  const seen = []
  const watcher = setInterval(() => {
    try {
      seen.push(JSON.parse(readFileSync(file, 'utf8')).index)
    } catch (error) {
      if (error.code !== 'ENOENT') seen.push(error)
    }
  }, 1)
  await Promise.all(writes)
  clearInterval(watcher)
  assert.ok(seen.every((value) => typeof value === 'number'), 'a reader saw a partial file')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).index, 59)
  assert.deepEqual(readdirSync(dir), ['runs.json'])
})

test('a failed write rejects, cleans up, and does not block the next write', async (t) => {
  const dir = scratch(t)
  const file = join(dir, 'blocked', 'x.json')
  writeFileSync(join(dir, 'blocked'), 'a file where a directory should be')
  await assert.rejects(writeJsonAtomic(file, { a: 1 }))
  const good = join(dir, 'ok.json')
  await writeJsonAtomic(good, { a: 1 })
  assert.deepEqual(JSON.parse(readFileSync(good, 'utf8')), { a: 1 })
})

test('a missing file returns the fallback and creates nothing', async (t) => {
  const dir = scratch(t)
  assert.deepEqual(await readJsonQuarantine(join(dir, 'nope.json'), { ids: [] }), { ids: [] })
  assert.deepEqual(readdirSync(dir), [])
})

test('a truncated file is kept as .corrupt-<timestamp> and the fallback is returned', async (t) => {
  const dir = scratch(t)
  const file = join(dir, 'queue.json')
  const original = JSON.stringify({ s1: { items: [{ prompt: 'keep me' }] } }, null, 2)
  writeFileSync(file, original.slice(0, original.length - 9))
  const reports = []
  const value = await readJsonQuarantine(file, {}, { now: () => 1234, onCorrupt: (info) => reports.push(info) })
  assert.deepEqual(value, {})
  assert.equal(existsSync(file), false)
  assert.equal(readFileSync(`${file}.corrupt-1234`, 'utf8'), original.slice(0, original.length - 9))
  assert.equal(reports.length, 1)
  assert.equal(reports[0].kept, `${file}.corrupt-1234`)
})

test('an empty file counts as corrupt', async (t) => {
  const dir = scratch(t)
  const file = join(dir, 'schedules.json')
  writeFileSync(file, '')
  assert.deepEqual(await readJsonQuarantine(file, { items: [] }, { now: () => 7 }), { items: [] })
  assert.ok(existsSync(`${file}.corrupt-7`))
})

test('after quarantine a fresh write does not touch the kept copy', async (t) => {
  const dir = scratch(t)
  const file = join(dir, 'snippets.json')
  writeFileSync(file, '{"items": [')
  await readJsonQuarantine(file, null, { now: () => 9 })
  await writeJsonAtomic(file, { items: [] })
  assert.equal(readFileSync(`${file}.corrupt-9`, 'utf8'), '{"items": [')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { items: [] })
})
