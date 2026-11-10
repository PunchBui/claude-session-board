import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createScanStore } from './scan.js'
import { usageOf } from './live.js'

const AGENT_ID = /^[A-Za-z0-9]{1,40}$/
const META_FILE = /^agent-([A-Za-z0-9]{1,40})\.meta\.json$/
const RUNNING_WINDOW_MS = 5 * 60_000
const CHAT_ITEMS = 200

export const isAgentId = (value) => AGENT_ID.test(value ?? '')

export const subagentDir = (transcriptPath) => join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')

export function subagentStatus(meta, mtimeMs, nowMs) {
  if (meta?.finished === true) return 'done'
  return nowMs - mtimeMs < RUNNING_WINDOW_MS ? 'running' : 'stopped'
}

async function readMeta(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

export function createSubagentStore() {
  const scans = createScanStore({ sidechain: true })

  async function entries(transcriptPath) {
    const dir = subagentDir(transcriptPath)
    const names = await readdir(dir).catch(() => [])
    return names.flatMap((name) => {
      const id = META_FILE.exec(name)?.[1]
      return id ? [{ id, metaPath: join(dir, name), transcript: join(dir, `agent-${id}.jsonl`) }] : []
    })
  }

  async function describe(entry, nowMs) {
    const [meta, info] = await Promise.all([readMeta(entry.metaPath), stat(entry.transcript).catch(() => null)])
    const state = info ? await scans.scan(entry.transcript, info.size) : null
    const usage = state ? usageOf(state) : null
    return {
      id: entry.id,
      type: meta.agentType ?? 'agent',
      description: meta.description ?? '',
      branch: meta.worktreeBranch ?? null,
      worktree: meta.worktreePath ?? null,
      status: subagentStatus(meta, info?.mtimeMs ?? 0, nowMs),
      startedAt: info?.birthtimeMs ?? null,
      updatedAt: info?.mtimeMs ?? null,
      toolCount: state?.toolCalls ?? 0,
      usage: usage && { output: usage.output, context: usage.context, responses: usage.responses, model: usage.model },
    }
  }

  async function list(transcriptPath, nowMs = Date.now()) {
    const items = await Promise.all((await entries(transcriptPath)).map((entry) => describe(entry, nowMs)))
    return items.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  }

  async function summary(transcriptPath, nowMs = Date.now()) {
    const found = await entries(transcriptPath)
    if (!found.length) return { total: 0, running: 0 }
    const statuses = await Promise.all(
      found.map(async (entry) => {
        const [meta, info] = await Promise.all([readMeta(entry.metaPath), stat(entry.transcript).catch(() => null)])
        return subagentStatus(meta, info?.mtimeMs ?? 0, nowMs)
      })
    )
    return { total: found.length, running: statuses.filter((s) => s === 'running').length }
  }

  async function chat(transcriptPath, agentId) {
    if (!isAgentId(agentId)) return null
    const entry = (await entries(transcriptPath)).find((item) => item.id === agentId)
    if (!entry) return null
    const info = await stat(entry.transcript).catch(() => null)
    if (!info) return { chat: [] }
    const state = await scans.scan(entry.transcript, info.size)
    return { chat: state.chat.slice(-CHAT_ITEMS) }
  }

  return { list, summary, chat }
}
