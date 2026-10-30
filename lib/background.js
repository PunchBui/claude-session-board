const MAX_EVENTS = 25
const MAX_COMMAND_CHARS = 4000
const UNKNOWN_AFTER_MS = 24 * 60 * 60_000
const OUTPUT_PATH = /^\/private\/tmp\/claude-\d+\/[^\0]*\/tasks\/[A-Za-z0-9_-]+\.output$/
const OUTPUT_IN_RESULT = /written to: (\S+?\.output)/
const ID_IN_RESULT = /(?:with ID:|\(task) ([A-Za-z0-9_-]+)/
const FINAL = new Set(['completed', 'failed', 'killed', 'stopped'])

export function newBackgroundState() {
  return { calls: new Map(), tasks: new Map() }
}

const millis = (at) => {
  const value = Date.parse(at)
  return Number.isNaN(value) ? Date.now() : value
}

const textOf = (content) => (typeof content === 'string' ? content : (Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : ''))

export function noteBackgroundToolUse(background, block, at) {
  const input = block.input ?? {}
  if (block.name === 'Bash' && input.run_in_background) {
    background.calls.set(block.id, { kind: 'command', command: String(input.command ?? '').slice(0, MAX_COMMAND_CHARS), description: String(input.description ?? ''), startedAt: millis(at), timeoutMs: input.timeout ?? null })
  } else if (block.name === 'Monitor') {
    background.calls.set(block.id, { kind: 'monitor', command: String(input.command ?? '').slice(0, MAX_COMMAND_CHARS), description: String(input.description ?? ''), startedAt: millis(at), timeoutMs: input.timeout_ms ?? null })
  }
}

export function noteBackgroundResult(background, toolUseId, content, toolUseResult) {
  const call = background.calls.get(toolUseId)
  if (!call) return
  background.calls.delete(toolUseId)
  const text = textOf(content)
  const id = toolUseResult?.backgroundTaskId ?? toolUseResult?.taskId ?? ID_IN_RESULT.exec(text)?.[1]
  if (!id) return
  background.tasks.set(id, {
    id,
    ...call,
    timeoutMs: toolUseResult?.timeoutMs ?? call.timeoutMs,
    persistent: Boolean(toolUseResult?.persistent),
    outputFile: OUTPUT_IN_RESULT.exec(text)?.[1] ?? null,
    status: 'running',
    endedAt: null,
    exitCode: null,
    summary: null,
    eventCount: 0,
    events: [],
  })
}

const tag = (xml, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim() ?? null

export function noteTaskNotification(background, xml, at) {
  const when = millis(at)
  const ids = [...xml.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((match) => match[1].trim()).filter((id) => !id.startsWith('__'))
  const status = tag(xml, 'status')
  const summary = tag(xml, 'summary')
  const event = tag(xml, 'event')
  const outputFile = tag(xml, 'output-file')
  for (const id of ids) {
    let task = background.tasks.get(id)
    if (!task) {
      task = { id, kind: /Monitor/.test(summary ?? '') ? 'monitor' : 'command', command: '', description: summary ?? '', startedAt: when, timeoutMs: null, persistent: false, outputFile: null, status: 'running', endedAt: null, exitCode: null, summary: null, eventCount: 0, events: [] }
      background.tasks.set(id, task)
    }
    if (outputFile) task.outputFile = outputFile
    if (status && FINAL.has(status)) {
      task.status = status
      task.endedAt = when
      task.summary = summary
      const code = /exit code (-?\d+)/.exec(summary ?? '')?.[1]
      if (code !== undefined) task.exitCode = Number(code)
      if (event) pushEvent(task, when, event)
    } else if (event) {
      if (event.startsWith('[Monitor expired')) {
        task.status = 'expired'
        task.endedAt = when
        task.summary = event
      } else {
        pushEvent(task, when, event)
      }
    }
  }
}

function pushEvent(task, at, text) {
  task.eventCount += 1
  task.events.push({ at, text: text.slice(0, 600) })
  if (task.events.length > MAX_EVENTS) task.events.shift()
}

export function backgroundTasks(background, { nowMs, idleMs }) {
  return [...background.tasks.values()].map((task) => {
    const stale = task.status === 'running' && idleMs > UNKNOWN_AFTER_MS
    return {
      id: task.id,
      kind: task.kind,
      command: task.command,
      description: task.description,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      status: stale ? 'unknown' : task.status,
      exitCode: task.exitCode,
      summary: task.summary,
      timeoutMs: task.timeoutMs,
      expiresAt: task.kind === 'monitor' && !task.persistent && task.timeoutMs ? task.startedAt + task.timeoutMs : null,
      eventCount: task.eventCount,
      events: task.events,
      hasOutput: Boolean(task.outputFile),
      durationMs: (task.endedAt ?? nowMs) - task.startedAt,
    }
  })
}

export function runningCount(background) {
  let count = 0
  for (const task of background.tasks.values()) if (task.status === 'running') count += 1
  return count
}

export const safeOutputPath = (path) => typeof path === 'string' && !path.includes('..') && OUTPUT_PATH.test(path)

const RECENT_MS = 60 * 60_000

export function backgroundCounts(background, { nowMs, idleMs, recentMs = RECENT_MS }) {
  const counts = { running: 0, done: 0, failed: 0, lastEndedAt: null }
  for (const task of background.tasks.values()) {
    if (task.status === 'running') {
      if (idleMs <= UNKNOWN_AFTER_MS) counts.running += 1
    } else if (FINAL.has(task.status) && task.endedAt && nowMs - task.endedAt < recentMs) {
      counts.done += 1
      if (task.status === 'failed') counts.failed += 1
    }
    if (task.endedAt && (counts.lastEndedAt ?? 0) < task.endedAt) counts.lastEndedAt = task.endedAt
  }
  return counts
}
