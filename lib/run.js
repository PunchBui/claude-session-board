import { spawn } from 'node:child_process'
import { openSync, closeSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { userMessageLine } from './ask.js'

// A run gets its own process group and writes stderr to a file, not a pipe to the board.
// launchd kills the board's whole process group when the board restarts, and a run that
// shared it (or wrote to a pipe the dead board held) died with it, including a run that
// was itself restarting the board.
// With outFile the run speaks stream-json: stdout goes to that file (still no pipe to the board)
// and stdin stays open so the board can answer the run's questions. If the board dies, stdin
// closes and the run finishes its turn on its own, with any open question cancelled.
export function spawnDetached(bin, args, { cwd, logFile, outFile, input, env }) {
  mkdirSync(dirname(logFile), { recursive: true })
  const log = openSync(logFile, 'w')
  const out = outFile ? openSync(outFile, 'w') : null
  try {
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['pipe', out ?? 'ignore', log] })
    child.stdin.on('error', () => {})
    if (outFile) {
      child.write = (line) => child.stdin.writable && child.stdin.write(line)
      child.write(userMessageLine(input))
      child.finish = () => child.stdin.end()
    } else child.stdin.end(input)
    return child
  } finally {
    closeSync(log)
    if (out !== null) closeSync(out)
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
