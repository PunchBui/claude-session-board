import vm from 'node:vm'
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SERVER_NAME = 'visualize'
export const WIDGET_TOOL = `mcp__${SERVER_NAME}__show_widget`
export const README_TOOL = `mcp__${SERVER_NAME}__read_me`
export const WIDGET_ASSET_BASE = 'https://sandbox.claudemcpcontent.com/'
const EXPORT_NAME = 'getImagineServerDef'
const BUILD_DIR = '.vite/build'
const MAX_CHUNK_BYTES = 4_000_000

export function asarCandidates(env = process.env, home = homedir()) {
  return [env.CLAUDE_APP_ASAR, '/Applications/Claude.app/Contents/Resources/app.asar', join(home, 'Applications/Claude.app/Contents/Resources/app.asar')].filter(Boolean)
}

export function findAsar(candidates = asarCandidates()) {
  for (const path of candidates) {
    const info = statSync(path, { throwIfNoEntry: false })
    if (info?.isFile()) return { path, mtimeMs: info.mtimeMs, size: info.size }
  }
  return null
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length)
  const read = readSync(fd, buffer, 0, length, position)
  return buffer.subarray(0, read)
}

function asarEntries(header) {
  const found = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const full = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry, full)
      else if (entry.offset !== undefined && !entry.unpacked) found.push({ name: full, offset: Number(entry.offset), size: entry.size })
    }
  }
  walk(header, '')
  return found
}

export function findInAsar(path, accept, matches) {
  const fd = openSync(path, 'r')
  try {
    const head = readAt(fd, 0, 16)
    const headerPickle = head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    const header = JSON.parse(readAt(fd, 16, jsonLength).toString('utf8'))
    const dataStart = 8 + headerPickle
    for (const entry of asarEntries(header)) {
      if (!accept(entry.name, entry.size)) continue
      const text = readAt(fd, dataStart + entry.offset, entry.size).toString('utf8')
      if (matches(text)) return text
    }
    return null
  } finally {
    closeSync(fd)
  }
}

export function findImagineSource(asarPath) {
  return findInAsar(asarPath, (name, size) => name.startsWith(`${BUILD_DIR}/`) && name.endsWith('.js') && size < MAX_CHUNK_BYTES, (text) => text.includes(`exports.${EXPORT_NAME}`))
}

function inert() {
  const target = function () {}
  return new Proxy(target, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : inert()),
    apply: () => undefined,
    construct: () => ({}),
  })
}

export function evaluateImagine(source) {
  const module = { exports: {} }
  const context = vm.createContext({ require: () => inert(), module, exports: module.exports, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout })
  vm.runInContext(source, context, { timeout: 5000 })
  const create = module.exports[EXPORT_NAME]
  if (typeof create !== 'function') return null
  const def = create('ccd')
  if (!def || !Array.isArray(def.tools)) return null
  return def
}

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

export function imagineFrom(def) {
  const tools = plain(def.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, ...(tool._meta ? { _meta: tool._meta } : {}) })))
  const resources = () => plain(def.handleListResources?.() ?? [])
  return {
    serverName: def.serverName ?? SERVER_NAME,
    tools,
    call: async (name, args) => plain(await def.handleToolCall(name, args ?? {})),
    resources,
    read: async (uri) => plain(await def.handleReadResource?.(uri)),
    async widgetHtml() {
      const uri = resources()[0]?.uri
      const result = uri ? await def.handleReadResource(uri) : null
      const text = result?.contents?.[0]?.text
      return typeof text === 'string' && /<html/i.test(text) ? text : null
    },
  }
}

export function loadImagine({ candidates = asarCandidates() } = {}) {
  const asar = findAsar(candidates)
  if (!asar) return null
  const source = findImagineSource(asar.path)
  if (!source) return null
  const def = evaluateImagine(source)
  return def ? { ...imagineFrom(def), asar } : null
}

export function createImagineCache({ load = loadImagine, find = findAsar } = {}) {
  let cached = null
  let key = null
  return function current() {
    const asar = find()
    const next = asar ? `${asar.path}:${asar.mtimeMs}:${asar.size}` : null
    if (next !== key) {
      key = next
      try {
        cached = next ? load() : null
      } catch {
        cached = null
      }
    }
    return cached
  }
}

export function widgetPage(html, base = WIDGET_ASSET_BASE) {
  const tag = `<base href="${base}">`
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (open) => `${open}\n${tag}`) : `${tag}\n${html}`
}
