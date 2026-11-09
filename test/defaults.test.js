import test from 'node:test'
import assert from 'node:assert/strict'
import { readNewSessionDefaults } from '../lib/defaults.js'

const files = (map) => async (file) => {
  if (file in map) return JSON.stringify(map[file])
  throw new Error('ENOENT')
}

test('user settings supply the model and effort', async () => {
  const read = files({ '/h/.claude/settings.json': { model: 'sonnet', effortLevel: 'high' } })
  assert.deepEqual(await readNewSessionDefaults({ home: '/h', folder: '/p', permissionMode: 'plan', read }), { model: 'sonnet', effort: 'high', permissionMode: 'plan' })
})

test('project settings beat user settings, and local beats shared', async () => {
  const read = files({
    '/h/.claude/settings.json': { model: 'sonnet', effortLevel: 'high' },
    '/h/.claude/settings.local.json': { model: 'haiku' },
    '/p/.claude/settings.json': { model: 'opus' },
    '/p/.claude/settings.local.json': { effortLevel: 'low' },
  })
  assert.deepEqual(await readNewSessionDefaults({ home: '/h', folder: '/p', permissionMode: 'x', read }), { model: 'opus', effort: 'low', permissionMode: 'x' })
  assert.equal((await readNewSessionDefaults({ home: '/h', folder: '/other', permissionMode: 'x', read })).model, 'haiku')
})

test('missing, broken or odd files leave the value unset', async () => {
  const read = async (file) => (file.endsWith('settings.json') ? '{broken' : JSON.stringify({ model: 5, effortLevel: '' }))
  assert.deepEqual(await readNewSessionDefaults({ home: '/h', folder: null, permissionMode: 'p', read }), { model: null, effort: null, permissionMode: 'p' })
})
