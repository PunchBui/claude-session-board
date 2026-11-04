const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
const ACTIVE_WINDOW_MS = 20_000
const APPROVAL_IDLE_MS = 45_000
const INFLIGHT_MS = 15 * 60_000
const STALE_MS = 24 * 60 * 60_000

export function usageOf(state) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const t of state.byId.values()) {
    totals.input += t.input
    totals.output += t.output
    totals.cacheRead += t.cacheRead
    totals.cacheWrite += t.cacheWrite
  }
  return { ...totals, context: state.context, responses: state.byId.size, model: state.model }
}

export function liveOf(state, { nowMs, mtimeMs, running }) {
  const pending = [...state.pending.values()]
  const idleMs = nowMs - mtimeMs
  const subagents = pending
    .filter((p) => SUBAGENT_TOOLS.has(p.name))
    .map((p) => ({ name: p.name, text: p.hint, since: p.at }))
  const tools = pending.filter((p) => !SUBAGENT_TOOLS.has(p.name) && !INTERACTIVE_TOOLS.has(p.name))
  const question = pending.find((p) => INTERACTIVE_TOOLS.has(p.name))

  let attention = null
  if (question && idleMs < STALE_MS && !running) {
    attention = { kind: 'question', tool: question.name, text: question.hint, since: question.at }
  } else if (tools.length && idleMs > APPROVAL_IDLE_MS && idleMs < STALE_MS && !running) {
    const tool = tools.at(-1)
    attention = { kind: 'approval', tool: tool.name, text: tool.hint, since: tool.at }
  }

  // The transcript only gains a line when a step finishes, so a long Bash, subagent or
  // generation leaves it quiet for minutes. A tool still pending, or a turn waiting on the
  // model (last line is a prompt or tool result), counts as working unless it needs the person.
  const inFlight = !attention && (tools.length > 0 || subagents.length > 0 || state.lastKind === 'user' || state.lastKind === 'tool_result' || state.lastStop === 'tool_use')
  const working = running || idleMs < ACTIVE_WINDOW_MS || (inFlight && idleMs < INFLIGHT_MS)
  let phase = 'idle'
  let current = null
  if (working) {
    if (tools.length) {
      phase = 'tool'
      const tool = tools.at(-1)
      current = { name: tool.name, text: tool.hint, since: tool.at }
    } else if (state.lastKind === 'user' || state.lastKind === 'tool_result' || state.lastStop === 'tool_use') {
      phase = 'thinking'
    } else {
      phase = 'writing'
    }
  }
  return { attention, phase, current, subagents, working }
}
