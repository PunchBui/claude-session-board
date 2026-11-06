import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newScanState, absorbLine } from '../lib/scan.js'
import { listSkills, aggregateSkills, skillDetail } from '../lib/skills.js'
import { skillTemperature, visibleSkills, usesInRange, dailyUses, summarize, skillCounts } from '../public/skills.js'

const NOW = Date.parse('2026-11-06T12:00:00')
const at = (offsetMs) => new Date(NOW - offsetMs).toISOString()
const HOUR = 3_600_000
const DAY = 24 * HOUR
const feed = (state, entry) => absorbLine(state, JSON.stringify(entry))
const skillCall = (id, skill, when) => ({ type: 'assistant', timestamp: at(when), message: { id: `m${id}`, content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] } })
const slash = (name, when) => ({ type: 'user', timestamp: at(when), message: { content: `<command-name>/${name}</command-name>\n<command-args></command-args>` } })

async function skillTree() {
  const root = await mkdtemp(join(tmpdir(), 'skills-'))
  const write = async (dir, name, text) => {
    await mkdir(join(dir, name), { recursive: true })
    await writeFile(join(dir, name, 'SKILL.md'), text)
  }
  await write(join(root, 'home', '.claude', 'skills'), 'alpha', '---\nname: alpha\ndescription: Does alpha things\nargument-hint: <x>\n---\nAlpha body\n')
  await write(join(root, 'repo', '.claude', 'skills'), 'beta', '---\nname: beta\ndescription: Project beta\n---\nBeta body\n')
  await writeFile(join(root, 'repo', '.claude', 'skills', 'beta', 'extra.md'), 'more')
  return { root, home: join(root, 'home'), repo: join(root, 'repo') }
}

test('the Skill tool and slash commands are both counted per skill and per day', () => {
  const state = newScanState()
  feed(state, skillCall('a', 'alpha', 2 * HOUR))
  feed(state, skillCall('b', 'alpha', HOUR))
  feed(state, slash('alpha', 30 * 60_000))
  const alpha = state.skills.get('alpha')
  assert.equal(alpha.tool, 2)
  assert.equal(alpha.command, 1)
  assert.equal(alpha.lastAt, NOW - 30 * 60_000)
  assert.equal(alpha.firstAt, NOW - 2 * HOUR)
  assert.equal([...alpha.days.values()].reduce((a, b) => a + b, 0), 3)
})

test('skill calls made inside subagents are not counted', () => {
  const state = newScanState()
  feed(state, { ...skillCall('a', 'alpha', HOUR), isSidechain: true })
  assert.equal(state.skills.size, 0)
})

test('listing finds global and project skills and keeps the project name', async () => {
  const { home, repo } = await skillTree()
  const skills = await listSkills({ projects: new Map([['repo', repo]]), home })
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]))
  assert.equal(byName.alpha.scope, 'global')
  assert.equal(byName.alpha.hint, '<x>')
  assert.ok(Math.abs(byName.alpha.updatedAt - Date.now()) < 60_000)
  assert.equal(byName.beta.scope, 'project')
  assert.equal(byName.beta.project, 'repo')
})

test('a project whose skills folder is the global one is not listed twice', async () => {
  const { home } = await skillTree()
  const skills = await listSkills({ projects: new Map([['home', home]]), home })
  assert.deepEqual(skills.map((s) => s.name), ['alpha'])
})

test('usage is attributed to the project skill of that project, and elsewhere it is missing', async () => {
  const { home, repo } = await skillTree()
  const installed = await listSkills({ projects: new Map([['repo', repo]]), home })
  const make = (project, name, when) => {
    const state = newScanState()
    feed(state, skillCall(name, name, when))
    return { id: `local_${project}${name}`, title: `${project} session`, project, archived: false, skills: state.skills }
  }
  const stats = aggregateSkills([make('repo', 'beta', HOUR), make('other', 'beta', HOUR), make('repo', 'alpha', 2 * HOUR), make('repo', 'alpha', 3 * HOUR)], installed)
  const find = (name, scope) => stats.find((s) => s.name === name && s.scope === scope)
  assert.equal(find('beta', 'project').uses, 1)
  assert.equal(find('beta', 'missing').uses, 1)
  assert.equal(find('alpha', 'global').uses, 2)
  assert.equal(find('alpha', 'global').sessions, 2)
  assert.equal(find('alpha', 'global').byProject[0].project, 'repo')
})

