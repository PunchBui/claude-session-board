const PERMALINK = /https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.slack\.com\/archives\/([CDG][A-Z0-9]{6,})\/p(\d{10})(\d{6})(\?[^\s)"'<>\]`|]*)?/g
const CHANNEL_REFS = [
  /<#([CG][A-Z0-9]{6,})\|([a-z0-9_.-]{1,80})>/g,
  /#([a-z0-9_.-]{1,80}) \((?:ID: ?)?([CG][A-Z0-9]{6,})\)/g,
]
const THREAD_TS = /(?:^|[?&])thread_ts=(\d{10}\.\d{6})/
const READ_THREAD = /(^|__)slack_read_thread$/
const SLACK_TOOL = /(^|__)slack_[a-z_]+$/
const PARENT = /=== THREAD PARENT MESSAGE ===\s*\nFrom:\s*([^<(\n]+?)\s*(?:<[^>\n]*>)?\s*(?:\([^)\n]*\))?\s*\n(?:Time:[^\n]*\n)?(?:Message TS:[^\n]*\n)?([\s\S]*?)(?:\n(?:Reactions:|Files:|=== )|$)/
export const MAX_TITLE = 140

export const threadKey = ({ channel, ts }) => `${channel}/${ts}`

export function slackThreadsIn(text) {
  const found = []
  for (const match of String(text ?? '').matchAll(PERMALINK)) {
    const [, host, channel, seconds, micros, query = ''] = match
    const ts = THREAD_TS.exec(query.slice(1))?.[1] ?? `${seconds}.${micros}`
    if (!found.some((item) => item.channel === channel && item.ts === ts)) found.push({ host, channel, ts })
  }
  return found
}

export function channelNamesIn(text) {
  const value = String(text ?? '')
  return [
    ...[...value.matchAll(CHANNEL_REFS[0])].map(([, id, name]) => [id, name]),
    ...[...value.matchAll(CHANNEL_REFS[1])].map(([, name, id]) => [id, name]),
  ]
}

export function plainText(text) {
  return String(text ?? '')
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@[A-Z0-9]+>/g, '@someone')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
    .replace(/<!subteam\^[A-Z0-9]+>/g, '@team')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/:[a-z0-9_+-]{2,40}:/g, '')
    .replace(/(^|\n)\s*&gt;\s?|(^|\n)\s*>\s?/g, '$1$2')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export const isReadThread = (name) => READ_THREAD.test(String(name ?? ''))
export const isSlackTool = (name) => SLACK_TOOL.test(String(name ?? ''))

export function readThreadTarget(input) {
  const channel = typeof input?.channel_id === 'string' ? input.channel_id : null
  const ts = typeof input?.message_ts === 'string' ? input.message_ts : typeof input?.thread_ts === 'string' ? input.thread_ts : null
  return channel && /^[CDG][A-Z0-9]{6,}$/.test(channel) && /^\d{10}\.\d{6}$/.test(ts ?? '') ? { channel, ts } : null
}

export function resultText(content) {
  let text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => block?.text ?? '').join('\n') : ''
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.messages === 'string') text = parsed.messages
  } catch {}
  return text
}

export function threadParent(text) {
  const match = PARENT.exec(resultText(text))
  if (!match) return null
  const body = plainText(match[2])
  return { author: match[1].trim(), text: body.length > MAX_TITLE ? `${body.slice(0, MAX_TITLE - 1)}…` : body }
}

export const threadUrl = ({ host, channel, ts }) => (host ? `https://${host}.slack.com/archives/${channel}/p${ts.replace('.', '')}` : null)
export const channelUrl = ({ host, id }) => (host ? `https://${host}.slack.com/archives/${id}` : null)
export const tsToMs = (ts) => Math.round(Number(ts) * 1000)
