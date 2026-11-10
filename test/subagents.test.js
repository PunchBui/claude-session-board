import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSubagentStore, subagentStatus, subagentDir, isAgentId } from '../lib/subagents.js'
import { newScanState, absorbLine } from '../lib/scan.js'

const line = (value) => JSON.stringify({ isSidechain: true, timestamp: '2026-11-10T08:00:00.000Z', ...value })

const transcript = [
  line({ type: 'user', message: { role: 'user', content: 'Integrate PROJ-1007' } }),
  line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 1, output_tokens: 40 } } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  line({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 1, output_tokens: 10 } } }),
].join('\n') + '\n'

async function fixture(metas) {
  const root = await mkdtemp(join(tmpdir(), 'subagents-'))
  const sessionFile = join(root, 'abc.jsonl')
  const dir = subagentDir(sessionFile)
  await mkdir(dir, { recursive: true })
  for (const [id, meta] of Object.entries(metas)) {
    await writeFile(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta))
    await writeFile(join(dir, `agent-${id}.jsonl`), transcript)
  }
  return { root, sessionFile, dir }
}

test('sidechain entries are ignored by default and kept for subagent transcripts', () => {
  const main = newScanState()
  const sub = newScanState({ sidechain: true })
  for (const l of transcript.trim().split('\n')) {
    absorbLine(main, l)
    absorbLine(sub, l)
  }
  assert.equal(main.messages.length, 0)
  assert.equal(sub.messages.length, 2)
  assert.equal(sub.toolCalls, 1)
})

test('status is done when finished, running when recently written, otherwise stopped', () => {
  const now = Date.now()
  assert.equal(subagentStatus({ finished: true }, now - 60 * 60_000, now), 'done')
  assert.equal(subagentStatus({ finished: false }, now - 10_000, now), 'running')
  assert.equal(subagentStatus({}, now - 60 * 60_000, now), 'stopped')
})

test('lists subagents with metadata, tool count and tokens', async () => {
  const { root, sessionFile } = await fixture({
    aaa: { agentType: 'general-purpose', description: 'Integrate PROJ-1007 keep B', worktreeBranch: 'worktree-agent-aaa', finished: true },
  })
  try {
    const [item] = await createSubagentStore().list(sessionFile)
    assert.equal(item.id, 'aaa')
    assert.equal(item.type, 'general-purpose')
    assert.equal(item.description, 'Integrate PROJ-1007 keep B')
    assert.equal(item.branch, 'worktree-agent-aaa')
    assert.equal(item.status, 'done')
    assert.equal(item.toolCount, 1)
    assert.equal(item.usage.output, 50)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('summary counts total and running subagents, and is empty without a folder', async () => {
  const { root, sessionFile, dir } = await fixture({ aaa: { finished: true }, bbb: { finished: false }, ccc: { finished: false } })
  try {
    const old = new Date(Date.now() - 60 * 60_000)
    await utimes(join(dir, 'agent-ccc.jsonl'), old, old)
    const store = createSubagentStore()
    assert.deepEqual(await store.summary(sessionFile), { total: 3, running: 1 })
    assert.deepEqual(await store.summary(join(root, 'none.jsonl')), { total: 0, running: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('chat returns the subagent conversation and rejects unknown or unsafe ids', async () => {
  const { root, sessionFile } = await fixture({ aaa: { finished: true } })
  try {
    const store = createSubagentStore()
    const result = await store.chat(sessionFile, 'aaa')
    assert.deepEqual(result.chat.map((m) => m.role), ['user', 'tools', 'assistant'])
    assert.equal(await store.chat(sessionFile, 'zzz'), null)
    assert.equal(await store.chat(sessionFile, '../abc'), null)
    assert.equal(isAgentId('../abc'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
