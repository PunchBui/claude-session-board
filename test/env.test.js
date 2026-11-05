import test from 'node:test'
import assert from 'node:assert/strict'
import { mergePaths, pathFromShellOutput, loginShellPath, resolveSpawnEnv } from '../lib/env.js'

test('mergePaths keeps order and drops duplicates and empties', () => {
  assert.equal(mergePaths('/a:/b', '/b:/c', undefined, '', ':/d:'), '/a:/b:/c:/d')
})

test('the path is read out from between the markers, ignoring shell noise', () => {
  const noisy = 'welcome banner\n__BOARD_PATH__/opt/homebrew/bin:/usr/bin__BOARD_PATH__\ntrailing'
  assert.equal(pathFromShellOutput(noisy), '/opt/homebrew/bin:/usr/bin')
  assert.equal(pathFromShellOutput('nothing here'), '')
})

test('the login shell is asked for its PATH and failures fall back to empty', async () => {
  let asked
  const ok = await loginShellPath({ shell: '/bin/zsh', run: (bin, args, options, done) => { asked = { bin, args, options }; done(null, '__BOARD_PATH__/x/bin:/y/bin__BOARD_PATH__') } })
  assert.equal(ok, '/x/bin:/y/bin')
  assert.equal(asked.bin, '/bin/zsh')
  assert.deepEqual(asked.args.slice(0, 1), ['-ilc'])
  assert.ok(asked.options.timeout > 0)
  assert.equal(await loginShellPath({ run: (bin, args, options, done) => done(new Error('boom'), '') }), '')
})

test('the spawn env puts the login PATH first and keeps everything else', async () => {
  const env = await resolveSpawnEnv({ base: { PATH: '/usr/bin:/bin', KEEP: '1' }, shellPath: async () => '/Users/me/.nvm/bin:/opt/homebrew/bin', home: '/Users/me' })
  assert.equal(env.KEEP, '1')
  const parts = env.PATH.split(':')
  assert.equal(parts[0], '/Users/me/.nvm/bin')
  assert.ok(parts.includes('/opt/homebrew/bin'))
  assert.ok(parts.includes('/Users/me/.local/bin'))
  assert.equal(new Set(parts).size, parts.length)
})

test('with no login PATH the minimal PATH still gains the usual tool directories', async () => {
  const env = await resolveSpawnEnv({ base: { PATH: '/usr/bin:/bin' }, shellPath: async () => '', home: '/Users/me' })
  assert.ok(env.PATH.split(':').includes('/opt/homebrew/bin'))
})
