import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'

const GIT_TIMEOUT_MS = 5000
const MAX_FILES = 80

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4_000_000 }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
}

export function parseBranchLine(line) {
  const match = /^## (?:No commits yet on )?([^\s.]+(?:\.[^\s.]+)*?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(line ?? '')
  if (!match) return { branch: null, upstream: null, ahead: 0, behind: 0 }
  const state = match[3] ?? ''
  return {
    branch: match[1],
    upstream: match[2] ?? null,
    ahead: Number(/ahead (\d+)/.exec(state)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(state)?.[1] ?? 0),
  }
}

export async function gitInfo(cwd) {
  if (!cwd || !(await stat(cwd).catch(() => null))?.isDirectory()) return { available: false, reason: 'folder not found' }
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside?.trim() !== 'true') return { available: false, reason: 'not a git repository' }
  const [status, diffstat, last] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-b']),
    git(cwd, ['diff', '--shortstat', 'HEAD']),
    git(cwd, ['log', '-1', '--format=%h%x09%s%x09%cr']),
  ])
  const lines = (status ?? '').split('\n').filter(Boolean)
  const files = lines.slice(1).map((line) => ({ code: line.slice(0, 2).trim() || '?', path: line.slice(3) }))
  const [hash, subject, when] = (last ?? '').trim().split('\t')
  return {
    available: true,
    ...parseBranchLine(lines[0]),
    dirtyCount: files.length,
    files: files.slice(0, MAX_FILES),
    diffstat: (diffstat ?? '').trim() || null,
    lastCommit: hash ? { hash, subject, when } : null,
  }
}
