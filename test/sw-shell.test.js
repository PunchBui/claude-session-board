import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))

const shell = () => {
  const source = readFileSync(join(PUBLIC, 'sw.js'), 'utf8')
  const match = source.match(/const SHELL = \[([^\]]*)\]/)
  assert.ok(match, 'SHELL array found in sw.js')
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const importsOf = (file) => {
  const source = readFileSync(join(PUBLIC, file), 'utf8')
  const found = new Set()
  for (const m of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) found.add(m[1])
  return [...found]
}

const importGraph = (entry) => {
  const seen = new Set([entry])
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()
    for (const spec of importsOf(file)) {
      const target = posix.normalize(posix.join(posix.dirname(file), spec))
      if (!seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }
  return [...seen]
}

test('every module reachable from app.js is precached by the service worker', () => {
  const entries = new Set(shell())
  const missing = importGraph('app.js').filter((file) => !entries.has('/' + file))
  assert.deepEqual(missing, [])
})

test('every precached file path exists in public', () => {
  const absent = shell().filter((entry) => entry !== '/' && !existsSync(join(PUBLIC, entry)))
  assert.deepEqual(absent, [])
})
