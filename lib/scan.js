import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { newBackgroundState, noteBackgroundToolUse, noteBackgroundResult, noteTaskNotification } from './background.js'
import { newLoopState, noteLoopToolUse, noteLoopToolResult, noteLoopFire } from './loops.js'
import { noteSessionSetting } from './sessionsettings.js'
import { WIDGET_TOOL, README_TOOL } from './imagine.js'
import { slackThreadsIn, channelNamesIn, isReadThread, isSlackTool, readThreadTarget, threadParent, threadKey, resultText } from './slack.js'

const CHUNK_BYTES = 8_000_000
const MAX_MESSAGES = 8000
const MAX_TEXT_CHARS = 60_000
const MAX_HINT_CHARS = 2000
const CHAT_RING = 300
const MAX_WIDGET_CHARS = 400_000
const FILE_TOOLS = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
export const TICKET = /\b[A-Z][A-Z0-9]{1,7}-\d{1,6}\b/g
export const TICKET_IGNORE = new Set(['UTF', 'SHA', 'ISO', 'AES', 'RSA', 'TLS', 'HTTP', 'HTML', 'JSON', 'UUID', 'ASCII', 'IPV', 'CVE', 'RFC', 'MD', 'EC', 'GPT', 'UTC', 'GMT', 'ES', 'TS', 'PR', 'X', 'ID', 'OK'])
const MR_URL = /https?:\/\/[^\s)"'<>\]`]+\/merge_requests\/\d+/g
export const HANDOFF_PATH = /(?:~|\/)[^\s'"`<>()]*handoff[^\s'"`<>()]*\.md\b/gi
export const isHandoffFile = (path) => /handoff[^/]*\.md$/i.test(String(path ?? ''))

export function localDay(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function newScanState({ sidechain = false, ownId = null } = {}) {
  return {
    sidechain,
    ownId,
    inheriting: false,
    offset: 0,
    carry: Buffer.alloc(0),
    byId: new Map(),
    context: 0,
    model: null,
    files: new Map(),
    tickets: new Map(),
    ticketFirstAt: new Map(),
    branches: new Map(),
    slack: new Map(),
    slackChannels: new Map(),
    slackReads: new Map(),
    handoffReads: new Set(),
    links: new Map(),
    messages: [],
    chat: [],
    toolCalls: 0,
    skills: new Map(),
    pending: new Map(),
    lastKind: null,
    lastStop: null,
    lastAt: null,
    lastPromptAt: null,
    customTitle: null,
    aiTitle: null,
    settings: {},
    permissionMode: null,
    pendingCommand: '',
    loops: newLoopState(),
    background: newBackgroundState(),
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
    const ms = Date.parse(at)
    if (!Number.isNaN(ms) && !(state.ticketFirstAt.get(key) <= ms)) state.ticketFirstAt.set(key, ms)
  }
  for (const url of text.match(MR_URL) ?? []) {
    const known = state.links.get(url)
    state.links.set(url, { count: (known?.count ?? 0) + 1, lastAt: at })
  }
}

function noteThread(state, { host = null, channel, ts }, at, via) {
  const key = threadKey({ channel, ts })
  const ms = Date.parse(at)
  const known = state.slack.get(key) ?? { key, host, channel, ts, firstAt: Number.isNaN(ms) ? null : ms, via: [] }
  known.host ??= host
  if (!Number.isNaN(ms) && !(known.firstAt <= ms)) known.firstAt = ms
  if (!known.via.includes(via)) known.via.push(via)
  state.slack.set(key, known)
  return known
}

function noteChannels(state, text) {
  for (const [id, name] of channelNamesIn(text)) state.slackChannels.set(id, name)
}

function noteBranch(state, name, at) {
  const ms = Date.parse(at)
  if (!name || name === 'HEAD' || Number.isNaN(ms)) return
  const known = state.branches.get(name)
  if (!known) state.branches.set(name, { firstAt: ms, lastAt: ms })
  else {
    known.firstAt = Math.min(known.firstAt, ms)
    known.lastAt = Math.max(known.lastAt, ms)
  }
}

function pushChat(state, item) {
  if (state.inheriting) item.inherited = true
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
  noteChannels(state, message.text)
  if (role === 'user' && !state.inheriting && !state.sidechain) {
    for (const thread of slackThreadsIn(message.text)) noteThread(state, thread, at, 'link')
    for (const path of message.text.match(HANDOFF_PATH) ?? []) state.handoffReads.add(path)
  }
}

export function noteSkill(state, name, via, at) {
  const ms = Date.parse(at)
  const key = String(name ?? '').replace(/^\//, '')
  if (!key || Number.isNaN(ms)) return
  const known = state.skills.get(key) ?? { tool: 0, command: 0, firstAt: ms, lastAt: ms, days: new Map() }
  known[via] += 1
  known.firstAt = Math.min(known.firstAt, ms)
  known.lastAt = Math.max(known.lastAt, ms)
  const day = localDay(ms)
  known.days.set(day, (known.days.get(day) ?? 0) + 1)
  state.skills.set(key, known)
}

function widgetItem(input, at) {
  const code = typeof input?.widget_code === 'string' ? input.widget_code : ''
  const title = typeof input?.title === 'string' ? input.title.slice(0, 120) : ''
  if (!code.trim() || code.length > MAX_WIDGET_CHARS) return { role: 'widget', at, title, code: null, size: code.length }
  return { role: 'widget', at, title, code }
}

function noteToolUse(state, block, at) {
  state.toolCalls += 1
  if (block.name === 'Skill' && typeof block.input?.skill === 'string') noteSkill(state, block.input.skill, 'tool', at)
  noteLoopToolUse(state.loops, block, at)
  noteBackgroundToolUse(state.background, block, at)
  const hint = toolHint(block)
  state.pending.set(block.id, { id: block.id, name: block.name, hint, at })
  if (isReadThread(block.name) && !state.inheriting && !state.sidechain) {
    const target = readThreadTarget(block.input)
    if (target) state.slackReads.set(block.id, noteThread(state, target, at, 'read').key)
  }
  if (block.name === README_TOOL) return
  if (block.name === WIDGET_TOOL) return pushChat(state, widgetItem(block.input, at))
  const last = state.chat.at(-1)
  const item = { name: block.name, hint }
  if (last?.role === 'tools' && Boolean(last.inherited) === state.inheriting) last.tools.push(item)
  else pushChat(state, { role: 'tools', at, tools: [item] })
  const key = FILE_TOOLS[block.name]
  const path = key ? block.input?.[key] : null
  if (typeof path === 'string' && path) {
    const known = state.files.get(path)
    state.files.set(path, { count: (known?.count ?? 0) + 1, lastAt: at, tools: new Set([...(known?.tools ?? []), block.name]) })
  }
}

const COMMAND_NAME = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
const COMMAND_OUTPUT = /<local-command-(?:stdout|stderr)>([\s\S]*?)(?:<\/local-command-(?:stdout|stderr)>|$)/

const SYSTEM_WRAPPER = /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|ide_selection|ide_opened_file)[\s>]/

export const isSystemWrapper = (text) => SYSTEM_WRAPPER.test(String(text ?? '').trimStart())

function commandInvocation(value) {
  const name = COMMAND_NAME.exec(value)?.[1]
  if (!name) return null
  const args = COMMAND_ARGS.exec(value)?.[1]?.trim() ?? ''
  return { name, text: args ? `${name} ${args}` : name }
}

export function absorbLine(state, line) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  if (state.ownId && typeof entry.sessionId === 'string') state.inheriting = entry.sessionId !== state.ownId
  if (typeof entry.gitBranch === 'string' && !state.inheriting) noteBranch(state, entry.gitBranch.trim(), entry.timestamp)
  if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
    state.customTitle = entry.customTitle.trim()
    return
  }
  if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
    state.aiTitle = entry.aiTitle.trim()
    return
  }
  if (entry.type === 'system' && entry.subtype === 'local_command' && typeof entry.content === 'string') {
    const output = COMMAND_OUTPUT.exec(entry.content)?.[1]?.trim()
    if (!state.sidechain && !entry.isSidechain) {
      noteSessionSetting(state.settings, entry.commandRun, output ?? '')
      state.lastKind = 'command'; state.lastStop = 'end_turn'
    }
    if (output) {
      const text = output.length > MAX_TEXT_CHARS ? `${output.slice(0, MAX_TEXT_CHARS)}\n\n[output truncated at ${MAX_TEXT_CHARS} characters]` : output
      pushChat(state, { role: 'command', at: entry.timestamp, command: state.pendingCommand, text })
    }
    return
  }
  if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command' && entry.attachment.commandMode === 'task-notification' && !(!state.sidechain && entry.isSidechain)) {
    if (typeof entry.attachment.prompt === 'string') noteTaskNotification(state.background, entry.attachment.prompt, entry.timestamp)
    return
  }
  const message = entry.message
  if (!message) return
  const side = !state.sidechain && Boolean(entry.isSidechain)
  const at = entry.timestamp
  if (entry.type === 'user' && !side && typeof entry.permissionMode === 'string') state.permissionMode = entry.permissionMode
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
    if (!side) state.lastStop = message.stop_reason ?? null
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
  } else if (entry.type === 'user' && entry.origin?.kind === 'task-notification' && !side) {
    const xml = typeof message.content === 'string' ? message.content : message.content?.find?.((b) => b.type === 'text')?.text
    if (xml) noteTaskNotification(state.background, xml, at)
  } else if (entry.type === 'user' && entry.isMeta && entry.turnOrigin === 'scheduled' && !side) {
    const fired = typeof message.content === 'string' ? message.content : message.content?.find?.((b) => b.type === 'text')?.text
    if (fired) noteLoopFire(state.loops, fired, at)
  } else if (entry.type === 'user' && !entry.isMeta && !side) {
    const content = message.content
    if (typeof content === 'string') {
      const command = content.startsWith('<') ? commandInvocation(content) : null
      if (command) {
        if (entry.turnOrigin === 'scheduled') noteLoopFire(state.loops, command.text, at)
        state.pendingCommand = command.name
        noteSkill(state, command.name, 'command', at)
        pushMessage(state, 'user', at, command.text)
        state.lastKind = 'user'; state.lastStop = null
        state.lastAt = at
        state.lastPromptAt = at
      } else if (!isSystemWrapper(content)) {
        if (entry.turnOrigin === 'scheduled') noteLoopFire(state.loops, content, at)
        pushMessage(state, 'user', at, content)
        state.lastKind = 'user'; state.lastStop = null
        state.lastAt = at
        state.lastPromptAt = at
      }
      return
    }
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type === 'tool_result') {
        const tool = state.pending.get(block.tool_use_id)?.name
        state.pending.delete(block.tool_use_id)
        const read = state.slackReads.get(block.tool_use_id)
        if (read) {
          state.slackReads.delete(block.tool_use_id)
          const parent = threadParent(block.content)
          const thread = state.slack.get(read)
          if (parent && thread && !thread.title) Object.assign(thread, { title: parent.text, author: parent.author })
        }
        if (read || isSlackTool(tool)) noteChannels(state, resultText(block.content))
        noteLoopToolResult(state.loops, block.tool_use_id, block.content)
        noteBackgroundResult(state.background, block.tool_use_id, block.content, entry.toolUseResult)
        state.lastKind = 'tool_result'; state.lastStop = null
        state.lastAt = at
      } else if (block.type === 'text' && !isSystemWrapper(block.text)) {
        pushMessage(state, 'user', at, block.text)
        state.lastKind = 'user'; state.lastStop = null
        state.lastAt = at
        state.lastPromptAt = at
      }
    }
  }
}

export const transcriptTitle = (state) => state?.customTitle ?? state?.aiTitle ?? null

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

export const MAX_SCAN_STATES = 50

export function createScanStore({ sidechain = false, maxStates = MAX_SCAN_STATES } = {}) {
  const states = new Map()
  const inflight = new Map()

  function remember(path, state) {
    states.delete(path)
    states.set(path, state)
    for (const key of states.keys()) {
      if (states.size <= maxStates) break
      if (key !== path && !inflight.has(key)) states.delete(key)
    }
  }

  async function advance(path, size) {
    let state = states.get(path)
    if (!state || size < state.offset) state = newScanState({ sidechain, ownId: sidechain ? null : basename(path, '.jsonl') })
    remember(path, state)
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

  return { scan, states, capacity: maxStates }
}
