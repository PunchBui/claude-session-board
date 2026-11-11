import test from 'node:test'
import assert from 'node:assert/strict'
import { noteSessionSetting, runSettings, shownSettings } from '../lib/sessionsettings.js'
import { newScanState, absorbLine } from '../lib/scan.js'

test('only a /model or /effort that Claude accepted is remembered', () => {
  const settings = {}
  noteSessionSetting(settings, { command: 'model', args: 'bogus' }, "Model 'bogus' not found")
  noteSessionSetting(settings, { command: 'effort', args: 'turbo' }, 'Invalid argument: turbo.')
  noteSessionSetting(settings, { command: 'model', args: '' }, 'Current model: Haiku')
  assert.deepEqual(settings, {})
  noteSessionSetting(settings, { command: 'model', args: 'sonnet' }, 'Set model to `Sonnet 5.5` for this session only')
  noteSessionSetting(settings, { command: 'effort', args: 'high' }, 'Set effort level to high (this session only): …')
  assert.deepEqual(settings, { model: 'sonnet', effort: 'high' })
  noteSessionSetting(settings, { command: 'model', args: 'default' }, 'Set model to `Sonnet 5.5 (default)` for this session only')
  noteSessionSetting(settings, { command: 'effort', args: 'auto' }, 'Effort level set to auto (this session only)')
  assert.deepEqual(settings, { model: null, effort: null })
  noteSessionSetting(settings, { command: 'effort', args: 'ultracode on' }, 'Set effort level to ultracode')
  assert.deepEqual(settings, { model: null, effort: null })
})

test('a run uses the chosen setting, else the board start setting, and never the desktop one', () => {
  const board = { source: 'board', model: 'opus', effort: 'high' }
  const desktop = { model: 'claude-opus-5', effort: 'high' }
  assert.deepEqual(runSettings(board), { model: 'opus', effort: 'high' })
  assert.deepEqual(runSettings(board, { model: null }), { model: null, effort: 'high' })
  assert.deepEqual(runSettings(desktop), { model: null, effort: null })
  assert.deepEqual(runSettings(desktop, { model: 'sonnet' }), { model: 'sonnet', effort: null })
  assert.deepEqual(shownSettings(desktop, { effort: 'low' }), { model: 'claude-opus-5', effort: 'low' })
})

test('the transcript scan picks up /model and /effort from local command entries', () => {
  const state = newScanState()
  const command = (name, args, output) => JSON.stringify({ type: 'system', subtype: 'local_command', content: `<local-command-stdout>${output}</local-command-stdout>`, commandRun: { command: name, args } })
  absorbLine(state, command('model', 'haiku', 'Set model to `Haiku 5.5` for this session only'))
  absorbLine(state, command('effort', 'max', 'Set effort level to max (this session only)'))
  absorbLine(state, command('model', 'nope', "Model 'nope' not found"))
  assert.deepEqual(state.settings, { model: 'haiku', effort: 'max' })
})
