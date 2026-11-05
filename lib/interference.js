import { open, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'

export const POLL_MS = 2000
const READ_BYTES = 1_000_000
const DESKTOP = 'claude-desktop'
const CONVERSATION = new Set(['user', 'assistant'])

export function isDesktopEntry(line) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return false
  }
  return CONVERSATION.has(entry?.type) && !entry.isSidechain && entry.entrypoint === DESKTOP
}

export function scanAppended(carry, chunk) {
  const buffer = Buffer.concat([carry, chunk])
  const end = buffer.lastIndexOf(10)
  if (end < 0) return { found: false, carry: buffer }
  const lines = buffer.subarray(0, end).toString('utf8').split('\n')
  return { found: lines.some((line) => line && isDesktopEntry(line)), carry: buffer.subarray(end + 1) }
}

const sizeNow = (path) => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function createDesktopWatcher(path) {
  let offset = path ? sizeNow(path) : 0
  let carry = Buffer.alloc(0)
  let found = false
  let reading = null

  async function readAppended() {
    const { size } = await stat(path)
    if (size < offset) {
      offset = size
      carry = Buffer.alloc(0)
      return
    }
    const handle = await open(path, 'r')
    try {
      while (offset < size && !found) {
        const buffer = Buffer.alloc(Math.min(READ_BYTES, size - offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (!bytesRead) break
        offset += bytesRead
        const scanned = scanAppended(carry, buffer.subarray(0, bytesRead))
        carry = scanned.carry
        found = scanned.found
      }
    } finally {
      await handle.close()
    }
  }

  async function poll() {
    if (found || !path) return found
    reading ??= readAppended().catch(() => {}).finally(() => { reading = null })
    await reading
    return found
  }

  return { poll, offset: () => offset }
}

export function guardAgainstDesktop(run, path, { intervalMs = POLL_MS } = {}) {
  const watcher = createDesktopWatcher(path)
  let active = true
  const timer = setInterval(async () => {
    if (!(await watcher.poll()) || !active || run.interfered) return
    run.interfered = true
    run.stop()
  }, intervalMs)
  return () => {
    active = false
    clearInterval(timer)
  }
}
