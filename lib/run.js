import { spawn } from 'node:child_process'
import { openSync, closeSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// A run gets its own process group and writes stderr to a file, not a pipe to the board.
// launchd kills the board's whole process group when the board restarts, and a run that
// shared it (or wrote to a pipe the dead board held) died with it, including a run that
// was itself restarting the board.
export function spawnDetached(bin, args, { cwd, logFile, input }) {
  mkdirSync(dirname(logFile), { recursive: true })
  const log = openSync(logFile, 'w')
  try {
    const child = spawn(bin, args, { cwd, detached: true, stdio: ['pipe', 'ignore', log] })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    return child
  } finally {
    closeSync(log)
  }
}

// Stops the run and everything it started (MCP servers, shell commands), not just claude.
export function killGroup(child, signal = 'SIGTERM') {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

export function logTail(file, max) {
  try {
    return readFileSync(file, 'utf8').slice(-max)
  } catch {
    return ''
  }
}