test('a skill called by Claude that is not installed shows as missing, a stray slash command does not', () => {
  const state = newScanState()
  feed(state, skillCall('a', 'gone', HOUR))
  feed(state, slash('model', HOUR))
  const stats = aggregateSkills([{ id: 'local_x', title: 't', project: 'p', archived: false, skills: state.skills }], [])
  assert.deepEqual(stats.map((s) => [s.name, s.scope, s.uses]), [['gone', 'missing', 1]])
})

test('a bare name resolves to the one plugin skill that carries it', () => {
  const state = newScanState()
  feed(state, skillCall('a', 'simplifier', HOUR))
  const installed = [{ key: 'global::tools:simplifier', name: 'tools:simplifier', description: '', hint: '', source: 'plugin', scope: 'global', project: null, path: '/x' }]
  const stats = aggregateSkills([{ id: 'local_x', title: 't', project: 'p', archived: false, skills: state.skills }], installed)
  assert.equal(stats[0].uses, 1)
})

test('detail returns the body without frontmatter and lists supporting files', async () => {
  const { home, repo } = await skillTree()
  const beta = (await listSkills({ projects: new Map([['repo', repo]]), home })).find((s) => s.name === 'beta')
  const detail = await skillDetail(beta)
  assert.equal(detail.body, 'Beta body')
  assert.deepEqual(detail.files, ['extra.md'])
  assert.equal(detail.fields.description, 'Project beta')
})

const stat = (over) => ({ key: over.name, scope: 'global', source: 'user', project: null, description: '', uses: 0, toolUses: 0, commandUses: 0, firstUsedAt: null, lastUsedAt: null, days: {}, sessions: 0, ...over })

test('temperature follows time since last use and never-used skills are their own group', () => {
  assert.equal(skillTemperature(stat({ name: 'a', lastUsedAt: NOW - 10 * 60_000 }), NOW).tier, 'hot')
  assert.equal(skillTemperature(stat({ name: 'a', lastUsedAt: NOW - 3 * HOUR }), NOW).group, 'warm')
  assert.equal(skillTemperature(stat({ name: 'a', lastUsedAt: NOW - 3 * DAY }), NOW).tier, 'cooling')
  assert.equal(skillTemperature(stat({ name: 'a', lastUsedAt: NOW - 9 * DAY }), NOW).tier, 'cold')
  assert.equal(skillTemperature(stat({ name: 'a' }), NOW).group, 'unused')
})

test('uses in range only count the days inside the window', () => {
  const skill = stat({ name: 'a', days: { '2026-11-06': 2, '2026-11-01': 3, '2026-10-01': 9 } })
  assert.equal(usesInRange(skill, 7, NOW), 5)
  assert.equal(usesInRange(skill, 3, NOW), 2)
  assert.deepEqual(dailyUses(skill, 3, NOW), [0, 0, 2])
})

test('visible skills filter by scope, temperature and text and order by uses in range', () => {
  const list = [
    stat({ name: 'busy', days: { '2026-11-06': 5 }, uses: 5, lastUsedAt: NOW - HOUR / 2 }),
    stat({ name: 'old', days: { '2026-09-01': 8 }, uses: 8, lastUsedAt: NOW - 60 * DAY }),
    stat({ name: 'idle' }),
    stat({ name: 'proj', scope: 'project', source: 'project', project: 'repo', description: 'builds things' }),
  ]
  assert.deepEqual(visibleSkills(list, { now: NOW }).map((s) => s.name), ['busy', 'old', 'idle', 'proj'])
  assert.deepEqual(visibleSkills(list, { scope: 'project', now: NOW }).map((s) => s.name), ['proj'])
  assert.deepEqual(visibleSkills(list, { temp: 'unused', now: NOW }).map((s) => s.name), ['idle', 'proj'])
  assert.deepEqual(visibleSkills(list, { temp: 'cool', now: NOW }).map((s) => s.name), ['old'])
  assert.deepEqual(visibleSkills(list, { query: 'BUILDS', now: NOW }).map((s) => s.name), ['proj'])
  assert.deepEqual(skillCounts(list, NOW), { warm: 1, cool: 1, unused: 2 })
})

test('the summary counts used and never-used skills and names the top one', () => {
  const list = [
    stat({ name: 'busy', days: { '2026-11-06': 5 }, uses: 5, lastUsedAt: NOW }),
    stat({ name: 'idle' }),
    stat({ name: 'gone', scope: 'missing', days: { '2026-11-05': 1 }, uses: 1, lastUsedAt: NOW }),
  ]
  assert.deepEqual(summarize(list, 30, NOW), { installed: 2, usedInRange: 2, neverUsed: 1, top: { name: 'busy', uses: 5 } })
})
