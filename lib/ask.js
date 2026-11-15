import { openSync, closeSync, readSync, fstatSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

// Board runs talk to claude over stream-json so the board can answer what a `-p` run
// could only auto-cancel: an MCP server's confirmation (an "elicitation", e.g. Supabase
// asking before apply_migration). Verified against claude 2.1.x: the CLI writes a
// control_request {subtype:'elicitation'} on stdout and waits for a control_response.

export const ANSWER_ACTIONS = ['accept', 'decline', 'cancel']
const MAX_TEXT = 2000
const MAX_FIELDS = 20
const MAX_OPTIONS = 50

const clip = (value, max = MAX_TEXT) => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export const userMessageLine = (prompt) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`

function safeUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function fieldFrom(name, spec, required) {
  if (!spec || typeof spec !== 'object') return null
  const items = spec.items && typeof spec.items === 'object' ? spec.items : null
  const multi = spec.type === 'array'
  const source = multi ? items : spec
  let options = null
  if (Array.isArray(source?.enum)) {
    const names = Array.isArray(source.enumNames) ? source.enumNames : []
    options = source.enum.slice(0, MAX_OPTIONS).map((value, index) => ({ value: clip(value, 200), label: clip(names[index] ?? value, 200) }))
  } else if (Array.isArray(source?.oneOf ?? source?.anyOf)) {
    options = (source.oneOf ?? source.anyOf).slice(0, MAX_OPTIONS).filter((item) => item && 'const' in item).map((item) => ({ value: clip(item.const, 200), label: clip(item.title ?? item.const, 200) }))
  }
  const type = multi ? 'multi' : options ? 'choice' : ['boolean', 'number', 'integer'].includes(spec.type) ? spec.type : 'string'
  return {
    name: clip(name, 100),
    type,
    title: clip(spec.title ?? name, 200),
    description: clip(spec.description ?? '', 500),
    required,
    options,
    default: spec.default ?? null,
  }
}

// A control_request the board must show to a person, or null for anything else.
export function askFrom(message) {
  if (message?.type !== 'control_request' || typeof message.request_id !== 'string') return null
  const request = message.request
  if (request?.subtype !== 'elicitation') return null
  const schema = request.requested_schema
  const required = Array.isArray(schema?.required) ? schema.required : []
  const entries = Object.entries(schema?.properties ?? {})
  const order = Array.isArray(request.property_order) ? request.property_order : []
  entries.sort(([a], [b]) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9))
  const fields = entries.slice(0, MAX_FIELDS).map(([name, spec]) => fieldFrom(name, spec, required.includes(name))).filter(Boolean)
  const url = request.mode === 'url' ? safeUrl(request.url) : null
  return {
    id: message.request_id,
    kind: 'elicitation',
    server: clip(request.mcp_server_name, 100),
    title: clip(request.title ?? request.display_name ?? '', 200),
    message: clip(request.message),
    mode: request.mode === 'url' ? 'url' : 'form',
    url,
    fields: request.mode === 'url' ? [] : fields,
    at: Date.now(),
  }
}

// Permission prompts would hang a stream-json run until somebody answers. Board runs never had
// a way to answer them (-p denied them), so keep denying: only elicitations reach a person.
export function permissionRequestFrom(message) {
  if (message?.type !== 'control_request' || typeof message.request_id !== 'string') return null
  return message.request?.subtype === 'can_use_tool' ? message.request_id : null
}

export const denyLine = (requestId) => responseLine(requestId, { behavior: 'deny', message: 'This board run cannot ask for permission, so the call was denied.' })

// Any other control_request we do not understand is answered with an error so the CLI never waits on us.
export const errorLine = (requestId, error) => `${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })}\n`

export const cancelledId = (message) => (message?.type === 'control_cancel_request' && typeof message.request_id === 'string' ? message.request_id : null)

function responseLine(requestId, response) {
  return `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`
}

function cleanValue(field, raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (field.type === 'boolean') return raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : undefined
  if (field.type === 'number' || field.type === 'integer') {
    const number = Number(raw)
    if (!Number.isFinite(number)) return undefined
    return field.type === 'integer' ? Math.trunc(number) : number
  }
  if (field.type === 'choice') return field.options.some((option) => option.value === String(raw)) ? String(raw) : undefined
  if (field.type === 'multi') {
    const list = (Array.isArray(raw) ? raw : []).map(String).filter((value) => field.options?.some((option) => option.value === value))
    return list.length ? list : undefined
  }
  return clip(raw)
}

// Turns a person's answer into the line the CLI is waiting for. Only fields the request declared are sent.
export function answerLine(ask, { action, content } = {}) {
  if (!ANSWER_ACTIONS.includes(action)) return { error: 'Choose accept, decline or cancel.' }
  if (action !== 'accept') return { line: responseLine(ask.id, { action }) }
  const values = {}
  for (const field of ask.fields) {
    const value = cleanValue(field, content?.[field.name])
    if (value !== undefined) values[field.name] = value
    else if (field.required) return { error: `"${field.title}" is required.` }
  }
  return { line: responseLine(ask.id, ask.mode === 'url' || !ask.fields.length ? { action } : { action, content: values }) }
}

// Follows a file another process appends to and hands over each complete JSON line.
// The run's stdout goes to a file (not a pipe) so the run still survives a board restart.
export function tailJsonLines(file, onMessage, { pollMs = 250, open = openSync, close = closeSync, read = readSync, size = (fd) => fstatSync(fd).size, schedule = setInterval } = {}) {
  let fd = null
  let offset = 0
  let rest = ''
  const decoder = new StringDecoder('utf8')
  const drain = () => {
    try {
      fd ??= open(file, 'r')
      const end = size(fd)
      while (offset < end) {
        const buffer = Buffer.alloc(Math.min(end - offset, 1 << 20))
        const got = read(fd, buffer, 0, buffer.length, offset)
        if (!got) break
        offset += got
        rest += decoder.write(buffer.subarray(0, got))
      }
    } catch {
      return
    }
    let cut
    while ((cut = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, cut).trim()
      rest = rest.slice(cut + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line))
      } catch {}
    }
  }
  const timer = schedule(drain, pollMs)
  timer.unref?.()
  return {
    drain,
    stop() {
      clearInterval(timer)
      drain()
      if (fd !== null) try { close(fd) } catch {}
      fd = null
    },
  }
}
