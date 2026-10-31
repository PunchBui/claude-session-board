import { join } from 'node:path'

export const HANDOFF_FOCUS = 'Continue the current work in a new session: summarize where we are, what is done, what is left, and the next step.'

export function handoffFile(sessionId, tmpDir, now = Date.now()) {
  return join(tmpDir, `handoff-${sessionId.replace(/^local_/, '').slice(0, 8)}-${now}.md`)
}

export function handoffPrompt(file) {
  return `/handoff ${HANDOFF_FOCUS} Save the document to exactly this path: ${file}`
}

export function handoffLink({ folder, file }) {
  const params = new URLSearchParams()
  if (folder) params.set('folder', folder)
  params.set('q', `Read the handoff document at ${file} and continue the work it describes.`)
  return `claude://code/new?${params}`
}
