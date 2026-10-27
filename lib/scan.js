import { open } from 'node:fs/promises'

const CHUNK_BYTES = 8_000_000
const MAX_MESSAGES = 8000
const MAX_TEXT_CHARS = 60_000
const MAX_HINT_CHARS = 2000
const CHAT_RING = 300
const FILE_TOOLS = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
const TICKET = /\b[A-Z][A-Z0-9]{1,7}-\d{1,6}\b/g
const TICKET_IGNORE = new Set(['UTF', 'SHA', 'ISO', 'AES', 'RSA', 'TLS', 'HTTP', 'HTML', 'JSON', 'UUID', 'ASCII', 'IPV', 'CVE', 'RFC', 'MD', 'EC', 'GPT', 'UTC', 'GMT', 'ES', 'TS', 'PR', 'X', 'ID', 'OK'])
const MR_URL = /https?:\/\/[^\s)"'<>\]`]+\/merge_requests\/\d+/g

export function localDay(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function newScanState() {
  return {
    offset: 0,
    carry: Buffer.alloc(0),
    byId: new Map(),
    context: 0,
    model: null,
    files: new Map(),
    tickets: new Map(),
    links: new Map(),
    messages: [],
    chat: [],
    toolCalls: 0,
    pending: new Map(),
    lastKind: null,
    lastAt: null,
  }
}

function toolHint(block) {
  const input = block.input ?? {}
  const hint = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.questions?.[0]?.question ?? ''
  return String(hint).slice(0, MAX_HINT_CHARS)
}

function harvest(state, text, at) {
  for (const key of text.match(TICKET) ?? []) {
    if (TICKET_IGNORE.has(key.split('-')[0])) continue
    state.tickets.set(key, (state.tickets.get(key) ?? 0) + 1)
  }
  for (const url of text.match(MR_URL) ?? []) {
    const known = state.links.get(url)
    state.links.set(url, { count: (known?.count ?? 0) + 1, lastAt: at })
  }
}

function pushChat(state, item) {
  state.chat.push(item)
  if (state.chat.length > CHAT_RING) state.chat.shift()
}

function pushMessage(state, role, at, raw) {
  const text = String(raw ?? '').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) return
  const message = { role, at, text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[message truncated at ${MAX_TEXT_CHARS} characters]` : text }
  state.messages.push(message)
  if (state.messages.length > MAX_MESSAGES) state.messages.shift()
  pushChat(state, message)
  harvest(state, message.text, at)
}

function noteToolUse(state, block, at) {
  state.toolCalls += 1
  const hint = toolHint(block)
  state.pending.set(block.id, { id: block.id, name: block.name, hint, at })
  const last = state.chat.at(-1)
  const item = { name: block.name, hint }
  if (last?.role === 'tools') last.tools.push(item)
  else pushChat(state, { role: 'tools', at, tools: [item] })
  const key = FILE_TOOLS[block.name]
  const path = key ? block.input?.[key] : null
  if (typeof path === 'string' && path) {
    const known = state.files.get(path)
    state.files.set(path, { count: (known?.count ?? 0) + 1, lastAt: at, tools: new Set([...(known?.tools ?? []), block.name]) })
  }
}

export function absorbLine(state, line) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  const message = entry.message
  if (!message) return
  const side = Boolean(entry.isSidechain)
  const at = entry.timestamp
  if (entry.type === 'assistant') {
    const usage = message.usage
    if (usage) {
      const tokens = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        day: localDay(at),
      }
      state.byId.set(message.id ?? entry.uuid, tokens)
      if (!side) {
        state.context = tokens.input + tokens.cacheRead + tokens.cacheWrite
        state.model = message.model ?? state.model
      }
    }
    if (side || !Array.isArray(message.content)) return
    for (const block of message.content) {
      if (block.type === 'text') {
        pushMessage(state, 'assistant', at, block.text)
        state.lastKind = 'assistant_text'
        state.lastAt = at
      } else if (block.type === 'tool_use') {
        noteToolUse(state, block, at)
        state.lastKind = 'assistant_tool'
        state.lastAt = at
      }
    }
  } else if (entry.type === 'user' && !entry.isMeta && !side) {
    const content = message.content
    if (typeof content === 'string') {
      if (!content.startsWith('<')) {
        pushMessage(state, 'user', at, content)
        state.lastKind = 'user'
        state.lastAt = at
      }
      return
    }
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type === 'tool_result') {
        state.pending.delete(block.tool_use_id)
        state.lastKind = 'tool_result'
        state.lastAt = at
      } else if (block.type === 'text' && !block.text.startsWith('<')) {
        pushMessage(state, 'user', at, block.text)
        state.lastKind = 'user'
        state.lastAt = at
      }
    }
  }
}

export function absorbBuffer(state, chunk) {
  const buffer = Buffer.concat([state.carry, chunk])
  const end = buffer.lastIndexOf(10)
  if (end < 0) {
    state.carry = buffer
    return
  }
  state.carry = buffer.subarray(end + 1)
  buffer.subarray(0, end).toString('utf8').split('\n').forEach((line) => line && absorbLine(state, line))
}

export function createScanStore() {
  const states = new Map()
  const inflight = new Map()

  async function advance(path, size) {
    let state = states.get(path)
    if (!state || size < state.offset) {
      state = newScanState()
      states.set(path, state)
    }
    if (size <= state.offset) return state
    const handle = await open(path, 'r')
    try {
      while (state.offset < size) {
        const length = Math.min(CHUNK_BYTES, size - state.offset)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, state.offset)
        if (!bytesRead) break
        state.offset += bytesRead
        absorbBuffer(state, buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
    return state
  }

  function scan(path, size) {
    const running = inflight.get(path)
    const next = (running ?? Promise.resolve()).then(() => advance(path, size)).finally(() => {
      if (inflight.get(path) === next) inflight.delete(path)
    })
    inflight.set(path, next)
    return next
  }

  return { scan, states }
}
