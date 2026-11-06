import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { skillsIn, pluginInstalls, parseFrontmatter } from './commands.js'

const MAX_DESCRIPTION = 600
const MAX_BODY = 60_000
const MAX_FILES = 60
const MAX_DEPTH = 3
const RECENT_SESSIONS = 8
const TOP_PROJECTS = 8

export const skillKey = (scope, project, name) => `${scope}:${project ?? ''}:${name}`

async function describe(items, scope, project) {
  return Promise.all(
    items.map(async (item) => {
      const path = await realpath(item.path).catch(() => item.path)
      const info = await stat(path).catch(() => null)
      return {
        key: skillKey(scope, project, item.name),
        name: item.name,
        description: item.description.slice(0, MAX_DESCRIPTION),
        hint: item.hint,
        source: item.source,
        scope,
        project: project ?? null,
        path,
        updatedAt: info ? Math.round(info.mtimeMs) : null,
      }
    })
  )
}

export async function listSkills({ projects, home }) {
  const claudeDir = join(home, '.claude')
  const globalDir = join(claudeDir, 'skills')
  const plugins = await pluginInstalls(claudeDir)
  const projectDirs = [...projects].map(([project, root]) => [project, join(root, '.claude', 'skills')]).filter(([, dir]) => dir !== globalDir)
  const groups = await Promise.all([
    skillsIn(globalDir, 'user').then((items) => describe(items, 'global')),
    ...plugins.map(({ dir, prefix }) => skillsIn(join(dir, 'skills'), 'plugin', prefix).then((items) => describe(items, 'global'))),
    ...projectDirs.map(([project, dir]) => skillsIn(dir, 'project').then((items) => describe(items, 'project', project))),
  ])
  const seen = new Set()
  const skills = []
  for (const skill of groups.flat()) {
    if (!skill.name || seen.has(skill.key)) continue
    seen.add(skill.key)
    skills.push(skill)
  }
  return skills
}

function blank(skill) {
  return { ...skill, uses: 0, toolUses: 0, commandUses: 0, firstUsedAt: null, lastUsedAt: null, days: {}, perSession: [], perProject: new Map() }
}

function absorb(target, entry, use) {
  const uses = use.tool + use.command
  target.uses += uses
  target.toolUses += use.tool
  target.commandUses += use.command
  target.firstUsedAt = target.firstUsedAt === null ? use.firstAt : Math.min(target.firstUsedAt, use.firstAt)
  target.lastUsedAt = target.lastUsedAt === null ? use.lastAt : Math.max(target.lastUsedAt, use.lastAt)
  for (const [day, count] of use.days) target.days[day] = (target.days[day] ?? 0) + count
  target.perSession.push({ sessionId: entry.id, title: entry.title, project: entry.project, archived: entry.archived, uses, lastAt: use.lastAt })
  const project = entry.project ?? 'unknown'
  target.perProject.set(project, (target.perProject.get(project) ?? 0) + uses)
}

function finish({ perSession, perProject, ...rest }) {
  return {
    ...rest,
    sessions: perSession.length,
    recent: [...perSession].sort((a, b) => b.lastAt - a.lastAt).slice(0, RECENT_SESSIONS),
    byProject: [...perProject].map(([project, uses]) => ({ project, uses })).sort((a, b) => b.uses - a.uses).slice(0, TOP_PROJECTS),
  }
}

export function aggregateSkills(entries, skills) {
  const stats = new Map(skills.map((skill) => [skill.key, blank(skill)]))
  const global = new Map()
  const scoped = new Map()
  const qualified = new Map()
  for (const skill of skills) {
    if (skill.scope === 'project') {
      scoped.set(`${skill.project}\0${skill.name}`, skill.key)
      continue
    }
    global.set(skill.name, skill.key)
    const bare = skill.name.split(':').pop()
    qualified.set(bare, [...(qualified.get(bare) ?? []), skill.key])
  }
  const missing = new Map()
  for (const entry of entries) {
    for (const [name, use] of entry.skills ?? []) {
      const known = scoped.get(`${entry.project}\0${name}`) ?? global.get(name) ?? (qualified.get(name)?.length === 1 ? qualified.get(name)[0] : null)
      let target = known ? stats.get(known) : null
      if (!target) {
        if (!use.tool) continue
        target = missing.get(name) ?? blank({ key: skillKey('missing', null, name), name, description: '', hint: '', source: 'missing', scope: 'missing', project: null, path: null, updatedAt: null })
        missing.set(name, target)
      }
      absorb(target, entry, use)
    }
  }
  return [...stats.values(), ...missing.values()].map(finish).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
}

async function filesIn(root, dir = root, depth = 0) {
  if (depth > MAX_DEPTH) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const found = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await filesIn(root, path, depth + 1)))
    else if (entry.isFile() && !(depth === 0 && entry.name === 'SKILL.md')) found.push(relative(root, path))
    if (found.length >= MAX_FILES) break
  }
  return found.slice(0, MAX_FILES)
}

export async function skillDetail(skill) {
  const text = await readFile(skill.path, 'utf8').catch(() => '')
  const body = text.replace(/^---\s*\n[\s\S]*?\n---[ \t]*\n?/, '').trim()
  return {
    key: skill.key,
    body: body.slice(0, MAX_BODY),
    truncated: body.length > MAX_BODY,
    fields: parseFrontmatter(text),
    files: await filesIn(dirname(skill.path)),
  }
}
