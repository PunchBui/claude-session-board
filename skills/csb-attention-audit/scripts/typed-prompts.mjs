import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const days = Math.max(1, Number(process.argv[2]) || 30)
const root = process.env.PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
const since = Date.now() - days * 24 * 60 * 60_000

const normalize = (text) => text.replace(/https?:\S+/g, '<url>').replace(/\s+/g, ' ').toLowerCase().slice(0, 70)

const dataDir = process.env.DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data')
const routinePrompts = new Set()
try {
  const saved = JSON.parse(await readFile(join(dataDir, 'routines.json'), 'utf8'))
  for (const item of saved.items ?? []) if (typeof item.prompt === 'string') routinePrompts.add(normalize(item.prompt.trim()))
} catch {}

const BOARD = [
  [/^\/csb-/, 'board: skill'],
  [/^send one slack (direct|channel) message/, 'board: ping'],
  [/^the ci pipeline failed on/, 'board: fix'],
  [/^this session is being continued/, 'context continued'],
  [/^read the handoff/, 'handoff read'],
]

async function* transcripts(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'subagents') yield* transcripts(path)
    } else if (entry.name.endsWith('.jsonl') && (await stat(path)).mtimeMs >= since) {
      yield path
    }
  }
}

const textOf = (message) => {
  const content = message?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : ''
}

const typed = new Map()
const board = new Map()
let sessions = 0
let prompts = 0

for await (const file of transcripts(root)) {
  sessions += 1
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.includes('"type":"user"')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'user' || entry.isSidechain || entry.isMeta) continue
    const text = textOf(entry.message).trim()
    if (!text || text.startsWith('<') || text.startsWith('[')) continue
    const key = normalize(text)
    prompts += 1
    const kind = routinePrompts.has(key) ? 'board: routine' : BOARD.find(([pattern]) => pattern.test(key))?.[1]
    const bucket = kind ? board : typed
    const name = kind ?? key
    bucket.set(name, (bucket.get(name) ?? 0) + 1)
  }
}

const top = (map, min) => [...map].filter(([, count]) => count >= min).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([text, count]) => ({ text, count }))

console.log(JSON.stringify({
  days,
  sessions,
  prompts,
  typedTotal: [...typed.values()].reduce((sum, count) => sum + count, 0),
  repeatedTyped: top(typed, 3),
  boardAndAutomatic: top(board, 1),
}, null, 2))
