import { execFile } from 'node:child_process'
import { classifyExit } from './guard.js'

const SAFE_ID = /^[A-Za-z0-9-]{1,80}$/

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function commandOf(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], (error, stdout) => resolve(error ? '' : stdout.trim()))
  })
}

export function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {}
  }
}

export const liveProbe = { isAlive: isPidAlive, commandOf }

export function validEntry(entry) {
  return Boolean(entry) && Number.isInteger(entry.pid) && entry.pid > 1 && Number.isFinite(entry.startedAt) && typeof entry.cliSessionId === 'string' && SAFE_ID.test(entry.cliSessionId)
}

export function matchesRun(command, cliSessionId) {
  if (typeof command !== 'string' || !SAFE_ID.test(cliSessionId ?? '')) return false
  const resumes = new RegExp(`(^|\\s)--(resume|session-id)\\s+${cliSessionId}(\\s|$)`)
  return /claude/i.test(command) && /(^|\s)-p(\s|$)/.test(command) && resumes.test(command)
}

export async function isSavedRunAlive(entry, probe = liveProbe) {
  if (!validEntry(entry) || !probe.isAlive(entry.pid)) return false
  return matchesRun(await probe.commandOf(entry.pid), entry.cliSessionId)
}

export function remainingMs(startedAt, nowMs, timeoutMs) {
  return Math.max(0, startedAt + timeoutMs - nowMs)
}

export function adoptedRun(entry, { graceMs, signal = signalGroup, isAlive = isPidAlive, schedule = setTimeout }) {
  const run = {
    state: 'running',
    startedAt: entry.startedAt,
    endedAt: null,
    error: null,
    mode: entry.mode ?? null,
    stopRequested: false,
    timedOut: false,
    prompt: null,
    handoff: entry.handoffFile ? { file: entry.handoffFile, ready: false } : null,
    adopted: true,
  }
  run.stop = () => {
    run.stopRequested = true
    signal(entry.pid, 'SIGTERM')
    const timer = schedule(() => {
      if (isAlive(entry.pid)) signal(entry.pid, 'SIGKILL')
    }, graceMs)
    timer?.unref?.()
  }
  return run
}

export function watchUntilGone(pid, { isAlive = isPidAlive, pollMs = 2000, onGone }) {
  const timer = setInterval(() => {
    if (isAlive(pid)) return
    clearInterval(timer)
    onGone()
  }, pollMs)
  return () => clearInterval(timer)
}

export function adoptedOutcome({ stopRequested, timedOut, endedCleanly }) {
  return classifyExit({ code: 0, signal: null, stopRequested, timedOut, cleanTail: Boolean(endedCleanly), errorText: '' })
}
