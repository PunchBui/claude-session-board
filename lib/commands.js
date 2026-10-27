import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep, basename } from 'node:path'

const MAX_DEPTH = 4
const MAX_ITEMS = 600
const SOURCE_ORDER = ['project', 'user', 'skill', 'plugin', 'built-in']

export const BUILTINS = [
  { name: 'compact', description: 'Compact the conversation to free up context', source: 'built-in', hint: '[what to keep]' },
  { name: 'context', description: 'Show how much of the context window is used', source: 'built-in', hint: '' },
  { name: 'cost', description: 'Show usage and limits', source: 'built-in', hint: '' },
  { name: 'model', description: 'Show the current model and the ones you can switch to', source: 'built-in', hint: '' },
]

export const BLOCKED_PROMPT = /^\s*\/(clear|reset|new)\b/i

export function parseFrontmatter(text) {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(text)
  if (!match) return {}
  const fields = {}
  const lines = match[1].split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!pair) continue
    let value = pair[2].trim()
    if (/^[>|][+-]?$/.test(value)) {
      const parts = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        i += 1
        parts.push(lines[i].trim())
      }
      value = parts.join(' ')
    }
    fields[pair[1]] = value.replace(/^["']|["']$/g, '')
  }
  return fields
}

async function markdownFiles(dir, depth = 0) {
  if (depth > MAX_DEPTH) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return markdownFiles(path, depth + 1)
      return entry.name.endsWith('.md') ? [path] : []
    })
  )
  return nested.flat()
}

async function commandsIn(dir, source, prefix = '') {
  const files = await markdownFiles(dir)
  const items = await Promise.all(
    files.map(async (file) => {
      const fields = parseFrontmatter(await readFile(file, 'utf8').catch(() => ''))
      const name = relative(dir, file).slice(0, -3).split(sep).join(':')
      return { name: `${prefix}${name}`, description: fields.description ?? '', hint: fields['argument-hint'] ?? '', source }
    })
  )
  return items
}

async function skillsIn(dir, source, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const items = await Promise.all(
    entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(async (entry) => {
      const text = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8').catch(() => null)
      if (text === null) return null
      const fields = parseFrontmatter(text)
      return { name: `${prefix}${fields.name ?? basename(entry.name)}`, description: fields.description ?? '', hint: fields['argument-hint'] ?? '', source }
    })
  )
  return items.filter(Boolean)
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function pluginItems(claudeDir) {
  const installed = await readJson(join(claudeDir, 'plugins', 'installed_plugins.json'))
  const settings = await readJson(join(claudeDir, 'settings.json'))
  const enabled = settings?.enabledPlugins ?? {}
  const found = []
  for (const [key, installs] of Object.entries(installed?.plugins ?? {})) {
    if (key in enabled && !enabled[key]) continue
    const install = Array.isArray(installs) ? installs.at(-1) : null
    if (!install?.installPath) continue
    const prefix = `${key.split('@')[0]}:`
    found.push(commandsIn(join(install.installPath, 'commands'), 'plugin', prefix), skillsIn(join(install.installPath, 'skills'), 'plugin', prefix))
  }
  return (await Promise.all(found)).flat()
}

export async function listCommands({ cwd, home }) {
  const claudeDir = join(home, '.claude')
  const groups = await Promise.all([
    cwd ? commandsIn(join(cwd, '.claude', 'commands'), 'project') : [],
    commandsIn(join(claudeDir, 'commands'), 'user'),
    cwd ? skillsIn(join(cwd, '.claude', 'skills'), 'skill') : [],
    skillsIn(join(claudeDir, 'skills'), 'skill'),
    pluginItems(claudeDir),
  ])
  const seen = new Set()
  const items = []
  for (const item of [...groups.flat(), ...BUILTINS]) {
    if (!item.name || BLOCKED_PROMPT.test(`/${item.name}`) || seen.has(item.name)) continue
    seen.add(item.name)
    items.push(item)
  }
  items.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.name.localeCompare(b.name))
  return items.slice(0, MAX_ITEMS)
}
