const QUESTION = /\?\s*(["')\]*_`]*\s*)?$/
const CI_WORDS = /\b(pipeline|ci\b|coverage|build failed|job failed|checks? (are |is )?(still )?(running|failing))/i
const SHIPPED = /\b(pushed|committed|pushed to|created (the |an? )?(mr|merge request)|opened (the |an? )?(mr|merge request))\b/i
const PUSH_WORDS = /\b(push|commit|merge request|\bMR\b)/i

export function lastAssistantText(chat) {
  const items = Array.isArray(chat) ? chat : []
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.role === 'user' || item.role === 'command') return null
    if (item.role === 'assistant') return String(item.text ?? '')
  }
  return null
}

export function quickReplies(card) {
  if (!card || card.run?.state === 'running' || card.active || card.live?.attention || card.queue?.items?.length) return []
  const text = lastAssistantText(card.details?.chat)
  if (text === null) return []
  const tail = text.trim().slice(-400)
  const replies = []
  if (QUESTION.test(tail)) {
    replies.push({ label: 'Yes', prompt: 'yes' })
    if (PUSH_WORDS.test(tail)) replies.push({ label: 'Yes, push', prompt: 'yes, commit and push' })
    replies.push({ label: 'No', prompt: 'no' })
  }
  if (card.details?.filesEdited > 0 && !SHIPPED.test(tail)) {
    replies.push({ label: 'Commit and push', prompt: 'commit and push' })
    replies.push({ label: 'Commit and create MR', prompt: 'commit and create mr' })
  }
  if (CI_WORDS.test(tail)) replies.push({ label: 'Check again', prompt: 'check again' })
  const seen = new Set()
  return replies.filter((reply) => !seen.has(reply.prompt) && seen.add(reply.prompt))
}
