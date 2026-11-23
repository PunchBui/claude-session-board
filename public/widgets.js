export const WIDGET_HOST = '/visualize/widget.html'
export const PROTOCOL_VERSION = '2025-11-21'
export const START_HEIGHT = 160
export const MAX_HEIGHT = 6000
const LINK = /^(https?|mailto):/i

export function widgetKey(code) {
  let hash = 5381
  for (let i = 0; i < code.length; i += 1) hash = ((hash * 33) ^ code.charCodeAt(i)) >>> 0
  return `${code.length.toString(36)}-${hash.toString(36)}`
}

export const clampHeight = (value) => Math.min(MAX_HEIGHT, Math.max(24, Math.ceil(Number(value) || 0)))

export function hostContext({ dark, mobile, width, locale }) {
  return {
    theme: dark ? 'dark' : 'light',
    platform: mobile ? 'mobile' : 'desktop',
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    containerDimensions: { maxWidth: Math.round(width) || undefined },
    locale,
  }
}

export const promptText = (params) => (params?.content ?? []).filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n').trim()

export const safeLink = (url) => (typeof url === 'string' && LINK.test(url.trim()) ? url.trim() : null)

export function createWidgetHost(env) {
  const result = (frame, id, value) => env.post(frame, { jsonrpc: '2.0', id, result: value })
  const failure = (frame, id, message) => env.post(frame, { jsonrpc: '2.0', id, error: { code: -32601, message } })
  return async function handle(frame, message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'anthropic:copy-image' || message.type === 'anthropic:copy-text') {
      return env.post(frame, { type: `${message.type}-result`, requestId: message.requestId, ok: false })
    }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return
    const { id, method, params } = message
    const widget = env.widget(frame)
    if (!widget) return
    switch (method) {
      case 'ui/initialize':
        return result(frame, id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          hostInfo: { name: 'claude-session-board', version: '1.0.0' },
          hostCapabilities: { openLinks: {}, downloadFile: {} },
          hostContext: env.context(frame),
        })
      case 'ui/notifications/initialized':
        return env.post(frame, { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { title: widget.title, widget_code: widget.code, loading_messages: [] } } })
      case 'ui/notifications/size-changed':
        return env.resize(frame, clampHeight(params?.height))
      case 'ui/message': {
        const text = promptText(params)
        const sent = text ? await env.sendPrompt(frame, text) : false
        return result(frame, id, sent ? { _sentToChat: true } : { isError: true })
      }
      case 'ui/open-link': {
        const url = safeLink(params?.url)
        if (url) env.openLink(url)
        return result(frame, id, url ? {} : { isError: true })
      }
      case 'ui/download-file':
        env.download(params?.contents ?? [])
        return result(frame, id, {})
      case 'ui/request-display-mode':
        return result(frame, id, { mode: 'inline' })
      case 'ui/update-model-context':
        return result(frame, id, {})
      default:
        if (id !== undefined) return failure(frame, id, `Not supported: ${method}`)
    }
  }
}

export function fileFrom(content) {
  const resource = content?.resource ?? content
  if (!resource) return null
  const name = decodeURIComponent(String(resource.uri ?? '').split('/').pop() || 'download')
  const type = resource.mimeType || 'application/octet-stream'
  if (typeof resource.blob === 'string') {
    const raw = atob(resource.blob)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
    return { name, blob: new Blob([bytes], { type }) }
  }
  if (typeof resource.text === 'string') return { name, blob: new Blob([resource.text], { type }) }
  return null
}

const widgets = new WeakMap()
const heights = new Map()
const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
const isDark = () => Boolean(darkQuery?.matches)
const liveFrames = () => [...document.querySelectorAll('iframe.widget-frame')]

export function renderWidget(m) {
  const wrap = document.createElement('div')
  wrap.className = 'msg widget'
  if (!m.code) {
    const note = document.createElement('div')
    note.className = 'muted'
    note.textContent = m.size ? `Visualization too large to show (${Math.round(m.size / 1000)} KB).` : 'Empty visualization.'
    wrap.append(note)
    return wrap
  }
  const frame = document.createElement('iframe')
  frame.className = 'widget-frame'
  frame.title = m.title ? m.title.replace(/_/g, ' ') : 'Visualization'
  frame.setAttribute('sandbox', 'allow-scripts allow-forms')
  frame.dataset.key = widgetKey(m.code)
  frame.style.cssText = `display:block;width:100%;height:${START_HEIGHT}px;border:0;background:transparent;color-scheme:${isDark() ? 'dark' : 'light'}`
  frame.src = WIDGET_HOST
  frame.addEventListener('load', () => {
    const known = heights.get(frame.dataset.key)
    if (known) frame.style.height = `${known}px`
  })
  widgets.set(frame, m)
  wrap.append(frame)
  return wrap
}

function download(contents) {
  for (const content of contents) {
    const file = fileFrom(content)
    if (!file) continue
    const url = URL.createObjectURL(file.blob)
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

export function installWidgetHost({ sendPrompt, mobile = () => false }) {
  const handle = createWidgetHost({
    widget: (frame) => widgets.get(frame),
    post: (frame, message) => frame.contentWindow?.postMessage(message, '*'),
    context: (frame) => hostContext({ dark: isDark(), mobile: mobile(), width: frame.clientWidth, locale: navigator.language }),
    resize(frame, height) {
      heights.set(frame.dataset.key, height)
      frame.style.height = `${height}px`
    },
    sendPrompt,
    openLink: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    download,
  })
  window.addEventListener('message', (event) => {
    const frame = liveFrames().find((candidate) => candidate.contentWindow === event.source)
    if (frame) handle(frame, event.data)
  })
  darkQuery?.addEventListener?.('change', () => {
    const theme = isDark() ? 'dark' : 'light'
    for (const frame of liveFrames()) {
      frame.style.colorScheme = theme
      frame.contentWindow?.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme } }, '*')
    }
  })
}
