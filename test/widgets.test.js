import test from 'node:test'
import assert from 'node:assert/strict'
import { createWidgetHost, hostContext, widgetKey, clampHeight, promptText, safeLink, fileFrom, MAX_HEIGHT } from '../public/widgets.js'

function host({ widget = { title: 'flow', code: '<svg></svg>' }, sent = true } = {}) {
  const h = { posted: [], heights: [], prompts: [], links: [], downloads: [] }
  h.handle = createWidgetHost({
    widget: () => widget,
    post: (frame, message) => h.posted.push(message),
    context: () => hostContext({ dark: true, mobile: false, width: 700.4, locale: 'en' }),
    resize: (frame, height) => h.heights.push(height),
    sendPrompt: async (frame, text) => { h.prompts.push(text); return sent },
    openLink: (url) => h.links.push(url),
    download: (contents) => h.downloads.push(contents),
  })
  return h
}

test('answers the widget handshake and then hands over the widget code', async () => {
  const h = host()
  await h.handle({}, { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2025-11-21' } })
  const init = h.posted[0]
  assert.equal(init.id, 1)
  assert.equal(init.result.protocolVersion, '2025-11-21')
  assert.deepEqual(init.result.hostContext, { theme: 'dark', platform: 'desktop', displayMode: 'inline', availableDisplayModes: ['inline'], containerDimensions: { maxWidth: 700 }, locale: 'en' })
  assert.ok(init.result.hostCapabilities.downloadFile)
  await h.handle({}, { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} })
  assert.deepEqual(h.posted[1], { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { title: 'flow', widget_code: '<svg></svg>', loading_messages: [] } } })
})

test('resizes to the reported height within bounds', async () => {
  const h = host()
  await h.handle({}, { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 600, height: 412.2 } })
  await h.handle({}, { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 99999 } })
  assert.deepEqual(h.heights, [413, MAX_HEIGHT])
  assert.equal(clampHeight(undefined), 24)
})

test('sendPrompt goes to the session and reports whether it was sent', async () => {
  const h = host()
  await h.handle({}, { jsonrpc: '2.0', id: 7, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Explain step 2' }] } })
  assert.deepEqual(h.prompts, ['Explain step 2'])
  assert.deepEqual(h.posted[0], { jsonrpc: '2.0', id: 7, result: { _sentToChat: true } })
  const refused = host({ sent: false })
  await refused.handle({}, { jsonrpc: '2.0', id: 8, method: 'ui/message', params: { content: [{ type: 'text', text: 'x' }] } })
  assert.deepEqual(refused.posted[0].result, { isError: true })
})

test('opens only web and mail links', async () => {
  const h = host()
  await h.handle({}, { jsonrpc: '2.0', id: 1, method: 'ui/open-link', params: { url: 'https://example.com/a' } })
  await h.handle({}, { jsonrpc: '2.0', id: 2, method: 'ui/open-link', params: { url: 'javascript:alert(1)' } })
  assert.deepEqual(h.links, ['https://example.com/a'])
  assert.deepEqual(h.posted.map((m) => m.result), [{}, { isError: true }])
  assert.equal(safeLink(' mailto:a@b.c '), 'mailto:a@b.c')
})

test('refuses copy requests and unknown methods, ignores frames it does not know', async () => {
  const h = host()
  await h.handle({}, { type: 'anthropic:copy-image', requestId: 'r1', blob: {} })
  await h.handle({}, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })
  assert.deepEqual(h.posted[0], { type: 'anthropic:copy-image-result', requestId: 'r1', ok: false })
  assert.equal(h.posted[1].error.code, -32601)
  const unknown = host({ widget: null })
  await unknown.handle({}, { jsonrpc: '2.0', id: 1, method: 'ui/initialize' })
  assert.deepEqual(unknown.posted, [])
})

test('downloads hand the files over and turn resources into blobs', async () => {
  const h = host()
  const contents = [{ type: 'resource', resource: { uri: 'file:///chart%201.png', mimeType: 'image/png', blob: btoa('PNG') } }]
  await h.handle({}, { jsonrpc: '2.0', id: 4, method: 'ui/download-file', params: { contents } })
  assert.deepEqual(h.downloads, [contents])
  const file = fileFrom(contents[0])
  assert.equal(file.name, 'chart 1.png')
  assert.equal(file.blob.type, 'image/png')
  assert.equal(await file.blob.text(), 'PNG')
  assert.equal(await fileFrom({ resource: { uri: 'file:///a.svg', text: '<svg/>' } }).blob.text(), '<svg/>')
})

test('widget keys and prompt text are stable', () => {
  assert.equal(widgetKey('<svg/>'), widgetKey('<svg/>'))
  assert.notEqual(widgetKey('<svg/>'), widgetKey('<svg />'))
  assert.equal(promptText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
})
