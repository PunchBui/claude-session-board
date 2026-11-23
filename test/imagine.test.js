import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadImagine, findAsar, widgetPage, createImagineCache, WIDGET_ASSET_BASE } from '../lib/imagine.js'
import { createHandler, runArgs, mcpConfig, UNAVAILABLE } from '../lib/visualize-mcp.js'

function writeAsar(path, files) {
  const tree = { files: {} }
  const bodies = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const parts = name.split('/')
    let node = tree
    for (const dir of parts.slice(0, -1)) node = node.files[dir] ??= { files: {} }
    const body = Buffer.from(content)
    node.files[parts.at(-1)] = { size: body.length, offset: String(offset) }
    offset += body.length
    bodies.push(body)
  }
  const json = Buffer.from(JSON.stringify(tree))
  const padded = Math.ceil(json.length / 4) * 4
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(8 + padded, 4)
  head.writeUInt32LE(4 + padded, 8)
  head.writeUInt32LE(json.length, 12)
  writeFileSync(path, Buffer.concat([head, json, Buffer.alloc(padded - json.length), ...bodies]))
}

const CHUNK = `"use strict";const e=require("./index.chunk-a.js");
function N(n,a){if(n==="read_me")return{content:[{type:"text",text:"guide:"+(a.modules||[]).join(",")}]};if(n==="show_widget")return{content:[{type:"text",text:"shown"}]};return{content:[{type:"text",text:"Unknown"}],isError:!0}}
exports.getImagineServerDef=function(k){return{serverName:"visualize",tools:[{name:"show_widget",description:"Show",inputSchema:{type:"object"},_meta:{ui:{resourceUri:"ui://imagine/show-widget.html"}}},{name:"read_me",description:"Read",inputSchema:{type:"object"},_meta:{"anthropic/maxResultSizeChars":200000}}],handleToolCall:async(n,a)=>e.policyBlocks()?{content:[],isError:!0}:N(n,a),handleListResources:()=>[{uri:"ui://imagine/show-widget.html",name:"w"}],handleReadResource:u=>({contents:[{uri:u,mimeType:"text/html;profile=mcp-app",text:"<!DOCTYPE html><html><head><title>w</title></head><body></body></html>"}]})}};`

function fakeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-test-'))
  const path = join(dir, 'app.asar')
  writeAsar(path, { 'package.json': '{}', '.vite/build/index.js': 'exports.other=1', '.vite/build/index.chunk-x.js': CHUNK, '.vite/build/big/readme.md': 'exports.getImagineServerDef' })
  return path
}

test('loads the visualize server from the Claude desktop app bundle', async () => {
  const imagine = loadImagine({ candidates: ['/nowhere/app.asar', fakeApp()] })
  assert.deepEqual(imagine.tools.map((tool) => tool.name), ['show_widget', 'read_me'])
  assert.equal(imagine.tools[1]._meta['anthropic/maxResultSizeChars'], 200000)
  assert.deepEqual(await imagine.call('read_me', { modules: ['diagram', 'chart'] }), { content: [{ type: 'text', text: 'guide:diagram,chart' }] })
  assert.equal((await imagine.call('show_widget', { widget_code: '<p/>' })).content[0].text, 'shown')
  assert.match(await imagine.widgetHtml(), /<html>/)
})

test('finds no app when no bundle exists', () => {
  assert.equal(findAsar(['/nowhere/a.asar']), null)
  assert.equal(loadImagine({ candidates: ['/nowhere/a.asar'] }), null)
})

test('reloads the definition only when the bundle changes', () => {
  const path = fakeApp()
  let loads = 0
  const current = createImagineCache({ find: () => findAsar([path]), load: () => ({ n: ++loads }) })
  current()
  current()
  assert.equal(loads, 1)
  const later = new Date(Date.now() + 60_000)
  utimesSync(path, later, later)
  assert.equal(current().n, 2)
})

test('points the widget page at the public widget libraries', () => {
  const page = widgetPage('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">')
  assert.match(page, new RegExp(`<head>\\n<base href="${WIDGET_ASSET_BASE}">\\n<meta`))
})

test('the MCP server answers the handshake, lists tools and calls them', async () => {
  const imagine = loadImagine({ candidates: [fakeApp()] })
  const handle = createHandler(() => imagine)
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.equal(init.result.serverInfo.name, 'visualize')
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((tool) => tool.name), ['show_widget', 'read_me'])
  const call = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_me', arguments: { modules: ['art'] } } })
  assert.equal(call.result.content[0].text, 'guide:art')
  const read = await handle({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'ui://imagine/show-widget.html' } })
  assert.match(read.result.contents[0].text, /<html>/)
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'prompts/list' })).error.code, -32601)
})

test('without the desktop app the MCP server lists no tools and refuses calls', async () => {
  const handle = createHandler(() => null)
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools, [])
  const call = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'show_widget', arguments: {} } })
  assert.equal(call.result.isError, true)
  assert.equal(call.result.content[0].text, UNAVAILABLE)
})

test('board runs get the visualize server and its tools pre-allowed only when the app exists', () => {
  assert.deepEqual(runArgs(false), [])
  const args = runArgs(true, '/usr/bin/node', '/board/lib/visualize-mcp.js')
  assert.equal(args[0], '--mcp-config')
  assert.deepEqual(JSON.parse(args[1]), { mcpServers: { visualize: { type: 'stdio', command: '/usr/bin/node', args: ['/board/lib/visualize-mcp.js'] } } })
  assert.deepEqual(args.slice(2), ['--allowedTools', 'mcp__visualize__read_me mcp__visualize__show_widget'])
  assert.equal(JSON.parse(mcpConfig('/n', '/s')).mcpServers.visualize.command, '/n')
})
