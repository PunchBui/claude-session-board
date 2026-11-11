import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep, basename } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

const MAX_DEPTH = 4
const MAX_ITEMS = 600
const PROBE_TIMEOUT_MS = 20_000
const SOURCE_ORDER = ['project', 'user', 'skill', 'plugin', 'mcp', 'built-in', 'board']

export const BUILTIN_INFO = {
  advisor: { description: 'Show or set the advisor model', hint: '[fable|opus|sonnet|off]' },
  agents: { description: 'How to create and edit subagents' },
  autocompact: { description: 'Show or set the auto-compact window', hint: '[tokens]' },
  'claude-api': { description: 'Reference for the Claude API and Anthropic SDK' },
  'code-review': { description: 'Review the current diff for correctness bugs', hint: '[level]' },
  color: { description: 'Set the session colour', hint: '[colour]' },
  compact: { description: 'Compact the conversation to free up context', hint: '[what to keep]' },
  config: { description: 'Change a setting', hint: '[key=value]' },
  context: { description: 'Show how much of the context window is used' },
  cost: { description: 'Show usage and limits' },
  debug: { description: 'Debug this session' },
  doctor: { description: 'Check the Claude Code install and settings' },
  effort: { description: 'Set the effort level for this session (the board keeps it for later prompts)', hint: '[low|medium|high|xhigh|max|auto]' },
  'extra-usage': { description: 'Show extra usage' },
  fast: { description: 'Toggle fast mode' },
  'fewer-permission-prompts': { description: 'Add an allowlist for common read-only tool calls' },
  goal: { description: 'Set a goal Claude keeps working towards', hint: '[condition]' },
  init: { description: 'Write a CLAUDE.md for this project' },
  insights: { description: 'Report on your recent sessions' },
  'list-agents': { description: 'List the other Claude sessions on this machine' },
  loop: { description: 'Run a prompt or command on a recurring interval', hint: '[interval] [prompt]' },
  mcp: { description: 'Show MCP server status' },
  model: { description: 'Set the model for this session (the board keeps it for later prompts)', hint: '[name]' },
  'output-style': { description: 'Show or set the output style', hint: '[style]' },
  recap: { description: 'Summarise this session so far' },
  'reload-plugins': { description: 'Reload plugins' },
  'reload-skills': { description: 'Reload skills' },
  rename: { description: 'Rename this session', hint: '[name]' },
  review: { description: 'Review a pull request', hint: '[pr]' },
  schedule: { description: 'Create or manage scheduled cloud agents' },
  'security-review': { description: 'Review the pending changes for security issues' },
  simplify: { description: 'Review changed code for reuse and simplification, then fix it' },
  'update-config': { description: 'Configure Claude Code through settings.json' },
  usage: { description: 'Show usage and limits' },
}

export const FALLBACK_BUILTINS = ['compact', 'context', 'cost', 'model']

export const BOARD_COMMANDS = ['clear', 'new', 'reset'].map((name) => ({ name, description: 'Start a new session in this folder: opens a New chat with the same project and settings', hint: '[first prompt]', source: 'board' }))

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

export async function skillsIn(dir, source, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const items = await Promise.all(
    entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(async (entry) => {
      const text = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8').catch(() => null)
      if (text === null) return null
      const fields = parseFrontmatter(text)
      return { name: `${prefix}${fields.name ?? basename(entry.name)}`, description: fields.description ?? '', hint: fields['argument-hint'] ?? '', source, path: join(dir, entry.name, 'SKILL.md') }
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

export async function pluginInstalls(claudeDir) {
  const installed = await readJson(join(claudeDir, 'plugins', 'installed_plugins.json'))
  const settings = await readJson(join(claudeDir, 'settings.json'))
  const enabled = settings?.enabledPlugins ?? {}
  const found = []
  for (const [key, installs] of Object.entries(installed?.plugins ?? {})) {
    if (key in enabled && !enabled[key]) continue
    const install = Array.isArray(installs) ? installs.at(-1) : null
    if (!install?.installPath) continue
    found.push({ dir: install.installPath, prefix: `${key.split('@')[0]}:` })
  }
  return found
}

async function pluginItems(claudeDir) {
  const found = []
  for (const { dir, prefix } of await pluginInstalls(claudeDir)) {
    found.push(commandsIn(join(dir, 'commands'), 'plugin', prefix), skillsIn(join(dir, 'skills'), 'plugin', prefix))
  }
  return (await Promise.all(found)).flat()
}

export function probeSlashCommands({ bin, cwd, env, spawn = nodeSpawn, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child
    let done = false
    let buffer = ''
    const finish = (names) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child?.kill()
      resolve(names)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      child = spawn(bin, ['-p', '--no-session-persistence', '--output-format', 'stream-json', '--verbose'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      return finish(null)
    }
    child.on('error', () => finish(null))
    child.on('close', () => finish(null))
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const names = initCommands(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        if (names) return finish(names)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end('/model\n')
  })
}

export function initCommands(line) {
  try {
    const event = JSON.parse(line)
    if (event.type !== 'system' || event.subtype !== 'init' || !Array.isArray(event.slash_commands)) return null
    return event.slash_commands.filter((name) => typeof name === 'string' && name && !name.startsWith('_'))
  } catch {
    return null
  }
}

function probedSource(name) {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name.includes(':')) return 'plugin'
  return 'built-in'
}

export async function listCommands({ cwd, home, probed = null }) {
  const claudeDir = join(home, '.claude')
  const groups = await Promise.all([
    cwd ? commandsIn(join(cwd, '.claude', 'commands'), 'project') : [],
    commandsIn(join(claudeDir, 'commands'), 'user'),
    cwd ? skillsIn(join(cwd, '.claude', 'skills'), 'skill') : [],
    skillsIn(join(claudeDir, 'skills'), 'skill'),
    pluginItems(claudeDir),
  ])
  const extra = (probed ?? FALLBACK_BUILTINS).map((name) => ({ name, description: '', hint: '', ...BUILTIN_INFO[name], source: probedSource(name) }))
  const seen = new Set()
  const items = []
  for (const item of [...groups.flat(), ...extra]) {
    if (!item.name || BLOCKED_PROMPT.test(`/${item.name}`) || seen.has(item.name)) continue
    seen.add(item.name)
    items.push(item)
  }
  items.push(...BOARD_COMMANDS)
  items.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.name.localeCompare(b.name))
  return items.slice(0, MAX_ITEMS)
}
