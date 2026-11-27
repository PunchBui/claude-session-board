import test from 'node:test'
import assert from 'node:assert/strict'
import { overlapsOf, modifiedPaths } from '../lib/overlap.js'
import { overlapFor, commitOnlyPrompt, relativeTo } from '../public/overlapwarn.js'

const NOW = Date.parse('2026-11-27T10:00:00Z')
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString()
const entry = (id, files, over = {}) => ({ id, title: `Session ${id}`, cwd: '/w/app', files: new Map(files.map(([path, ago]) => [path, { lastAt: at(ago) }])), ...over })

test('a file edited by two sessions in the same folder is an overlap, newest session first', () => {
  const result = overlapsOf([entry('a', [['/w/app/src/x.js', 30]]), entry('b', [['/w/app/src/x.js', 5], ['/w/app/y.js', 5]])], { nowMs: NOW })
  assert.equal(result.length, 1)
  assert.equal(result[0].path, '/w/app/src/x.js')
  assert.deepEqual(result[0].sessions.map((s) => s.id), ['b', 'a'])
})

test('edits older than a day, outside the session folder or in node_modules do not count', () => {
  assert.equal(overlapsOf([entry('a', [['/w/app/x.js', 25 * 60]]), entry('b', [['/w/app/x.js', 5]])], { nowMs: NOW }).length, 0)
  assert.equal(overlapsOf([entry('a', [['/Users/me/.claude/notes.md', 5]]), entry('b', [['/Users/me/.claude/notes.md', 5]])], { nowMs: NOW }).length, 0)
  assert.equal(overlapsOf([entry('a', [['/w/app/node_modules/p/i.js', 5]]), entry('b', [['/w/app/node_modules/p/i.js', 5]])], { nowMs: NOW }).length, 0)
})

test('one session editing a file many times is not an overlap', () => {
  assert.equal(overlapsOf([entry('a', [['/w/app/x.js', 5]])], { nowMs: NOW }).length, 0)
})

test('modified paths are read from porcelain status, renames to their new name', () => {
  const paths = modifiedPaths(' M src/x.js\n?? new.js\nR  old.js -> moved.js\n', '/w/app')
  assert.deepEqual([...paths].sort(), ['/w/app/moved.js', '/w/app/new.js', '/w/app/src/x.js'])
  assert.equal(modifiedPaths('', '/w/app').size, 0)
})

test('overlaps are narrowed to the session asked about', () => {
  const overlaps = overlapsOf([entry('a', [['/w/app/x.js', 30]]), entry('b', [['/w/app/x.js', 5]])], { nowMs: NOW })
  assert.deepEqual(overlapFor(overlaps, 'a').map((o) => [o.path, o.others.map((s) => s.id)]), [['/w/app/x.js', ['b']]])
  assert.deepEqual(overlapFor(overlaps, 'zzz'), [])
})

test('the commit prompt names the file, the other session and the stop rule', () => {
  const prompt = commitOnlyPrompt('/w/app/public/app.js', '/w/app', [{ title: 'Fix focus lag' }])
  assert.match(prompt, /Commit only public\/app\.js/)
  assert.match(prompt, /"Fix focus lag"/)
  assert.match(prompt, /ask me before committing/)
})

test('paths inside the folder are shown relative to it', () => {
  assert.equal(relativeTo('/w/app/src/x.js', '/w/app'), 'src/x.js')
  assert.equal(relativeTo('/elsewhere/x.js', '/w/app'), '/elsewhere/x.js')
  assert.equal(relativeTo('/w/app/x.js', null), '/w/app/x.js')
})
