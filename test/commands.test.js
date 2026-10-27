import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCommands, parseFrontmatter, BLOCKED_PROMPT } from '../lib/commands.js'

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
  const names = (await listCommands({ cwd: null, home })).map((item) => item.name)
  assert.ok(!names.includes('off:hidden'))
  assert.ok(!names.includes('clear'))
})

test('blocked prompt pattern matches commands that start a new session', () => {
  for (const value of ['/clear', ' /clear now', '/reset', '/new']) assert.ok(BLOCKED_PROMPT.test(value), value)
  for (const value of ['/compact', '/clearance', 'please /clear']) assert.ok(!BLOCKED_PROMPT.test(value), value)
})
