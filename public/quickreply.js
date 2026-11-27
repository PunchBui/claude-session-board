const QUESTION = /\?\s*(["')\]*_`]*\s*)?$/
const CI_WORDS = /\b(pipeline|ci\b|coverage|build failed|job failed|checks? (are |is )?(still )?(running|failing))/i
const SHIPPED = /\b(pushed|committed|pushed to|created (the |an? )?(mr|merge request)|opened (the |an? )?(mr|merge request))\b/i
const PUSH_WORDS = /\b(push|commit|merge request|\bMR\b)/i
const OFFER = /\b(say if you want|let me know if you want|tell me if you want|say the word|if you want,? i can|i can (also )?(write|add|fix|do|make|run|split|draft|push|update|post|open|create|check)\b|want me to|should i\b|shall i\b)/i
export const STUCK_AFTER_MS = 10 * 60_000
export const STUCK_PROMPT = 'Are you stuck? Say in one line what you are waiting on, then carry on or tell me what you need.'

export function lastAssistantText(chat) {
  const items = Array.isArray(chat) ? chat : []
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.role === 'user' || item.role === 'command') return null
    if (item.role === 'assistant') return String(item.text ?? '')
  }
  return null
}

export function stalledFor(card, nowMs = Date.now()) {
  if (!card || card.live?.attention || card.queue?.items?.length) return null
  const working = card.run?.state === 'running' || card.live?.working
  if (!working || card.live?.subagents?.length) return null
  if ((card.backgroundTasks?.tasks ?? []).some((task) => task.status === 'running')) return null
  const quiet = nowMs - (card.touchedAt ?? nowMs)
  return quiet >= STUCK_AFTER_MS ? quiet : null
}

export function quickReplies(card, nowMs = Date.now()) {
  if (stalledFor(card, nowMs) !== null) return [{ label: 'Are you stuck?', prompt: STUCK_PROMPT, stuck: true }]
  if (!card || card.run?.state === 'running' || card.active || card.live?.attention || card.queue?.items?.length) return []
  const text = lastAssistantText(card.details?.chat)
  if (text === null) return []
  const tail = text.trim().slice(-400)
  const replies = []
  if (QUESTION.test(tail)) {
    replies.push({ label: 'Yes', prompt: 'yes' })
    if (PUSH_WORDS.test(tail)) replies.push({ label: 'Yes, push', prompt: 'yes, commit and push' })
    replies.push({ label: 'No', prompt: 'no' })
  } else if (OFFER.test(tail)) replies.push({ label: 'Yes, do it', prompt: 'yes, do it' })
  if (card.details?.filesEdited > 0 && !SHIPPED.test(tail)) {
    replies.push({ label: 'Commit and push', prompt: 'commit and push' })
    replies.push({ label: 'Commit and create MR', prompt: 'commit and create mr' })
  }
  if (CI_WORDS.test(tail)) replies.push({ label: 'Check again', prompt: 'check again' })
  const seen = new Set()
  return replies.filter((reply) => !seen.has(reply.prompt) && seen.add(reply.prompt))
}
