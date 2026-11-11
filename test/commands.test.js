import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { listCommands, parseFrontmatter, BLOCKED_PROMPT, initCommands, probeSlashCommands } from '../lib/commands.js'

const write = (path, body) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

test('parseFrontmatter reads plain and block-scalar values', () => {
  const fields = parseFrontmatter('---\nname: demo\ndescription: >\n  First line\n  second line\nargument-hint: "[topic]"\n---\nbody')
  assert.equal(fields.name, 'demo')
  assert.equal(fields.description, 'First line second line')
  assert.equal(fields['argument-hint'], '[topic]')
  assert.deepEqual(parseFrontmatter('no frontmatter'), {})
})

test('lists project, user, skill and plugin commands plus built-ins, project first', async () => {
  const home = mkdtempSync(join(tmpdir(), 'csb-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'csb-cwd-'))
  write(join(cwd, '.claude/commands/deploy.md'), '---\ndescription: Deploy it\n---\nbody')
  write(join(home, '.claude/commands/team/review.md'), '---\ndescription: Review\nargument-hint: "[pr]"\n---\nbody')
  write(join(home, '.claude/skills/helper/SKILL.md'), '---\nname: helper\ndescription: Helps\n---\nbody')
  const plugin = join(home, 'plugin-install')
  write(join(plugin, 'commands/scan.md'), '---\ndescription: Scan\n---\nbody')
  write(join(plugin, 'skills/lint/SKILL.md'), '---\nname: lint\ndescription: Lint\n---\nbody')
  write(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'tools@market': [{ installPath: plugin }] } }))
  write(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'tools@market': true } }))

  const items = await listCommands({ cwd, home })
  const names = items.map((item) => `${item.source}:${item.name}`)
  assert.equal(names[0], 'project:deploy')
  assert.ok(names.includes('user:team:review'))
  assert.ok(names.includes('skill:helper'))
  assert.ok(names.includes('plugin:tools:scan'))
  assert.ok(names.includes('plugin:tools:lint'))
  assert.ok(names.includes('built-in:compact'))
  assert.equal(items.find((item) => item.name === 'team:review').hint, '[pr]')
  assert.equal(items.find((item) => item.name === 'deploy').description, 'Deploy it')
})

test('a disabled plugin is skipped and commands that start new sessions are never listed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'csb-home-'))
  const plugin = join(home, 'p')
  write(join(plugin, 'commands/hidden.md'), 'x')
  write(join(home, '.claude/commands/clear.md'), 'x')
  write(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'off@m': [{ installPath: plugin }] } }))
  write(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'off@m': false } }))
  const items = await listCommands({ cwd: null, home })
  assert.ok(!items.some((item) => item.name === 'off:hidden'))
  assert.deepEqual(items.filter((item) => item.name === 'clear').map((item) => item.source), ['board'])
})

test('commands reported by Claude Code are listed with their source, the board handles the new-session ones', async () => {
  const home = mkdtempSync(join(tmpdir(), 'csb-home-'))
  write(join(home, '.claude/skills/helper/SKILL.md'), '---\nname: helper\ndescription: Helps\n---\nbody')
  const probed = ['helper', 'model', 'rename', 'clear', 'tools:scan', 'mcp__srv__prompt', 'brand-new']
  const items = await listCommands({ cwd: null, home, probed })
  const by = (name) => items.filter((item) => item.name === name)
  assert.equal(by('helper').length, 1)
  assert.equal(by('helper')[0].description, 'Helps')
  assert.equal(by('rename')[0].source, 'built-in')
  assert.equal(by('rename')[0].hint, '[name]')
  assert.equal(by('brand-new')[0].description, '')
  assert.equal(by('tools:scan')[0].source, 'plugin')
  assert.equal(by('mcp__srv__prompt')[0].source, 'mcp')
  assert.deepEqual([...by('clear'), ...by('new'), ...by('reset')].map((item) => item.source), ['board', 'board', 'board'])
  assert.ok(!items.some((item) => item.name === 'compact'))
})

test('initCommands reads slash_commands from the init event only', () => {
  assert.deepEqual(initCommands(JSON.stringify({ type: 'system', subtype: 'init', slash_commands: ['model', '__internal', 'x:y', 3] })), ['model', 'x:y'])
  assert.equal(initCommands(JSON.stringify({ type: 'system', subtype: 'hook_started' })), null)
  assert.equal(initCommands('not json'), null)
})

function fakeClaude(lines) {
  const calls = []
  const spawn = (bin, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stdin = new PassThrough()
    child.killed = false
    child.kill = () => { child.killed = true }
    calls.push({ bin, args, options, child })
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${line}\n`)
      if (!lines.length) child.emit('close', 1)
    })
    return child
  }
  return { spawn, calls }
}

test('probeSlashCommands stops claude once it reports its commands', async () => {
  const { spawn, calls } = fakeClaude([JSON.stringify({ type: 'system', subtype: 'hook_started' }), JSON.stringify({ type: 'system', subtype: 'init', slash_commands: ['model', 'goal'] })])
  assert.deepEqual(await probeSlashCommands({ bin: 'claude', cwd: '/tmp', env: {}, spawn }), ['model', 'goal'])
  assert.ok(calls[0].args.includes('--no-session-persistence'))
  assert.equal(calls[0].options.cwd, '/tmp')
  assert.ok(calls[0].child.killed)
})

test('probeSlashCommands gives null when claude exits, fails or never answers', async () => {
  assert.equal(await probeSlashCommands({ bin: 'claude', cwd: '/tmp', env: {}, spawn: fakeClaude([]).spawn }), null)
  assert.equal(await probeSlashCommands({ bin: 'claude', cwd: '/tmp', env: {}, spawn: () => { throw new Error('nope') } }), null)
  assert.equal(await probeSlashCommands({ bin: 'claude', cwd: '/tmp', env: {}, spawn: fakeClaude(['{}']).spawn, timeoutMs: 20 }), null)
})

test('blocked prompt pattern matches commands that start a new session', () => {
  for (const value of ['/clear', ' /clear now', '/reset', '/new']) assert.ok(BLOCKED_PROMPT.test(value), value)
  for (const value of ['/compact', '/clearance', 'please /clear']) assert.ok(!BLOCKED_PROMPT.test(value), value)
})
