import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, utimes, readdir, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneOldFiles, RUN_LOG_TTL_MS } from '../lib/prune.js'

const DAY = 86_400_000

test('run logs and transcripts older than the limit are removed and everything else is kept', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'board-prune-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const now = Date.now()
  const make = async (name, ageDays) => {
    const path = join(dir, name)
    await writeFile(path, 'x')
    const at = new Date(now - ageDays * DAY)
    await utimes(path, at, at)
  }
  await make('old.log', 31)
  await make('old.out.jsonl', 40)
  await make('new.log', 2)
  await make('new.out.jsonl', 29)
  await make('old.txt', 90)
  await mkdir(join(dir, 'old-dir.log'))
  const removed = await pruneOldFiles(dir, { now })
  assert.deepEqual(removed.sort(), ['old.log', 'old.out.jsonl'])
  assert.deepEqual((await readdir(dir)).sort(), ['new.log', 'new.out.jsonl', 'old-dir.log', 'old.txt'])
  assert.equal(RUN_LOG_TTL_MS, 30 * DAY)
})

test('a missing folder prunes nothing', async () => {
  assert.deepEqual(await pruneOldFiles(join(tmpdir(), 'board-no-such-dir-xyz')), [])
})
