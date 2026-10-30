import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveClaudeBin, claudeSearchDirs } from '../lib/claudebin.js'

test('an explicit CLAUDE_BIN always wins', () => {
  assert.equal(resolveClaudeBin({ configured: '/custom/claude', exists: () => false }), '/custom/claude')
})

test('finds claude in ~/.local/bin even when PATH is minimal', () => {
  const found = resolveClaudeBin({ pathEnv: '/usr/bin:/bin', home: '/Users/me', exists: (path) => path === '/Users/me/.local/bin/claude' })
  assert.equal(found, '/Users/me/.local/bin/claude')
})

test('prefers a directory earlier on PATH', () => {
  const found = resolveClaudeBin({ pathEnv: '/first:/second', home: '/Users/me', exists: (path) => path.endsWith('/claude') })
  assert.equal(found, '/first/claude')
})

test('falls back to the bare name when nothing is found', () => {
  assert.equal(resolveClaudeBin({ pathEnv: '/usr/bin', home: '/Users/me', exists: () => false }), 'claude')
})

test('search dirs are unique and keep PATH order first', () => {
  const dirs = claudeSearchDirs({ pathEnv: '/usr/local/bin:/usr/bin', home: '/h' })
  assert.deepEqual(dirs.slice(0, 2), ['/usr/local/bin', '/usr/bin'])
  assert.equal(new Set(dirs).size, dirs.length)
})
